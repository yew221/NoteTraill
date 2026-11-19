import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopClient } from '../src/desktop/client.mjs';
import { requestRoute } from '../src/desktop/bridge.mjs';
import { newId } from '../dist/server/contracts.js';
import { desktopQuestions } from './fixtures/desktop-questions.mjs';

const options = { timeout: 30_000 };
async function setup(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-desktop-questions-')));
  const f = await desktopQuestions(directory);
  t.after(async () => { await f.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  const { origin, bootstrapToken } = f.connection;
  const response = await fetch(origin + '/api/v1/bootstrap', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: bootstrapToken }) });
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const client = new DesktopClient(origin, cookie);
  const session = await client.request({ op: 'createSession', input: { vaultId: f.vault.id, title: '桌面问题' } });
  return { ...f, directory, origin, cookie, client, session,
    ask: (input = {}, key = randomUUID()) => client.request({ op: 'ask', sessionId: session.id, key,
      input: { text: '蓝盒放在哪里？', action: 'ask', scope: { mode: 'selected', paths: ['notes.md'] }, answerPolicy: 'vault_only', ...input } }) };
}
async function until(read, predicate) {
  const deadline = Date.now() + 15_000;
  for (;;) { const value = await read(); if (predicate(value)) return value; assert(Date.now() < deadline, 'timed out'); await new Promise(resolve => setTimeout(resolve, 30)); }
}
const terminal = run => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.state);

test('desktop writes accept only explicit Q&A, validated scopes and named cancellation', () => {
  const sessionId = newId('session'), runId = newId('run'), key = randomUUID();
  const valid = { op: 'ask', sessionId, key, input: { text: '问题', action: 'ask' } };
  assert.throws(() => requestRoute({ op: 'modelBudget' }), { code: 'BAD_REQUEST' });
  assert.throws(() => requestRoute({ op: 'saveModelBudget', input: {} }), { code: 'BAD_REQUEST' });
  assert.equal(requestRoute(valid).method, 'POST');
  assert.equal(requestRoute({ op: 'cancel', runId }).path, `/api/v1/runs/${runId}/cancel`);
  assert.equal(requestRoute({ ...valid, input: { text: '记住：回答简洁', action: 'auto' } }).method, 'POST');
  for (const input of [{ text: '问题' }, { text: '问题', action: 'remember' },
    { text: '', action: 'ask' }, { text: '问题', action: 'ask', actionInput: undefined },
    { text: '问题', action: 'ask', scope: { mode: 'selected', paths: ['../secret'] } },
    { text: '问题', action: 'ask', scope: { mode: 'selected', paths: [] } }]) assert.throws(() => requestRoute({ ...valid, input }), { code: 'BAD_REQUEST' });
  for (const request of [{ ...valid, key: 'bad' }, { ...valid, url: 'https://example.com' }, { op: 'cancel', runId, method: 'GET' },
    { op: 'citation', answerId: newId('answer'), evidenceId: newId('evidence'), path: '/secret' }]) assert.throws(() => requestRoute(request), { code: 'BAD_REQUEST' });
});

