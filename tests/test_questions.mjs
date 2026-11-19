import { MODEL_LIMITS } from '../dist/shared/model-run.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openStorage, MIGRATIONS } from '../dist/server/storage.js';
import { VaultFiles } from '../dist/server/vault-files.js';
import { VaultService } from '../dist/server/vaults.js';
import { VaultToolSession } from '../dist/server/vault-tools.js';
import { Ripgrep } from '../dist/server/ripgrep.js';
import { ModelSettings } from '../dist/server/model-settings.js';
import { ModelLedger } from '../dist/server/model-ledger.js';
import { WorkerRunner } from '../dist/server/worker-runner.js';
import { AnswerService } from '../dist/server/answers.js';
import { ConversationService } from '../dist/server/conversations.js';
import { QuestionService } from '../dist/server/questions.js';
import { RunService } from '../dist/server/runs.js';
import { BrowserSession } from '../dist/server/session.js';
import { createApp } from '../dist/server/app.js';
import { ApiError } from '../dist/server/contracts.js';
import { ConversionFiles } from '../dist/server/conversion-files.js';
import Database from 'better-sqlite3';
import { IngestService } from '../dist/server/ingestions.js';
import { IngestFiles } from '../dist/server/ingest-files.js';
import { backupData, restoreData } from '../dist/server/maintenance.js';
import { readSessionFile } from '../dist/server/session-files.js';

const python = process.env.NOTETRAIL_PYTHON ?? path.join(os.homedir(), '.local/share/uv/tools/markitdown/bin/python');
const rg = process.env.NOTETRAIL_RG ?? ['/opt/homebrew/bin/rg','/usr/local/bin/rg','/Applications/ChatGPT.app/Contents/Resources/codex-cli/codex-path/rg'].find(fs.existsSync);
const options = { skip: process.platform !== 'darwin', timeout: 20000 };
const fails = code => error => error instanceof ApiError && error.publicError.code === code;
const key = () => randomUUID();
const notices = () => ({ outcome: 'insufficient_evidence', blocks: [{ id: 'b1', kind: 'notice', markdown: '当前资料不足。', evidenceIds: [] }], limitations: [] });
const grounded = evidence => ({ outcome: 'answered', blocks: [{ id: 'b1', kind: 'grounded', markdown: evidence.excerpt.trim(), evidenceIds: [evidence.id] }], limitations: [] });
const evidenceFrom = body => body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content)).filter(r => r.ok && r.data.evidence).map(r => r.data.evidence);
function response({ calls, answer = notices() } = {}) {
  const model = 'deepseek-flash-SYNTHETIC', chunks = [];
  if (calls) chunks.push({ model, choices: [{ index: 0, delta: { tool_calls: calls.map((c, index) => ({ index, id: c.id, type: 'function',
    function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) }, finish_reason: 'tool_calls' }] });
  else chunks.push({ model, choices: [{ index: 0, delta: { content: JSON.stringify(answer) }, finish_reason: 'stop' }] });
  chunks.push({ model, choices: [], usage: { prompt_tokens: 600, completion_tokens: 100, total_tokens: 700 } });
  return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
async function fixture(t, model) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-questions-'))), vault = path.join(directory, 'vault');
  fs.mkdirSync(path.join(vault, 'allowed'), { recursive: true }); fs.mkdirSync(path.join(vault, 'other'));
  fs.writeFileSync(path.join(vault, 'allowed/a.md'), '# 甲方案\n旧事实甲：工具箱在三楼。\n');
  fs.writeFileSync(path.join(vault, 'allowed/b.md'), '# 乙方案\n事实乙：工具箱在二楼。\n');
  fs.writeFileSync(path.join(vault, 'other/outside.md'), '不在所选目录的事实。\n');
  const storage = openStorage(path.join(directory, 'data')), db = storage.db;
  const roots = [storage.directory, fs.realpathSync(process.cwd())];
  const vaults = new VaultService(db, new VaultFiles(python, roots), new ConversionFiles(python, roots));
  const connected = await vaults.connect({ absolutePath: vault, exclusions: [] }), credentials = new Map();
  const models = new ModelSettings(db, { async write(binding, value) { credentials.set(binding.account, value); },
    async read(binding) { return credentials.get(binding.account); }, async remove(binding) { credentials.delete(binding.account); } });
  await models.setModel({ provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' }, 1);
  await models.setCredential('PUBLIC_SYNTHETIC_QUESTION_SECRET_ONLY', 2);
  const ledger = new ModelLedger(db); ledger.batch('synthetic');
  const requests = [], runner = new WorkerRunner(db, vaults, new Ripgrep(rg), models, ledger, storage.directory, async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body); return model(body, requests.length - 1, init);
  });
  const conversations = new ConversationService(db, vaults, models), answers = new AnswerService(db, vaults);
  const questions = new QuestionService(db, vaults, models, conversations, answers, runner, ledger, storage.directory, 'synthetic');
  const ingestions = new IngestService(db, vaults, new IngestFiles(python, storage.directory, roots[1]));
  const runs = new RunService(db, vaults, ingestions, questions), conversation = conversations.create({ vaultId: connected.id });
  const sources = vaults.sources(connected.id, { limit: '50' }).items, a = sources.find(s => s.relativePath === 'allowed/a.md'), b = sources.find(s => s.relativePath === 'allowed/b.md');
  let stopped = false;
  const stop = async () => { if (stopped) return; stopped = true; await runs.close(); ingestions.close(); await vaults.close(); };
  t.after(async () => { await stop(); storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, vault, storage, db, vaults, models, ledger, runner, conversations, answers, questions, runs, ingestions, conversation, requests, a, b, stop,
    ask(text = '比较甲方案与乙方案', extra = {}, idempotencyKey = key()) {
      return runs.message(conversation.id, { text, scope: { mode: 'selected', paths: ['allowed/'] }, answerPolicy: 'vault_only', ...extra }, idempotencyKey);
    },
  };
}
async function completed(f, ref) {
  const deadline = Date.now() + 12000;
  for (;;) {
    const run = f.runs.get(ref.runId);
    if (['succeeded','failed','cancelled','interrupted'].includes(run.state)) return run;
    assert(Date.now() < deadline, 'question did not finish');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function reading(f, id, source = f.a) {
  return { id, name: 'vault_read', arguments: { sourceId: source.id, startLine: 1, maxLines: 2 } };
}

test('HTTP question publishes one atomic answer with real references, usage, replay and history', options, async t => {
  let f;
  f = await fixture(t, (body, round) => round === 0 ? response({ calls: [reading(f, 'a1'), reading(f, 'b1', f.b)] }) :
    response({ answer: { outcome: 'answered', blocks: [
      ...evidenceFrom(body).map((e,index) => ({ id: `record${index}`, kind: 'grounded', markdown: e.excerpt.trim(), evidenceIds: [e.id] })),
      { id: 'comparison', kind: 'inference', markdown: '两份记录的楼层不同，可能不是同一次记录，需要核对日期。', evidenceIds: evidenceFrom(body).map(e => e.id) }
    ], limitations: [] } }));
  const token = 'Q'.repeat(43), app = createApp(new BrowserSession(token), f.models, f.vaults, f.runs, f.questions);
  await app.listen({ host: '127.0.0.1', port: 0 }); t.after(() => app.close());
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const bootstrap = await fetch(origin + '/api/v1/bootstrap', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0], headers = { origin, cookie, 'content-type': 'application/json', 'idempotency-key': key() };
  const url = origin + `/api/v1/sessions/${f.conversation.id}/messages`, input = { text: '比较两份记录', answerPolicy: 'vault_only', scope: { mode: 'selected', paths: ['allowed'] } };
  const accepted = await fetch(url, { method: 'POST', headers, body: JSON.stringify(input) }); assert.equal(accepted.status, 202);
  const ref = (await accepted.json()).data, run = await completed(f, ref); assert.equal(run.state, 'succeeded', JSON.stringify(run.error));
  const replay = await fetch(url, { method: 'POST', headers, body: JSON.stringify(input) }); assert.equal((await replay.json()).data.runId, ref.runId);
  assert.equal(f.requests.length, 2); assert.equal(run.sessionId, f.conversation.id); assert.equal(run.usage.inputTokens, 1200); assert.equal(run.usage.toolCalls, 2);
  const result = await fetch(origin + `/api/v1/answers/${run.result.answerId}`, { headers: { cookie } });
  const view = (await result.json()).data; assert.equal(view.answer.citations.length, 2); assert.match(view.answer.markdown, /推断/);
  assert(view.citationStatus.every(c => c.status === 'current' && c.contentUrl.includes('expectedVersion=')));
  const events = f.db.prepare('SELECT type,payload_json FROM run_events WHERE run_id=? ORDER BY event_id').all(run.id);
  assert.equal(events.filter(e => e.type === 'answer.final').length, 1); assert.equal(events.at(-1).type, 'run.completed');
  assert.deepEqual(JSON.parse(events.find(e => e.type === 'answer.final').payload_json), { answerId: view.answer.id });
  const history = f.conversations.messages(f.conversation.id, {}); assert.equal(history.items.length, 1); assert.equal(history.items[0].answerId, view.answer.id);
  assert(!JSON.stringify(history).includes('session_file'));
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, 'idempotency-key': key() }, body: JSON.stringify({ ...input, forged: true }) })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, origin: 'https://invalid.example' }, body: JSON.stringify(input) })).status, 403);
  assert.equal((await fetch(origin + `/api/v1/answers/${view.answer.id}`)).status, 401);
});

