import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import Database from 'better-sqlite3';
import { openStorage, MIGRATIONS } from '../dist/server/storage.js';
import { VaultFiles } from '../dist/server/vault-files.js';
import { VaultService } from '../dist/server/vaults.js';
import { RunService } from '../dist/server/runs.js';
import { createApp } from '../dist/server/app.js';
import { BrowserSession, sessionCookie } from '../dist/server/session.js';
import { ApiError } from '../dist/server/contracts.js';

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const python = process.env.NOTETRAIL_PYTHON ?? path.join(os.homedir(), '.local/share/uv/tools/markitdown/bin/python');
const fails = code => error => error.publicError?.code === code;
const terminal = run => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.state);
async function until(check) {
  const deadline = performance.now() + 5000;
  while (!check()) { assert(performance.now() < deadline, 'Run did not reach expected state'); await delay(10); }
}
async function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-refresh-')));
  const vaultPath = path.join(directory, 'vault'); fs.mkdirSync(vaultPath); fs.writeFileSync(path.join(vaultPath, 'note.md'), 'PUBLIC_NOTE');
  const storage = openStorage(path.join(directory, 'data'));
  const files = new VaultFiles(python, [storage.directory, root]);
  const vaults = new VaultService(storage.db, files);
  const vault = await vaults.connect({ absolutePath: vaultPath, exclusions: [] });
  const runs = new RunService(storage.db, vaults);
  const token = randomBytes(32).toString('base64url'), session = new BrowserSession(token);
  const app = createApp(session, undefined, vaults, runs);
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const cookie = sessionCookie(session.exchange(token), app.server.address().port).split(';')[0];
  t.after(async () => { await app.close(); await runs.close(); await vaults.close(); storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const request = (route, options = {}) => fetch(`${origin}${route}`, { ...options,
    headers: { origin, cookie, ...options.headers } });
  return { directory, vaultPath, storage, files, vaults, vault, runs, app, origin, cookie, request,
    refresh: key => request(`/api/v1/vaults/${vault.id}/refresh`, { method: 'POST', headers: { 'idempotency-key': key } }) };
}
const parseEvents = text => text.split('\n\n').filter(frame => frame.includes('data: '))
  .map(frame => JSON.parse(frame.split('\n').find(line => line.startsWith('data: ')).slice(6)));

test('real HTTP refresh is accepted once per key, persists its result and emits ordered terminal events', async t => {
  const f = await fixture(t), key = randomUUID(), snapshot = f.files.snapshot.bind(f.files); let scans = 0;
  f.files.snapshot = (...args) => { scans++; return snapshot(...args); };
  const responses = await Promise.all([f.refresh(key), f.refresh(key)]);
  for (const response of responses) assert.equal(response.status, 202);
  const refs = await Promise.all(responses.map(r => r.json())); assert.equal(refs[0].data.runId, refs[1].data.runId);
  const id = refs[0].data.runId;
  await until(() => terminal(f.runs.get(id)));
  const response = await f.request(`/api/v1/runs/${id}`), run = (await response.json()).data;
  assert.equal(response.status, 200); assert.equal(run.state, 'succeeded'); assert.equal(scans, 1);
  assert.deepEqual(run.result, { scanned: 1, ready: 1, partial: 0, failed: 0, skipped: 0,
    pending: 0, unsupported: 0, needsReview: 0, missing: 0, excluded: 0 });
  assert.equal(run.usage.modelRequests, 0); assert.equal(run.usage.cost.value, 0);
  assert(run.createdAt <= run.startedAt && run.startedAt <= run.endedAt);
  const eventResponse = await f.request(`/api/v1/runs/${id}/events`);
  assert.match(eventResponse.headers.get('content-type'), /^text\/event-stream/);
  const events = parseEvents(await eventResponse.text());
  assert.deepEqual(events.map(e => e.eventId), [1, 2, 3, 4]);
  assert.deepEqual(events.filter(e => e.type === 'run.state').map(e => e.payload.state), ['queued', 'running', 'succeeded']);
  assert.equal(events.filter(e => e.type === 'run.completed').length, 1);
  const replay = await f.refresh(key); assert.equal((await replay.json()).data.runId, id);
  const observer = new Database(path.join(f.storage.directory, 'state.sqlite'), { readonly: true });
  try {
    assert.equal(observer.prepare('SELECT state FROM runs WHERE id=?').get(id).state, run.state);
    assert.equal(JSON.parse(observer.prepare('SELECT result_json FROM idempotency_records WHERE key=?').get(key).result_json).runId, id);
  } finally { observer.close(); }
  await delay(20); assert.equal(scans, 1);
});

test('refresh and task routes reject missing keys, extra payloads, foreign origins and unauthenticated reads', async t => {
  const f = await fixture(t), route = `/api/v1/vaults/${f.vault.id}/refresh`;
  for (const key of ['', 'short', 'a'.repeat(129), 'a'.repeat(16) + ',' + 'b'.repeat(16)]) {
    const response = await f.refresh(key); assert.equal(response.status, 400); await response.text();
  }
  for (const [endpoint, options, expected] of [
    [route, { method: 'POST' }, 400],
    [route, { method: 'POST', headers: { 'idempotency-key': randomUUID(), 'content-type': 'application/json' }, body: '{}' }, 400],
    [route + '?extra=true', { method: 'POST', headers: { 'idempotency-key': randomUUID() } }, 400],
    [route, { method: 'POST', headers: { cookie: '', 'idempotency-key': randomUUID() } }, 401],
    [route, { method: 'POST', headers: { origin: 'https://outside.invalid', 'idempotency-key': randomUUID() } }, 403],
  ]) { const response = await f.request(endpoint, options); assert.equal(response.status, expected); await response.text(); }
  const ref = f.runs.refresh(f.vault.id, randomUUID()); f.runs.cancel(ref.runId);
  for (const suffix of ['', '/events']) {
    const response = await f.request(`/api/v1/runs/${ref.runId}${suffix}`, { headers: { cookie: '' } });
    assert.equal(response.status, 401); await response.text();
  }
  for (const value of ['-1', '1.5', 'x', '9007199254740992', '1,2']) {
    const response = await f.request(`/api/v1/runs/${ref.runId}/events`, { headers: { 'last-event-id': value } });
    assert.equal(response.status, 400); await response.text();
  }
  assert.equal(f.storage.db.prepare('SELECT count(*) AS n FROM runs').get().n, 1);
});

test('queued cancellation never scans, and running cancellation cannot be replaced by a late success', async t => {
  const f = await fixture(t); let scans = 0, reached, finish;
  const ready = new Promise(resolve => { reached = resolve; });
  f.vaults.scan = async () => { scans++; reached(); await new Promise(resolve => { finish = resolve; }); return f.vault; };
  const queued = f.runs.refresh(f.vault.id, randomUUID());
  assert.equal(f.runs.cancel(queued.runId).state, 'cancelled');
  assert.equal(f.runs.cancel(queued.runId).state, 'cancelled');
  const running = f.runs.refresh(f.vault.id, randomUUID()); await ready;
  const response = await f.request(`/api/v1/runs/${running.runId}/cancel`, { method: 'POST' });
  assert.equal(response.status, 200); assert.equal((await response.json()).data.state, 'cancelling');
  finish(); await until(() => terminal(f.runs.get(running.runId)));
  assert.equal(f.runs.get(running.runId).state, 'cancelled'); assert.equal(f.runs.get(running.runId).result, null);
  assert.equal(scans, 1);
  for (const id of [queued.runId, running.runId]) assert.equal(f.runs.events(id, 0).items.filter(e => e.type === 'run.completed').length, 1);
});

test('failed scans return a failed task with an explicit error and retain the last committed catalog', async t => {
  const f = await fixture(t);
  f.files.snapshot = async () => { throw new ApiError('BUDGET_EXCEEDED'); };
  const response = await f.refresh(randomUUID()), id = (await response.json()).data.runId;
  await until(() => terminal(f.runs.get(id)));
  const current = await f.request(`/api/v1/runs/${id}`); assert.equal(current.status, 200);
  const run = (await current.json()).data;
  assert.equal(run.state, 'failed'); assert.equal(run.error.code, 'BUDGET_EXCEEDED'); assert.equal(run.result, null);
  assert.equal(f.vaults.sources(f.vault.id, {}).items.length, 1);
  assert.equal(f.runs.events(id, 0).items.filter(e => e.type === 'run.error').length, 1);
});

test('disconnecting a live event stream and resuming after an event does not restart a refresh', async t => {
  const f = await fixture(t), snapshot = f.files.snapshot.bind(f.files); let reached, release, scans = 0;
  const ready = new Promise(resolve => { reached = resolve; });
  f.files.snapshot = async (...args) => { scans++; const result = await snapshot(...args); reached(); await new Promise(resolve => { release = resolve; }); return result; };
  const ref = f.runs.refresh(f.vault.id, randomUUID()); await ready;
  const abort = new AbortController();
  const stream = await f.request(ref.eventsUrl, { signal: abort.signal });
  const reader = stream.body.getReader(); const first = await reader.read();
  assert.match(Buffer.from(first.value).toString(), /event: run.state/); abort.abort();
  await reader.cancel().catch(() => {});
  const resumed = f.request(ref.eventsUrl, { headers: { 'last-event-id': '1' } }).then(r => r.text());
  release(); const events = parseEvents(await resumed);
  assert.deepEqual(events.map(e => e.eventId), [2, 3, 4]); assert.equal(scans, 1);
  assert.equal(f.runs.get(ref.runId).state, 'succeeded');
});

test('expired or future event cursors return a snapshot reset without deleting results or idempotency', async t => {
  const f = await fixture(t), key = randomUUID(), ref = f.runs.refresh(f.vault.id, key);
  await until(() => terminal(f.runs.get(ref.runId)));
  let response = await f.request(ref.eventsUrl, { headers: { 'last-event-id': '9999' } });
  assert.equal(parseEvents(await response.text())[0].type, 'stream.reset');
  f.storage.db.prepare('UPDATE runs SET ended_at=? WHERE id=?').run(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), ref.runId);
  response = await f.request(ref.eventsUrl);
  const reset = parseEvents(await response.text())[0];
  assert.equal(reset.type, 'stream.reset'); assert.equal(reset.payload.snapshotUrl, `/api/v1/runs/${ref.runId}`);
  assert.equal(f.storage.db.prepare('SELECT count(*) AS n FROM run_events').get().n, 0);
  assert.equal(f.runs.get(ref.runId).result.ready, 1);
  assert.equal(f.runs.refresh(f.vault.id, key).runId, ref.runId);
});

