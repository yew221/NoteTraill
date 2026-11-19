import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { openStorage } from '../dist/server/storage.js';
import { VaultFiles } from '../dist/server/vault-files.js';
import { VaultService } from '../dist/server/vaults.js';
import { Ripgrep } from '../dist/server/ripgrep.js';
import { ModelSettings } from '../dist/server/model-settings.js';
import { ModelLedger } from '../dist/server/model-ledger.js';
import { WorkerRunner } from '../dist/server/worker-runner.js';
import { ApiError } from '../dist/server/contracts.js';
import { isAnswerDraft, parseAnswerDraft } from '../dist/shared/answer.js';

const python = process.env.NOTETRAIL_PYTHON ?? path.join(os.homedir(), '.local/share/uv/tools/markitdown/bin/python');
const rg = process.env.NOTETRAIL_RG ?? ['/opt/homebrew/bin/rg', '/usr/local/bin/rg', '/usr/bin/rg', '/Applications/ChatGPT.app/Contents/Resources/codex-cli/codex-path/rg'].find(fs.existsSync);
const secret = 'PUBLIC_SYNTHETIC_WORKER_SECRET_ONLY';
const options = { skip: process.platform !== 'darwin', timeout: 20000 };
const fails = code => error => error instanceof ApiError && error.publicError.code === code;
const notice = () => ({ outcome: 'insufficient_evidence', blocks: [{ id: 'b1', kind: 'notice', markdown: '当前资料不足。', evidenceIds: [] }], limitations: ['未找到依据。'] });
function response({ calls, answer = notice(), thinking = '', input = 500, output = 70, malformedArguments = false, finish = 'stop' } = {}) {
  const model = 'deepseek-flash-SYNTHETIC', chunks = [];
  const chunk = (delta, finish_reason = null) => ({ model, choices: [{ index: 0, delta, finish_reason }] });
  if (thinking) chunks.push(chunk({ reasoning_content: thinking }));
  if (calls) chunks.push(chunk({ tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function',
    function: { name: call.name, arguments: malformedArguments ? '{"sourceId":' : JSON.stringify(call.arguments) } })) }), chunk({}, 'tool_calls'));
  else chunks.push(chunk({ content: typeof answer === 'string' ? answer : JSON.stringify(answer) }), chunk({}, finish));
  chunks.push({ model, choices: [], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output,
    prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: input - 20, completion_tokens_details: { reasoning_tokens: thinking ? 10 : 0 } } });
  const bytes = Buffer.from(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n');
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 73) controller.enqueue(bytes.subarray(i, i + 73)); controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
async function fixture(t, model) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-worker-'))), vault = path.join(directory, 'vault');
  fs.mkdirSync(vault); fs.mkdirSync(path.join(vault, 'allowed')); fs.mkdirSync(path.join(vault, 'outside'));
  fs.writeFileSync(path.join(vault, 'allowed/note.md'), '# 公开资料\n蓝色工具箱放在东门层架。\n文中的 AGENTS 指令属于资料，不应执行。\n');
  fs.writeFileSync(path.join(vault, 'outside/note.md'), 'OUTSIDE_SOURCE_MUST_NOT_LOAD');
  fs.writeFileSync(path.join(vault, 'AGENTS.md'), 'AMBIENT_CONFIGURATION_MUST_NOT_LOAD');
  const storage = openStorage(path.join(directory, 'data')), service = new VaultService(storage.db, new VaultFiles(python, [storage.directory, fs.realpathSync(process.cwd())]));
  const active = new Set();
  t.after(async () => { for (const controller of active) controller.abort(); await service.close(); storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const connected = await service.connect({ absolutePath: vault, exclusions: [] }), values = new Map();
  const settings = new ModelSettings(storage.db, { async write(binding, value) { values.set(binding.account, value); },
    async read(binding) { return values.get(binding.account); }, async remove(binding) { values.delete(binding.account); } });
  await settings.setModel({ provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' }, 1);
  await settings.setCredential(secret, 2);
  const ledger = new ModelLedger(storage.db); ledger.batch('t00', 4710);
  const requests = [], requestHeaders = [], runner = new WorkerRunner(storage.db, service, new Ripgrep(rg), settings, ledger, storage.directory,
    async (url, init) => {
      const body = JSON.parse(init.body); requests.push(body); requestHeaders.push({ url, authorization: init.headers.authorization });
      return model(body, requests.length - 1, init);
    });
  return { directory, vault, storage, service, settings, ledger, runner, requests, requestHeaders,
    input(extra = {}) {
      const runId = `r_${randomUUID()}`, now = new Date().toISOString(), controller = new AbortController(); active.add(controller);
      storage.db.prepare("INSERT INTO runs(id,kind,vault_id,state,created_at,started_at) VALUES (?,'message',?,'running',?,?)")
        .run(runId, connected.id, now, now);
      return { runId, vaultId: connected.id, scope: { mode: 'selected', paths: ['allowed/'] }, scopeRevision: service.get(connected.id).revision,
        deadline: Date.parse(now) + 120000, signal: controller.signal, controller, generation: 1, sessionId: `c_${randomUUID()}`, segmentId: `seg_${randomUUID()}`,
        question: '蓝色工具盒收在哪儿？', policy: 'vault_only', preferences: [], thinking: 'off', batchId: 't00', modelRevision: settings.view().revision, ...extra };
    },
  };
}

test('AnswerDraft parsing refuses prose, unknown fields, forged id formats and duplicate blocks', () => {
  assert(isAnswerDraft(notice())); assert(parseAnswerDraft('```json\n' + JSON.stringify(notice()) + '\n```'));
  for (const value of ['Plain answer', '{broken}', JSON.stringify({ ...notice(), citations: [] }), JSON.stringify({ ...notice(), blocks: [] }),
    JSON.stringify({ ...notice(), blocks: [notice().blocks[0], notice().blocks[0]] }),
    JSON.stringify({ ...notice(), blocks: [{ ...notice().blocks[0], evidenceIds: ['invented'] }] })]) assert.equal(parseAnswerDraft(value), null);
});

test('only source-free model blocks may omit an empty evidence list', () => {
  for (const kind of ['general', 'notice']) {
    const block = { id: 'b1', kind, markdown: '公开概念说明' };
    const draft = { outcome: 'answered', blocks: [block], limitations: [] };
    assert(!isAnswerDraft(draft));
    assert.deepEqual(parseAnswerDraft(JSON.stringify(draft)).blocks[0].evidenceIds, []);
    for (const invalid of [{ ...block, evidenceIds: null }, { ...block, evidenceIds: ['invented'] }, { ...block, extra: true }]) {
      assert.equal(parseAnswerDraft(JSON.stringify({ ...draft, blocks: [invalid] })), null);
    }
  }
  for (const kind of ['grounded', 'inference', 'web']) {
    assert.equal(parseAnswerDraft(JSON.stringify({ outcome: 'answered', blocks: [{ id: 'b1', kind, markdown: '有依据的说法' }], limitations: [] })), null);
  }
});

test('real isolated Pi process searches synonyms, reads actual evidence and returns only an uncommitted candidate', options, async t => {
  let evidence;
  const f = await fixture(t, (body, round) => {
    const last = body.messages.findLast(m => m.role === 'tool');
    const result = last ? JSON.parse(last.content) : null;
    if (round === 3) assert.deepEqual(result.data.matches, []);
    const actions = [ ['vault_list', {}], ['vault_status', {}], ['vault_search', { terms: ['工具盒'] }],
      ['vault_search', { terms: ['工具箱'] }], ['vault_read', round === 4 ? { sourceId: result.data.matches[0].sourceId,
        expectedVersion: result.data.matches[0].version, startLine: result.data.matches[0].line, maxLines: 1 } : {}] ];
    if (round < 5) return response({ calls: [{ id: `call_${round}`, name: actions[round][0], arguments: actions[round][1] }] });
    evidence = result.data.evidence;
    return response({ answer: { outcome: 'answered', blocks: [{ id: 'b1', kind: 'grounded', markdown: evidence.excerpt.trim(), evidenceIds: [evidence.id] }], limitations: [] } });
  });
  const input = f.input(), stages = [], result = await f.runner.run(input, event => stages.push(event));
  assert.equal(result.draft.blocks[0].markdown, '蓝色工具箱放在东门层架。'); assert.equal(result.draft.blocks[0].evidenceIds[0], evidence.id);
  assert.equal(result.usage.modelRequests, 6); assert.equal(result.usage.toolCalls, 5); assert.equal(result.usage.inputTokens, 3000);
  assert.equal(result.usage.outputTokens, 420); assert.equal(result.usage.costMicroYuan, 9360); assert(result.usage.readBytes > 1000);
  assert.equal(f.storage.db.prepare('SELECT state FROM runs WHERE id=?').get(input.runId).state, 'running');
  assert.equal(f.storage.db.prepare('SELECT count(*) n FROM evidence').get().n, 1);
  assert(stages.some(s => s.stage === 'searching') && stages.some(s => s.stage === 'reading') && stages.some(s => s.stage === 'validating'));
  for (const request of f.requests) {
    assert.equal(request.model, 'deepseek-flash'); assert.equal(request.thinking.type, 'disabled'); assert(request.max_tokens <= 8192);
    if (request.tool_choice === 'none') assert.equal(request.tools, undefined);
    else assert.deepEqual(request.tools.map(t => t.function.name).sort(), ['vault_list','vault_read','vault_search','vault_status','web_search']);
    for (const marker of ['AMBIENT_CONFIGURATION_MUST_NOT_LOAD','OUTSIDE_SOURCE_MUST_NOT_LOAD', secret]) assert(!JSON.stringify(request).includes(marker));
    const toolIds = new Set(request.messages.flatMap(m => m.tool_calls ?? []).map(call => call.id));
    for (const tool of request.messages.filter(m => m.role === 'tool')) assert(toolIds.has(tool.tool_call_id));
  }
  assert(!f.requests.at(-1).messages.filter(m => m.role === 'tool').some(m => JSON.parse(m.content).data?.matches));
  assert(f.requestHeaders.every(h => h.url === 'https://api.deepseek.com/chat/completions' && h.authorization === `Bearer ${secret}`));
  const native = fs.readFileSync(path.join(f.storage.directory, result.sessionFile), 'utf8');
  assert(native.includes('蓝色工具箱')); assert(native.includes(evidence.id)); assert(!native.includes(secret));
  assert.equal(fs.statSync(path.join(f.storage.directory, result.sessionFile)).mode & 0o777, 0o600);
  assert.throws(() => process.kill(result.workerPid, 0), error => error.code === 'ESRCH');
});

test('long Chinese source reads leave room for a final answer without dropping lines or evidence', options, async t => {
  let source; const excerpts = [];
  const f = await fixture(t, (body, round) => {
    assert.equal(body.temperature, 0);
    assert.equal(body.tools.find(tool => tool.function.name === 'vault_read').function.parameters.properties.maxLines.maximum, undefined);
    if (round === 0) return response({ calls: [1, 101].map((startLine, index) => ({
      id: `read_${index}`, name: 'vault_read', arguments: { sourceId: source.id, startLine, maxLines: 32 },
    })) });
    for (const message of body.messages.filter(m => m.role === 'tool')) {
      const result = JSON.parse(message.content); assert(result.ok); assert(result.truncated);
      const e = result.data.evidence;
      assert.equal(e.excerpt, lines.slice(e.location.startLine - 1, e.location.endLine).join(''));
      assert.equal(result.data.nextLine, e.location.endLine + 1); excerpts.push(e);
    }
    return response({ answer: { outcome: 'answered', blocks: [{ id: 'b', kind: 'grounded',
      markdown: '两段记录均说明这是公开合成验收资料。', evidenceIds: excerpts.map(e => e.id) }], limitations: ['只读取了两个片段。'] } });
  });
  const lines = Array.from({ length: 300 }, (_, i) => `${i + 1}：这是公开合成验收资料，记录的编号与原文应保持对应。${'中文长文资料。'.repeat(12)}\n`);
  fs.writeFileSync(path.join(f.vault, 'allowed/long.md'), lines.join(''));
  const input = f.input(); await f.service.scan(input.vaultId);
  source = f.service.sources(input.vaultId, {}).items.find(s => s.relativePath === 'allowed/long.md');
  input.scopeRevision = f.service.get(input.vaultId).revision;
  const answer = await f.runner.run(input);
  assert.equal(answer.usage.modelRequests, 2); assert.equal(excerpts.length, 2);
  assert.deepEqual(answer.draft.blocks[0].evidenceIds, excerpts.map(e => e.id));
});

test('SDK-rejected arguments and unknown tools count and return only sanitized bounded errors', options, async t => {
  const f = await fixture(t, (body, round) => {
    if (round === 0) return response({ calls: [
      { id: 'unknown_tool', name: 'bash', arguments: { command: 'UNTRUSTED_TOOL_ARGUMENT' } },
      { id: 'invalid_read', name: 'vault_read', arguments: { sourceId: 'invalid', startLine: 1 } },
      { id: 'valid_status', name: 'vault_status', arguments: {} },
    ] });
    const results = body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
    assert.equal(results.length, round === 1 ? 3 : 4); assert.equal(results[0].error.code, 'BAD_REQUEST'); assert.equal(results[1].error.code, 'BAD_REQUEST'); assert(results[2].ok);
    if (round === 1) return response({ calls: [{ id: 'more_status', name: 'vault_status', arguments: {} }] });
    return response();
  });
  const result = await f.runner.run(f.input()); assert.equal(result.usage.modelRequests, 3); assert.equal(result.usage.toolCalls, 4);
  const textBytes = f.requests[2].messages.filter(m => m.role === 'tool').reduce((n, m) => n + Buffer.byteLength(m.content), 0);
  assert.equal(result.usage.readBytes, textBytes); assert.equal(f.storage.db.prepare('SELECT count(*) n FROM evidence').get().n, 0);
  const persisted = f.storage.db.prepare('SELECT tool_calls,read_bytes FROM tool_usage').get();
  assert.deepEqual(persisted, { tool_calls: 4, read_bytes: textBytes });
});

test('extended retrieval leaves two final/repair opportunities within the cost ceiling', options, async t => {
  const f = await fixture(t, (body, round) => {
    if (body.tool_choice === 'none') { assert.equal(round, 14); return response(); }
    return response({ calls: [{ id: `status_${round}`, name: 'vault_status', arguments: {} }] });
  });
  const answer = await f.runner.run(f.input());
  assert.equal(answer.usage.modelRequests, 15); assert.equal(f.requests.at(-1).tool_choice, 'none');
});

test('growing evidence triggers an early final answer while every read excerpt remains available', options, async t => {
  let source;
  const f = await fixture(t, (body, round) => {
    const evidence = body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content).data?.evidence).filter(Boolean);
    if (body.tool_choice === 'none') {
      assert(round > 1 && round < 14); assert.equal(evidence.length, round * 2); assert.equal(body.tools, undefined);
      assert(evidence.every(e => e.excerpt === lines.slice(e.location.startLine - 1, e.location.endLine).join('')));
      return response({ answer: { outcome: 'answered', blocks: [{ id: 'b', kind: 'grounded', markdown: '各段均为公开合成记录。', evidenceIds: evidence.map(e => e.id) }], limitations: ['只核对已读取的片段。'] } });
    }
    return response({ calls: [0, 1].map(i => ({ id: `read_${round}_${i}`, name: 'vault_read', arguments: { sourceId: source.id, startLine: 1 + round * 40 + i * 20, maxLines: 20 } })) });
  });
  const lines = Array.from({ length: 300 }, (_, i) => `${i + 1} 公开合成记录。${'正文需要原样保留。'.repeat(8)}\n`);
  fs.writeFileSync(path.join(f.vault, 'allowed/growing.md'), lines.join('')); const input = f.input();
  await f.service.scan(input.vaultId); input.scopeRevision = f.service.get(input.vaultId).revision;
  source = f.service.sources(input.vaultId, {}).items.find(s => s.relativePath === 'allowed/growing.md');
  const answer = await f.runner.run(input); assert(answer.usage.modelRequests < 6);
});

test('many long selected paths are only a bounded preview and cannot consume the first model request', options, async t => {
  const f = await fixture(t, () => response());
  await f.runner.run(f.input());
  const baselineBytes = Buffer.byteLength(JSON.stringify(f.requests[0]));
  const scope = { mode: 'selected', paths: Array.from({ length: 50 }, (_, i) => `allowed/${'directory/'.repeat(70)}${i}.md`) };
  const answer = await f.runner.run(f.input({ scope }));
  assert.equal(answer.usage.modelRequests, 1); assert(JSON.stringify(f.requests[1]).includes('omittedPaths'));
  // Bound the scope contribution independently of the product's shared instructions.
  assert(Buffer.byteLength(JSON.stringify(f.requests[1])) - baselineBytes < 2500);
  assert(!JSON.stringify(f.requests[1]).includes(scope.paths.at(-1)));
});

test('tool and model attempt ceilings stop the actual worker without publishing an answer', options, async t => {
  const f = await fixture(t, () => response({ calls: Array.from({ length: 21 }, (_, i) => ({ id: `call_${i}`, name: 'vault_status', arguments: {} })) }));
  const input = f.input(); await assert.rejects(f.runner.run(input), fails('MODEL_PROTOCOL_ERROR')); assert.equal(f.requests.length, 1);
  assert.equal(f.storage.db.prepare('SELECT tool_calls FROM tool_usage').get().tool_calls, 21);
  assert.equal(f.storage.db.prepare('SELECT count(*) n FROM evidence').get().n, 0);
  const g = await fixture(t, (_body, round) => response({ calls: [{ id: `call_${round}`, name: 'vault_status', arguments: {} }] }));
  const capped = g.input(); await assert.rejects(g.runner.run(capped), fails('MODEL_PROTOCOL_ERROR'));
  assert.equal(g.requests.at(-1).tool_choice, 'none');
  assert.equal(g.requests.length, 15); assert.equal(g.ledger.totals(capped.runId).modelRequests, 15);
});

test('low thinking is replayed within a tool loop and counted in total output', options, async t => {
  const thought = 'SYNTHETIC_REASONING_FOR_PROTOCOL_CHECK';
  const f = await fixture(t, (body, round) => {
    assert.equal(body.thinking.type, 'enabled'); assert.equal(body.reasoning_effort, 'low');
    if (round === 0) return response({ thinking: thought, calls: [{ id: 'status', name: 'vault_status', arguments: {} }] });
    assert.equal(body.messages.findLast(m => m.role === 'assistant').reasoning_content, thought);
    return response({ thinking: thought });
  });
  const result = await f.runner.run(f.input({ thinking: 'low' })); assert.equal(result.usage.outputTokens, 140); assert.equal(result.usage.modelRequests, 2);
});

test('cancellation and credential revision change stop real worker processes while retaining unknown charges', options, async t => {
  for (const reason of ['cancel', 'configuration']) {
    let begin; const sent = new Promise(resolve => { begin = resolve; });
    const f = await fixture(t, async () => { begin(); return new Promise(() => {}); }), input = f.input();
    const running = f.runner.run(input); await sent;
    await assert.rejects(f.runner.run(f.input()), fails('SESSION_BUSY'));
    if (reason === 'cancel') input.controller.abort();
    else await f.settings.setCredential('PUBLIC_REPLACEMENT_WORKER_SECRET', f.settings.view().revision);
    await assert.rejects(running, fails(reason === 'cancel' ? 'RUN_INTERRUPTED' : 'CONTEXT_CHANGED'));
    assert.equal(f.requests.length, 1); assert.equal(f.ledger.totals(input.runId).costMicroYuan, null); assert(f.ledger.batchTotals('t00').reservedMicroYuan > 0);
    assert.equal(f.storage.db.prepare('SELECT count(*) n FROM evidence').get().n, 0);
  }
});

test('malformed final text and failed authentication do not become AnswerCandidates', options, async t => {
  const f = await fixture(t, () => response({ answer: '未经解析的任意正文' }));
  const input = f.input(); await assert.rejects(f.runner.run(input), fails('MODEL_PROTOCOL_ERROR')); assert.equal(f.requests.length, 3);
  assert.equal(f.ledger.totals(input.runId).costMicroYuan, 4680);
  const g = await fixture(t, () => new Response(secret, { status: 401 }));
  const failed = g.input(); await assert.rejects(g.runner.run(failed), fails('MODEL_AUTH_FAILED'));
  assert.equal(g.ledger.totals(failed.runId).costMicroYuan, null); assert.equal(g.requests.length, 1);
  const files = fs.readdirSync(path.join(g.storage.directory, 'workers', `${failed.runId}-1`, 'sessions'));
  for (const name of files) assert(!fs.readFileSync(path.join(g.storage.directory, 'workers', `${failed.runId}-1`, 'sessions', name), 'utf8').includes(secret));
});

test('duplicate tool identifiers are counted but no repeated operation is authorized', options, async t => {
  const f = await fixture(t, () => response({ calls: [0, 1].map(() => ({ id: 'same', name: 'vault_status', arguments: {} })) }));
  const input = f.input(); await assert.rejects(f.runner.run(input), fails('MODEL_PROTOCOL_ERROR'));
  assert.equal(f.requests.length, 1); assert.deepEqual(f.storage.db.prepare('SELECT tool_calls,read_bytes FROM tool_usage').get(), { tool_calls: 2, read_bytes: 0 });
});

test('a partial JSON argument repaired by the SDK cannot turn into an authorized tool operation', options, async t => {
  const f = await fixture(t, () => response({ malformedArguments: true, calls: [{ id: 'partial', name: 'vault_status', arguments: {} }] }));
  const input = f.input(); await assert.rejects(f.runner.run(input), fails('MODEL_PROTOCOL_ERROR'));
  assert.equal(f.requests.length, 1); assert.deepEqual(f.storage.db.prepare('SELECT tool_calls,read_bytes FROM tool_usage').get(), { tool_calls: 1, read_bytes: 0 });
  assert.equal(f.ledger.totals(input.runId).costMicroYuan, 1560);
});

test('stale or foreign IPC requests are rejected, and a non-cooperating child is reaped', options, async t => {
  const f = await fixture(t, () => { throw new Error('No network request should be authorized.'); });
  for (const variant of ['version', 'run', 'generation', 'unreserved', 'ignore_abort']) {
    const script = path.join(f.directory, `${variant}.mjs`), input = f.input();
    fs.writeFileSync(script, `
      process.send({ projectProtocolVersion: 1, type: 'Ready' });
      process.on('message', m => {
        if (m.type === 'Abort') { ${variant === 'ignore_abort' ? 'return;' : 'process.exit(0);'} }
        if (m.type !== 'RunStart') return;
        const request = { projectProtocolVersion: 1, type: 'Request', runId: m.runId, generation: m.generation,
          id: 1, operation: 'tool', data: { id: 'unreserved' } };
        ${variant === 'version' ? 'request.projectProtocolVersion = 2;' : variant === 'run' ? "request.runId = 'foreign';" : variant === 'generation' ? 'request.generation++;' : ''}
        process.send(request);
      });
      setInterval(() => {}, 1000);
    `);
    const child = fork(script, [], { execArgv: [], env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, stdio: ['ignore','ignore','ignore','ipc'] });
    const abort = new AbortController();
    const start = { projectProtocolVersion: 1, type: 'RunStart', runId: input.runId, generation: input.generation,
      deadline: Date.now() + 5000, question: input.question, policy: input.policy, preferences: [], thinking: 'off', sessionId: input.sessionId, segmentId: input.segmentId };
    // Exercise the parent IPC boundary with a real adversarial child, without opening the production worker to arbitrary entrypoints.
    await assert.rejects(f.runner.drive(child, start, input.modelRevision, {}, {}, abort, abort.signal, () => {}), fails('MODEL_PROTOCOL_ERROR'));
    assert.throws(() => process.kill(child.pid, 0), error => error.code === 'ESRCH');
  }
  assert.equal(f.requests.length, 0);
});

test('75-line reads and two bounded answer repairs retain current evidence and one logical user entry', options, async t => {
  let source, actual;
  const f = await fixture(t, (body, round) => {
    if (!round) return response({ calls: [{ id: 'read75', name: 'vault_read', arguments: { sourceId: source.id, startLine: 1, maxLines: 75 } }] });
    actual = body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content).data?.evidence).find(Boolean);
    assert(actual, 'repair must preserve the current read'); assert.equal(actual.location.endLine, 75);
    const evidenceId = round === 1 ? source.id : round === 2 ? `e_${randomUUID()}` : actual.id;
    return response({ answer: { outcome: 'answered', blocks: [{ id: 'b1', kind: 'grounded', markdown: '第 75 行的公开编号是 FINAL_75。', evidenceIds: [evidenceId] }], limitations: [] } });
  });
  fs.writeFileSync(path.join(f.vault, 'allowed/资料[1].md'), Array.from({ length: 100 }, (_, i) => `${i + 1}: ${i === 74 ? 'FINAL_75' : '公开合成记录'}\n`).join(''));
  const input = f.input(); await f.service.scan(input.vaultId); source = f.service.sources(input.vaultId, {}).items.find(s => s.relativePath.endsWith('资料[1].md'));
  const result = await f.runner.run(input);
  assert.equal(result.usage.modelRequests, 4); assert.deepEqual(result.draft.blocks[0].evidenceIds, [actual.id]);
  const entries = fs.readFileSync(path.join(f.storage.directory, result.sessionFile), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(entries.filter(e => e.type === 'message' && e.message.role === 'user').length, 1);
});

