import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { launchBackend, connectBackend } from './fixtures/backend-process.mjs';
import test from 'node:test';
import Database from 'better-sqlite3';
import { openStorage, MIGRATIONS } from '../dist/server/storage.js';
import { VaultFiles } from '../dist/server/vault-files.js';
import { VaultService } from '../dist/server/vaults.js';
import { IngestFiles } from '../dist/server/ingest-files.js';
import { IngestService } from '../dist/server/ingestions.js';
import { RunService } from '../dist/server/runs.js';
import { ApiError } from '../dist/server/contracts.js';
import { createApp } from '../dist/server/app.js';
import { BrowserSession, sessionCookie } from '../dist/server/session.js';
import { MAX_FILE_BYTES } from '../dist/shared/vault.js';

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const python = process.env.NOTETRAIL_PYTHON ?? path.join(os.homedir(), '.local/share/uv/tools/markitdown/bin/python');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fails = code => error => error.publicError?.code === code;
async function finish(f, ref) {
  const deadline = performance.now() + 5000;
  while (!['succeeded', 'failed', 'cancelled', 'interrupted'].includes(f.runs.get(ref.runId).state)) {
    assert(performance.now() < deadline, 'Intake did not finish'); await delay(10);
  }
  return f.runs.get(ref.runId);
}
async function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-intake-')));
  const vaultPath = path.join(directory, 'vault'); fs.mkdirSync(vaultPath);
  const storage = openStorage(path.join(directory, 'data'));
  const vaults = new VaultService(storage.db, new VaultFiles(python, [storage.directory, root]));
  const vault = await vaults.connect({ absolutePath: vaultPath, exclusions: [] });
  const files = new IngestFiles(python, storage.directory, root), ingestions = new IngestService(storage.db, vaults, files);
  const runs = new RunService(storage.db, vaults, ingestions);
  const token = randomBytes(32).toString('base64url'), session = new BrowserSession(token);
  const app = createApp(session, undefined, vaults, runs);
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const cookie = sessionCookie(session.exchange(token), app.server.address().port).split(';')[0];
  t.after(async () => { await app.close(); await runs.close(); ingestions.close(); await vaults.close(); storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const request = (route, options = {}) => fetch(`${origin}${route}`, { ...options, headers: { origin, cookie, ...options.headers } });
  const input = (text = '# Public\n原文不会被改写。\n', title = '中文资料') => ({ vaultId: vault.id, input: { kind: 'text', text, title } });
  const post = (body, key = randomUUID(), headers = {}) => request('/api/v1/ingestions', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'idempotency-key': key, ...headers } });
  const operation = ref => storage.db.prepare('SELECT o.* FROM ingest_operations o JOIN runs r ON r.operation_id=o.id WHERE r.id=?').get(ref.runId);
  return { directory, vaultPath, storage, vaults, vault, files, ingestions, runs, app, origin, cookie, request, input, post, operation };
}

test('real JSON intake preserves exact text, publishes one source and exposes saved-before-ready progress', async t => {
  const f = await fixture(t), input = f.input(); input.input.origin = 'imported_chat';
  const started = performance.now(), response = await f.post(input);
  assert.equal(response.status, 202); const acceptedMs = Math.round(performance.now() - started), ref = (await response.json()).data;
  const run = await finish(f, ref); assert.equal(run.state, 'succeeded', JSON.stringify(run.error)); assert.equal(run.kind, 'ingest');
  const source = f.vaults.source(run.result.sourceId);
  assert.equal(source.origin, 'imported_chat'); assert.equal(source.state, 'ready'); assert.equal(source.originalSaved, true);
  assert.match(source.relativePath, /^助手资料\/原件\/s_[a-f0-9-]+\/中文资料\.md$/);
  assert.equal(fs.readFileSync(path.join(f.vaultPath, source.relativePath), 'utf8'), input.input.text);
  const content = await f.request(`/api/v1/sources/${source.id}/content?view=text&expectedVersion=${source.version}`);
  assert.equal(content.status, 200); assert.equal(await content.text(), input.input.text);
  const events = f.runs.events(run.id, 0).items;
  assert.deepEqual(events.filter(e => e.type === 'source.updated').map(e => e.payload.sourceState), ['pending', 'ready']);
  assert(!JSON.stringify(events).includes(input.input.text)); assert.equal(run.usage.modelRequests, 0);
  assert.equal(f.operation(ref).phase, 'registered'); assert.equal(f.operation(ref).staged, 0);
  assert.deepEqual(fs.readdirSync(path.join(f.storage.directory, 'staging')), ['.notetrail-staging']);
  await f.vaults.scan(f.vault.id); assert.equal(f.vaults.sources(f.vault.id, {}).items.length, 1);
  t.diagnostic(JSON.stringify({ scenario: 'text_intake', acceptedMs, sourceState: source.state }));
});