test('retired budget endpoints cannot read or change legacy monetary limits', options, async t => {
  const f = await setup(t);
  for (const method of ['GET', 'PUT']) {
    const response = await fetch(f.origin + '/api/v1/model/budget', { method,
      headers: { origin: f.origin, cookie: f.cookie, ...(method === 'PUT' ? { 'content-type': 'application/json' } : {}) },
      ...(method === 'PUT' ? { body: JSON.stringify({ expectedRevision: 1, questionMicroYuan: 1, pauseMicroYuan: 1, totalMicroYuan: 1, reviewed: true }) } : {}) });
    assert.equal(response.status, 404);
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM budget_settings').get().n, 0);
});

test('desktop asks, deduplicates, follows up, restores history and reads verified original lines', options, async t => {
  const f = await setup(t), key = randomUUID();
  const [ref, replay] = await Promise.all([f.ask({}, key), f.ask({}, key)]); assert.equal(replay.runId, ref.runId);
  const run = await until(() => f.client.request({ op: 'run', runId: ref.runId }), terminal);
  assert.equal(run.state, 'succeeded', JSON.stringify(run.error)); assert.equal(f.requests.length, 2);
  const answer = await f.client.request({ op: 'answer', answerId: run.result.answerId });
  const evidenceId = answer.answer.citations[0].id;
  const citation = await f.client.request({ op: 'citation', answerId: answer.answer.id, evidenceId });
  assert.equal(citation.status, 'current'); assert.equal(citation.evidence.location.startLine, 2); assert.match(citation.text, /蓝盒在北柜第二层/);
  assert.equal(citation.text.split('\n').slice(1, 3).join('\n') + '\n', citation.evidence.excerpt);
  await assert.rejects(f.client.request({ op: 'citation', answerId: answer.answer.id, evidenceId: newId('evidence') }), { code: 'NOT_FOUND' });
  const second = await f.ask({ text: '再核对一下交接时间' });
  const secondRun = await until(() => f.client.request({ op: 'run', runId: second.runId }), terminal); assert.equal(secondRun.state, 'succeeded', JSON.stringify(secondRun.error));
  const history = await f.client.request({ op: 'messages', sessionId: f.session.id });
  assert.equal(history.items.length, 2); assert(history.items.every(message => message.answerId));
  assert.deepEqual(history.items[0].scope, { mode: 'selected', paths: ['notes.md'] });
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 0);
});

test('desktop cancels active generation, never publishes a cancelled answer and retains unsettled accounting without blocking the next question', options, async t => {
  const f = await setup(t), ref = await f.ask({ text: '停止测试 STOP_TEST' });
  await until(async () => f.requests.length, n => n > 0);
  await f.client.request({ op: 'cancel', runId: ref.runId });
  const run = await until(() => f.client.request({ op: 'run', runId: ref.runId }), terminal);
  assert.equal(run.state, 'cancelled'); assert.equal(run.result, null);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM answers WHERE run_id=?').get(ref.runId).n, 0);
  const again = await f.client.request({ op: 'cancel', runId: ref.runId }); assert.equal(again.state, 'cancelled');
  const next = await f.ask(); const nextRun = await until(() => f.client.request({ op: 'run', runId: next.runId }), terminal);
  assert.equal(nextRun.state, 'succeeded'); assert.equal(f.requests.length, 3);
  assert.equal(f.db.prepare("SELECT state FROM model_attempts WHERE run_id=?").get(ref.runId).state, 'unknown');
});