test('native Pi continuation rereads evidence; changed files rebuild without old tool or assistant facts', options, async t => {
  let f, questionNumber = 0; const firstRequests = [];
  f = await fixture(t, body => {
    const afterUser = body.messages.slice(body.messages.findLastIndex(m => m.role === 'user') + 1);
    if (!afterUser.some(m => m.role === 'tool')) {
      questionNumber++; firstRequests.push(body);
      return response({ calls: [reading(f, `read${questionNumber}`)] });
    }
    return response({ answer: grounded(evidenceFrom(body).at(-1)) });
  });
  const first = await completed(f, f.ask()); assert.equal(first.state, 'succeeded', JSON.stringify(first.error));
  const firstSegment = f.conversations.get(f.conversation.id).activeSegmentId;
  const firstFile = f.db.prepare('SELECT session_file FROM session_segments WHERE id=?').get(firstSegment).session_file;
  const firstBytes = fs.readFileSync(path.join(f.storage.directory, firstFile));
  const second = await completed(f, f.ask('再比较刚才两种方案')); assert.equal(second.state, 'succeeded', JSON.stringify(second.error));
  const oldEvidence = f.db.prepare('SELECT id FROM evidence WHERE run_id=?').get(first.id).id;
  assert(!JSON.stringify(firstRequests[1]).includes(oldEvidence), 'historical citation IDs must not tempt the model to reuse old evidence');
  assert.equal(f.conversations.get(f.conversation.id).activeSegmentId, firstSegment);
  assert.deepEqual(fs.readFileSync(path.join(f.storage.directory, firstFile)), firstBytes, 'resuming must copy, never mutate the published session');
  assert.notEqual(f.answers.stored(first.result.answerId).citations[0].id, f.answers.stored(second.result.answerId).citations[0].id);
  fs.writeFileSync(path.join(f.vault, 'allowed/a.md'), '# 甲方案\n新事实甲：工具箱搬到四楼。\n');
  const third = await completed(f, f.ask('重新读取，再比较甲方案')); assert.equal(third.state, 'succeeded', JSON.stringify(third.error));
  assert.notEqual(f.conversations.get(f.conversation.id).activeSegmentId, firstSegment);
  assert.equal(f.conversations.messages(f.conversation.id, {}).items.length, 3);
  const historical = await f.answers.get(first.result.answerId); assert.match(historical.answer.markdown, /旧事实甲/); assert.equal(historical.citationStatus[0].status, 'changed');
  assert.equal(historical.citationStatus[0].contentUrl, null);
  assert.match(f.answers.stored(third.result.answerId).markdown, /新事实甲/);
  assert(firstRequests[1].messages.filter(m => m.role === 'user').length >= 2); assert(JSON.stringify(firstRequests[1]).includes('旧事实甲'));
  assert.equal(firstRequests[2].messages.filter(m => m.role === 'assistant').length, 0); assert(!JSON.stringify(firstRequests[2]).includes('旧事实甲'));
  assert.match(JSON.stringify(firstRequests[2].messages.findLast(m => m.role === 'user').content), /再比较/);
});

test('search snippets without citations invalidate continuation, and narrowed scope drops previous quoted questions', options, async t => {
  let f, round = 0;
  f = await fixture(t, body => {
    round++;
    if (round === 1) return response({ calls: [{ id: 'search1', name: 'vault_search', arguments: { terms: ['旧事实甲'] } }] });
    if (round === 2) return response();
    assert(!JSON.stringify(body).includes('旧事实甲')); assert.equal(body.messages.filter(m => m.role === 'assistant').length, 0);
    if (round === 4) assert.equal(body.messages.filter(m => m.role === 'user').length, 1);
    return response();
  });
  const first = await completed(f, f.ask('查一下甲方案')); assert.equal(first.state, 'succeeded');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM evidence WHERE run_id=?').get(first.id).n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM context_sources WHERE run_id=?').get(first.id).n, 1);
  fs.writeFileSync(path.join(f.vault, 'allowed/a.md'), '全新记录。\n');
  const second = await completed(f, f.ask('先前问题不再适用')); assert.equal(second.state, 'succeeded', JSON.stringify(second.error));
  const third = await completed(f, f.ask('只看乙方案', { scope: { mode: 'selected', paths: ['allowed/b.md'] } }));
  assert.equal(third.state, 'succeeded', JSON.stringify(third.error));
});

test('a long historical answer keeps its complete saved history while bounded context obtains fresh evidence', options, async t => {
  let f; const long = '这是两种公开方案的历史比较。\n\n' + '公开合成历史说明。'.repeat(1200);
  f = await fixture(t, (body, round) => {
    if (round === 0 || round === 2) {
      if (round === 2) { assert(body.messages.some(message => typeof message.content === 'string' && message.content.includes(long))); assert(!JSON.stringify(body).includes('部分正文及限制已省略')); }
      return response({ calls: [reading(f, `read_${round}`)] });
    }
    const answer = grounded(evidenceFrom(body).at(-1));
    if (round === 1) answer.blocks[0].markdown = long;
    return response({ answer });
  });
  const first = await completed(f, f.ask('比较两种公开方案')); assert.equal(first.state, 'succeeded', JSON.stringify(first.error));
  const second = await completed(f, f.ask('那它们目前的位置呢？')); assert.equal(second.state, 'succeeded', JSON.stringify(second.error));
  assert.equal(f.answers.stored(first.result.answerId).blocks[0].markdown, long);
  assert.notEqual(f.answers.stored(first.result.answerId).citations[0].id, f.answers.stored(second.result.answerId).citations[0].id);
});

test('history exceeding the worker envelope is packed before IPC and still obtains fresh evidence', { ...options, timeout: 60000 }, async t => {
  const long = 'public '.repeat(2800), answer = { outcome: 'answered', blocks: [{ id: 'b1', kind: 'general', markdown: long, evidenceIds: [] }], limitations: [] };
  let f;
  f = await fixture(t, (body, round) => {
    assert(Buffer.byteLength(JSON.stringify(body)) < 262144);
    if (round < 15) return response({ answer });
    if (round === 15) return response({ calls: [reading(f, 'fresh-after-long-history')] });
    return response({ answer: grounded(evidenceFrom(body).at(-1)) });
  });
  const ids = [];
  for (let i = 0; i < 15; i++) {
    const run = await completed(f, f.ask(`公开长答复 ${i}`, { answerPolicy: 'vault_first' }));
    assert.equal(run.state, 'succeeded', `round ${i}: ${JSON.stringify(run.error)}`); ids.push(run.result.answerId);
  }
  const final = await completed(f, f.ask('现在回查甲方案的原文', { answerPolicy: 'vault_first' }));
  assert.equal(final.state, 'succeeded', JSON.stringify(final.error));
  assert.equal(f.answers.stored(final.result.answerId).citations[0].sourceId, f.a.id);
  assert.equal(f.conversations.messages(f.conversation.id, {}).items.length, 16);
  for (const id of ids) assert.equal(f.answers.stored(id).blocks[0].markdown, long);
});

test('uploaded attachments guide follow-up reading across new and resumed sessions without becoming evidence', options, async t => {
  let f, uploaded, inspectOnly = false;
  f = await fixture(t, (body, round) => {
    if (inspectOnly) { assert(!JSON.stringify(body).includes(uploaded.id)); return response(); }
    if (round % 2 === 0) {
      assert(JSON.stringify(body).includes(uploaded.id));
      assert(JSON.stringify(body).includes('相同文件名.md'));
      return response({ calls: [reading(f, `attachment-${round}`, uploaded)] });
    }
    return response({ answer: grounded(evidenceFrom(body).at(-1)) });
  });
  for (let i = 0; i < 2; i++) {
    const stored = await completed(f, await f.runs.ingest({ vaultId: f.conversation.vaultId, input: { kind: 'upload', filePart: 'file' },
      conversation: { sessionId: f.conversation.id, text: '帮我入库' } }, key(), { filename: '相同文件名.md', bytes: Buffer.from(`公开附件内容 ${i}。\n`) }));
    assert.equal(stored.state, 'succeeded', JSON.stringify(stored.error));
    uploaded = f.vaults.source(stored.result.sourceId);
    const run = await completed(f, f.ask('刚才上传的这份文件讲了什么？', { scope: { mode: 'vault' } }));
    assert.equal(run.state, 'succeeded', JSON.stringify(run.error));
    assert.equal(f.answers.stored(run.result.answerId).citations[0].sourceId, uploaded.id);
  }
  const other = f.conversations.create({ vaultId: f.conversation.vaultId });
  inspectOnly = true;
  const original = f.runner.run.bind(f.runner);
  const captured = [];
  f.runner.run = (input, progress) => { captured.push(input.context.attachments); return original(input, progress); };
  // Other conversations and revoked scopes must not expose the uploaded identities.
  assert.equal((await completed(f, f.runs.message(other.id, { text: '什么文件？' }, key()))).state, 'succeeded');
  assert.deepEqual(captured.at(-1), []);
  assert.equal((await completed(f, f.ask('刚才的文件', { scope: { mode: 'selected', paths: ['allowed'] } }))).state, 'succeeded');
  assert.deepEqual(captured.at(-1), [{ state: 'unavailable' }, { state: 'unavailable' }]);
});