test('real multipart intake preserves arbitrary binary bytes and readable plain text with the same endpoint', async t => {
  const f = await fixture(t);
  for (const [filename, bytes, expected] of [['二进制.bin', Buffer.from([0, 255, 1, 13, 10, 45, 45]), 'unsupported'],
    ['正文.txt', Buffer.from('纯文本原件。\nSecond line.'), 'ready']]) {
    const form = new FormData(); form.set('meta', JSON.stringify({ vaultId: f.vault.id, input: { kind: 'upload', filePart: 'file' } }));
    form.set('file', new File([bytes], filename));
    const response = await f.request('/api/v1/ingestions', { method: 'POST', body: form, headers: { 'idempotency-key': randomUUID() } });
    assert.equal(response.status, 202); const run = await finish(f, (await response.json()).data); assert.equal(run.state, 'succeeded');
    const source = f.vaults.source(run.result.sourceId); assert.equal(source.state, expected); assert.equal(source.version, hash(bytes));
    assert.deepEqual(fs.readFileSync(path.join(f.vaultPath, source.relativePath)), bytes);
    const original = await f.request(`/api/v1/sources/${source.id}/content?view=original&expectedVersion=${source.version}`);
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
    if (expected === 'ready') assert.equal((await f.vaults.content(source.id, 'text', source.version)).bytes.toString(), bytes.toString());
  }
});

test('simultaneous duplicate requests share one original; a changed payload conflicts and repeated names remain separate', async t => {
  const f = await fixture(t), key = randomUUID();
  const responses = await Promise.all([f.post(f.input('FIRST', 'same'), key), f.post(f.input('FIRST', 'same'), key)]);
  for (const response of responses) assert.equal(response.status, 202);
  const refs = await Promise.all(responses.map(async r => (await r.json()).data)); assert.equal(refs[0].runId, refs[1].runId);
  const first = await finish(f, refs[0]); assert.equal(first.state, 'succeeded');
  const conflict = await f.post(f.input('CHANGED', 'same'), key); assert.equal(conflict.status, 409); await conflict.text();
  const secondResponse = await f.post(f.input('SECOND', 'same')); const second = await finish(f, (await secondResponse.json()).data);
  const a = f.vaults.source(first.result.sourceId), b = f.vaults.source(second.result.sourceId);
  assert.notEqual(a.id, b.id); assert.notEqual(a.relativePath, b.relativePath); assert.equal(a.title, b.title);
  assert.equal(fs.readFileSync(path.join(f.vaultPath, a.relativePath), 'utf8'), 'FIRST');
  assert.equal(fs.readFileSync(path.join(f.vaultPath, b.relativePath), 'utf8'), 'SECOND');
  assert.deepEqual(fs.readdirSync(path.join(f.storage.directory, 'staging')), ['.notetrail-staging']);
});

