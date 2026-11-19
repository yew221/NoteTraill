import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { openStorage, MIGRATIONS } from '../dist/server/storage.js';
import { ModelLedger } from '../dist/server/model-ledger.js';
import { ModelTransport, checkModelPayload, modelInputEnvelope, packModelContext, DEEPSEEK_ENDPOINT } from '../dist/server/model-transport.js';
import { ModelSettings } from '../dist/server/model-settings.js';
import { ApiError } from '../dist/server/contracts.js';
import { createVaultTools } from '../dist/server/pi-tools.js';
import { MODEL_LIMITS } from '../dist/shared/model-run.js';
import { SearchPrivacy } from '../dist/server/search-privacy.js';
import { WebSearch, SEARCH_ENDPOINT } from '../dist/server/web-search.js';

const secret = 'PUBLIC_SYNTHETIC_ONLY_MODEL_RUNTIME_SECRET';
const config = { provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' };
const fails = code => error => error instanceof ApiError && error.publicError.code === code && !error.message.includes(secret);
const usage = (input = 240, output = 40) => ({ prompt_tokens: input, completion_tokens: output, total_tokens: input + output });
const payload = () => ({ model: 'deepseek-flash', stream: true, stream_options: { include_usage: true }, max_tokens: 4096,
  thinking: { type: 'disabled' }, messages: [{ role: 'system', content: 'Read sources.' }, { role: 'user', content: '公开问题' }],
  tools: createVaultTools(async () => {}).map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) });