test('attachment hints preserve unavailable status without leaking excluded file identities', options, async t => {
  const f = await fixture(t, () => response());
  const stored = await completed(f, await f.runs.ingest({ vaultId: f.conversation.vaultId, input: { kind: 'upload', filePart: 'file' },
    conversation: { sessionId: f.conversation.id, text: '帮我入库' } }, key(), { filename: '附件状态.unknown', bytes: Buffer.from('公开状态样本') }));
  assert.equal(stored.state, 'succeeded');
  const source = f.vaults.source(stored.result.sourceId);
  const latestHint = async () => {
    const run = await completed(f, f.ask('刚才上传的文件能读了吗？', { scope: { mode: 'vault' } }));
    assert.equal(run.state, 'succeeded', JSON.stringify(run.error));
    return f.requests.at(-1).messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  };
  assert((await latestHint()).includes('"state":"unsupported"'));
  fs.unlinkSync(path.join(f.vault, source.relativePath)); await f.vaults.scan(f.conversation.vaultId);
  assert((await latestHint()).includes('"state":"missing"'));
  f.vaults.update(f.conversation.vaultId, { expectedRevision: f.vaults.get().revision, exclusions: ['助手资料/原件'] });
  const revoked = await latestHint(); assert(revoked.includes('"state":"unavailable"'));
  assert(!revoked.includes(source.id)); assert(!revoked.includes('附件状态.unknown'));
});

test('cancellation after candidate preparation rolls back answer, session pointer and final event', options, async t => {
  let f;
  f = await fixture(t, (body, round) => round === 0 ? response({ calls: [reading(f, 'cancel-read')] }) : response({ answer: grounded(evidenceFrom(body).at(-1)) }));
  const prepare = f.answers.prepare.bind(f.answers);
  f.answers.prepare = async (...args) => { const answer = await prepare(...args); f.runs.cancel(answer.runId); return answer; };
  const run = await completed(f, f.ask()); assert.equal(run.state, 'cancelled');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM answers').get().n, 0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM run_events WHERE type='answer.final'").get().n, 0);
  assert.equal(f.conversations.get(f.conversation.id).activeSegmentId, null); assert.equal(run.usage.modelRequests, 2);
});

test('stopping during tool, model, validation and just before final commit has one terminal and no published answer', { ...options, timeout: 30000 }, async t => {
  for (const phase of ['tool', 'model', 'validating', 'commit']) await t.test(phase, async child => {
    let f, runId;
    f = await fixture(child, (body, round) => {
      if (phase === 'model') { f.runs.cancel(runId); return response(); }
      return round === 0 ? response({ calls: [reading(f, 'stop-read')] }) : response({ answer: grounded(evidenceFrom(body).at(-1)) });
    });
    if (phase === 'tool') {
      const content = f.vaults.content.bind(f.vaults);
      f.vaults.content = async (...args) => { const result = await content(...args); f.runs.cancel(runId); return result; };
    } else if (phase === 'validating') {
      const prepare = f.answers.prepare.bind(f.answers);
      f.answers.prepare = async (...args) => { f.runs.cancel(runId); return prepare(...args); };
    } else if (phase === 'commit') {
      const execute = f.questions.execute.bind(f.questions);
      f.questions.execute = async (...args) => { const candidate = await execute(...args); f.runs.cancel(runId); return candidate; };
    }
    const ref = f.ask(); runId = ref.runId;
    const run = await completed(f, ref); assert.equal(run.state, 'cancelled');
    assert.equal(f.runs.cancel(runId).state, 'cancelled');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM answers').get().n, 0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM session_segments').get().n, 0);
    assert.equal(f.runs.events(runId, 0).items.filter(event => event.type === 'run.completed').length, 1);
    assert.equal(f.requests.length, ['tool', 'model'].includes(phase) ? 1 : 2);
  });
});

test('offline backup restores a real Pi session and history; explicit reconfiguration starts a safe new segment', options, async t => {
  const f = await fixture(t, () => response()), first = await completed(f, f.ask('PUBLIC_BACKUP_PREVIOUS_QUESTION'));
  assert.equal(first.state, 'succeeded');
  const history = f.conversations.messages(f.conversation.id, {}), segment = f.db.prepare('SELECT * FROM session_segments').get();
  const original = readSessionFile(f.storage.directory, segment.session_file, segment.session_hash).bytes;
  await f.stop(); f.storage.close(); const backup = path.join(f.directory, 'backup'), restored = path.join(f.directory, 'restored');
  const started = performance.now(); backupData(f.storage.directory, backup); restoreData(backup, restored);
  t.diagnostic(`Native Pi backup and restore: ${Math.round(performance.now() - started)} ms`);
  const store = openStorage(restored), db = store.db, vaults = new VaultService(db, new VaultFiles(python, [restored, fs.realpathSync(process.cwd())]));
  const models = new ModelSettings(db, { async write() {}, async read() { return 'PUBLIC_RESTORED_TEST_KEY'; }, async remove() {} });
  const ledger = new ModelLedger(db); ledger.recover(); const requests = [];
  const runner = new WorkerRunner(db, vaults, new Ripgrep(rg), models, ledger, restored, async (_url, init) => { requests.push(JSON.parse(init.body)); return response(); });
  const conversations = new ConversationService(db, vaults, models), answers = new AnswerService(db, vaults);
  const questions = new QuestionService(db, vaults, models, conversations, answers, runner, ledger, restored, 'synthetic');
  const runs = new RunService(db, vaults, undefined, questions);
  try {
    assert.deepEqual(readSessionFile(restored, segment.session_file, segment.session_hash).bytes, original);
    assert.deepEqual(conversations.messages(f.conversation.id, {}), history);
    assert.equal(answers.stored(first.result.answerId).id, first.result.answerId); assert.equal(requests.length, 0);
    assert.equal(models.view().credentialConfigured, false);
    await models.setCredential('PUBLIC_RESTORED_TEST_KEY', models.view().revision);
    const resumed = await completed({ runs }, runs.message(f.conversation.id, { text: '继续恢复后的会话', answerPolicy: 'vault_only', scope: { mode: 'selected', paths: ['allowed/'] } }, key()));
    assert.equal(resumed.state, 'succeeded', JSON.stringify(resumed.error)); assert.equal(requests.length, 1);
    assert.notEqual(conversations.get(f.conversation.id).activeSegmentId, segment.id);
    assert.deepEqual(readSessionFile(restored, segment.session_file, segment.session_hash).bytes, original);
  } finally { await runs.close(); await vaults.close(); store.close(); }
});

test('a file edit during generation prevents final publication even before a watcher scan', options, async t => {
  let f;
  f = await fixture(t, (body, round) => {
    if (!round) return response({ calls: [reading(f, 'race-read')] });
    const evidence = evidenceFrom(body).at(-1); fs.writeFileSync(path.join(f.vault, 'allowed/a.md'), '生成期间已修改。\n');
    return response({ answer: grounded(evidence) });
  });
  const run = await completed(f, f.ask()); assert.equal(run.state, 'failed'); assert(['SOURCE_CHANGED','CONTEXT_CHANGED'].includes(run.error.code));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM answers').get().n, 0); assert.equal(run.usage.modelRequests, 2);
});

