import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { connectBackend, launchBackend, startupMessage } from './fixtures/backend-process.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import Database from 'better-sqlite3';

const python = process.env.NOTETRAIL_PYTHON ?? path.join(os.homedir(), '.local/share/uv/tools/markitdown/bin/python');
const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'en_US.UTF-8', PI_OFFLINE: '1', NOTETRAIL_PYTHON: python };
const terminal = run => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.state);
async function until(read, expected) {
  const deadline = Date.now() + 12000;
  for (;;) { const value = await read(); if (expected(value)) return value; assert(Date.now() < deadline, 'fault boundary not reached'); await delay(15); }
}
function area(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-recovery-'))), data = path.join(directory, 'data'), vault = path.join(directory, 'vault');
  fs.mkdirSync(vault); fs.writeFileSync(path.join(vault, 'public.md'), '公开故障验收资料。');
  const children = []; t.after(async () => { for (const item of children) { if (item.child.exitCode === null && item.child.signalCode === null) { item.child.kill('SIGKILL'); await item.exited; } } fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, data, vault, async launch(fault = '', port = 0) {
    const child = fork('tests/fixtures/recovery-server.mjs', [JSON.stringify({ data, fault, port })], { execArgv: [], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const exited = once(child, 'exit'); child.stdout.resume(); child.stderr.resume();
    const item = { child, exited, stats: { modelCalls: 0, messagePosts: 0 } }; children.push(item);
    child.on('message', message => { if (message.type === 'stats') item.stats = message; });
    Object.assign(item, await connectBackend(item));
    item.json = async (route, body, key) => { const result = await item.request(route, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify(body) }); assert(result.ok, `${route}: ${result.status}`); return (await result.json()).data; };
    item.run = async id => (await (await item.request(`/api/v1/runs/${id}`)).json()).data;
    item.stop = async () => { child.kill('SIGTERM'); assert.deepEqual(await exited, [0, null]); };
    return item;
  } };
}
async function question(f, app, text = '公开恢复验收问题') {
  const vault = await app.json('/api/v1/vaults', { absolutePath: f.vault, exclusions: [] });
  const session = await app.json('/api/v1/sessions', { vaultId: vault.id });
  const route = `/api/v1/sessions/${session.id}/messages`, key = randomUUID(), body = { text, answerPolicy: 'vault_only' };
  const ref = await app.json(route, body, key); return { ref, route, key, body, session };
}

test('formal shutdown with an open SSE and a blocked real Pi worker exits cleanly and leaves one terminal', { timeout: 25000 }, async t => {
  const f = area(t), app = await f.launch('hold'), q = await question(f, app);
  await until(() => app.stats, stats => stats.modelCalls === 1);
  const stream = await app.request(q.ref.eventsUrl), reader = stream.body.getReader(); assert.equal((await reader.read()).done, false);
  const consuming = (async () => { try { while (!(await reader.read()).done) {} } catch {} })();
  const started = performance.now(); await app.stop(); await consuming;
  t.diagnostic(`Formal shutdown with model + SSE: ${Math.round(performance.now() - started)} ms`);
  const restarted = await f.launch(); assert.equal((await restarted.run(q.ref.runId)).state, 'interrupted');
  assert.equal((await restarted.json(q.route, q.body, q.key)).runId, q.ref.runId); await delay(100); assert.equal(restarted.stats.modelCalls, 0);
  await restarted.stop();
  const db = new Database(path.join(f.data, 'state.sqlite'), { readonly: true });
  try { assert.equal(db.prepare("SELECT count(*) AS n FROM run_events WHERE run_id=? AND type='run.completed'").get(q.ref.runId).n, 1); } finally { db.close(); }
});

test('second formal startup cannot interrupt a live task, and SSE reconnect and expired history only read snapshots', { timeout: 25000 }, async t => {
  const f = area(t), app = await f.launch('hold'), q = await question(f, app);
  await until(() => app.stats, stats => stats.modelCalls === 1);
  const other = launchBackend(['--data-dir', f.data, '--port', '0'], { env });
  t.after(() => { if (other.child.exitCode === null) other.child.kill('SIGKILL'); });
  assert.deepEqual(await startupMessage(other), { type: 'failed', code: 'DATABASE_BUSY' });
  assert.deepEqual(await other.exited, [1, null]);
  assert.equal((await app.run(q.ref.runId)).state, 'running');
  const abort = new AbortController(), first = await app.request(q.ref.eventsUrl, { signal: abort.signal });
  const reader = first.body.getReader(); const initial = Buffer.from((await reader.read()).value).toString(); assert.match(initial, /run.state/); abort.abort(); await reader.cancel().catch(() => {});
  const resumed = await app.request(q.ref.eventsUrl, { headers: { 'last-event-id': '1' } });
  app.child.kill('SIGUSR1'); const events = await resumed.text(); assert(!events.includes('id: 1\n')); assert.match(events, /run.completed/);
  const run = await until(() => app.run(q.ref.runId), terminal); assert.equal(run.state, 'succeeded');
  assert.equal(app.stats.modelCalls, 1); assert.equal(app.stats.messagePosts, 1);
  await app.stop();
  const db = new Database(path.join(f.data, 'state.sqlite'));
  db.prepare('UPDATE runs SET ended_at=? WHERE id=?').run(new Date(Date.now() - 25 * 3600000).toISOString(), run.id); db.close();
  const restarted = await f.launch(); const reset = await (await restarted.request(q.ref.eventsUrl)).text(); assert.match(reset, /stream.reset/);
  assert.equal((await restarted.run(run.id)).result.answerId, run.result.answerId); assert.equal(restarted.stats.modelCalls, 0); await restarted.stop();
});

for (const fault of ['commit-before', 'commit-after', 'hold']) test(`SIGKILL at ${fault} recovers an atomic result without another model call`, { timeout: 25000 }, async t => {
  const f = area(t), app = await f.launch(fault), q = await question(f, app);
  if (fault === 'hold') { await until(() => app.stats, stats => stats.modelCalls === 1); app.child.kill('SIGKILL'); }
  assert.deepEqual(await app.exited, [null, 'SIGKILL']);
  const restarted = await f.launch(), run = await restarted.run(q.ref.runId);
  assert.equal(run.state, fault === 'commit-after' ? 'succeeded' : 'interrupted');
  assert.equal((await restarted.json(q.route, q.body, q.key)).runId, q.ref.runId);
  await delay(100); assert.equal(restarted.stats.modelCalls, 0); await restarted.stop();
  const db = new Database(path.join(f.data, 'state.sqlite'), { readonly: true });
  try {
    const expected = fault === 'commit-after' ? 1 : 0;
    assert.equal(db.prepare('SELECT count(*) AS n FROM answers').get().n, expected);
    assert.equal(db.prepare('SELECT count(*) AS n FROM session_segments').get().n, expected);
    assert.equal(db.prepare("SELECT count(*) AS n FROM run_events WHERE type='answer.final'").get().n, expected);
    assert.equal(db.prepare("SELECT count(*) AS n FROM run_events WHERE type='run.completed'").get().n, 1);
    if (fault === 'hold') { assert.equal(db.prepare('SELECT state FROM model_attempts').get().state, 'unknown'); assert.equal(db.prepare('SELECT paused FROM model_batches').get().paused, 0); }
  } finally { db.close(); }
});

test('a killed isolated worker fails its task while the desktop backend remains available', { timeout: 20000 }, async t => {
  const f = area(t), app = await f.launch('worker'), q = await question(f, app);
  const run = await until(() => app.run(q.ref.runId), terminal); assert.equal(run.state, 'failed'); assert.equal(run.result, null);
  assert.equal((await fetch(app.origin + '/api/v1/health')).status, 200);
  assert.equal((await app.request(`/api/v1/sessions/${q.session.id}/messages`)).status, 200);
  assert.equal(app.stats.modelCalls, 1); await app.stop();
});