test('queued refreshes run sequentially and shutdown interrupts active and queued work without restarting them', async t => {
  const f = await fixture(t), scan = f.vaults.scan.bind(f.vaults); let active = 0, peak = 0;
  f.vaults.scan = async (...args) => { active++; peak = Math.max(peak, active); try { await delay(20); return await scan(...args); } finally { active--; } };
  const ids = Array.from({ length: 3 }, () => f.runs.refresh(f.vault.id, randomUUID()).runId);
  await until(() => ids.every(id => terminal(f.runs.get(id)))); assert.equal(peak, 1);
  let reached; const ready = new Promise(resolve => { reached = resolve; });
  f.vaults.scan = async (_id, signal) => { reached(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new ApiError('RUN_INTERRUPTED')), { once: true })); };
  const running = f.runs.refresh(f.vault.id, randomUUID()); await ready;
  const queued = f.runs.refresh(f.vault.id, randomUUID());
  await f.runs.close();
  for (const ref of [running, queued]) {
    const run = f.runs.get(ref.runId); assert.equal(run.state, 'interrupted'); assert.equal(run.error.code, 'RUN_INTERRUPTED');
    assert.equal(f.runs.events(ref.runId, 0).items.filter(e => e.type === 'run.completed').length, 1);
  }
  assert.equal(f.runs.get(queued.runId).startedAt, null);
});