test('invalid intent, metadata, duplicate parts, missing keys and oversized input do not create a source', async t => {
  const f = await fixture(t);
  for (const body of [{ ...f.input(), extra: true }, { ...f.input(), input: { kind: 'text', text: '' } },
    { ...f.input(), input: { kind: 'text', text: '\ud800' } }, { ...f.input(), input: { kind: 'upload', filePart: 'file' } },
    { ...f.input(), input: { kind: 'url', url: 'https://example.com/', extra: true } },
    { ...f.input(), input: { kind: 'text', text: 'public', outputPath: '/outside' } }]) {
    const response = await f.post(body); assert.equal(response.status, 400); await response.text();
  }
  for (const headers of [{ 'idempotency-key': '' }, { cookie: '' }, { origin: 'https://outside.invalid' }]) {
    const response = await f.post(f.input(), randomUUID(), headers); assert([400, 401, 403].includes(response.status)); await response.text();
  }
  const form = new FormData(); form.append('meta', JSON.stringify(f.input())); form.append('meta', JSON.stringify(f.input())); form.append('file', new File(['x'], 'x.md'));
  const response = await f.request('/api/v1/ingestions', { method: 'POST', body: form, headers: { 'idempotency-key': randomUUID() } });
  assert.equal(response.status, 400); await response.text();
  assert.throws(() => f.ingestions.normalize({ vaultId: f.vault.id, input: { kind: 'upload', filePart: 'file' } },
    { filename: 'big.pdf', bytes: Buffer.alloc(MAX_FILE_BYTES + 1) }), fails('FILE_TOO_LARGE'));
  assert.deepEqual(fs.readdirSync(f.vaultPath), []); assert.equal(f.vaults.sources(f.vault.id, {}).items.length, 0);
  assert(!fs.existsSync(path.join(f.storage.directory, 'staging')));
});

test('unknown managed folders and symlinked destinations are preserved without writing outside the vault', async t => {
  const f = await fixture(t), managed = path.join(f.vaultPath, '助手资料'); fs.mkdirSync(managed); fs.writeFileSync(path.join(managed, 'user.md'), 'USER_FILE');
  let response = await f.post(f.input()), run = await finish(f, (await response.json()).data);
  assert.equal(run.state, 'failed'); assert.equal(run.error.code, 'VAULT_ACCESS_DENIED');
  assert.deepEqual(fs.readdirSync(managed), ['user.md']); assert.equal(fs.readFileSync(path.join(managed, 'user.md'), 'utf8'), 'USER_FILE');
  const outside = path.join(f.directory, 'outside'); fs.renameSync(managed, outside); fs.symlinkSync(outside, managed);
  response = await f.post(f.input()); run = await finish(f, (await response.json()).data);
  assert.equal(run.state, 'failed'); assert.equal(run.error.code, 'PATH_OUTSIDE_SCOPE');
  assert.deepEqual(fs.readdirSync(outside), ['user.md']);
});

test('queued cancellation and range revocation retain staged data without publishing a new original', { timeout: 10000 }, async t => {
  const f = await fixture(t), queued = await f.runs.ingest(f.input(), randomUUID());
  assert.equal(f.runs.cancel(queued.runId).state, 'cancelled');
  const operation = f.operation(queued);
  const stopped = f.vaults.source(operation.source_id);
  assert.equal(stopped.originalSaved, false); assert.equal(stopped.state, 'failed');
  assert.equal(stopped.warnings[0].code, 'RUN_INTERRUPTED');
  await f.ingestions.recover(); assert(!fs.existsSync(path.join(f.vaultPath, '助手资料')));
  let entered; const ready = new Promise(resolve => { entered = resolve; });
  const publish = f.files.publish.bind(f.files);
  f.files.publish = async (value, signal, recover) => {
    if (recover) return publish(value, signal, recover);
    entered(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new ApiError('RUN_INTERRUPTED')), { once: true }));
  };
  const running = await f.runs.ingest(f.input('REVOKED'), randomUUID()); await ready;
  f.vaults.update(f.vault.id, { expectedRevision: 1, exclusions: ['助手资料/'] });
  const run = await finish(f, running); assert.equal(run.state, 'failed'); assert.equal(run.error.code, 'CONTEXT_CHANGED');
  assert(!fs.existsSync(path.join(f.vaultPath, '助手资料')));
  assert.equal(f.vaults.source(f.operation(running).source_id).state, 'excluded');
});