function sse({ tokens = usage(), model = 'deepseek-flash-SYNTHETIC', body = '公开回答', done = true, extra = [] } = {}) {
  const chunks = [{ model, choices: [{ index: 0, delta: { content: body }, finish_reason: null }] },
    { model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ...(tokens ? [{ model, choices: [], usage: tokens }] : []), ...extra];
  const bytes = Buffer.from(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join('') + (done ? 'data: [DONE]\r\n\r\n' : ''));
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 19) controller.enqueue(bytes.subarray(i, i + 19)); controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
function fixture(t, baseline = 4710) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-model-ledger-')));
  const storage = openStorage(path.join(directory, 'data')), db = storage.db, ledger = new ModelLedger(db);
  const vaultId = `v_${randomUUID()}`;
  db.prepare('INSERT INTO vaults(id,singleton,root_path,root_device,root_inode,exclusions_json) VALUES (?,1,?,?,?,?)')
    .run(vaultId, path.join(directory, 'not-read'), '0', '0', '[]');
  const values = new Map(), credentials = { reads: 0,
    async write(binding, value) { values.set(binding.account, value); },
    async read(binding) { this.reads++; await this.beforeRead?.(); return values.get(binding.account); },
    async remove(binding) { values.delete(binding.account); } };
  const settings = new ModelSettings(db, credentials), transports = [];
  ledger.batch('t00', baseline);
  t.after(() => { transports.forEach(transport => transport.close()); storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const f = { directory, storage, db, ledger, settings, credentials,
    run(limits = {}) {
      const id = `r_${randomUUID()}`, now = new Date().toISOString();
      db.prepare("INSERT INTO runs(id,kind,vault_id,state,created_at,started_at) VALUES (?,'message',?,'running',?,?)").run(id, vaultId, now, now);
      ledger.start(id, 't00', limits); return id;
    },
    async transport(fetcher = async () => sse(), limits = {}, signal = new AbortController().signal) {
      if (!settings.view().credentialConfigured) { await settings.setModel(config, settings.view().revision); await settings.setCredential(secret, settings.view().revision); }
      const id = f.run(limits), transport = new ModelTransport(ledger, settings, id, settings.view().revision, signal, fetcher);
      transports.push(transport); return { id, transport };
    },
  };
  return f;
}
function settle(f, id, tokens = usage()) {
  const attempt = f.ledger.reserve(id); f.ledger.sent(attempt.id, 1000, 'a'.repeat(64)); f.ledger.settle(attempt.id, tokens, 'deepseek-flash-test'); return attempt;
}

test('durable reservations include the earlier batch expense and settle exactly once', t => {
  const f = fixture(t), id = f.run(), reservation = f.ledger.reserve(id);
  assert.deepEqual(f.ledger.batchTotals('t00'), { spentMicroYuan: 4710, reservedMicroYuan: 321536 });
  assert.equal(f.ledger.totals(id).costMicroYuan, null);
  assert.throws(() => f.ledger.reserve(f.run()), fails('MODEL_REQUEST_BUSY'));
  f.ledger.sent(reservation.id, 500, 'b'.repeat(64)); f.ledger.settle(reservation.id, usage(), 'deepseek-flash-test');
  assert.deepEqual(f.ledger.totals(id), { inputTokens: 240, outputTokens: 40, modelRequests: 1, knownInputTokens: 240, knownOutputTokens: 40,
    costMicroYuan: 800, knownCostMicroYuan: 800, reservedMicroYuan: 0, retries: 0 });
  assert.equal(f.ledger.batchTotals('t00').spentMicroYuan, 5510);
  assert.throws(() => f.ledger.settle(reservation.id, usage(), 'deepseek-flash-test'), fails('MODEL_PROTOCOL_ERROR'));
  assert.throws(() => f.ledger.batch('t00', 0), fails('CONTEXT_CHANGED'));
  const reopened = new Database(path.join(f.directory, 'data/state.sqlite'), { readonly: true, fileMustExist: true });
  try { assert.equal(reopened.prepare('SELECT spent_micro_yuan FROM model_batches').get().spent_micro_yuan, 5510); } finally { reopened.close(); }
});

test('startup recovery releases definitely unsent reservations but retains uncertain charges across reopen', t => {
  const f = fixture(t), id = f.run(), first = f.ledger.reserve(id);
  f.ledger.recover(); assert.equal(f.ledger.batchTotals('t00').reservedMicroYuan, 0);
  assert.equal(f.db.prepare('SELECT state FROM model_attempts WHERE id=?').get(first.id).state, 'not_sent');
  const second = f.ledger.reserve(id); f.ledger.sent(second.id, 300, 'a'.repeat(64));
  new ModelLedger(f.db).recover(); assert(f.ledger.batchTotals('t00').reservedMicroYuan > 0);
  assert.equal(f.ledger.batchTotals('t00').reservedMicroYuan, 321536); assert.equal(f.ledger.totals(id).inputTokens, null);
  new ModelLedger(f.db).recover(); const next = f.ledger.reserve(f.run()); f.ledger.notSent(next.id);
});

test('each real attempt and retry count across rounds, with cumulative input/output enforcement', t => {
  const f = fixture(t), id = f.run({ maxRequests: 6 });
  f.ledger.notSent(f.ledger.reserve(id).id); f.ledger.retry(id);
  for (let i = 0; i < 5; i++) settle(f, id);
  assert.equal(f.ledger.totals(id).modelRequests, 6); assert.equal(f.ledger.totals(id).retries, 1);
  assert.throws(() => f.ledger.reserve(id), fails('BUDGET_EXCEEDED'));
  const another = f.run(); f.ledger.notSent(f.ledger.reserve(another).id); f.ledger.retry(another); f.ledger.notSent(f.ledger.reserve(another).id);
  assert.throws(() => f.ledger.retry(another), fails('BUDGET_EXCEEDED'));
  const input = f.run({ requestInputTokens: 32000, maxInputTokens: 120000 }); for (let i = 0; i < 3; i++) settle(f, input, usage(32000, 1));
  assert.throws(() => f.ledger.reserve(input), fails('BUDGET_EXCEEDED'));
  const output = f.run({ maxOutputTokens: 8192, requestOutputTokens: 4096 }); settle(f, output, usage(10, 4000)); settle(f, output, usage(10, 4000));
  const last = f.ledger.reserve(output); assert.equal(last.outputLimit, 192);
  f.ledger.sent(last.id, 200, 'c'.repeat(64)); f.ledger.settle(last.id, usage(10, 192), 'deepseek-flash-test');
  assert.throws(() => f.ledger.reserve(output), fails('BUDGET_EXCEEDED'));
});

test('operational limits, deadlines and ended runs remain enforced without monetary limits', t => {
  const f = fixture(t, 7950000);
  const allowed = f.ledger.reserve(f.run()); f.ledger.notSent(allowed.id);
  for (const limits of [{ maxRequests: 17 }, { questionMs: 300001 }, { maxRetries: -1 }, { extra: 1 }]) assert.throws(() => f.run(limits), fails('BAD_REQUEST'));
  const ended = f.run(); f.db.prepare("UPDATE runs SET state='cancelled' WHERE id=?").run(ended);
  assert.throws(() => f.ledger.reserve(ended), fails('RUN_INTERRUPTED'));
  const timed = f.run(); f.db.prepare('UPDATE model_runs SET deadline=1 WHERE run_id=?').run(timed);
  assert.throws(() => f.ledger.reserve(timed), fails('DEADLINE_EXCEEDED'));
  assert.throws(() => f.run({ questionMicroYuan: 500 }), fails('BAD_REQUEST'));
});

test('invalid usage stays unknown; valid excessive usage records the charge and fails that run', t => {
  for (const tokens of [null, { ...usage(), total_tokens: 10 }, { ...usage(), prompt_cache_hit_tokens: 500 }]) {
    const f = fixture(t), id = f.run(), attempt = f.ledger.reserve(id); f.ledger.sent(attempt.id, 100, 'a'.repeat(64));
    assert.throws(() => f.ledger.settle(attempt.id, tokens, 'deepseek-flash-test'), fails('MODEL_PROTOCOL_ERROR'));
    assert.equal(f.ledger.totals(id).costMicroYuan, null); assert(f.ledger.batchTotals('t00').reservedMicroYuan > 0);
  }
  const f = fixture(t), id = f.run(), attempt = f.ledger.reserve(id); f.ledger.sent(attempt.id, 100, 'a'.repeat(64), 5);
  assert.throws(() => f.ledger.settle(attempt.id, usage(32001, 10), 'deepseek-flash-test'), fails('BUDGET_EXCEEDED'));
  assert.equal(f.ledger.totals(id).costMicroYuan, 64082); assert.equal(f.ledger.totals(id).reservedMicroYuan, 0);
  const next = f.ledger.reserve(f.run()); f.ledger.notSent(next.id);
});

test('payload guard accepts current tools and text only, and refuses oversized contexts before network', async t => {
  assert(checkModelPayload(payload()));
  for (const mutate of [p => { p.model = 'other'; }, p => { p.web_search = true; }, p => { p.tools[0].function.name = 'bash'; },
    p => { p.messages[1].content = [{ type: 'image_url', image_url: { url: 'https://example.com/private' } }]; },
    p => { p.max_tokens = 8193; }, p => { p.thinking.type = 'enabled'; }]) {
    const p = payload(); mutate(p); assert.throws(() => checkModelPayload(p), fails('MODEL_PROTOCOL_ERROR'));
  }
  const p = payload(); p.messages[1].content = '资料🙂'.repeat(7000);
  const f = fixture(t); let calls = 0; const { id, transport } = await f.transport(async () => { calls++; return sse(); });
  await assert.rejects(transport.request(p), fails('CONTEXT_LIMIT')); assert.equal(calls, 0); assert.equal(f.ledger.totals(id).modelRequests, 0);
});

test('transport pins the endpoint, owns credentials and verifies fragmented SSE before returning it', async t => {
  const f = fixture(t); let requests = 0;
  const { id, transport } = await f.transport(async (url, init) => {
    requests++; assert.equal(url, DEEPSEEK_ENDPOINT); assert.equal(init.redirect, 'error'); assert.equal(init.headers.authorization, `Bearer ${secret}`);
    assert(!init.body.includes(secret)); assert.equal(f.ledger.totals(id).reservedMicroYuan, modelInputEnvelope(JSON.parse(init.body)) * 2 + 8192 * 8); return sse();
  });
  const result = await transport.request(payload()); assert.equal(requests, 1); assert.deepEqual(result.usage, usage());
  assert.equal(result.returnedModel, 'deepseek-flash-SYNTHETIC'); assert.equal(f.ledger.totals(id).inputTokens, 240);
  assert.equal(f.credentials.reads, 1); assert(!JSON.stringify(result).includes(secret));
});

test('closing removes unused tool definitions before enforcing the same input ceiling, preserving all source text', async t => {
  const p = payload(), excerpt = '公开证据片段'.repeat(1200); p.messages[1].content = excerpt;
  p.thinking = { type: 'enabled' }; p.reasoning_effort = 'low';
  for (const tool of p.tools) tool.function.description += 'UNUSED_TOOL_DESCRIPTION'.repeat(400);
  assert.throws(() => checkModelPayload(p, 32000), fails('BUDGET_EXCEEDED'));
  const f = fixture(t); let sent;
  const { id, transport } = await f.transport(async (_url, init) => { sent = JSON.parse(init.body); return sse(); });
  await transport.request(p);
  assert.equal(sent.tool_choice, 'none'); assert.equal(sent.tools, undefined); assert.equal(sent.messages[1].content, excerpt);
  assert.deepEqual(sent.thinking, { type: 'disabled' }); assert.equal(sent.reasoning_effort, undefined);
  assert(modelInputEnvelope(sent) <= MODEL_LIMITS.requestInputTokens); assert.equal(f.ledger.totals(id).modelRequests, 1);
});

test('fresh search clues leave a reading round before closing because consumed clues will be retired', async t => {
  const p = payload(); p.messages[1].content = 'q'.repeat(13000);
  p.messages.push({ role: 'assistant', content: null, tool_calls: [1, 2].map(i => ({ id: `search_${i}`, type: 'function', function: { name: 'vault_search', arguments: '{"terms":["public"]}' } })) });
  for (const i of [1, 2]) p.messages.push({ role: 'tool', tool_call_id: `search_${i}`, content: JSON.stringify({ ok: true,
    data: { matches: [{ line: 1, snippet: 'PUBLIC_CLUE'.repeat(300) }], coverage: { complete: false } }, warnings: [], truncated: true, nextCursor: `page_${i}` }) });
  assert(modelInputEnvelope(p) >= 20000 && modelInputEnvelope(p) < 32000);
  const f = fixture(t); let sent;
  const { transport } = await f.transport(async (_url, init) => { sent = JSON.parse(init.body); return sse(); });
  await transport.request(p); assert.notEqual(sent.tool_choice, 'none'); assert.equal(sent.tools.length, 5);
  assert(sent.messages.some(m => m.role === 'tool' && m.content.includes('PUBLIC_CLUE')));
});

test('only confirmed pre-send DNS may retry, once per run including later rounds', async t => {
  const f = fixture(t); let calls = 0;
  const dns = () => new TypeError('not sent', { cause: { code: 'EAI_AGAIN', syscall: 'getaddrinfo', hostname: 'api.deepseek.com' } });
  const { id, transport } = await f.transport(async () => { if (++calls % 2) throw dns(); return sse(); });
  await transport.request(payload()); assert.equal(calls, 2); assert.equal(f.ledger.totals(id).retries, 1);
  await assert.rejects(transport.request(payload()), fails('BUDGET_EXCEEDED'));
  assert.equal(calls, 3); assert.equal(f.ledger.totals(id).modelRequests, 3);
});

test('HTTP errors, missing usage, reset and malformed streams keep funds and never retry', async t => {
  const cases = [
    [() => new Response(secret, { status: 401 }), 'MODEL_AUTH_FAILED'],
    [() => new Response(secret, { status: 429 }), 'MODEL_RATE_LIMITED'],
    [() => new Response(secret, { status: 503 }), 'MODEL_UNAVAILABLE'],
    [() => { throw new TypeError(secret, { cause: { code: 'ECONNRESET' } }); }, 'MODEL_UNAVAILABLE'],
    [() => sse({ tokens: null }), 'MODEL_PROTOCOL_ERROR'], [() => sse({ done: false }), 'MODEL_PROTOCOL_ERROR'],
    [() => sse({ extra: [{ model: 'different', choices: [] }] }), 'MODEL_PROTOCOL_ERROR'],
    [() => sse({ extra: [{ model: 'deepseek-flash-SYNTHETIC', choices: [], usage: usage() }] }), 'MODEL_PROTOCOL_ERROR'],
  ];
  for (const [response, code] of cases) {
    const f = fixture(t); let calls = 0; const { id, transport } = await f.transport(async () => { calls++; return response(); });
    await assert.rejects(transport.request(payload()), fails(code)); assert.equal(calls, 1); assert(f.ledger.batchTotals('t00').reservedMicroYuan > 0);
    assert.equal(f.ledger.totals(id).costMicroYuan, null); assert.equal(f.ledger.totals(id).reservedMicroYuan, modelInputEnvelope(payload()) * 2 + 8192 * 8);
  }
});

test('request timeout and cancellation stop even an uncooperative transport and preserve unknown usage', async t => {
  const f = fixture(t), abort = new AbortController();
  const { id, transport } = await f.transport(async () => new Promise(() => {}), { requestMs: 40 }, abort.signal);
  await assert.rejects(transport.request(payload()), fails('DEADLINE_EXCEEDED')); assert(f.ledger.batchTotals('t00').reservedMicroYuan > 0);
  assert.equal(f.ledger.totals(id).costMicroYuan, null);
  const g = fixture(t), stop = new AbortController(); let ready; const started = new Promise(resolve => { ready = resolve; });
  const next = await g.transport(async () => { ready(); return new Promise(() => {}); }, {}, stop.signal);
  const pending = next.transport.request(payload()); await started; stop.abort();
  await assert.rejects(pending, fails('RUN_INTERRUPTED')); assert(g.ledger.batchTotals('t00').reservedMicroYuan > 0);
});

test('configuration changes cancel requests and late credential reads cannot authorize a send', async t => {
  const f = fixture(t); let release; const gate = new Promise(resolve => { release = resolve; }); let reading;
  const started = new Promise(resolve => { reading = resolve; }); let sends = 0;
  const { id, transport } = await f.transport(async () => { sends++; return sse(); });
  f.credentials.beforeRead = () => { reading(); return gate; };
  const pending = transport.request(payload()); await started;
  await f.settings.setModel({ ...config, baseUrl: 'https://new-service.example' }, f.settings.view().revision);
  release(); await assert.rejects(pending, error => fails('CONTEXT_CHANGED')(error) || fails('RUN_INTERRUPTED')(error));
  assert.equal(sends, 0); assert.equal(f.ledger.totals(id).modelRequests, 0);
  const g = fixture(t); let sent; const onSend = new Promise(resolve => { sent = resolve; });
  const active = await g.transport(async () => { sent(); return new Promise(() => {}); }); const request = active.transport.request(payload());
  await onSend; await g.settings.setCredential('PUBLIC_REPLACEMENT_SYNTHETIC_SECRET', g.settings.view().revision);
  await assert.rejects(request, fails('CONTEXT_CHANGED')); assert(g.ledger.batchTotals('t00').reservedMicroYuan > 0);
});

test('actual output limits shrink and a response cannot leak the in-memory credential into Pi', async t => {
  const f = fixture(t); let sentLimit;
  const { id, transport } = await f.transport(async (_url, init) => { sentLimit = JSON.parse(init.body).max_tokens; return sse({ tokens: usage(200, 10) }); }, { maxOutputTokens: 8192, requestOutputTokens: 4096 });
  settle(f, id, usage(10, 4000)); settle(f, id, usage(10, 4000)); await transport.request(payload()); assert.equal(sentLimit, 192);
  const g = fixture(t), blocked = await g.transport(async () => sse({ body: secret }));
  await assert.rejects(blocked.transport.request(payload()), fails('MODEL_PROTOCOL_ERROR'));
  assert.equal(g.ledger.totals(blocked.id).costMicroYuan, 800);
});

test('v8 upgrade preserves an inspectable backup and adds only the model ledger tables', t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-model-migration-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const data = path.join(directory, 'data'), old = openStorage(data, MIGRATIONS.slice(0, 8)); old.close();
  const current = openStorage(data);
  try {
    assert.equal(current.db.pragma('user_version', { simple: true }), MIGRATIONS.length);
    const backup = new Database(path.join(data, 'backups', fs.readdirSync(path.join(data, 'backups'))[0]), { readonly: true });
    try { assert.equal(backup.pragma('user_version', { simple: true }), 8); assert(!backup.prepare("SELECT name FROM sqlite_schema WHERE name='model_attempts'").get()); }
    finally { backup.close(); }
  } finally { current.close(); }
});

test('real SIGKILL recovery keeps uncertain reservations without rerunning a paid attempt', async t => {
  for (const sent of [false, true]) {
    const f = fixture(t), id = f.run(), script = path.join(f.directory, 'crash.mjs');
    const storageModule = pathToFileURL(path.resolve('dist/server/storage.js')).href;
    const ledgerModule = pathToFileURL(path.resolve('dist/server/model-ledger.js')).href;
    fs.writeFileSync(script, `
      import { openStorage } from ${JSON.stringify(storageModule)};
      import { ModelLedger } from ${JSON.stringify(ledgerModule)};
      const storage = openStorage(${JSON.stringify(f.storage.directory)}), ledger = new ModelLedger(storage.db);
      const attempt = ledger.reserve(${JSON.stringify(id)});
      ${sent ? "ledger.sent(attempt.id, 500, 'a'.repeat(64));" : ''}
      process.send({ ready: true }); setInterval(() => {}, 1000);
    `);
    f.storage.close();
    const child = fork(script, [], { execArgv: [], env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, stdio: ['ignore','ignore','ignore','ipc'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    await once(child, 'message'); const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
    const reopened = openStorage(path.join(f.directory, 'data'));
    try {
      const ledger = new ModelLedger(reopened.db); ledger.recover();
      assert.equal(ledger.batchTotals('t00').reservedMicroYuan, sent ? 321536 : 0);
      assert.equal(ledger.totals(id).modelRequests, 1); assert.equal(ledger.totals(id).costMicroYuan, sent ? null : 0);
      const next = ledger.reserve(id); ledger.notSent(next.id);
    } finally { reopened.close(); }
  }
});

test('answer preview arrives before stream closes, while usage remains pending', async t => {
  const f = fixture(t), model = 'deepseek-flash-SYNTHETIC';
  let controller;
  const { id, transport } = await f.transport(async () => new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { 'content-type': 'text/event-stream' } }));
  const previews = [], pending = transport.request(payload(), text => previews.push(text));
  while (!controller) await new Promise(resolve => setTimeout(resolve, 1));
  const send = data => controller.enqueue(Buffer.from(`data: ${JSON.stringify(data)}\n\n`));
  send({ model, choices: [{ index: 0, delta: { reasoning_content: 'PRIVATE_REASONING', content: '{"outcome":"answered","blocks":[{"id":"b1","kind":"notice","markdown":"公开' }, finish_reason: null }] });
  while (!previews.includes('公开')) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(f.ledger.totals(id).inputTokens, null);
  assert(!previews.join('').includes('PRIVATE_REASONING'));
  send({ model, choices: [{ index: 0, delta: { content: '回答","evidenceIds":[]}],"limitations":[]}' }, finish_reason: 'stop' }] });
  send({ model, choices: [], usage: usage() }); controller.enqueue(Buffer.from('data: [DONE]\n\n')); controller.close();
  await pending;
  assert.equal(previews.at(-1), '公开回答'); assert.equal(f.ledger.totals(id).outputTokens, 40);
});

test('web searches reserve a flat fee, preserve unknown maximums across recovery and allow six searches while retaining a finite call limit', t => {
  const f = fixture(t), run = f.run();
  const search = f.ledger.reserveSearch(run);
  assert.equal(f.ledger.batchTotals('t00').reservedMicroYuan, 5000);
  assert.throws(() => f.ledger.reserve(run), fails('MODEL_REQUEST_BUSY'));
  f.ledger.sentSearch(search); f.ledger.recover();
  assert.equal(f.ledger.totals(run).reservedMicroYuan, 5000);
  assert.equal(f.ledger.totals(run).knownCostMicroYuan, 0);
  assert.equal(f.ledger.totals(run).inputTokens, 0);
  assert.equal(f.ledger.totals(run).costMicroYuan, null);
  const model = f.ledger.reserve(run); f.ledger.notSent(model.id);
  const second = f.ledger.reserveSearch(run); f.ledger.sentSearch(second); f.ledger.endSearch(second, 'charged');
  assert.equal(f.ledger.batchTotals('t00').spentMicroYuan, 9710);
  assert.equal(f.ledger.totals(run).searchRequests, 2);
  for (let i = 2; i < 6; i++) { const extra = f.ledger.reserveSearch(run); f.ledger.sentSearch(extra); f.ledger.endSearch(extra, 'free'); }
  assert.equal(f.ledger.totals(run).searchRequests, 6);
  assert.throws(() => f.ledger.reserveSearch(run), fails('SEARCH_LIMIT_REACHED'));
  assert.throws(() => f.ledger.endSearch(second, 'free'), fails('MODEL_PROTOCOL_ERROR'));
  const small = f.run();
  const fee = f.ledger.reserveSearch(small); f.ledger.sentSearch(fee); f.ledger.endSearch(fee, 'unknown');
  const next = f.ledger.reserve(small); f.ledger.notSent(next.id);
  assert.equal(f.ledger.totals(small).reservedMicroYuan, 5000);
});

test('DeepSeek search sends only public keywords, filters unsafe sources and never exposes the key', async t => {
  const f = fixture(t), run = f.run();
  await f.settings.setModel(config, 1); await f.settings.setCredential(secret, 2);
  const search = new WebSearch(f.settings, f.ledger, new SearchPrivacy(), async (url, init) => {
    assert.equal(url, SEARCH_ENDPOINT); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, `Bearer ${secret}`);
    assert.deepEqual(JSON.parse(init.body), { query: 'SKU definition', count: 5, need_content: true });
    return Response.json({ results: [
      { url: 'file:///private/secret', title: 'bad', content: 'bad' },
      { url: 'http://127.0.0.1/private', title: 'bad', content: 'bad' },
      { url: 'https://example.com/sku', title: 'SKU', summary: 'Stock keeping unit.', content: '', date: null },
      { url: 'https://example.com/sku', title: 'duplicate', content: 'duplicate' },
    ] });
  });
  const result = await search.execute(run, 3, { query: 'SKU definition', reason: 'PRIVATE_LOCAL_REASON' }, new AbortController().signal);
  assert(result.ok); assert.equal(result.data.results.length, 1); assert.equal(result.data.results[0].contentKind, 'summary');
  assert.match(result.data.results[0].id, /^e_/); assert(!JSON.stringify(result).includes(secret));
  assert.equal(f.ledger.totals(run).knownCostMicroYuan, 5000);
  assert.equal(f.ledger.totals(run).modelRequests, 0);
  await assert.rejects(search.execute(run, 3, { query: 'person@example.com', reason: 'missing' }, new AbortController().signal), fails('BAD_REQUEST'));
});

test('search failures, empty results, cancellation and missing keys do not fabricate sources or charges', async t => {
  const f = fixture(t);
  const missing = new WebSearch(f.settings, f.ledger, new SearchPrivacy(), () => { assert.fail('network without credentials'); });
  await assert.rejects(missing.execute(f.run(), 1, { query: 'SKU', reason: 'missing' }, new AbortController().signal), fails('SEARCH_CONFIG_REQUIRED'));
  await f.settings.setModel(config, 1); await f.settings.setCredential(secret, 2);
  for (const [fetcher, cost, held] of [
    [async () => new Response(null, { status: 402 }), 0, 0],
    [async () => Response.json({ results: [] }), 0, 0],
    [async () => { throw new Error(secret); }, 0, 5000],
    [async () => new Response('{malformed'), 0, 5000],
  ]) {
    const run = f.run(), search = new WebSearch(f.settings, f.ledger, new SearchPrivacy(), fetcher);
    try { const result = await search.execute(run, 3, { query: 'SKU', reason: 'missing' }, new AbortController().signal); assert(result.ok); assert.deepEqual(result.data.results, []); }
    catch (error) { assert(fails('SEARCH_UNAVAILABLE')(error)); }
    assert.equal(f.ledger.totals(run).knownCostMicroYuan, cost); assert.equal(f.ledger.totals(run).reservedMicroYuan, held);
  }
  const controller = new AbortController(); controller.abort(); const run = f.run();
  await assert.rejects(new WebSearch(f.settings, f.ledger, new SearchPrivacy(), () => assert.fail('sent after stop')).execute(run, 3, { query: 'SKU', reason: 'missing' }, controller.signal));
  assert.equal(f.ledger.totals(run).searchRequests, undefined);
});

test('unified model payloads require the known tools and still reject extra capabilities', () => {
  const request = payload();
  assert(checkModelPayload(request));
  assert.equal(request.tools.length, 5);
  request.tools.push({ type: 'function', function: { name: 'shell', description: 'forbidden', parameters: { type: 'object', properties: {} } } });
  assert.throws(() => checkModelPayload(request), fails('MODEL_PROTOCOL_ERROR'));
});

test('legacy budget caps and pause flags never block new model or search requests, while all accounting survives', t => {
  const f = fixture(t, 50_000_000);
  f.db.prepare('INSERT INTO budget_settings(batch_id,revision,question_micro_yuan,pause_micro_yuan,total_micro_yuan) VALUES (?,?,?,?,?)').run('t00', 2, 1, 1, 1);
  f.db.prepare('UPDATE model_batches SET paused=1 WHERE id=?').run('t00');
  const id = f.run(), old = f.ledger.reserve(id, { input: 2, output: 8 }, config, 12000);
  f.ledger.sent(old.id, 1000, 'a'.repeat(64)); f.ledger.unknown(old.id, 'MODEL_UNAVAILABLE');
  const snapshot = f.db.prepare('SELECT * FROM model_attempts WHERE id=?').get(old.id);
  const held = f.ledger.batchTotals('t00').reservedMicroYuan;
  const nextId = f.run(); assert.equal(f.ledger.shouldCloseTools(nextId), false);
  const next = f.ledger.reserve(nextId, { input: 10000, output: 10000 }, config);
  f.ledger.sent(next.id, 1000, 'b'.repeat(64)); f.ledger.settle(next.id, usage(), 'deepseek-flash-test');
  assert.equal(f.ledger.totals(nextId).knownCostMicroYuan, 2_800_000);
  const search = f.ledger.reserveSearch(nextId); f.ledger.sentSearch(search); f.ledger.endSearch(search, 'charged');
  assert.equal(f.ledger.batchTotals('t00').spentMicroYuan, 52_805_000);
  assert.equal(f.ledger.batchTotals('t00').reservedMicroYuan, held);
  assert.deepEqual(f.db.prepare('SELECT * FROM model_attempts WHERE id=?').get(old.id), snapshot);
  assert.equal(f.db.prepare('SELECT paused FROM model_batches').get().paused, 1);
  assert.equal(f.db.prepare('SELECT total_micro_yuan FROM budget_settings').get().total_micro_yuan, 1);
  const reopened = new ModelLedger(f.db), last = reopened.reserve(f.run()); reopened.notSent(last.id);
});

test('context packing accepts 65 short messages and retires complete old turns without dropping current evidence', () => {
  const short = payload(); short.messages = Array.from({ length: 65 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: '短句' }));
  assert.doesNotThrow(() => checkModelPayload(short));
  const p = payload(); p.messages = [{ role: 'system', content: 'RULES' }];
  for (let i = 0; i < 20; i++) p.messages.push({ role: 'user', content: '旧问题'.repeat(1000) }, { role: 'assistant', content: '旧回答'.repeat(1000) });
  p.messages.push({ role: 'user', content: 'CURRENT_QUESTION' }, { role: 'tool', tool_call_id: 'read1', content: 'CURRENT_EVIDENCE'.repeat(100) });
  const before = JSON.stringify(p), packed = packModelContext(p);
  assert.equal(JSON.stringify(p), before); assert(packed.messages.length < p.messages.length);
  assert(packed.messages.some(m => m.content === 'CURRENT_QUESTION')); assert(packed.messages.some(m => m.content === 'CURRENT_EVIDENCE'.repeat(100)));
  assert(packed.messages.some(m => String(m.content).includes('完整记录仍保存在应用中')));
});


