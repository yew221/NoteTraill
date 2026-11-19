import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { DesktopWorkspaceStore } from '../src/desktop/workspace.mjs';
import { DesktopClient } from '../src/desktop/client.mjs';
import { DesktopService } from '../src/desktop/service.mjs';
import { emptyWorkspace, emptyDraft } from '../dist/shared/desktop.js';
import { isIngestInstruction, isIngestInput } from '../dist/shared/ingest.js';
import { newId } from '../dist/server/contracts.js';
import { desktopQuestions, desktopSandbox } from './fixtures/desktop-questions.mjs';

function renderer(file, replacements = {}) {
  let source = fs.readFileSync(new URL(`../src/desktop/renderer/${file}.ts`, import.meta.url), 'utf8');
  source = source.replace(/(['"])\.\.\/\.\.\/shared\/([^'"]+)\1/g, (_all, quote, name) => quote + new URL(`../dist/shared/${name}`, import.meta.url).href + quote);
  for (const [from, to] of Object.entries(replacements)) source = source.replaceAll(from, to);
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`;
}
const { Workspace } = await import(renderer('workspace', { './api.js': renderer('api') }));
const directory = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-d4-')));
const options = { timeout: 30000 };
async function until(read, predicate) {
  const deadline = Date.now() + 15000;
  for (;;) { const value = await read(); if (predicate(value)) return value; assert(Date.now() < deadline, 'timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
function bind(t, store, client, override = {}) {
  const previous = globalThis.window;
  const reply = action => Promise.resolve().then(action).then(data => ({ data }), error => ({ error: { code: error.code, message: error.message } }));
  globalThis.window = { notetrail: {
    loadWorkspace: () => ({ data: store.load() }), saveWorkspace: state => ({ data: store.save(state) }),
    createSession: (input, key) => reply(() => client.request({ op: 'createSession', input, key })),
    ask: (sessionId, input, key) => reply(() => client.request({ op: 'ask', sessionId, input, key })),
    run: runId => reply(() => client.request({op:'run',runId})),
    source: sourceId => reply(() => client.request({op:'source',sourceId})),
    ingest: (input, key, upload) => reply(() => client.request({ op: 'ingest', input, key, ...(upload ? { upload } : {}) })),
    getDraftFile: file => reply(() => store.getAttachment(file)), ...override,
  } };
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
}
async function setup(t, lostPath) {
  const dir = directory(), fixture = await desktopQuestions(dir);
  t.after(async () => { await fixture.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { origin, bootstrapToken } = fixture.connection;
  const response = await fetch(origin + '/api/v1/bootstrap', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: bootstrapToken }) });
  const cookie = response.headers.get('set-cookie').split(';')[0]; let lost = false;
  const client = new DesktopClient(origin, cookie, async (url, init) => {
    const response = await fetch(url, init);
    if (!lost && init.method === 'POST' && lostPath?.test(new URL(url).pathname)) { lost = true; await response.arrayBuffer(); throw new Error('PUBLIC_LOST_REPLY'); }
    return response;
  });
  const store = new DesktopWorkspaceStore(path.join(dir, 'profile'), fixture.dataDirectory);
  bind(t, store, client);
  return { ...fixture, dir, client, store };
}

test('desktop workspace binds drafts to the data directory, protects attachments and rejects credentials or paths', t => {
  const dir = directory(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const profile = path.join(dir, 'profile'), data = path.join(dir, 'data'), store = new DesktopWorkspaceStore(profile, data);
  const vaultId = newId('vault'), key = `new:${vaultId}`, attachment = store.putAttachment({ name: '公开.md', bytes: Buffer.from('PUBLIC'), lastModified: 1 });
  const state = { ...emptyWorkspace(), vaultId, page: 'sources', drafts: { [key]: { ...emptyDraft(), text: '未发送的草稿', mode: 'store', attachment } } };
  store.save(state);
  const reopened = new DesktopWorkspaceStore(profile, data); assert.deepEqual(reopened.load(), state); assert.equal(Buffer.from(reopened.getAttachment(attachment)).toString(), 'PUBLIC');
  assert.deepEqual(new DesktopWorkspaceStore(profile, path.join(dir, 'other-data')).load(), emptyWorkspace());
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
  for (const invalid of [{ ...state, apiKey: 'MUST_NOT_BE_SAVED' }, { ...state, drafts: { '../private': emptyDraft() } },
    { ...state, pending: { arbitrary: 'key' } }, { ...state, drafts: { [key]: { ...emptyDraft(), filePath: '/private/key' } } }]) assert.throws(() => store.save(invalid), { code: 'BAD_REQUEST' });
  assert(!fs.readFileSync(store.file, 'utf8').includes('MUST_NOT_BE_SAVED'));
  fs.writeFileSync(path.join(store.attachments, attachment.id), 'TAMPER', { mode: 0o600 });
  assert.throws(() => store.getAttachment(attachment), { code: 'DRAFT_INVALID' });
  fs.writeFileSync(store.file, '{broken'); assert.throws(() => new DesktopWorkspaceStore(profile, data), { code: 'DRAFT_INVALID' });
  assert.equal(fs.readFileSync(store.file, 'utf8'), '{broken');
});

test('restart after a lost new-session response reuses its identity and sends exactly one question', options, async t => {
  const f = await setup(t, /^\/api\/v1\/sessions$/), key = `new:${f.vault.id}`;
  let workspace = new Workspace(); workspace.edit(key, { text: '蓝盒在哪？' });
  await assert.rejects(workspace.submit(key, f.vault.id, null), { code: 'SUBMISSION_UNKNOWN' });
  const identity = f.store.load().drafts[key].pending.sessionKey;
  workspace = new Workspace(); assert.equal(workspace.draft(key).pending.sessionKey, identity);
  const { ref, session } = await workspace.submit(key, f.vault.id, null);
  await until(() => f.client.request({ op: 'run', runId: ref.runId }), run => run.state === 'succeeded');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1); assert.equal(f.requests.length, 2);
  assert.equal(f.store.load().sessionId, session.id); assert.equal(f.store.load().drafts[session.id].text, '');
  assert.equal(f.store.load().tasks[0].runId, ref.runId);
  await assert.rejects(f.client.request({ op: 'createSession', input: { vaultId: f.vault.id, title: '不能复用标识改标题' }, key: identity }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('restart after a lost question reply keeps the original key and does not charge or create a second run', options, async t => {
  const f = await setup(t, /\/messages$/), key = `new:${f.vault.id}`;
  let workspace = new Workspace(); workspace.edit(key, { text: '蓝盒在哪？', options: { scope: { mode: 'vault' }, answerPolicy: 'vault_only' } });
  await assert.rejects(workspace.submit(key, f.vault.id, null), { code: 'SUBMISSION_UNKNOWN' });
  const id = f.store.load().sessionId, identity = f.store.load().drafts[id].pending.key;
  workspace = new Workspace();
  assert.equal(workspace.draft(id).pending.key, identity);
  assert.equal(workspace.draft(id).options.answerPolicy, 'vault_only');
  workspace.edit(id, { options: { scope: { mode: 'vault' } } });
  assert.equal(workspace.draft(id).options.answerPolicy, 'vault_only');
  const { ref } = await workspace.submit(id, f.vault.id, await f.client.request({ op: 'session', sessionId: id }));
  assert.equal(f.db.prepare('SELECT result_json FROM idempotency_records WHERE key=?').get(identity).result_json.includes(ref.runId), true);
  await until(() => f.client.request({ op: 'run', runId: ref.runId }), run => run.state === 'succeeded');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1); assert.equal(f.requests.length, 2);
  assert.equal(workspace.draft(id).options.answerPolicy, undefined);
});

test('a file draft survives restart and uncertain delivery without duplicate originals', options, async t => {
  const f = await setup(t, /\/ingestions$/), key = `collect:${f.vault.id}`;
  const bytes = Buffer.from('# 公开附件\n蓝盒放在北柜。\n');
  const attachment = f.store.putAttachment({ name: '公开附件.md', bytes, lastModified: 1 });
  let workspace = new Workspace(); workspace.edit(key, { mode: 'store', title: '附件草稿', attachment });
  workspace = new Workspace(); assert.equal(workspace.draft(key).attachment.id, attachment.id);
  await assert.rejects(workspace.submit(key, f.vault.id, null), { code: 'SUBMISSION_UNKNOWN' });
  workspace = new Workspace(); const { ref } = await workspace.submit(key, f.vault.id, null);
  const run = await until(() => f.client.request({ op: 'run', runId: ref.runId }), run => run.state === 'succeeded');
  const sources = f.vaults.sources(f.vault.id, { limit: '50' }).items; assert.equal(sources.length, 2);
  const source = f.vaults.source(run.result.sourceId);
  assert.deepEqual((await f.client.request({ op: 'sourceOriginal', sourceId: source.id, version: source.version })).bytes, bytes);
  assert.equal(workspace.draft(key).attachment, undefined); assert(!fs.existsSync(path.join(f.store.attachments, attachment.id)));
  assert.equal(f.requests.length, 0);
});

test('changing a pending scope changes request identity, while saving the same scope preserves it', async t => {
  const dir = directory(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new DesktopWorkspaceStore(path.join(dir, 'profile'), path.join(dir, 'data'));
  const sessionId = newId('session'), vaultId = newId('vault'), keys = [];
  bind(t, store, {}, { ask: async (_id, _input, key) => { keys.push(key); return { error: { code: 'SUBMISSION_UNKNOWN', message: 'PUBLIC_LOST_REPLY' } }; } });
  const workspace = new Workspace(); workspace.edit(sessionId, { text: '公开问题', options: { scope: { mode: 'vault' }, answerPolicy: 'vault_only' } });
  const send = () => assert.rejects(workspace.submit(sessionId, vaultId, { id: sessionId }), { code: 'SUBMISSION_UNKNOWN' });
  await send(); workspace.edit(sessionId, { options: { scope: { mode: 'vault' } } }); await send();
  assert.equal(keys[0], keys[1]);
  workspace.edit(sessionId, { options: { scope: { mode: 'selected', paths: ['公开/'] } } }); await send();
  assert.notEqual(keys[1], keys[2]);
});

test('failed draft persistence prevents transmission, and failed acknowledgement keeps a recoverable pending identity', options, async t => {
  const f = await setup(t), key = `new:${f.vault.id}`, workspace = new Workspace(); workspace.edit(key, { text: '蓝盒在哪？' });
  const save = window.notetrail.saveWorkspace;
  window.notetrail.saveWorkspace = () => ({ error: { code: 'DRAFT_STORAGE_FAILED', message: 'PUBLIC_DISK_FULL' } });
  await assert.rejects(workspace.submit(key, f.vault.id, null), { code: 'DRAFT_STORAGE_FAILED' });
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 0);
  window.notetrail.saveWorkspace = state => state.tasks.length ? { error: { code: 'DRAFT_STORAGE_FAILED', message: 'PUBLIC_DISK_FULL' } } : save(state);
  await assert.rejects(workspace.submit(key, f.vault.id, null), { code: 'DRAFT_STORAGE_FAILED' });
  window.notetrail.saveWorkspace = save;
  const restored = new Workspace(), id = restored.current.sessionId;
  const { ref } = await restored.submit(id, f.vault.id, await f.client.request({ op: 'session', sessionId: id }));
  await until(() => f.client.request({ op: 'run', runId: ref.runId }), run => run.state === 'succeeded');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1); assert.equal(f.requests.length, 2);
});

test('auxiliary request identities persist until acknowledgement and completed task retention keeps active work', async t => {
  const dir = directory(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new DesktopWorkspaceStore(path.join(dir, 'profile'), path.join(dir, 'data')); bind(t, store, {});
  let workspace = new Workspace(), first;
  await assert.rejects(workspace.auxiliary('a'.repeat(64), async key => { first = key; throw new Error('LOST'); }));
  workspace = new Workspace(); const runId = newId('run'), ref = { runId, state: 'queued', eventsUrl: `/api/v1/runs/${runId}/events` };
  await workspace.auxiliary('a'.repeat(64), async key => { assert.equal(key, first); return ref; });
  assert.deepEqual(store.load().pending, {});
  for (let i = 0; i < 45; i++) { const runId = newId('run'); workspace.task({ runId }, null); workspace.terminal(runId); }
  assert.equal(workspace.current.tasks.length, 41); assert(workspace.current.tasks.some(task => task.runId === ref.runId && !task.finished));
});

test('chat upload intent is explicit and never treats a question or negation as permission to ingest', () => {
  for (const text of ['帮我入库', '请帮我把这份文件存入知识库。', '收录', '保存到资料库', '把附件入库吧']) assert(isIngestInstruction(text), text);
  for (const text of ['', '不要入库', '如何入库？', '帮我入库并总结', '帮我总结这个文件', '这份文件讲了什么', '请勿收藏']) assert(!isIngestInstruction(text), text);
  const input = { vaultId: newId('vault'), input: { kind: 'upload', filePart: 'file' }, conversation: { sessionId: newId('session'), text: '帮我入库' } };
  assert(isIngestInput(input));
  assert(!isIngestInput({ ...input, input: { kind: 'text', text: 'wrong' } }));
  assert(!isIngestInput({ ...input, conversation: { ...input.conversation, text: '不要入库' } }));
});

test('chat file and collection drafts stay independent across restart, and a lost chat upload reply creates one durable file card', options, async t => {
  const f = await setup(t, /\/ingestions$/), key = `new:${f.vault.id}`, collectKey = `collect:${f.vault.id}`;
  const attachment = f.store.putAttachment({ name: '聊天资料.md', bytes: Buffer.from('# 公开聊天资料\n下雨时记得关窗。\n'), lastModified: 1 });
  let workspace = new Workspace();
  workspace.edit(collectKey, { mode: 'store', text: '独立的收集草稿' });
  workspace.edit(key, { mode: 'ask', text: '帮我总结', attachment });
  await assert.rejects(workspace.submit(key, f.vault.id, null), /附件已保留/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 0);
  workspace.edit(key, { text: '帮我入库' });
  workspace.update(state => ({ ...state, inspector: { open: true, tab: 'read', width: 420 } }));
  await assert.rejects(workspace.submit(key, f.vault.id, null), { code: 'SUBMISSION_UNKNOWN' });
  workspace = new Workspace();
  const sessionId = workspace.current.sessionId;
  assert.equal(workspace.draft(sessionId).attachment.id, attachment.id);
  const { ref } = await workspace.submit(sessionId, f.vault.id, await f.client.request({ op: 'session', sessionId }));
  const run = await until(() => f.client.request({ op: 'run', runId: ref.runId }), run => run.state === 'succeeded');
  const messages = (await f.client.request({ op: 'messages', sessionId })).items;
  assert.equal(messages.length, 1); assert.equal(messages[0].text, '帮我入库'); assert.equal(messages[0].resolvedAction, 'ingest');
  assert.equal(messages[0].attachment.name, '聊天资料.md'); assert.equal(messages[0].attachment.sourceId, run.result.sourceId);
  assert.equal(workspace.current.tasks[0].sessionId, sessionId); assert.equal(workspace.draft(sessionId).attachment, undefined);
  assert.equal(workspace.draft(collectKey).text, '独立的收集草稿'); assert.deepEqual(workspace.current.inspector, { open: true, tab: 'read', width: 420 });
  assert.equal(f.requests.length, 0); assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 1);
  const source = await f.client.request({ op: 'source', sourceId: run.result.sourceId });
  assert.match(await f.client.request({ op: 'sourceText', sourceId: source.id, version: source.version }), /下雨时记得关窗/);
  await f.client.request({ op: 'deleteSession', sessionId });
  assert.equal((await f.client.request({ op: 'source', sourceId: source.id })).state, 'ready');
});

test('a definitively refused file save leaves the attachment and question editable', options, async t => {
  const f=await setup(t), ws=new Workspace(), key=`new:${f.vault.id}`;
  f.vaults.update(f.vault.id,{expectedRevision:f.vault.revision,exclusions:['助手资料/原件/']});
  const attachment=f.store.putAttachment({name:'不应存入.md',bytes:Buffer.from('公开合成材料'),lastModified:1});
  ws.edit(key,{attachment,text:'这个文件讲了什么？'});
  await assert.rejects(ws.submit(key,f.vault.id,null,true),{code:'SOURCE_EXCLUDED'});
  const saved=ws.draft(ws.current.sessionId);
  assert.equal(saved.pending,undefined);assert.equal(saved.attachment.id,attachment.id);assert.equal(saved.text,'这个文件讲了什么？');
  assert.equal(f.requests.length,0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM messages').get().n,0);
});

test('explicit file save survives a lost receipt, retains the editable question across restart, and only sends it on request', options, async t => {
  const f = await setup(t, /\/ingestions$/), key = `new:${f.vault.id}`, question='最晚几点交接？';
  let ws=new Workspace();
  const attach=f.store.putAttachment({name:'交接时间.md', bytes:Buffer.from('最晚周五 15:00 前交接。'),lastModified:1});
  ws.edit(key,{attachment:attach,text:question});
  await assert.rejects(ws.submit(key,f.vault.id,null,true),{code:'SUBMISSION_UNKNOWN'});
  ws=new Workspace();
  const id=ws.current.sessionId, session=await f.client.request({op:'session',sessionId:id});
  assert(ws.draft(id).pending.fileOnly);assert.equal(ws.draft(id).text,question);
  const revised=question+'请给出出处。';ws.edit(id,{text:revised});
  const {ref}=await ws.submit(id,f.vault.id,session,true);
  const done=await until(()=>f.client.request({op:'run',runId:ref.runId}),r=>r.state==='succeeded');
  const source=f.vaults.source(done.result.sourceId); assert.equal(done.attachmentSourceId,source.id);
  ws=new Workspace(); assert.equal(ws.draft(id).text,revised);assert.equal(ws.draft(id).questionFileRun,ref.runId);
  assert.equal(ws.draft(id).attachment,undefined);assert.equal(f.requests.length,0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM messages WHERE session_id=?').get(id).n,1);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM sources WHERE origin='imported_file' AND vault_id=?").get(f.vault.id).n,1);
  ws.edit(id,{options:{scope:{mode:'selected',paths:['other/']}}});
  await assert.rejects(ws.submit(id,f.vault.id,session),/不在当前资料范围/);
  assert.equal(f.requests.length,0);
  ws.edit(id,{options:{scope:{mode:'vault'}}});
  const asked=await ws.submit(id,f.vault.id,session);
  const accepted=JSON.parse(f.db.prepare('SELECT input_json FROM messages WHERE run_id=?').get(asked.ref.runId).input_json);
  assert.equal(accepted.text??f.db.prepare('SELECT text FROM messages WHERE run_id=?').get(asked.ref.runId).text,revised);
  assert.deepEqual(accepted.scope,{mode:'selected',paths:[source.relativePath]});
  assert.deepEqual(ws.draft(id).options.scope,{mode:'vault'});assert.equal(ws.draft(id).questionFileRun,undefined);
  await until(()=>f.client.request({op:'run',runId:asked.ref.runId}),r=>['succeeded','failed'].includes(r.state));
});

test('an uncertain attachment question keeps its identity until a definite scope rejection unlocks the draft', options, async t => {
  const f = await setup(t), session = f.conversations.create({ vaultId: f.vault.id }), ws = new Workspace();
  const key = session.id, question = '周几交接？', file = f.store.putAttachment({ name:'测试交接.md',bytes:Buffer.from('收件截止周五。'),lastModified:1 });
  ws.edit(key, {attachment:file,text:question});
  const saved = await ws.submit(key, f.vault.id, session, true);
  const run = await until(() => f.client.request({op:'run',runId:saved.ref.runId}), r => r.state === 'succeeded');
  const source = f.vaults.source(run.attachmentSourceId), ask = window.notetrail.ask;
  window.notetrail.ask = async () => ({error:{code:'SUBMISSION_UNKNOWN',message:'连接中断'}});
  await assert.rejects(ws.submit(key,f.vault.id,session),{code:'SUBMISSION_UNKNOWN'});
  const pending = ws.draft(key).pending; assert.equal(pending.questionPath,source.relativePath);
  ws.edit(key,{options:{scope:{mode:'selected',paths:[source.relativePath]}}});
  assert.deepEqual(ws.draft(key).options.scope,{mode:'vault'});
  f.vaults.update(f.vault.id,{expectedRevision:f.vaults.get(f.vault.id).revision,exclusions:[source.relativePath]});
  window.notetrail.ask = (id,input,retryKey) => { assert.equal(retryKey,pending.key); return ask(id,input,retryKey); };
  const after = new Workspace(); await assert.rejects(after.submit(key,f.vault.id,session),{code:'PATH_OUTSIDE_SCOPE'});
  assert.equal(after.draft(key).pending,undefined); assert.equal(after.draft(key).text,question); assert.equal(f.requests.length,0);
  const followUp = newId('answer');
  for (const patch of [{basedOnAnswerId:followUp}, {experienceComparison:true}]) {
    after.edit(key,{questionFileRun:run.id}); after.edit(key,patch);
    assert.equal(after.draft(key).questionFileRun,undefined); assert.equal(after.draft(key).text,question);
  }
});

test('chat upload identities survive backend restart and reach the follow-up model request', options, async t => {
  const f = await setup(t), session = f.conversations.create({ vaultId: f.vault.id });
  const ref = await f.runs.ingest({ vaultId: f.vault.id, input: { kind: 'upload', filePart: 'file' },
    conversation: { sessionId: session.id, text: '帮我入库' } }, randomUUID(), { filename: '重启后追问.md', bytes: Buffer.from('重启后仍能定位的公开附件。\n') });
  const stored = await until(() => f.runs.get(ref.runId), run => run.state === 'succeeded');
  await f.stop();
  const reopened = await desktopQuestions(f.dir); t.after(() => reopened.stop());
  const question = reopened.runs.message(session.id, { text: '刚才上传的文件是什么？', scope: { mode: 'vault' }, answerPolicy: 'vault_only' }, randomUUID());
  const finished = await until(() => reopened.runs.get(question.runId), run => ['succeeded', 'failed'].includes(run.state));
  assert.equal(finished.state, 'succeeded', JSON.stringify(finished.error));
  const payload = JSON.stringify(reopened.requests[0]);
  assert(payload.includes(stored.result.sourceId)); assert(payload.includes('重启后追问.md'));
});

test('desktop reconnects after backend death and expired authentication without replaying interrupted work', options, async t => {
  const dir = directory(), root = desktopSandbox(dir), service = new DesktopService({ root, node: process.execPath,
    dataDirectory: path.join(dir, 'data'), python: process.env.NOTETRAIL_PYTHON, rg: process.env.NOTETRAIL_RG });
  t.after(async () => { await service.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await service.start(); const vault = (await service.request({ op: 'vaults' })).items[0];
  const session = await service.request({ op: 'createSession', key: randomUUID(), input: { vaultId: vault.id, title: '中断恢复' } });
  const ref = await service.request({ op: 'ask', sessionId: session.id, key: randomUUID(), input: { text: 'STOP_TEST', action: 'ask' } });
  await until(() => service.request({ op: 'run', runId: ref.runId }), run => run.usage.modelRequests === 1);
  const pid = Number(fs.readFileSync(path.join(dir, 'synthetic-backend-pid'), 'utf8')); process.kill(pid, 'SIGKILL');
  await until(() => service.status(), status => status.phase === 'failed'); await service.restart();
  const interrupted = await service.request({ op: 'run', runId: ref.runId }); assert.equal(interrupted.state, 'interrupted'); assert.equal(interrupted.usage.modelRequests, 1);
  assert.equal((await service.request({ op: 'messages', sessionId: session.id })).items.length, 1);
  fs.writeFileSync(path.join(dir, 'expire-session'), 'TEST_ONLY');
  await assert.rejects(service.request({ op: 'vaults' }), { code: 'UNAUTHORIZED' }); assert.equal(service.status().phase, 'failed');
  await service.restart(); assert.equal((await service.request({ op: 'vaults' })).items[0].id, vault.id);
  assert.equal((await service.request({ op: 'run', runId: ref.runId })).state, 'interrupted');
});

test('desktop migrates every unsubmitted legacy draft without losing input', t => {
  const dir = directory(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new DesktopWorkspaceStore(path.join(dir, 'profile'), path.join(dir, 'data'));
  const id = newId('vault'), key = `new:${id}`, typed = newId('session');
  const legacy = { ...emptyDraft(), options: { scope: { mode: 'vault' }, answerPolicy: 'vault_only' } }; delete legacy.policyVersion;
  store.save({ ...emptyWorkspace(), vaultId: id, drafts: { [key]: legacy, [typed]: { ...legacy, text: '尚未提交' } } });
  bind(t, store, {});
  let workspace = new Workspace();
  assert.equal(workspace.draft(key).options.answerPolicy, undefined);
  assert.equal(workspace.draft(typed).options.answerPolicy, undefined);
  assert.equal(workspace.draft(typed).text, '尚未提交');
  workspace.edit(key, { options: { scope: { mode: 'vault' }, answerPolicy: 'vault_only' } });
  workspace = new Workspace(); assert.equal(workspace.draft(key).options.answerPolicy, undefined);
  assert.equal(emptyDraft().options.answerPolicy, undefined);
});

test('over 100 empty drafts compact before validation while real text, attachment and pending identity survive', t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-draft-prune-'))); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new DesktopWorkspaceStore(path.join(dir, 'profile'), path.join(dir, 'data'));
  const state = emptyWorkspace();
  for (let i = 0; i < 140; i++) state.drafts[newId('session')] = emptyDraft();
  const real = newId('session'), pending = newId('session'); state.drafts[real] = { ...emptyDraft(), text: '还没有发送' };
  state.drafts[pending] = { ...emptyDraft(), pending: { signature: 'a'.repeat(64), key: randomUUID(), sessionKey: randomUUID() } };
  store.save(state); const next = new DesktopWorkspaceStore(path.join(dir, 'profile'), path.join(dir, 'data')).load();
  assert.equal(Object.keys(next.drafts).length, 2); assert.equal(next.drafts[real].text, '还没有发送'); assert.deepEqual(next.drafts[pending], state.drafts[pending]);
});


test('a desktop attachment larger than 20 MiB survives draft restart', t => {
  const dir = directory(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const profile = path.join(dir, 'profile'), data = path.join(dir, 'data'), store = new DesktopWorkspaceStore(profile, data);
  const bytes = Buffer.alloc(25 * 1024 * 1024, 65), vaultId = newId('vault'), key = `new:${vaultId}`;
  const attachment = store.putAttachment({ name: 'large-public.txt', bytes, lastModified: 1 });
  const state = { ...emptyWorkspace(), vaultId, drafts: { [key]: { ...emptyDraft(), attachment } } }; store.save(state);
  const reopened = new DesktopWorkspaceStore(profile, data); assert.deepEqual(reopened.load(), state);
  assert.deepEqual(Buffer.from(reopened.getAttachment(attachment)), bytes);
});

for(const lostReply of [false,true])test(`version follow-up preserves an unsent attachment${lostReply?' across unknown reply and restart':''}`,async t=>{
  const dir=directory();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new DesktopWorkspaceStore(path.join(dir,'profile'),path.join(dir,'data')),vaultId=newId('vault'),sessionId=newId('session'),answerId=newId('answer');
  const attachment=store.putAttachment({name:'not-sent.md',bytes:Buffer.from('PRIVATE_DRAFT_ONLY'),lastModified:1}),runId=newId('run');
  const calls=[];
  bind(t,store,{request(){throw Error('No upload or file reading is allowed');}},{
    ask:async(session,input,key)=>{calls.push({session,input,key});if(lostReply&&calls.length===1)return{error:{code:'SUBMISSION_UNKNOWN',message:'Unknown reply'}};
      return{data:{runId,state:'queued',eventsUrl:`/api/v1/runs/${runId}/events`}};},
    getDraftFile:async()=>{throw Error('Attachment must remain local');}
  });
  let workspace=new Workspace();workspace.location({vaultId,sessionId});workspace.edit(sessionId,{text:'根据选定版本继续讨论。',attachment,basedOnAnswerId:answerId});
  if(lostReply){await assert.rejects(workspace.submit(sessionId,vaultId,{id:sessionId}),{code:'SUBMISSION_UNKNOWN'});
    assert.equal(workspace.draft(sessionId).text,'根据选定版本继续讨论。');assert.deepEqual(workspace.draft(sessionId).attachment,attachment);workspace=new Workspace();}
  await workspace.submit(sessionId,vaultId,{id:sessionId});assert.equal(workspace.draft(sessionId).text,'');assert.equal(workspace.draft(sessionId).basedOnAnswerId,undefined);
  assert.deepEqual(workspace.draft(sessionId).attachment,attachment);assert.equal(Buffer.from(store.getAttachment(attachment)).toString(),'PRIVATE_DRAFT_ONLY');
  assert(calls.every(c=>c.input.basedOnAnswerId===answerId&&c.input.action==='ask'&&!JSON.stringify(c.input).includes('PRIVATE_DRAFT_ONLY')));
  if(lostReply)assert.equal(calls[0].key,calls[1].key);
});

for(const lostReply of [false,true])test(`experience comparison preserves an unsent attachment${lostReply?' across unknown reply and restart':''}`,async t=>{
  const dir=directory();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new DesktopWorkspaceStore(path.join(dir,'profile'),path.join(dir,'data')),vaultId=newId('vault'),sessionId=newId('session'),answerId=newId('answer');
  const attachment=store.putAttachment({name:'not-sent.md',bytes:Buffer.from('PRIVATE_DRAFT_ONLY'),lastModified:1}),runId=newId('run');
  const calls=[];
  bind(t,store,{request(){throw Error('No upload or file reading is allowed');}},{
    ask:async(session,input,key)=>{calls.push({session,input,key});if(lostReply&&calls.length===1)return{error:{code:'SUBMISSION_UNKNOWN',message:'Unknown reply'}};
      return{data:{runId,state:'queued',eventsUrl:`/api/v1/runs/${runId}/events`}};},
    getDraftFile:async()=>{throw Error('Attachment must remain local');}
  });
  let workspace=new Workspace();workspace.location({vaultId,sessionId});workspace.edit(sessionId,{text:'根据选定版本继续讨论。',attachment,experienceComparison:true});
  if(lostReply){await assert.rejects(workspace.submit(sessionId,vaultId,{id:sessionId}),{code:'SUBMISSION_UNKNOWN'});
    assert.equal(workspace.draft(sessionId).text,'根据选定版本继续讨论。');assert.deepEqual(workspace.draft(sessionId).attachment,attachment);workspace=new Workspace();}
  await workspace.submit(sessionId,vaultId,{id:sessionId});assert.equal(workspace.draft(sessionId).text,'');assert.equal(workspace.draft(sessionId).experienceComparison,undefined);
  assert.deepEqual(workspace.draft(sessionId).attachment,attachment);assert.equal(Buffer.from(store.getAttachment(attachment)).toString(),'PRIVATE_DRAFT_ONLY');
  assert(calls.every(c=>c.input.experienceComparison===true&&c.input.action==='ask'&&!JSON.stringify(c.input).includes('PRIVATE_DRAFT_ONLY')));
  if(lostReply)assert.equal(calls[0].key,calls[1].key);
});