test('an explicitly retried queued cancellation saves the same staged original once', async t => {
  const f = await fixture(t), ref = await f.runs.ingest(f.input(), randomUUID());
  f.runs.cancel(ref.runId);
  const id = f.operation(ref).source_id;
  const run = await finish(f, f.runs.retry(id, randomUUID()));
  assert.equal(run.state, 'succeeded'); assert.equal(run.result.sourceId, id);
  assert.equal(f.vaults.source(id).originalSaved, true);
});

test('a failure after atomic publication can recover the same source without another file or overwriting bytes', async t => {
  const f = await fixture(t), publish = f.files.publish.bind(f.files);
  f.files.publish = async (...args) => { const saved = await publish(...args); if (!args[2]) throw new ApiError('SERVICE_UNAVAILABLE'); return saved; };
  const ref = await f.runs.ingest(f.input('RECOVERABLE'), randomUUID()), run = await finish(f, ref);
  assert.equal(run.state, 'failed'); const operation = f.operation(ref), source = f.vaults.source(operation.source_id);
  const file = path.join(f.vaultPath, source.relativePath), before = fs.statSync(file);
  assert.equal(source.originalSaved, false); assert.equal(operation.phase, 'prepared');
  await f.ingestions.recover();
  const after = f.vaults.source(source.id); assert.equal(after.originalSaved, true); assert.equal(after.state, 'ready');
  assert.equal(fs.statSync(file).ino, before.ino); assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
  assert.equal(fs.readFileSync(file, 'utf8'), 'RECOVERABLE'); assert.equal(f.operation(ref).staged, 0);
  assert.equal(f.runs.get(ref.runId).state, 'failed');
});

test('recovery refuses a modified published original and leaves both versions available for review', async t => {
  const f = await fixture(t), publish = f.files.publish.bind(f.files);
  f.files.publish = async (...args) => { const saved = await publish(...args); if (!args[2]) throw new ApiError('SERVICE_UNAVAILABLE'); return saved; };
  const ref = await f.runs.ingest(f.input('SUBMITTED'), randomUUID()); await finish(f, ref);
  const op = f.operation(ref), source = f.vaults.source(op.source_id), file = path.join(f.vaultPath, source.relativePath);
  fs.writeFileSync(file, 'USER_CHANGED'); await f.ingestions.recover();
  assert.equal(fs.readFileSync(file, 'utf8'), 'USER_CHANGED');
  assert.equal(fs.readFileSync(path.join(f.storage.directory, 'staging', `${op.id}.bin`), 'utf8'), 'SUBMITTED');
  await f.vaults.scan(f.vault.id); assert.equal(f.vaults.source(source.id).version, hash('USER_CHANGED'));
});

test('non-text originals are saved but unavailable conversion is not reported as a completed intake', async t => {
  const f = await fixture(t), bytes = Buffer.from('PUBLIC_PDF_PENDING_CONVERTER');
  const ref = await f.runs.ingest({ vaultId: f.vault.id, input: { kind: 'upload', filePart: 'file' } }, randomUUID(), { filename: 'pending.pdf', bytes });
  const run = await finish(f, ref); assert.equal(run.state, 'failed'); assert.equal(run.error.code, 'SOURCE_NOT_READY');
  const source = f.vaults.source(f.operation(ref).source_id);
  assert.equal(source.originalSaved, true); assert.equal(source.state, 'pending'); assert.equal(source.readableRepresentation, null);
  assert.deepEqual(fs.readFileSync(path.join(f.vaultPath, source.relativePath)), bytes);
});

test('intake accepts a 51st file and staged metadata is not mistaken for a second source', async t => {
  const f = await fixture(t); for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(f.vaultPath, `public-${i}.md`), 'PUBLIC_EXISTING');
  const ref = await f.runs.ingest(f.input(), randomUUID()), run = await finish(f, ref);
  assert.equal(run.state, 'succeeded');
  const source = f.vaults.source(f.operation(ref).source_id); assert.equal(source.originalSaved, true);
  await f.vaults.scan(f.vault.id); assert.equal(f.vaults.get(f.vault.id).discovery.scanned, 51);
});