test('conversation busy, duplicate payload conflict, queued cancel and unavailable action do not spend model calls', options, async t => {
  const f = await fixture(t, () => response()), idempotency = key(), ref = f.ask('第一问', {}, idempotency);
  assert.equal(f.ask('第一问', {}, idempotency).runId, ref.runId);
  assert.throws(() => f.ask('另一问', {}, idempotency), fails('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => f.ask('第三问'), fails('SESSION_BUSY'));
  f.runs.cancel(ref.runId); assert.equal(f.runs.get(ref.runId).state, 'cancelled');
  const unclear = await completed(f, f.ask('保存上面答案')); assert.equal(unclear.error.code, 'INTENT_UNCLEAR');
  assert.throws(() => f.ask('问', { scope: { mode: 'selected', paths: ['../outside'] } }), fails('BAD_REQUEST'));
  assert.equal(f.requests.length, 0); assert.equal(f.conversations.messages(f.conversation.id, {}).items.length, 2);
});

test('pre-upgrade request identities and session settings resume without duplicate runs or losing context', options, async t => {
  const f = await fixture(t, () => response()), identity = key();
  const first = f.ask('第一问', {}, identity); assert.equal((await completed(f, first)).state, 'succeeded');
  const row = f.db.prepare('SELECT input_json FROM messages WHERE run_id=?').get(first.runId);
  const legacy = { ...JSON.parse(row.input_json), answerPolicy: 'vault_only' };
  f.db.prepare('UPDATE messages SET input_json=? WHERE run_id=?').run(JSON.stringify(legacy), first.runId);
  f.db.prepare('UPDATE idempotency_records SET payload_hash=? WHERE key=?').run(createHash('sha256').update(JSON.stringify(legacy)).digest('hex'), identity);
  assert.equal(f.ask('第一问', { answerPolicy: undefined }, identity).runId, first.runId);
  assert.equal(f.ask('第一问', { answerPolicy: 'vault_only' }, identity).runId, first.runId);
  assert.throws(() => f.ask('修改后的问题', {}, identity), fails('IDEMPOTENCY_CONFLICT'));
  const segment = f.db.prepare('SELECT id,settings_json FROM session_segments').get();
  f.db.prepare('UPDATE session_segments SET settings_json=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(segment.settings_json), policy: 'vault_only' }), segment.id);
  assert.equal((await completed(f, f.ask('继续第二问'))).state, 'succeeded');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 2);
  assert.deepEqual(f.db.prepare('SELECT id FROM session_segments').all(), [{ id: segment.id }]);
  assert.equal(f.requests.length, 2);
  assert(JSON.stringify(f.requests.at(-1).messages).includes('第一问'));
});

test('worker blocks private local content and resumed history before search, then permits an automatic public retry', options, async t => {
  let f, turn = 0, outbound = [];
  f = await fixture(t, body => {
    if (body.query) { outbound.push(body.query); return Response.json({ results: [] }); }
    const step = turn++;
    if (step === 0) return response({ calls: [reading(f, 'private-read')] });
    if (step === 1 || step === 4) return response({ calls: [{ id: `private-${step}`, name: 'web_search', arguments: { query: '工具箱在三楼 最新', reason: '模拟受污染指令' } }] });
    if (step === 2 || step === 5) {
      const tool = JSON.parse(body.messages.at(-1).content); assert.equal(tool.ok, false); assert.equal(tool.error.code, 'SEARCH_PRIVACY_BLOCKED');
      return response({ calls: [{ id: `public-${step}`, name: 'web_search', arguments: { query: 'SKU definition', reason: '自动改为公开术语' } }] });
    }
    return response();
  });
  assert.equal((await completed(f, f.ask('根据我的笔记查证术语'))).state, 'succeeded');
  assert.equal((await completed(f, f.ask('继续查证'))).state, 'succeeded');
  assert.deepEqual(outbound, ['SKU definition', 'SKU definition']);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM search_attempts').get().n, 2);
});

test('formal answer checks ledger identity, quote location, original mapping and policy, including old run evidence', options, async t => {
  const f = await fixture(t, () => response()), runId = `r_${randomUUID()}`, now = new Date().toISOString();
  f.db.prepare("INSERT INTO runs(id,kind,vault_id,state,created_at,started_at,session_id) VALUES (?,'message',?,'running',?,?,?)")
    .run(runId, f.conversation.vaultId, now, now, f.conversation.id);
  const signal = new AbortController().signal;
  const gateway = new VaultToolSession(f.db, f.vaults, new Ripgrep(rg), { runId, vaultId: f.conversation.vaultId, scope: { mode: 'selected', paths: ['allowed'] },
    scopeRevision: f.vaults.get().revision, deadline: Date.now() + 100000, signal }); t.after(() => gateway.close());
  const result = await gateway.execute('vault_read', { sourceId: f.a.id, startLine: 1, maxLines: 2 }); assert.equal(result.ok, true);
  const evidence = result.data.evidence, body = JSON.stringify(evidence), draft = grounded(evidence);
  const context = { runId, sessionId: f.conversation.id, vaultId: f.conversation.vaultId, scope: { mode: 'selected', paths: ['allowed'] }, policy: 'vault_only', signal, check() {} };
  assert.equal((await f.answers.prepare(draft, context)).citations[0].excerpt, evidence.excerpt);
  for (const change of [e => { e.location.refersTo = 'extracted'; }, e => { e.location.startLine = 2; }, e => { e.originalLocator = { kind: 'page', page: 7 }; },
    e => { e.excerpt = '编造的摘录'; }, e => { e.origin = 'web_snapshot'; }, e => { e.runId = `r_${randomUUID()}`; }]) {
    const corrupt = structuredClone(evidence); change(corrupt);
    f.db.prepare('UPDATE evidence SET body_json=? WHERE id=?').run(JSON.stringify(corrupt), evidence.id);
    await assert.rejects(f.answers.prepare(draft, context), fails('CITATION_INVALID'));
  }
  f.db.prepare('UPDATE evidence SET body_json=? WHERE id=?').run(body, evidence.id);
  await assert.rejects(f.answers.prepare(draft, { ...context, runId: `r_${randomUUID()}` }), fails('CITATION_INVALID'));
  await assert.rejects(f.answers.prepare(draft, { ...context, scope: { mode: 'selected', paths: ['other'] } }), fails('CITATION_INVALID'));
  for (const blocks of [[{ ...draft.blocks[0], evidenceIds: [] }], [{ ...draft.blocks[0], kind: 'notice' }], [{ ...draft.blocks[0], markdown: '[假的来源](file:///etc/passwd)' }]]) {
    await assert.rejects(f.answers.prepare({ ...draft, blocks }, context), fails('CITATION_INVALID'));
  }
  const general = await f.answers.prepare({ ...draft, blocks: [{ id: 'b', kind: 'general', markdown: '通用建议', evidenceIds: [] }] }, { ...context, policy: 'vault_first' });
  assert.match(general.markdown, /模型回答/);
});

test('missing or tampered native session is preserved and fails without starting another model request', options, async t => {
  const f = await fixture(t, () => response());
  const first = await completed(f, f.ask('第一问')); assert.equal(first.state, 'succeeded');
  const segment = f.db.prepare('SELECT session_file FROM session_segments').get(), file = path.join(f.storage.directory, segment.session_file);
  fs.appendFileSync(file, '{"tampered":true}\n'); const bytes = fs.readFileSync(file);
  const second = await completed(f, f.ask('第二问')); assert.equal(second.state, 'failed'); assert.equal(second.error.code, 'SESSION_UNREADABLE');
  assert.equal(f.requests.length, 1); assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(f.db.prepare('SELECT count(*) AS n FROM answers').get().n, 1);
  const other = f.conversations.create({ vaultId: f.conversation.vaultId });
  f.db.prepare('UPDATE session_segments SET session_id=?').run(other.id);
  const third = await completed(f, f.ask('第三问')); assert.equal(third.state, 'failed'); assert.equal(third.error.code, 'SESSION_UNREADABLE');
  assert.equal(f.requests.length, 1, 'a mismatched database pointer must not load another conversation');
});

test('partial conversion keeps the original mapping and backend limitations even if the model omits them', options, async t => {
  let f, source;
  f = await fixture(t, (body, round) => {
    if (!round) return response({ calls: [reading(f, 'partial-read', source)] });
    const answer = grounded(evidenceFrom(body).at(-1)); answer.blocks[0].markdown = '页面包含公开正文。'; return response({ answer });
  });
  const original = path.join(f.vault, 'allowed/page.html'); fs.writeFileSync(original, '<h1>公开页面</h1><p>公开正文</p><img src="https://unread.invalid/image.png">');
  await f.vaults.scan(f.conversation.vaultId); source = f.vaults.sources(f.conversation.vaultId, { limit: '50' }).items.find(s => s.relativePath.endsWith('page.html'));
  await f.vaults.prepareSource(source.id); assert.equal(f.vaults.source(source.id).state, 'partial');
  const run = await completed(f, f.ask('页面说明什么？')); assert.equal(run.state, 'succeeded', JSON.stringify(run.error));
  const answer = f.answers.stored(run.result.answerId); assert.equal(answer.citations[0].sourceId, source.id);
  assert.equal(answer.citations[0].location.refersTo, 'extracted'); assert.equal(answer.citations[0].originalLocator, null);
  assert.match(answer.markdown, /提取文本/); assert(answer.limitations.length >= 1);
  assert(answer.limitations.includes(f.vaults.source(source.id).warnings[0].message));
  const derivative = path.join(f.vault, f.vaults.source(source.id).readableRepresentation.relativePath);
  fs.unlinkSync(original); assert(fs.existsSync(derivative));
  const history = await f.answers.get(answer.id); assert.equal(history.citationStatus[0].status, 'missing'); assert.equal(history.citationStatus[0].contentUrl, null);
  assert.deepEqual(history.answer, answer, 'history is not rewritten when a source disappears');
});

test('a final-event storage failure rolls back the answer and segment before recording failure', options, async t => {
  const f = await fixture(t, () => response());
  f.db.exec("CREATE TRIGGER refuse_answer_event BEFORE INSERT ON run_events WHEN NEW.type='answer.final' BEGIN SELECT RAISE(ABORT,'synthetic storage fault'); END");
  const run = await completed(f, f.ask()); assert.equal(run.state, 'failed'); assert.equal(run.error.code, 'SERVICE_UNAVAILABLE');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM answers').get().n, 0); assert.equal(f.db.prepare('SELECT count(*) AS n FROM session_segments').get().n, 0);
  assert.equal(f.conversations.get(f.conversation.id).activeSegmentId, null);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM run_events WHERE type='run.completed'").get().n, 1);
  assert.equal(run.usage.modelRequests, 1);
});

test('a settings or scope change at the commit boundary prevents publication and keeps the charged usage', options, async t => {
  for (const kind of ['model','scope','source']) await t.test(kind, async child => {
    let f;
    f = await fixture(child, (body, round) => round === 0 ? response({ calls: [reading(f, 'boundary-read')] }) : response({ answer: grounded(evidenceFrom(body).at(-1)) }));
    const prepare = f.answers.prepare.bind(f.answers);
    f.answers.prepare = async (...args) => {
      const answer = await prepare(...args);
      if (kind === 'model') await f.models.setModel({ provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' }, f.models.view().revision);
      else if (kind === 'scope') f.vaults.update(f.conversation.vaultId, { expectedRevision: f.vaults.get().revision, exclusions: ['allowed'] });
      else { fs.writeFileSync(path.join(f.vault, 'allowed/a.md'), '已在终稿检查时改变。\n'); await f.vaults.scan(f.conversation.vaultId); }
      return answer;
    };
    const run = await completed(f, f.ask()); assert.equal(run.state, 'failed'); assert.equal(run.error.code, 'CONTEXT_CHANGED');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM answers').get().n, 0); assert.equal(run.usage.modelRequests, 2);
  });
});

test('resumed native tool errors use the canonical charged result and never replay SDK diagnostics', options, async t => {
  const bodies = [];
  const f = await fixture(t, (body, round) => { bodies.push(body); return round === 0 ?
    response({ calls: [{ id: 'unknown1', name: 'unknown_tool', arguments: {} }] }) : response(); });
  assert.equal((await completed(f, f.ask('先检查状态'))).state, 'succeeded');
  assert.equal((await completed(f, f.ask('再看刚才结果'))).state, 'succeeded');
  const tool = bodies[1].messages.find(m => m.role === 'tool'); assert.equal(JSON.parse(tool.content).error.code, 'BAD_REQUEST');
  assert(!bodies[2].messages.some(m => m.role === 'tool'));
  assert(JSON.stringify(bodies[2]).includes('先检查状态')); assert(JSON.stringify(bodies[2]).includes('再看刚才结果'));
  assert(!tool.content.includes('not found')); assert(!tool.content.includes('schema'));
  assert.equal(f.db.prepare('SELECT sum(tool_calls) AS n FROM tool_usage').get().n, 1);
});

test('v9 upgrade and startup recovery preserve accounting while interrupting questions without reruns', async t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-v9-questions-'))), data = path.join(directory, 'data');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const old = openStorage(data, MIGRATIONS.slice(0, 9)), vaultId = `v_${randomUUID()}`, runId = `r_${randomUUID()}`, now = new Date().toISOString();
  old.db.prepare("INSERT INTO vaults(id,singleton,root_path,root_device,root_inode,exclusions_json) VALUES (?,1,?,'0','0','[]')").run(vaultId, path.join(directory, 'unused-vault'));
  old.db.prepare("INSERT INTO runs(id,kind,vault_id,state,created_at,started_at) VALUES (?,'message',?,'running',?,?)").run(runId, vaultId, now, now);
  const oldLedger = new ModelLedger(old.db); oldLedger.batch('migration', 4710); old.db.prepare('INSERT INTO model_runs(run_id,batch_id,deadline,limits_json) VALUES (?,?,?,?)').run(runId, 'migration', Date.now() + 120000, JSON.stringify(MODEL_LIMITS));
  // Seed the historical v9 shape directly; current accounting also stores per-model rates.
  old.db.prepare("INSERT INTO model_attempts(id,run_id,ordinal,state,input_reserved,output_limit,reserved_micro_yuan,created_at,payload_bytes,payload_hash) VALUES (?,?,1,'sent',32000,4096,96768,?,100,?)").run(randomUUID(), runId, now, 'a'.repeat(64)); old.close();
  const fresh = openStorage(data); t.after(() => fresh.close());
  assert.equal(fresh.db.pragma('user_version', { simple: true }), MIGRATIONS.length);
  const backupFile = fs.readdirSync(path.join(data, 'backups')).find(name => name.startsWith('schema-9-'));
  assert(backupFile);
  const backup = new Database(path.join(data, 'backups', backupFile), { readonly: true });
  try { assert.equal(backup.pragma('user_version', { simple: true }), 9); assert.equal(backup.prepare('SELECT state FROM model_attempts').get().state, 'sent'); }
  finally { backup.close(); }
  const ledger = new ModelLedger(fresh.db); ledger.recover();
  const runs = new RunService(fresh.db, {}, undefined, { ledger }); await runs.close();
  const run = runs.get(runId); assert.equal(run.state, 'interrupted'); assert.equal(run.usage.cost.basis, 'unknown'); assert.equal(run.usage.inputTokens, null);
  assert(ledger.batchTotals('migration').reservedMicroYuan > 0); assert.equal(ledger.batchTotals('migration').spentMicroYuan, 4710);
  assert.equal(fresh.db.prepare('SELECT count(*) AS n FROM model_attempts').get().n, 1); assert.equal(fresh.db.prepare('SELECT count(*) AS n FROM answers').get().n, 0);
});

test('Chinese continuation is sized as model context instead of rejecting UTF-8 bytes as tokens', options, async t => {
  const f = await fixture(t, () => response());
  const first = await completed(f, f.ask('长'.repeat(4500))); assert.equal(first.state, 'succeeded', JSON.stringify(first.error));
  const segment = f.conversations.get(f.conversation.id).activeSegmentId;
  const before = f.db.prepare('SELECT session_file,session_hash FROM session_segments WHERE id=?').get(segment);
  const second = await completed(f, f.ask('续'.repeat(4000))); assert.equal(second.state, 'succeeded', JSON.stringify(second.error));
  assert.equal(second.usage.modelRequests, 1); assert.equal(f.requests.length, 2);
  assert.notDeepEqual(f.db.prepare('SELECT session_file,session_hash FROM session_segments WHERE id=?').get(segment), before);
});

function selection(answer, text) {
  const start = answer.markdown.indexOf(text); assert(start >= 0);
  return { expectedAnswerRevision: answer.revision, selection: { start, end: start + text.length, expectedText: text } };
}

test('HTTP saves only the selected answer with provenance and deletes history without deleting saved material, memory or accounting', options, async t => {
  let f;
  f = await fixture(t, (body, round) => round === 0 ? response({ calls: [reading(f, 'read1')] }) : response({ answer: {
    outcome: 'answered', blocks: [
      { id: 'selected', kind: 'inference', markdown: '选中的推断：可能在三楼。', evidenceIds: evidenceFrom(body).map(e => e.id) },
      { id: 'unselected', kind: 'notice', markdown: 'UNSELECTED_不会入库的段落。', evidenceIds: [] },
    ], limitations: [] } }));
  const run = await completed(f, f.ask()); assert.equal(run.state, 'succeeded', JSON.stringify(run.error));
  const answer = f.answers.stored(run.result.answerId), input = selection(answer, '可能在三楼。');
  const token = 'H'.repeat(43), app = createApp(new BrowserSession(token), f.models, f.vaults, f.runs, f.questions);
  await app.listen({ host: '127.0.0.1', port: 0 }); t.after(() => app.close());
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const bootstrap = await fetch(origin + '/api/v1/bootstrap', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0], idempotencyKey = key();
  const headers = { origin, cookie, 'content-type': 'application/json', 'idempotency-key': idempotencyKey };
  const url = origin + `/api/v1/answers/${answer.id}/save`;
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, origin: 'https://outside.invalid' }, body: JSON.stringify(input) })).status, 403);
  const accepted = await fetch(url, { method: 'POST', headers, body: JSON.stringify(input) }); assert.equal(accepted.status, 202);
  const ref = (await accepted.json()).data, saved = await completed(f, ref); assert.equal(saved.state, 'succeeded', JSON.stringify(saved.error));
  assert.equal(saved.resolvedAction, 'save_answer'); assert.equal(f.requests.length, 2);
  const again = await fetch(url, { method: 'POST', headers, body: JSON.stringify(input) }); assert.equal((await again.json()).data.runId, ref.runId);
  const source = f.vaults.source(saved.result.sourceId), file = path.join(f.vault, source.relativePath), text = fs.readFileSync(file, 'utf8');
  assert.equal(source.origin, 'ai_saved'); assert.equal(source.state, 'ready');
  assert(text.includes('AI 整理')); assert(text.includes('推断')); assert(text.includes('\n\n可能在三楼。\n\n'));
  assert(!text.includes('UNSELECTED_')); assert(!text.includes('选中的推断：')); assert(!text.includes('旧事实甲'));
  assert(text.includes(f.a.version));
  const link = /\[原资料\]\(([^)]+)\)/.exec(text)[1];
  assert.equal(fs.realpathSync(path.resolve(path.dirname(file), decodeURIComponent(link))), path.join(f.vault, f.a.relativePath));
  const remembered = await completed(f, f.ask('记住：保留我明确保存的偏好。'));
  const memoryId = remembered.result.memoryId, before = f.ledger.batchTotals('synthetic');
  const workers = path.join(f.storage.directory, 'workers'); assert(fs.readdirSync(workers).some(name => name.startsWith(run.id)));
  const deleted = await fetch(origin + `/api/v1/sessions/${f.conversation.id}`, { method: 'DELETE', headers: { origin, cookie } });
  assert.equal(deleted.status, 200); assert.equal((await deleted.json()).data.deleted, true);
  assert.equal((await fetch(origin + `/api/v1/sessions/${f.conversation.id}`, { headers: { cookie } })).status, 404);
  assert.equal((await fetch(origin + `/api/v1/answers/${answer.id}`, { headers: { cookie } })).status, 404);
  assert.equal((await fetch(origin + `/api/v1/runs/${run.id}/events`, { headers: { cookie } })).status, 404);
  assert.equal(f.conversations.list({ vaultId: source.vaultId }).items.length, 0);
  for (const table of ['messages','session_segments','answers','evidence','tool_results','context_sources','run_events']) {
    assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, table);
  }
  assert.equal(fs.readdirSync(workers).length, 0); assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.equal(f.vaults.source(source.id).origin, 'ai_saved'); assert.equal(f.questions.memories.get(memoryId).sourceUserMessageId, null);
  assert.deepEqual(f.ledger.batchTotals('synthetic'), before); assert.equal(f.db.prepare('SELECT count(*) AS n FROM model_attempts').get().n, 2);
  assert.throws(() => f.runs.message(f.conversation.id, { text: '旧请求' }, key()), fails('NOT_FOUND'));
  assert.deepEqual(f.questions.deleteSession(f.conversation.id), { deleted: true });
});