test('recovery interrupts persisted unfinished tasks and preserves their original retry identity', async t => {
  const f = await fixture(t), key = randomUUID();
  const ref = f.runs.refresh(f.vault.id, key); f.runs.cancel(ref.runId);
  await f.runs.close();
  // Simulate the database left by a process killed after recording running, before completion.
  f.storage.db.prepare("UPDATE runs SET state='running',stage='scanning',ended_at=NULL,result_json=NULL,error_json=NULL WHERE id=?").run(ref.runId);
  f.storage.db.prepare('DELETE FROM run_events WHERE run_id=? AND event_id>1').run(ref.runId);
  const recovered = new RunService(f.storage.db, f.vaults);
  try {
    const run = recovered.get(ref.runId); assert.equal(run.state, 'interrupted'); assert.equal(run.error.code, 'RUN_INTERRUPTED');
    assert.equal(recovered.refresh(f.vault.id, key).runId, ref.runId);
    assert.equal(recovered.events(ref.runId, 0).items.filter(e => e.type === 'run.completed').length, 1);
  } finally { await recovered.close(); }
});

test('task acceptance is atomic and the same idempotency key cannot bind another operation', async t => {
  const f = await fixture(t), key = randomUUID();
  f.storage.db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON run_events BEGIN SELECT RAISE(ABORT,'test fault'); END");
  assert.throws(() => f.runs.refresh(f.vault.id, key));
  assert.equal(f.storage.db.prepare('SELECT count(*) AS n FROM runs').get().n, 0);
  assert.equal(f.storage.db.prepare('SELECT count(*) AS n FROM idempotency_records').get().n, 0);
  f.storage.db.exec('DROP TRIGGER reject_event');
  const ref = f.runs.refresh(f.vault.id, key); f.runs.cancel(ref.runId);
  f.storage.db.prepare("UPDATE idempotency_records SET operation='ingest.create' WHERE key=?").run(key);
  assert.throws(() => f.runs.refresh(f.vault.id, key), fails('IDEMPOTENCY_CONFLICT'));
});

test('v3 migration preserves registered sources and creates a readable pre-upgrade backup', async t => {
  const f = await fixture(t), directory = path.join(f.directory, 'v3-data');
  const old = openStorage(directory, MIGRATIONS.slice(0, 3));
  const files = new VaultFiles(python, [directory, root]), service = new VaultService(old.db, files);
  const vault = await service.connect({ absolutePath: f.vaultPath, exclusions: [] });
  const before = service.sources(vault.id, {}).items;
  await service.close(); old.close();
  const upgraded = openStorage(directory);
  try {
    assert.equal(upgraded.db.pragma('user_version', { simple: true }), MIGRATIONS.length);
    const current = new VaultService(upgraded.db, new VaultFiles(python, [directory, root]));
    assert.deepEqual(current.sources(vault.id, {}).items, before); await current.close();
    const backup = new Database(path.join(directory, 'backups', fs.readdirSync(path.join(directory, 'backups'))[0]), { readonly: true });
    try { assert.equal(backup.pragma('user_version', { simple: true }), 3); assert.equal(backup.prepare('SELECT count(*) AS n FROM sources').get().n, 1); }
    finally { backup.close(); }
  } finally { upgraded.close(); }
});