test('the native exclusive rename rejects a destination created immediately before publication', async t => {
  const f = await fixture(t), intake = f.ingestions.normalize(f.input('SUBMITTED')), staged = await f.ingestions.stage(intake);
  const { revision, ...location } = f.vaults.context(f.vault.id);
  const request = { op: 'publish', storageRoot: f.storage.directory, forbiddenRoots: [f.storage.directory, root], ...location,
    operationId: staged.operationId, sourceId: staged.sourceId, vaultId: f.vault.id, filename: intake.filename, version: intake.version };
  const code = `import importlib.util,json,os,errno\nspec=importlib.util.spec_from_file_location('ingest',${JSON.stringify(path.join(root, 'dist/server/ingest-files.py'))})\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nrequest=json.loads(${JSON.stringify(JSON.stringify(request))})\nwrite=m.write_new\ndef race(tree,name,content):\n    write(tree,name,content)\n    if name.startswith('.notetrail-temp-'):\n        write(tree,request['filename'],b'USER_CREATED')\nm.write_new=race\ntry:m.operate(request)\nexcept OSError as error:assert error.errno==errno.EEXIST\nelse:raise AssertionError('destination overwritten')\nprint('exclusive publication rejected')\n`;
  const result = spawnSync(python, ['-I', '-B', '-c', code], { encoding: 'utf8', timeout: 5000 }); assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(f.vaultPath, staged.relativePath), 'utf8'), 'USER_CREATED');
});

test('v4 upgrade retains the prior schema in its backup and malformed staging calls have no filesystem effects', async t => {
  const f = await fixture(t), legacyPath = path.join(f.directory, 'legacy');
  const legacy = openStorage(legacyPath, MIGRATIONS.slice(0, 4)); legacy.close();
  const upgraded = openStorage(legacyPath);
  try {
    assert.equal(upgraded.db.pragma('user_version', { simple: true }), MIGRATIONS.length);
    const backup = new Database(path.join(legacyPath, 'backups', fs.readdirSync(path.join(legacyPath, 'backups'))[0]), { readonly: true });
    try { assert.equal(backup.pragma('user_version', { simple: true }), 4); }
    finally { backup.close(); }
  } finally { upgraded.close(); }
  const response = spawnSync(python, ['-I', '-B', path.join(root, 'dist/server/ingest-files.py')], {
    input: JSON.stringify({ op: 'stage', storageRoot: f.storage.directory, operationId: '../outside' }), encoding: 'utf8', timeout: 5000 });
  assert.equal(response.status, 0); assert.deepEqual(JSON.parse(response.stdout), { ok: false, error: 'BAD_REQUEST' });
  assert(!fs.existsSync(path.join(f.storage.directory, 'staging')));
});