test('expanded search keeps five longer excerpts and discloses truncation', async t => {
  const f = fixture(t), run = f.run();
  await f.settings.setModel(config, 1); await f.settings.setCredential(secret, 2);
  const search = new WebSearch(f.settings, f.ledger, new SearchPrivacy(), async () => Response.json({ results: Array.from({ length: 5 }, (_, i) =>
    ({ url: `https://example.com/${i}`, title: `Public ${i}`, content: '公开资料'.repeat(600) })) }));
  const result = await search.execute(run, 3, { query: 'public facts', reason: 'r'.repeat(900) }, new AbortController().signal);
  assert(result.ok); assert.equal(result.data.results.length, 5);
  assert(result.data.results.every(item => Array.from(item.excerpt).length === 2000));
  assert(Buffer.byteLength(JSON.stringify(result)) > 16 * 1024);
  assert(Buffer.byteLength(JSON.stringify(result)) <= 32 * 1024);
  assert(result.truncated); assert(result.warnings.some(w => w.code === 'WEB_EXCERPT_TRUNCATED'));
  await assert.rejects(search.execute(run, 3, { query: 'q'.repeat(129), reason: 'public' }, new AbortController().signal), fails('BAD_REQUEST'));
});

test('a long answer can exceed the old per-request and cumulative output limits', async t => {
  const f = fixture(t), request = payload(); request.max_tokens = 8192;
  const { id, transport } = await f.transport(async (_url, init) => {
    assert.equal(JSON.parse(init.body).max_tokens, 8192); return sse({ tokens: usage(240, 6000) });
  });
  for (let i = 0; i < 2; i++) await transport.request(request);
  assert.equal(f.ledger.totals(id).knownOutputTokens, 12000);
});

test('output allowance shrinks to fit longer input without evicting current evidence', async t => {
  const f = fixture(t), p = payload(); p.max_tokens = 8192; p.messages[1].content = '公'.repeat(17000);
  const { transport } = await f.transport(async (_url, init) => {
    const sent = JSON.parse(init.body); assert(sent.messages.some(m => m.content === p.messages[1].content));
    assert(sent.max_tokens >= 4000 && sent.max_tokens < 8192); return sse();
  });
  await transport.request(p);
});