test('oversized Unicode line can be continued and both precise excerpts pass citation validation', options, async t => {
  let source, first, second;
  const f = await fixture(t, (body, round) => {
    const evidence = body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
    if (!round) return response({ calls: [{ id: 'long1', name: 'vault_read', arguments: { sourceId: source.id, startLine: 1, maxLines: 75 } }] });
    if (round === 1) {
      first = evidence[0].data;
      assert.equal(first.nextLine, 1); assert(first.nextOffset > 0);
      return response({ calls: [{ id: 'long2', name: 'vault_read', arguments: { sourceId: source.id, startLine: first.nextLine, startOffset: first.nextOffset, maxLines: 75, expectedVersion: source.version } }] });
    }
    second = evidence.at(-1).data;
    return response({ answer: { outcome: 'answered', blocks: [{ id: 'b', kind: 'grounded', markdown: '公开文本末尾编号 END_UNICODE。', evidenceIds: [first.evidence.id, second.evidence.id] }], limitations: [] } });
  });
  const text = '中😀'.repeat(3000) + 'END_UNICODE\n'; fs.writeFileSync(path.join(f.vault, 'allowed/long.md'), text);
  const input = f.input(); await f.service.scan(input.vaultId); source = f.service.sources(input.vaultId, {}).items.find(s => s.relativePath.endsWith('long.md'));
  await f.runner.run(input); assert.equal(first.evidence.excerpt + second.evidence.excerpt, text);
  assert.equal(second.nextLine, null);
});


test('a truncated final answer is shortened within unchanged output caps and its first usage stays settled', options, async t => {
  const f = await fixture(t, (_body, round) => round === 0 ? response({ answer: '{"outcome":"answered",', finish: 'length', output: 4096 }) : response());
  const result = await f.runner.run(f.input());
  assert.equal(result.usage.modelRequests, 2); assert.equal(result.usage.outputTokens, 4166);
  assert(f.requests.every(p => p.max_tokens <= 8192));
  assert.equal(f.ledger.batchTotals('t00').reservedMicroYuan, 0);
});


test('a longer final answer survives worker validation and publication', options, async t => {
  const markdown = 'Public explanation. '.repeat(1100);
  const draft = { outcome: 'answered', blocks: [{ id: 'b1', kind: 'general', markdown, evidenceIds: [] }], limitations: [] };
  const f = await fixture(t, body => { assert.equal(body.max_tokens, 8192); return response({ answer: draft, output: 6000 }); });
  const result = await f.runner.run(f.input({ policy: 'vault_first' }));
  assert.equal(result.draft.blocks[0].markdown, markdown); assert.equal(result.usage.outputTokens, 6000);
});
