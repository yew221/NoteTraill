import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { DesktopService } from '../src/desktop/service.mjs';
import { readRoute, trustedSender, publicFailure, DESKTOP_URL } from '../src/desktop/bridge.mjs';
import { assetPath, CONTENT_SECURITY_POLICY } from '../src/desktop/assets.mjs';
import { newId } from '../dist/server/contracts.js';
import { openStorage } from '../dist/server/storage.js';
import { requestControl } from '../dist/server/control.js';
import { desktopData } from './fixtures/desktop-data.mjs';
import { writeOriginalCopy, externalUrl } from '../src/desktop/files.mjs';

const root = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const directory = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-desktop-')));
const serviceAt = dataDirectory => new DesktopService({ root, dataDirectory, node: process.execPath,
  python: process.env.NOTETRAIL_PYTHON, rg: process.env.NOTETRAIL_RG });
const options = { timeout: 30000 };

test('production desktop child accepts a question and reports missing configuration without reading credentials', options, async t => {
  const dir = directory(), fixture = await desktopData(dir, 0), service = serviceAt(fixture.dataDirectory);
  t.after(async () => { await service.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await service.start();
  const session = await service.request({ op: 'createSession', input: { vaultId: fixture.vault.id, title: '未配置模型的公开测试' } });
  const ref = await service.request({ op: 'ask', sessionId: session.id, input: { text: '蓝盒在哪？', action: 'ask' }, key: randomUUID() });
  let run;
  for (let i = 0; i < 100; i++) {
    run = await service.request({ op: 'run', runId: ref.runId });
    if (run.state === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(run.state, 'failed'); assert.equal(run.error.code, 'CONFIG_REQUIRED'); assert.equal(run.usage.modelRequests, 0);
  assert.equal((await service.read({ op: 'messages', sessionId: session.id })).items.length, 1);
});

test('desktop bridge rejects writes, arbitrary URLs, malformed IDs, extra fields and prototype tricks', () => {
  const vaultId = newId('vault'), sessionId = newId('session'), answerId = newId('answer');
  assert.equal(readRoute({ op: 'vaults' }), '/api/v1/vaults');
  assert.match(readRoute({ op: 'sessions', vaultId }), /^\/api\/v1\/sessions\?vaultId=/);
  assert.match(readRoute({ op: 'messages', sessionId }), /\/messages\?limit=50$/);
  assert.equal(readRoute({ op: 'answer', answerId }), `/api/v1/answers/${answerId}`);
  assert.equal(readRoute({ op: 'settings' }), '/api/v1/settings');
  for (const request of [null, [], { op: 'unknownSettings' }, { op: 'fetch', url: 'https://example.com' },
    { op: 'vaults', method: 'POST' }, { op: 'vaults', headers: { cookie: 'secret' } },
    { op: 'messages', sessionId: '../settings' }, { op: 'sessions', vaultId, cursor: sessionId + '&x=1' },
    { op: 'messages', sessionId, cursor: sessionId }, Object.create({ op: 'vaults' })]) {
    assert.throws(() => readRoute(request), { code: 'BAD_REQUEST' });
  }
  assert.deepEqual(publicFailure('/private/sensitive/error'), publicFailure('SERVICE_UNAVAILABLE'));
});

test('only the application main frame may invoke desktop capabilities', () => {
  const mainFrame = { url: DESKTOP_URL }, webContents = { mainFrame };
  const window = { isDestroyed: () => false, webContents };
  assert(trustedSender({ sender: webContents, senderFrame: mainFrame }, window));
  for (const event of [{ sender: {}, senderFrame: mainFrame }, { sender: webContents, senderFrame: { url: DESKTOP_URL } },
    { sender: webContents, senderFrame: { url: 'https://example.com' } }, { sender: webContents, senderFrame: null }]) {
    assert.equal(trustedSender(event, window), false);
  }
  assert.equal(trustedSender({ sender: webContents, senderFrame: mainFrame }, { ...window, isDestroyed: () => true }), false);
});

test('desktop asset protocol never serves arbitrary local files or escaped symlinks', t => {
  const dir = directory(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'assets')); fs.writeFileSync(path.join(dir, 'index.html'), '<h1>public</h1>');
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'LOCAL_SENTINEL');
  fs.symlinkSync(path.join(dir, 'outside.txt'), path.join(dir, 'assets/outside.js'));
  assert.equal(assetPath(DESKTOP_URL, dir), path.join(dir, 'index.html'));
  for (const url of ['file:///etc/passwd', 'https://app/index.html', 'notetrail://other/index.html',
    'notetrail://app/../outside.txt', 'notetrail://app/assets/%2e%2e%2foutside.txt',
    'notetrail://app/assets/outside.js', 'notetrail://app/index.html?secret=1', 'notetrail://user:pass@app/index.html']) {
    assert.equal(assetPath(url, dir), null);
  }
  assert.match(CONTENT_SECURITY_POLICY, /connect-src 'none'/);
  assert(!CONTENT_SECURITY_POLICY.includes('unsafe-eval'));
});

test('desktop owns a real Node backend: auth, pagination, history, graceful stop and restart', options, async t => {
  const dir = directory(); const fixture = await desktopData(dir, 52);
  const original = fs.readFileSync(path.join(fixture.vaultPath, 'notes.md'));
  const service = serviceAt(fixture.dataDirectory), states = [];
  t.after(async () => { await service.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  service.on('status', status => states.push(status));
  await Promise.all([service.start(), service.start()]);
  assert.deepEqual(service.status(), { phase: 'ready' });
  const control = await requestControl(fixture.dataDirectory, 'status'); assert(control.running);
  const response = await fetch(`http://127.0.0.1:${control.port}/api/v1/vaults`);
  assert.equal(response.status, 401, 'A random browser must not inherit desktop authentication');
  const vaults = await service.read({ op: 'vaults' }); assert.equal(vaults.items[0].id, fixture.vault.id);
  const first = await service.read({ op: 'sessions', vaultId: fixture.vault.id });
  assert.equal(first.items.length, 50); assert(first.nextCursor);
  const second = await service.read({ op: 'sessions', vaultId: fixture.vault.id, cursor: first.nextCursor });
  assert.equal(second.items.length, 2); assert.equal(second.nextCursor, null);
  const messages = await service.read({ op: 'messages', sessionId: fixture.sessions[0].id });
  assert.equal(messages.items[0].text, '蓝盒放在哪里？');
  const answer = await service.read({ op: 'answer', answerId: messages.items[0].answerId });
  assert.equal(answer.answer.markdown, fixture.answers[0].markdown);
  assert(!JSON.stringify(states).match(/bootstrap|cookie|127\.0\.0\.1|token|dataDirectory/));
  await service.stop(); assert.equal((await requestControl(fixture.dataDirectory, 'status')).running, false);
  const storage = openStorage(fixture.dataDirectory); storage.close();
  await service.start();
  const restored = await service.read({ op: 'messages', sessionId: fixture.sessions[0].id });
  assert.deepEqual(restored, messages);
  assert.deepEqual(fs.readFileSync(path.join(fixture.vaultPath, 'notes.md')), original);
});

test('desktop session pages show recent activity first and retain their boundary across updates and restart', options, async t => {
  const dir = directory(), fixture = await desktopData(dir, 60), service = serviceAt(fixture.dataDirectory);
  t.after(async () => { await service.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const ids = fixture.sessions.map(s => s.id).sort().reverse(), storage = openStorage(fixture.dataDirectory);
  storage.db.prepare('UPDATE conversations SET updated_at=?').run('2020-01-01T00:00:00.000Z');
  storage.close(); await service.start();
  const request = { op: 'sessions', vaultId: fixture.vault.id };
  const first = await service.read(request);
  assert.deepEqual(first.items.map(s => s.id), ids.slice(0, 50));
  const legacy = await service.read({ ...request, cursor: first.items.at(-1).id });
  assert.deepEqual(legacy.items.map(s => s.id), ids.slice(50));
  await service.request({ op: 'ask', sessionId: first.items.at(-1).id, key: randomUUID(), input: { text: '更新最近活动', action: 'ask' } });
  const second = await service.read({ ...request, cursor: first.nextCursor });
  assert.deepEqual(second.items.map(s => s.id), ids.slice(50)); assert.equal(second.nextCursor, null);
  const newest = await service.request({ op: 'createSession', input: { vaultId: fixture.vault.id, title: '最新会话' } });
  assert.equal((await service.read(request)).items[0].id, newest.id);
  await service.stop(); await service.start();
  assert.equal((await service.read(request)).items[0].id, newest.id);
  await assert.rejects(service.read({ ...request, cursor: first.nextCursor + '&extra=1' }), { code: 'BAD_REQUEST' });
});

test('desktop refuses occupied data without stopping or altering its owner', options, async t => {
  const dir = directory(), data = path.join(dir, 'data'); const owner = openStorage(data), service = serviceAt(data);
  t.after(async () => { owner.close(); await service.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await assert.rejects(service.start(), { code: 'DATABASE_BUSY' });
  assert.equal(service.status().code, 'DATABASE_BUSY');
  assert.equal(owner.db.prepare('SELECT 1 AS ok').get().ok, 1);
  owner.close();
  await service.start(); assert.equal(service.status().phase, 'ready');
});

test('unknown data is retained and a missing runtime produces a recoverable failure', options, async t => {
  const dir = directory(), data = path.join(dir, 'data'); fs.mkdirSync(data, { mode: 0o700 });
  fs.writeFileSync(path.join(data, 'untouched.txt'), 'PUBLIC_SENTINEL');
  const service = serviceAt(data), missing = new DesktopService({ root, dataDirectory: data, node: path.join(dir, 'missing-node') });
  t.after(async () => { await service.stop(); await missing.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await assert.rejects(service.start(), { code: 'DATA_DIRECTORY_UNRECOGNIZED' });
  assert.equal(fs.readFileSync(path.join(data, 'untouched.txt'), 'utf8'), 'PUBLIC_SENTINEL');
  await assert.rejects(missing.start(), { code: 'START_FAILED' });
});

test('backend exits and releases its data lock when desktop IPC disconnects', options, async t => {
  const dir = directory(), data = path.join(dir, 'data');
  const child = fork(path.join(root, 'scripts/desktop-backend.mjs'), ['--port', '0', '--data-dir', data], {
    execPath: process.execPath, execArgv: [], cwd: root, env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', NOTETRAIL_INSTALL_ROOT: root },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let logs = ''; child.stdout.on('data', bytes => { logs += bytes; }); child.stderr.on('data', bytes => { logs += bytes; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); });
  const exited = once(child, 'exit');
  const [ready] = await once(child, 'message'); assert.equal(ready.type, 'ready');
  assert(!logs.includes(ready.bootstrapToken));
  child.disconnect(); await exited;
  child.stdout.destroy(); child.stderr.destroy();
  assert.equal((await requestControl(data, 'status')).running, false);
  const storage = openStorage(data); storage.close();
});

test('pi-gui copied source matches the recorded pin and retains its MIT notice', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'desktop/upstream.json'), 'utf8'));
  assert.equal(manifest.commit, 'dd5708fb61a38b5012d0ab149b62054d02c1c72f');
  for (const item of manifest.copiedFiles) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, item.local))).digest('hex'), item.sha256);
  assert.match(fs.readFileSync(path.join(root, 'desktop/PI_GUI_LICENSE'), 'utf8'), /Copyright \(c\) 2026 Matthew Lam/);
});

test('native original export never overwrites files or symlinks and only opens web links', t => {
  const dir = directory(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'original.md'), link = path.join(dir, 'link.md');
  writeOriginalCopy(file, Buffer.from('PUBLIC_ORIGINAL'));
  fs.symlinkSync(file, link);
  for (const target of [file, link]) assert.throws(() => writeOriginalCopy(target, Buffer.from('changed')), { code: 'EXPORT_EXISTS' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'PUBLIC_ORIGINAL');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['link.md', 'original.md']);
  assert.equal(externalUrl('https://example.org/hello'), 'https://example.org/hello');
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:password@example.org', 'broken']) assert.equal(externalUrl(url), null);
});