test('partial-line citation labels survive selection and old stored reference text remains selectable', options, async t => {
  let f;
  f = await fixture(t, (body, round) => !round ? response({ calls: [{ id: 'part', name: 'vault_read', arguments: { sourceId: f.a.id, startLine: 1, maxLines: 75 } }] }) :
    response({ answer: { outcome: 'answered', blocks: [{ id: 'part', kind: 'grounded', markdown: '开头为公开片段。', evidenceIds: evidenceFrom(body).map(e => e.id) }], limitations: [] } }));
  fs.writeFileSync(path.join(f.vault, 'allowed/a.md'), '公开片段😀'.repeat(2000));
  await f.vaults.scan(f.conversation.vaultId);
  const run = await completed(f, f.ask()); assert.equal(run.state, 'succeeded');
  const answer = f.answers.stored(run.result.answerId);
  assert(answer.citations[0].location.endOffset > 0); assert.match(answer.markdown, /行内片段/);
  const selected = '资料 1（原文';
  assert.match((await f.answers.selection(answer.id, selection(answer, selected))).text, /行内片段/);
  answer.markdown = answer.markdown.replace('，行内片段', '');
  f.db.prepare('UPDATE answers SET body_json=? WHERE id=?').run(JSON.stringify(answer), answer.id);
  assert.match((await f.answers.selection(answer.id, selection(answer, selected))).text, /行内片段/);
  assert.equal(f.answers.stored(answer.id).markdown, answer.markdown);
});