test('chat ingestion binds idempotency to its conversation and rolls back when the session is busy or missing', options, async t => {
  const f = await setup(t), upload = { name: '会话入库.md', bytes: Buffer.from('# 公开附件\n聊天上传的正文。\n') };
  const input = { vaultId: f.vault.id, input: { kind: 'upload', filePart: 'file' }, conversation: { sessionId: f.session.id, text: '帮我入库' } };
  const key = randomUUID(), request = { op: 'ingest', input, upload, key };
  const [ref, replay] = await Promise.all([f.client.request(request), f.client.request(request)]);
  assert.equal(ref.runId, replay.runId);
  const run = await until(() => f.client.request({ op: 'run', runId: ref.runId }), terminal);
  assert.equal(run.state, 'succeeded'); assert.equal(f.requests.length, 0);
  await assert.rejects(f.client.request({ ...request, input: { ...input, conversation: { ...input.conversation, text: '收藏' } } }), { code: 'IDEMPOTENCY_CONFLICT' });
  const second = await f.client.request({ op: 'createSession', input: { vaultId: f.vault.id, title: '另一对话' } });
  await assert.rejects(f.client.request({ ...request, input: { ...input, conversation: { ...input.conversation, sessionId: second.id } } }), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(f.client.request({ ...request, key: randomUUID(), input: { ...input, conversation: { ...input.conversation, sessionId: newId('session') } } }), { code: 'NOT_FOUND' });
  const before = f.vaults.sources(f.vault.id, { limit: '50' }).items.length;
  const active = await f.ask({ text: 'STOP_TEST' });
  await until(() => f.requests.length, n => n > 0);
  await assert.rejects(f.client.request({ ...request, key: randomUUID() }), { code: 'SESSION_BUSY' });
  assert.equal(f.vaults.sources(f.vault.id, { limit: '50' }).items.length, before);
  assert.equal((await f.client.request({ op: 'messages', sessionId: f.session.id })).items.length, 2);
  await f.client.request({ op: 'cancel', runId: active.runId });
  await until(() => f.client.request({ op: 'run', runId: active.runId }), terminal);
});

test('unsupported chat files keep a durable card and original without claiming readable text', options, async t => {
  const f = await setup(t);
  const ref = await f.client.request({ op: 'ingest', key: randomUUID(),
    input: { vaultId: f.vault.id, input: { kind: 'upload', filePart: 'file' }, conversation: { sessionId: f.session.id, text: '帮我入库' } },
    upload: { name: '公开样本.unknown', bytes: Buffer.from('PUBLIC_UNSUPPORTED') } });
  const run = await until(() => f.client.request({ op: 'run', runId: ref.runId }), terminal);
  const messages = (await f.client.request({ op: 'messages', sessionId: f.session.id })).items;
  assert.equal(messages.length, 1); assert.equal(messages[0].attachment.name, '公开样本.unknown');
  const source = await f.client.request({ op: 'source', sourceId: messages[0].attachment.sourceId });
  assert.equal(source.state, 'unsupported'); assert.equal(source.originalSaved, true); assert.equal(f.requests.length, 0);
  assert.deepEqual((await f.client.request({ op: 'sourceOriginal', sourceId: source.id, version: source.version })).bytes, Buffer.from('PUBLIC_UNSUPPORTED'));
  assert.notEqual(run.result?.sourceState, 'ready');
});

test('citation checks reject changes during read; changed, excluded and missing sources return no old excerpt', options, async t => {
  const f = await setup(t), ref = await f.ask();
  const run = await until(() => f.client.request({ op: 'run', runId: ref.runId }), terminal);
  const answer = await f.client.request({ op: 'answer', answerId: run.result.answerId });
  const target = { op: 'citation', answerId: answer.answer.id, evidenceId: answer.answer.citations[0].id };
  const original = fs.readFileSync(f.note);
  const tampered = new DesktopClient(f.origin, f.cookie, (url, init) => url.includes('/content?') ?
    Promise.resolve(new Response('unverified substituted body')) : fetch(url, init));
  await assert.rejects(tampered.request(target), { code: 'SOURCE_CHANGED' });
  const race = new DesktopClient(f.origin, f.cookie, async (url, init) => {
    if (url.includes('/content?')) fs.writeFileSync(f.note, '# 新版本\n蓝盒移到了南柜。\n');
    return fetch(url, init);
  });
  await assert.rejects(race.request(target), { code: 'SOURCE_CHANGED' });
  const changed = await f.client.request(target); assert.equal(changed.status, 'changed'); assert.equal(changed.text, undefined); assert.equal(changed.evidence, undefined);
  fs.writeFileSync(f.note, original); await f.vaults.scan(f.vault.id);
  f.vaults.update(f.vault.id, { expectedRevision: f.vaults.get(f.vault.id).revision, exclusions: ['notes.md'] });
  const excluded = await f.client.request(target); assert.equal(excluded.status, 'excluded'); assert.equal(excluded.text, undefined);
  f.vaults.update(f.vault.id, { expectedRevision: f.vaults.get(f.vault.id).revision, exclusions: [] });
  await f.vaults.scan(f.vault.id); fs.unlinkSync(f.note);
  const missing = await f.client.request(target); assert.equal(missing.status, 'missing'); assert.equal(missing.text, undefined);
});

test('desktop reopens exact Unicode line fragments and rejects offsets that do not match the verified excerpt', options, async t => {
  const f = await setup(t);
  fs.writeFileSync(f.note, '# 公开长行\n' + '公开😀片段'.repeat(2000) + '\nEND\n');
  await f.vaults.scan(f.vault.id);
  const ref = await f.ask(), run = await until(() => f.client.request({ op: 'run', runId: ref.runId }), terminal);
  assert.equal(run.state, 'succeeded');
  const view = await f.client.request({ op: 'answer', answerId: run.result.answerId });
  const evidence = view.answer.citations[0], target = { op: 'citation', answerId: view.answer.id, evidenceId: evidence.id };
  assert(evidence.location.endOffset > 0);
  const citation = await f.client.request(target);
  assert.equal(citation.status, 'current'); assert.equal(citation.evidence.excerpt, evidence.excerpt);
  assert.equal(citation.text.split('\n')[1].slice(0, evidence.location.endOffset), evidence.excerpt);
  // Exercise reopening a continued fragment through the same authenticated desktop path.
  const original = structuredClone(view.answer), fragment = view.answer.citations[0];
  fragment.location.startOffset = 2; fragment.excerpt = fragment.excerpt.slice(2);
  f.db.prepare('UPDATE answers SET body_json=? WHERE id=?').run(JSON.stringify(view.answer), original.id);
  assert.equal((await f.client.request(target)).evidence.excerpt, fragment.excerpt);
  fragment.location.startOffset = 1;
  f.db.prepare('UPDATE answers SET body_json=? WHERE id=?').run(JSON.stringify(view.answer), original.id);
  await assert.rejects(f.client.request(target), { code: 'CITATION_INVALID' });
});

test('desktop source pagination and a narrowed scope cannot expose an out-of-scope reading', options, async t => {
  const f = await setup(t);
  for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(path.dirname(f.note), `public-${i}.md`), '# 公开范围样本\n');
  await f.vaults.scan(f.vault.id);
  // Historical missing records can exceed one page while each live snapshot stays under 50 files.
  for (let i = 0; i < 25; i++) fs.unlinkSync(path.join(path.dirname(f.note), `public-${i}.md`));
  for (let i = 25; i < 51; i++) fs.writeFileSync(path.join(path.dirname(f.note), `public-${i}.md`), '# 公开范围样本\n');
  await f.vaults.scan(f.vault.id);
  const first = await f.client.request({ op: 'sources', vaultId: f.vault.id });
  assert.equal(first.items.length, 50); assert(first.nextCursor);
  const last = await f.client.request({ op: 'sources', vaultId: f.vault.id, cursor: first.nextCursor });
  assert.equal(last.items.length, 2); assert.equal(last.nextCursor, null);
  assert.equal(new Set([...first.items, ...last.items].map(source => source.id)).size, 52);
  const ref = await f.ask({ scope: { mode: 'selected', paths: ['public-25.md'] } });
  const run = await until(() => f.client.request({ op: 'run', runId: ref.runId }), terminal);
  assert.equal(run.state, 'succeeded', JSON.stringify(run.error));
  const view = await f.client.request({ op: 'answer', answerId: run.result.answerId });
  assert.equal(view.answer.outcome, 'insufficient_evidence'); assert.equal(view.answer.citations.length, 0);
  assert(!JSON.stringify(f.requests).includes('蓝盒在北柜第二层'));
});