test('formal startup recovers an original after the writer process is killed between file publication and database registration', { timeout: 15000 }, async t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-intake-crash-')));
  const volume = process.env.NOTETRAIL_TEST_VOLUME;
  const vaultPath = volume ? fs.mkdtempSync(path.join(fs.realpathSync(volume), 'intake-crash-')) : path.join(directory, 'vault'), dataPath = path.join(directory, 'data');
  if (!volume) fs.mkdirSync(vaultPath);
  else { assert.notEqual(fs.statSync(vaultPath).dev, fs.statSync(directory).dev); t.diagnostic('Original publication SIGKILL uses distinct real filesystem devices'); }
  const children = [];
  t.after(async () => {
    for (const item of children) {
      if (item.child.exitCode === null && item.child.signalCode === null) { item.child.kill('SIGKILL'); await item.exited; }
    }
    fs.rmSync(directory, { recursive: true, force: true });
    if (volume) fs.rmSync(vaultPath, { recursive: true, force: true });
  });
  async function launch(crash) {
    const injection = crash ? `const {IngestFiles}=await import('./dist/server/ingest-files.js'); const publish=IngestFiles.prototype.publish; IngestFiles.prototype.publish=async function(...args){const result=await publish.apply(this,args);if(!args[2])process.kill(process.pid,'SIGKILL');return result;};` : '';
    const backend = launchBackend(['--data-dir', dataPath, '--port', '0'], { beforeStart: injection, cwd: root, env: {
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'en_US.UTF-8', NOTETRAIL_PYTHON: python } });
    children.push(backend);
    return { ...backend, ...(await connectBackend(backend)) };
  }
  const first = await launch(true);
  const connected = await first.request('/api/v1/vaults', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ absolutePath: vaultPath, exclusions: [] }) });
  const vault = (await connected.json()).data, key = randomUUID();
  const body = JSON.stringify({ vaultId: vault.id, input: { kind: 'text', title: 'Crash recovery', text: 'DURABLE_PUBLIC_ORIGINAL' } });
  const accepted = await first.request('/api/v1/ingestions', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body });
  assert.equal(accepted.status, 202); const ref = (await accepted.json()).data;
  assert.deepEqual(await first.exited, [null, 'SIGKILL']);
  const database = new Database(path.join(dataPath, 'state.sqlite'), { readonly: true }); let saved;
  try {
    saved = database.prepare('SELECT s.*,o.phase FROM sources s JOIN ingest_operations o ON o.source_id=s.id').get();
    // The watcher can see the published file first; the operation must still be unregistered.
    assert.equal(saved.phase, 'prepared');
  } finally { database.close(); }
  const originalPath = path.join(vaultPath, saved.relative_path), inode = fs.statSync(originalPath).ino;
  assert.equal(fs.readFileSync(originalPath, 'utf8'), 'DURABLE_PUBLIC_ORIGINAL');
  const restarted = await launch(false);
  const source = (await (await restarted.request(`/api/v1/sources/${saved.id}`)).json()).data;
  assert.equal(source.originalSaved, true); assert.equal(source.state, 'ready'); assert.equal(fs.statSync(originalPath).ino, inode);
  const run = (await (await restarted.request(`/api/v1/runs/${ref.runId}`)).json()).data;
  assert.equal(run.state, 'interrupted'); assert.equal(run.error.code, 'RUN_INTERRUPTED');
  const replay = await restarted.request('/api/v1/ingestions', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body });
  assert.equal((await replay.json()).data.runId, ref.runId);
  const listing = (await (await restarted.request(`/api/v1/vaults/${vault.id}/sources`)).json()).data.items;
  assert.equal(listing.length, 1); assert.equal(listing[0].id, saved.id);
  restarted.child.kill('SIGTERM'); assert.deepEqual(await restarted.exited, [0, null]);
});


test('a 25 MiB upload passes HTTP, staging, publication, rescan and original retrieval', { timeout: 30000 }, async t => {
  const f = await fixture(t), bytes = Buffer.alloc(25 * 1024 * 1024, 65);
  const form = new FormData(); form.set('meta', JSON.stringify({ vaultId: f.vault.id, input: { kind: 'upload', filePart: 'file' } }));
  form.set('file', new File([bytes], 'large-public.txt'));
  const response = await f.request('/api/v1/ingestions', { method: 'POST', body: form, headers: { 'idempotency-key': randomUUID() } });
  assert.equal(response.status, 202); const run = await finish(f, (await response.json()).data);
  assert.equal(run.state, 'succeeded', JSON.stringify(run.error));
  await f.vaults.scan(f.vault.id);
  const source = f.vaults.source(run.result.sourceId); assert.equal(source.state, 'ready'); assert.equal(source.version, hash(bytes));
  const original = await f.request(`/api/v1/sources/${source.id}/content?view=original&expectedVersion=${source.version}`);
  assert.equal(original.status, 200); assert.equal(hash(Buffer.from(await original.arrayBuffer())), hash(bytes));
});