test('answer selection validates revision, exact UTF-16 slice, payload and current sources without widening the selection', options, async t => {
  let f;
  f = await fixture(t, (body, round) => round === 0 ? response({ calls: [reading(f, 'read1')] }) : response({ answer: {
    outcome: 'answered', blocks: [{ id: 'b1', kind: 'grounded', markdown: '公开说明🪁：三楼。', evidenceIds: evidenceFrom(body).map(e => e.id) }], limitations: [] } }));
  const run = await completed(f, f.ask()), answer = f.answers.stored(run.result.answerId), input = selection(answer, '🪁：三楼。');
  await assert.rejects(f.runs.saveAnswer(answer.id, { ...input, expectedAnswerRevision: 2 }, key()), fails('REVISION_CONFLICT'));
  await assert.rejects(f.runs.saveAnswer(answer.id, { ...input, selection: { ...input.selection, expectedText: '改写的答案' } }, key()), fails('REVISION_CONFLICT'));
  await assert.rejects(f.runs.saveAnswer(answer.id, { ...input, selection: { ...input.selection, end: input.selection.end + 10000 } }, key()), fails('REVISION_CONFLICT'));
  await assert.rejects(f.runs.saveAnswer(answer.id, { ...input, selection: { start: input.selection.start, end: input.selection.start + 1, expectedText: '\ud83e' } }, key()), fails('BAD_REQUEST'));
  await assert.rejects(f.runs.saveAnswer(answer.id, { ...input, arbitraryPath: '../outside' }, key()), fails('BAD_REQUEST'));
  const referenceOnly = await f.answers.selection(answer.id, selection(answer, '资料 1（原文'));
  assert(referenceOnly.text.includes(f.a.version)); assert(!referenceOnly.text.includes('公开说明'));
  const saved = await completed(f, await f.runs.saveAnswer(answer.id, input, key())); assert.equal(saved.state, 'succeeded');
  assert(fs.readFileSync(path.join(f.vault, f.vaults.source(saved.result.sourceId).relativePath), 'utf8').includes('🪁：三楼。'));
  fs.writeFileSync(path.join(f.vault, f.a.relativePath), '新版本：一楼。');
  await assert.rejects(f.runs.saveAnswer(answer.id, input, key()), fails('SOURCE_CHANGED'));
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM sources WHERE origin='ai_saved'").get().n, 1);
});

test('saving a browser selection across formatted text and a citation writes only its visible words', options, async t => {
  let f;
  f = await fixture(t, (body, round) => round === 0 ? response({ calls: [reading(f, 'formatted-read')] }) : response({ answer: {
    outcome: 'answered', blocks: [
      { id: 'b1', kind: 'grounded', markdown: '**结论：** 选中的中文😀。', evidenceIds: evidenceFrom(body).map(e => e.id) },
      { id: 'b2', kind: 'notice', markdown: 'UNSELECTED_下一段。', evidenceIds: [] },
    ], limitations: [] } }));
  const run = await completed(f, f.ask()), answer = f.answers.stored(run.result.answerId);
  const start = answer.markdown.indexOf('结论：'), end = answer.markdown.indexOf('[资料 1]') + '[资料 1'.length;
  const input = { expectedAnswerRevision: answer.revision, selection: { start, end, expectedText: answer.markdown.slice(start, end) } };
  const saved = await completed(f, await f.runs.saveAnswer(answer.id, input, key())); assert.equal(saved.state, 'succeeded');
  const text = fs.readFileSync(path.join(f.vault, f.vaults.source(saved.result.sourceId).relativePath), 'utf8');
  assert(text.includes('\n\n结论： 选中的中文😀。 资料 1\n\n## 选段来源'));
  assert(!text.includes('**')); assert(!text.includes('/api/v1/')); assert(!text.includes('UNSELECTED_'));
  assert(text.includes('AI 整理')); assert(text.includes(f.a.version));
});

test('concurrent answer saves with one key publish one file, and cannot enqueue after history is deleted', options, async t => {
  const f = await fixture(t, () => response());
  const run = await completed(f, f.ask()), answer = f.answers.stored(run.result.answerId), input = selection(answer, '当前资料不足。'), idempotencyKey = key();
  const refs = await Promise.all([f.runs.saveAnswer(answer.id, input, idempotencyKey), f.runs.saveAnswer(answer.id, input, idempotencyKey)]);
  assert.equal(refs[0].runId, refs[1].runId); assert.equal((await completed(f, refs[0])).state, 'succeeded');
  await assert.rejects(f.runs.saveAnswer(answer.id, { ...input, title: '不同标题' }, idempotencyKey), fails('IDEMPOTENCY_CONFLICT'));
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM sources WHERE origin='ai_saved'").get().n, 1);
  const stage = f.ingestions.stage.bind(f.ingestions);
  f.ingestions.stage = async intake => { const staged = await stage(intake); f.questions.deleteSession(f.conversation.id); return staged; };
  await assert.rejects(f.runs.saveAnswer(answer.id, input, key()), fails('NOT_FOUND'));
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM sources WHERE origin='ai_saved'").get().n, 1);
});

test('deleting a queued or running chat requires stopping it and retains the charged reservation', options, async t => {
  let started; const began = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, () => { started(); return new Promise(() => {}); }), ref = f.ask();
  assert.throws(() => f.questions.deleteSession(f.conversation.id), fails('SESSION_BUSY'));
  await began; assert.throws(() => f.questions.deleteSession(f.conversation.id), fails('SESSION_BUSY'));
  f.runs.cancel(ref.runId); const run = await completed(f, ref); assert.equal(run.state, 'cancelled');
  const before = f.ledger.batchTotals('synthetic'); assert(before.reservedMicroYuan > 0);
  f.questions.deleteSession(f.conversation.id);
  assert.deepEqual(f.ledger.batchTotals('synthetic'), before); assert.equal(f.db.prepare('SELECT state FROM model_attempts').get().state, 'unknown');
});

test('history cleanup rejects a substituted worker directory and resumes a failed final transaction on startup', options, async t => {
  const f = await fixture(t, () => response()), run = await completed(f, f.ask());
  const workers = path.join(f.storage.directory, 'workers'), name = fs.readdirSync(workers)[0], worker = path.join(workers, name);
  const outside = path.join(f.directory, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep'), 'do not delete');
  fs.renameSync(worker, worker + '.held'); fs.symlinkSync(outside, worker);
  assert.throws(() => f.questions.deleteSession(f.conversation.id), fails('SESSION_UNREADABLE'));
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'do not delete');
  assert.throws(() => f.conversations.get(f.conversation.id), fails('NOT_FOUND'));
  assert.throws(() => f.runs.get(run.id), fails('NOT_FOUND'));
  fs.unlinkSync(worker); fs.renameSync(worker + '.held', worker);
  f.db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT,'synthetic deletion fault'); END");
  assert.throws(() => f.questions.deleteSession(f.conversation.id));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM messages').get().n, 1);
  assert.equal(f.db.prepare('SELECT deletion_state FROM conversations').get().deletion_state, 'deleting');
  f.db.exec('DROP TRIGGER fail_delete');
  new QuestionService(f.db, f.vaults, f.models, f.conversations, f.answers, f.runner, f.ledger, f.storage.directory, 'synthetic');
  assert.equal(f.db.prepare('SELECT deletion_state FROM conversations').get().deletion_state, 'deleted');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM messages').get().n, 0); assert.equal(fs.readdirSync(workers).length, 0);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'do not delete');
});