test('unknown delivery preserves idempotent replay without another model run', options, async t => {
  const f = await setup(t), key = randomUUID(); let dropped = false;
  const uncertain = new DesktopClient(f.origin, f.cookie, async (url, init) => {
    const response = await fetch(url, init);
    if (!dropped && init.method === 'POST') { dropped = true; await response.arrayBuffer(); throw new TypeError('simulated lost response'); }
    return response;
  });
  const request = { op: 'ask', sessionId: f.session.id, key, input: { text: '蓝盒在哪', action: 'ask' } };
  await assert.rejects(uncertain.request(request), { code: 'SUBMISSION_UNKNOWN' });
  const replay = await uncertain.request(request);
  assert.equal((await until(() => f.client.request({ op: 'run', runId: replay.runId }), terminal)).state, 'succeeded');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1); assert.equal(f.requests.length, 2);
});

test('desktop ingestion preserves text, file originals and webpage snapshots with idempotent submission', options, async t => {
  const f = await setup(t), baseline = fs.readFileSync(f.note), key = randomUUID();
  const textInput = { vaultId: f.vault.id, input: { kind: 'text', title: '桌面正文', text: '# 公开条目\n巡检时间为周三。\n' } };
  const ref = await f.client.request({ op: 'ingest', input: textInput, key });
  assert.equal((await f.client.request({ op: 'ingest', input: textInput, key })).runId, ref.runId);
  const run = await until(() => f.client.request({ op: 'run', runId: ref.runId }), terminal);
  assert.equal(run.state, 'succeeded', JSON.stringify(run.error));
  const source = f.vaults.source(run.result.sourceId);
  assert.equal(source.originalSaved, true);
  assert.equal(await f.client.request({ op: 'sourceText', sourceId: source.id, version: source.version }), textInput.input.text);
  const original = await f.client.request({ op: 'sourceOriginal', sourceId: source.id, version: source.version });
  assert.equal(original.bytes.toString('utf8'), textInput.input.text); assert.equal(original.filename, '桌面正文.md');
  const bytes = fs.readFileSync('tests/fixtures/public/t00/inputs/formats/inspection.docx');
  const upload = await f.client.request({ op: 'ingest', key: randomUUID(), input: { vaultId: f.vault.id, input: { kind: 'upload', filePart: 'file' } }, upload: { name: '公开巡检.docx', bytes: new Uint8Array(bytes) } });
  const fileRun = await until(() => f.client.request({ op: 'run', runId: upload.runId }), terminal);
  assert.equal(fileRun.state, 'succeeded', JSON.stringify(fileRun.error));
  const fileSource = f.vaults.source(fileRun.result.sourceId);
  assert.deepEqual((await f.client.request({ op: 'sourceOriginal', sourceId: fileSource.id, version: fileSource.version })).bytes, bytes);
  assert.equal(fileSource.readableRepresentation.kind, 'extracted_markdown');
  const web = await f.client.request({ op: 'ingest', key: randomUUID(), input: { vaultId: f.vault.id, input: { kind: 'url', url: 'https://public.example.org/desktop-test' } } });
  const webRun = await until(() => f.client.request({ op: 'run', runId: web.runId }), terminal);
  assert.equal(webRun.state, 'succeeded', JSON.stringify(webRun.error)); assert.equal(f.webRequests.length, 1);
  const webSource = f.vaults.source(webRun.result.sourceId); assert.equal(webSource.origin, 'web_snapshot'); assert.equal(webSource.originalSaved, true);
  assert.deepEqual(fs.readFileSync(f.note), baseline); assert.equal(f.requests.length, 0);
});