test('retrieving an explicitly saved answer retains the AI-derived origin and mandatory limitation', options, async t => {
  let f, savedSource;
  f = await fixture(t, (body, round) => round === 0 ? response() : round === 1 ?
    response({ calls: [reading(f, 'saved1', savedSource)] }) : response({ answer: grounded(evidenceFrom(body).at(-1)) }));
  const first = await completed(f, f.ask()), answer = f.answers.stored(first.result.answerId);
  const saved = await completed(f, await f.runs.saveAnswer(answer.id, selection(answer, '当前资料不足。'), key()));
  savedSource = f.vaults.source(saved.result.sourceId);
  const asked = await completed(f, f.ask('此前的整理有什么结论？', { scope: { mode: 'vault' } }));
  assert.equal(asked.state, 'succeeded', JSON.stringify(asked.error));
  const derived = f.answers.stored(asked.result.answerId);
  assert.equal(derived.citations[0].origin, 'ai_saved'); assert(derived.limitations.some(text => text.includes('派生内容')));
});

test('partial answer is observable before completion and cancelled text survives history without a final answer', options, async t => {
  let controller;
  const f = await fixture(t, () => new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { 'content-type': 'text/event-stream' } }));
  const ref = f.ask('公开流式问题');
  const deadline = Date.now() + 10000;
  while (!controller) { assert(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)); }
  controller.enqueue(Buffer.from('data: ' + JSON.stringify({ model: 'deepseek-flash-SYNTHETIC', choices: [{ index: 0,
    delta: { content: '{"outcome":"insufficient_evidence","blocks":[{"id":"b1","kind":"notice","markdown":"未完成的公开回答' }, finish_reason: null }] }) + '\n\n'));
  while (!f.runs.get(ref.runId).preview) { assert(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(f.runs.get(ref.runId).state, 'running');
  assert.equal(f.runs.get(ref.runId).preview, '未完成的公开回答');
  assert(f.runs.events(ref.runId, 0).items.some(event => event.type === 'answer.preview'));
  f.runs.cancel(ref.runId); const run = await completed(f, ref);
  assert.equal(run.state, 'cancelled'); assert.equal(run.usage.inputTokens, null);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM answers WHERE run_id=?').get(ref.runId).n, 0);
  assert.equal(f.runs.get(ref.runId).preview, '未完成的公开回答');
  f.db.prepare("UPDATE runs SET ended_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(ref.runId);
  f.runs.events(ref.runId, 0);
  assert.equal(f.runs.get(ref.runId).preview, '未完成的公开回答', 'history outlives the short event-replay window');
  f.questions.deleteSession(f.conversation.id);
  assert.equal(f.db.prepare('SELECT preview_text FROM runs WHERE id=?').get(ref.runId).preview_text, null);
});

test('OpenAI-compatible configuration completes tool retrieval, validated citations, streaming and usage with its own price', options, async t => {
  let f;
  f = await fixture(t, (body, round) => {
    assert.equal(body.model, 'public-chat'); assert.equal(body.thinking, undefined); assert.equal(body.reasoning_effort, undefined);
    assert.equal(body.stream_options.include_usage, true);
    return round === 0 ? response({ calls: [reading(f, 'compat_read')] }) : response({ answer: grounded(evidenceFrom(body)[0]) });
  });
  let profiles = await f.models.saveProfile({ name: '公开兼容测试', provider: 'openai-compatible', baseUrl: 'https://public-chat.example/v1',
    model: 'public-chat', modelIds: ['public-chat'], pricing: { input: 3, output: 11 }, apiKey: 'PUBLIC_SYNTHETIC_COMPATIBLE_SECRET', expectedRevision: f.models.view().revision });
  const added = profiles.profiles.find(profile => profile.provider === 'openai-compatible'); f.models.activateProfile(added.id, profiles.revision);
  const ref = f.ask('公开兼容提问'), run = await completed(f, ref);
  assert.equal(run.state, 'succeeded', JSON.stringify(run.error)); assert.equal(run.usage.inputTokens, 1200); assert.equal(run.usage.outputTokens, 200);
  assert.equal(run.usage.cost.value, 0.0058); assert.equal(run.usage.toolCalls, 1);
  const answer = await f.answers.get(run.result.answerId); assert.equal(answer.citationStatus[0].status, 'current');
  assert(f.runs.events(ref.runId, 0).items.some(event => event.type === 'answer.preview'));
});


test('official OpenAI endpoint uses max_completion_tokens and omits DeepSeek-specific fields', options, async t => {
  const f = await fixture(t, body => {
    assert.equal(body.max_tokens, undefined); assert.equal(body.max_completion_tokens, 8192); assert.equal(body.thinking, undefined);
    return response();
  });
  const profiles = await f.models.saveProfile({ name: '公开 OpenAI 协议测试', provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1',
    model: 'public-chat', modelIds: ['public-chat'], pricing: { input: 1, output: 2 }, apiKey: 'PUBLIC_SYNTHETIC_OPENAI_SECRET_ONLY', expectedRevision: f.models.view().revision });
  f.models.activateProfile(profiles.profiles.find(p => p.provider === 'openai-compatible').id, profiles.revision);
  const run = await completed(f, f.ask()); assert.equal(run.state, 'succeeded', JSON.stringify(run.error));
});

test('knowledge-first searches locally then adds separately validated web citations and preserves saved provenance', options, async t => {
  let f;
  f = await fixture(t, (body, round) => {
    if (body.query) { assert.equal(round, 2); assert.deepEqual(Object.keys(body).sort(), ['count','need_content','query']);
      return Response.json({ results: [{ title: 'SKU definition', url: 'https://example.com/sku', content: 'SKU means stock keeping unit.', date: null }] }); }
    assert.equal(body.tools?.length, 5);
    if (round === 0) return response({ calls: [reading(f, 'local_read')] });
    if (round === 1) return response({ calls: [{ id: 'search_web', name: 'web_search', arguments: { query: 'SKU definition', reason: '已读资料只记位置，没有解释术语。' } }] });
    const local = evidenceFrom(body)[0], web = body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content)).find(r => r.data?.kind === 'web_search').data.results[0];
    return response({ answer: { outcome: 'answered', blocks: [
      { id: 'web', kind: 'web', markdown: 'SKU 是库存单位，用来区分具体商品规格。', evidenceIds: [web.id] },
      { id: 'local', kind: 'grounded', markdown: '资料记录工具箱在三楼。', evidenceIds: [local.id] },
    ], limitations: [] } });
  });
  const run = await completed(f, f.ask('SKU 是什么？顺便说明资料中的位置。', { answerPolicy: 'vault_first' }));
  assert.equal(run.state, 'succeeded', JSON.stringify(run.error)); assert.equal(run.usage.modelRequests, 3); assert.equal(run.usage.searchRequests, 1);
  assert.equal(run.usage.cost.value, (3 * 2000 + 5000) / 1e6);
  const view = await f.answers.get(run.result.answerId), answer = view.answer;
  assert.equal(answer.citations.length, 1); assert.equal(answer.webCitations.length, 1);
  assert.match(answer.markdown, /\[网页 1\]\(https:\/\/example.com\/sku\)/); assert.match(answer.markdown, /\[资料 1\]/);
  const selected = answer.blocks[0].markdown, start = answer.markdown.indexOf(selected);
  const saved = await f.answers.selection(answer.id, { expectedAnswerRevision: 1, selection: { start, end: start + selected.length, expectedText: selected } });
  assert.match(saved.text, /网页补充/); assert.match(saved.text, /https:\/\/example.com\/sku/); assert.match(saved.text, /非全文核查/);
  const reloaded = new AnswerService(f.db, f.vaults).stored(answer.id);
  assert.deepEqual(reloaded.webCitations, answer.webCitations);
  const context = { runId: run.id, sessionId: f.conversation.id, vaultId: f.conversation.vaultId, scope: { mode: 'vault' }, policy: 'vault_first', signal: new AbortController().signal, check() {} };
  const forged = structuredClone(answer); forged.blocks[0].evidenceIds = [`e_${randomUUID()}`];
  const draft = a => ({ outcome: a.outcome, blocks: a.blocks, limitations: a.limitations });
  await assert.rejects(f.answers.prepare(draft(forged), context), fails('CITATION_INVALID'));
  const swapped = structuredClone(answer); swapped.blocks[0].kind = 'grounded';
  await assert.rejects(f.answers.prepare(draft(swapped), context), fails('CITATION_INVALID'));
  assert.equal((await f.answers.prepare(draft(answer), context)).webCitations.length, 1);
});