test('desktop memory settings enforce revisions, and explicit chat memory commands avoid the model', options, async t => {
  const f = await setup(t), key = randomUUID(), input = { vaultId: f.vault.id, text: '先给结论，再列出处。', category: 'preference' };
  const memory = await f.client.request({ op: 'createMemory', input, key });
  assert.equal((await f.client.request({ op: 'createMemory', input, key })).id, memory.id);
  const changed = await f.client.request({ op: 'updateMemory', memoryId: memory.id, input: { text: '用简洁中文。', expectedRevision: memory.revision } });
  await assert.rejects(f.client.request({ op: 'updateMemory', memoryId: memory.id, input: { text: '不能覆盖新版', expectedRevision: memory.revision } }), { code: 'REVISION_CONFLICT' });
  await f.client.request({ op: 'deleteMemory', memoryId: memory.id, input: { expectedRevision: changed.revision } });
  assert.equal((await f.client.request({ op: 'memories', vaultId: f.vault.id })).items.length, 0);
  const ref = await f.ask({ text: '记住：回答尽量简洁。', action: 'auto' });
  const run = await until(() => f.client.request({ op: 'run', runId: ref.runId }), terminal);
  assert.equal(run.state, 'succeeded'); assert.equal(run.resolvedAction, 'remember'); assert.equal(f.requests.length, 0);
  assert.equal((await f.client.request({ op: 'memories', vaultId: f.vault.id })).items[0].text, '回答尽量简洁。');
});

test('desktop saves only the selected answer with provenance and deletes history without deleting saved material', options, async t => {
  const f = await setup(t), ref = await f.ask(), run = await until(() => f.client.request({ op: 'run', runId: ref.runId }), terminal);
  const { answer } = await f.client.request({ op: 'answer', answerId: run.result.answerId });
  const end = answer.markdown.indexOf('。') + 1, key = randomUUID();
  const request = { op: 'saveAnswer', answerId: answer.id, key, input: { expectedAnswerRevision: answer.revision,
    title: '蓝盒位置选段', selection: { start: 0, end, expectedText: answer.markdown.slice(0, end) } } };
  const saved = await f.client.request(request);
  assert.equal((await f.client.request(request)).runId, saved.runId);
  const savedRun = await until(() => f.client.request({ op: 'run', runId: saved.runId }), terminal);
  assert.equal(savedRun.state, 'succeeded', JSON.stringify(savedRun.error));
  const source = f.vaults.source(savedRun.result.sourceId); assert.equal(source.origin, 'ai_saved');
  const text = await f.client.request({ op: 'sourceText', sourceId: source.id, version: source.version });
  assert.match(text, /AI 整理/); assert.match(text, /原资料/); assert(!text.includes('交接截止时间为周五'));
  await f.client.request({ op: 'deleteSession', sessionId: f.session.id });
  assert.equal((await f.client.request({ op: 'sessions', vaultId: f.vault.id })).items.length, 0);
  assert.equal(await f.client.request({ op: 'sourceText', sourceId: source.id, version: source.version }), text);
});

test('desktop model settings never return credential values and probe uses the existing ledger', options, async t => {
  const f = await setup(t), settings = await f.client.request({ op: 'settings' });
  const input = { apiKey: 'PUBLIC_SYNTHETIC_REPLACEMENT', expectedRevision: settings.revision };
  const result = await f.client.request({ op: 'setCredential', input }); assert.equal(result.configured, true); assert.equal(input.apiKey, '');
  const after = await f.client.request({ op: 'settings' }); assert.equal(after.credentialConfigured, true); assert(!JSON.stringify(after).includes('PUBLIC_SYNTHETIC'));
  const ref = await f.client.request({ op: 'probe', key: randomUUID() });
  const run = await until(() => f.client.request({ op: 'run', runId: ref.runId }), terminal);
  assert.equal(run.state, 'succeeded', JSON.stringify(run.error)); assert.equal(run.result.modelRevision, after.revision); assert.equal(run.usage.modelRequests, 1);
});

test('desktop rejects forged uploads, unbounded input, source versions and writes without identity or revision', () => {
  const vaultId = newId('vault'), sourceId = newId('source'), memoryId = newId('memory'), key = randomUUID();
  const input = { vaultId, input: { kind: 'upload', filePart: 'file' } };
  for (const upload of [{ name: '../key', bytes: new Uint8Array([1]) }, { name: 'public.md', bytes: [1, 2] },
    { name: 'public.md', bytes: new Uint8Array(100 * 1024 * 1024 + 1) }]) assert.throws(() => requestRoute({ op: 'ingest', input, upload, key }), { code: 'BAD_REQUEST' });
  for (const request of [{ op: 'sourceText', sourceId, version: '../private' },
    { op: 'createMemory', input: { vaultId, text: 'hello', category: 'focus' } },
    { op: 'updateMemory', memoryId, input: { text: 'hello' } }, { op: 'setCredential', input: { apiKey: 'PUBLIC_SYNTHETIC_KEY' } },
    { op: 'refreshVault', vaultId, key, path: '/private' }]) assert.throws(() => requestRoute(request), { code: 'BAD_REQUEST' });
});