test('failed web search keeps the local answer, explicit failure and held maximum without inventing a source', options, async t => {
  let f;
  f = await fixture(t, (body, round) => {
    if (body.query) throw new Error('synthetic connection reset');
    if (round === 0) return response({ calls: [reading(f, 'local')] });
    if (round === 1) return response({ calls: [{ id: 'web', name: 'web_search', arguments: { query: 'SKU definition', reason: '术语定义未找到' } }] });
    return response({ answer: grounded(evidenceFrom(body)[0]) });
  });
  const run = await completed(f, f.ask('SKU 是什么？', { answerPolicy: 'vault_first' }));
  assert.equal(run.state, 'succeeded', JSON.stringify(run.error));
  const { answer } = await f.answers.get(run.result.answerId);
  assert.equal(answer.citations.length, 1); assert.equal(answer.webCitations, undefined);
  assert.match(answer.limitations.join('\n'), /联网搜索未成功/);
  assert.equal(f.ledger.totals(run.id).reservedMicroYuan, 5000); assert.equal(run.usage.cost.value, null);
});

test('questions about notes retain local citations without unnecessary web requests', options, async t => {
  let f, call = 0;
  f = await fixture(t, body => {
    assert(!body.query, 'unnecessary web search');
    if (call++ === 0) return response({ calls: [reading(f, 'local')] });
    return response({ answer: grounded(evidenceFrom(body)[0]) });
  });
  const run = await completed(f, f.ask('我的笔记里工具箱在哪？', { answerPolicy: 'vault_first' }));
  assert.equal(run.state, 'succeeded', JSON.stringify(run.error)); assert.equal(run.usage.searchRequests, undefined);
  assert.equal((await f.answers.get(run.result.answerId)).answer.citations.length, 1);
});

test('stopping during web search aborts the request and retains its maximum without publishing an answer', options, async t => {
  let f, searching = false, aborted = false;
  f = await fixture(t, (body, round, init) => {
    if (body.query) { searching = true; return new Promise((_resolve, reject) => {
      const stop = () => { aborted = true; reject(new Error('cancelled public test')); };
      if (init.signal.aborted) stop(); else init.signal.addEventListener('abort', stop, { once: true });
    }); }
    if (round === 0) return response({ calls: [reading(f, 'local')] });
    return response({ calls: [{ id: 'web', name: 'web_search', arguments: { query: 'SKU definition', reason: 'definition missing' } }] });
  });
  const ref = f.ask('SKU 是什么？', { answerPolicy: 'vault_first' });
  const deadline = Date.now() + 5000;
  while (!searching) { assert(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)); }
  f.runs.cancel(ref.runId); const run = await completed(f, ref);
  assert.equal(run.state, 'cancelled'); assert(aborted); assert.equal(f.db.prepare('SELECT count(*) n FROM answers').get().n, 0);
  assert.equal(f.ledger.totals(run.id).reservedMicroYuan, 5000); assert.equal(f.requests.filter(b => b.query).length, 1);
});

test('general questions and follow-ups complete without retrieval and preserve current and legacy saved selections', options, async t => {
  const draft = { outcome: 'answered', blocks: [{ id: 'general', kind: 'general', markdown: 'SKU 是库存管理中区分具体商品规格的单位。', evidenceIds: [] }], limitations: [] };
  const f = await fixture(t, body => { assert(!body.query);
    return response({ answer: { ...draft, blocks: draft.blocks.map(({ evidenceIds, ...block }) => block) } }); });
  for (const question of ['SKU是什么？', '同一种商品的不同颜色怎么区分？']) {
    const run = await completed(f, f.ask(question, { answerPolicy: 'vault_first' }));
    assert.equal(run.state, 'succeeded', JSON.stringify(run.error));
    assert.equal(run.usage.modelRequests, 1); assert.equal(run.usage.toolCalls, 0); assert.equal(run.usage.searchRequests, undefined);
    const answer = (await f.answers.get(run.result.answerId)).answer;
    assert.equal(answer.outcome, 'answered'); assert.deepEqual(answer.citations, []); assert.equal(answer.webCitations, undefined);
    assert.deepEqual(answer.limitations, []); assert.match(answer.markdown, /模型回答/);
    for (const legacy of [false, true]) {
      if (legacy) { answer.markdown = answer.markdown.replace('**模型回答：** ', '**通用补充（非资料结论）：** ');
        f.db.prepare('UPDATE answers SET body_json=? WHERE id=?').run(JSON.stringify(answer), answer.id); }
      const selected = draft.blocks[0].markdown, start = answer.markdown.indexOf(selected);
      const saved = await f.answers.selection(answer.id, { expectedAnswerRevision: 1, selection: { start, end: start + selected.length, expectedText: selected } });
      assert.match(saved.text, /模型回答（未引用来源）/); assert(saved.text.includes(selected));
      assert.equal(f.answers.stored(answer.id).markdown, answer.markdown);
    }
  }
  const get = f.vaults.get, sources = f.vaults.sources;
  f.vaults.get = () => assert.fail('general-only answer should not inspect unrelated vault status');
  f.vaults.sources = () => assert.fail('general-only answer should not enumerate unrelated sources');
  try {
    const answer = await f.answers.prepare(draft, { runId: `r_${randomUUID()}`, sessionId: f.conversation.id,
      vaultId: f.conversation.vaultId, scope: { mode: 'vault' }, policy: 'vault_first', signal: new AbortController().signal, check() {} });
    assert.deepEqual(answer.limitations, []);
  } finally { f.vaults.get = get; f.vaults.sources = sources; }
});

test('current public facts can search the web directly without opening the knowledge base', options, async t => {
  const f = await fixture(t, (body, round) => {
    if (body.query) return Response.json({ results: [{ title: '公开演示发布说明', url: 'https://example.com/releases', content: '这是用于测试的发布说明。', date: null }] });
    if (round === 0) return response({ calls: [{ id: 'current_web', name: 'web_search', arguments: { query: 'public release notes', reason: '用户明确要求核实当前公开信息' } }] });
    const result = body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content)).find(r => r.data?.kind === 'web_search');
    assert(result?.ok); assert.equal(evidenceFrom(body).length, 0);
    return response({ answer: { outcome: 'answered', blocks: [{ id: 'web', kind: 'web', markdown: '公开演示发布说明已取得。', evidenceIds: [result.data.results[0].id] }], limitations: [] } });
  });
  const run = await completed(f, f.ask('请联网核实当前公开发布说明。', { answerPolicy: 'vault_first' }));
  assert.equal(run.state, 'succeeded', JSON.stringify(run.error)); assert.equal(run.usage.toolCalls, 1); assert.equal(run.usage.searchRequests, 1);
  const answer = (await f.answers.get(run.result.answerId)).answer;
  assert.equal(answer.citations.length, 0); assert.equal(answer.webCitations.length, 1);
});

test('legacy request fields cannot re-enable the removed mode and automatic web search needs no confirmation', options, async t => {
  const f = await fixture(t, (body, round) => {
    if (body.query) return Response.json({ results: [] });
    assert.equal(body.tools.length, 5);
    if (round === 0) return response({ calls: [{ id: 'auto_web', name: 'web_search', arguments: { query: 'SKU', reason: '公开术语查证' } }] });
    assert.equal(JSON.parse(body.messages.at(-1).content).ok, true);
    return response({ answer: { outcome: 'answered', blocks: [{ id: 'g', kind: 'general', markdown: 'SKU 是商品单位。', evidenceIds: [] }], limitations: ['本次搜索没有结果。'] } });
  });
  const run = await completed(f, f.ask('请查证 SKU 定义', { answerPolicy: 'vault_only' }));
  assert.equal(run.state, 'succeeded', JSON.stringify(run.error)); assert.equal(run.usage.searchRequests, 1);
  assert.equal((await f.answers.get(run.result.answerId)).answer.blocks[0].kind, 'general');
});

test('general answers work without scanning the vault and allow Markdown links and HTML examples as content', options, async t => {
  const prose = '示例链接 [公开页面](https://example.com)\n\n```html\n<div>示例</div>\n```';
  const f = await fixture(t, () => response({ answer: { outcome: 'answered', blocks: [{ id: 'b', kind: 'general', markdown: prose, evidenceIds: [] }], limitations: [] } }));
  f.vaults.scan = async () => { throw new ApiError('BUDGET_EXCEEDED'); };
  const run = await completed(f, f.ask('解释这个 HTML 示例', { answerPolicy: 'vault_first' }));
  assert.equal(run.state, 'succeeded', JSON.stringify(run.error));
  const answer = (await f.answers.get(run.result.answerId)).answer;
  assert.equal(answer.blocks[0].markdown, prose); assert.equal(answer.citations.length, 0);
  assert.throws(() => f.conversations.normalize({ text: '中'.repeat(6000) }), fails('QUESTION_TOO_LONG'));
});


test('source changes rebuild more than six complete recent questions and over four kilobytes', { ...options, timeout: 60000 }, async t => {
  let f;
  const questions = Array.from({ length: 8 }, (_, i) => `QUESTION-${i}：` + '公开历史问题。'.repeat(50));
  f = await fixture(t, (body, round) => {
    if (round === 0) return response({ calls: [reading(f, 'initial-read')] });
    if (round === 9) { const text = JSON.stringify(body); for (const q of questions) assert(text.includes(q)); }
    return response();
  });
  for (const q of questions) { const run = await completed(f, f.ask(q)); assert.equal(run.state, 'succeeded', JSON.stringify(run.error)); }
  fs.writeFileSync(path.join(f.vault, 'allowed/a.md'), '变更后的公开资料。\n');
  const run = await completed(f, f.ask('继续比较前面的问题。'));
  assert.equal(run.state, 'succeeded', JSON.stringify(run.error)); assert.equal(f.requests.length, 10);
});
