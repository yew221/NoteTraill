import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { launchBackend, startupMessage } from './fixtures/backend-process.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { claimPrefix, withInstallLock, canonicalTarget, cleanEnv, requireCleanToolchain, sourceInventory, run, failureText } from '../scripts/distribution.mjs';
import { openStorage } from '../dist/server/storage.js';
import { openControl, requestControl } from '../dist/server/control.js';
import { stopService } from '../scripts/stop.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-distribution-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
test('an interrupted legacy install must migrate to a fresh prefix and keeps its old files', t => {
  const prefix = claimPrefix(path.join(fixture(t), 'install'));
  const archive = path.join(prefix, 'cache/pnpm-old.archive');
  fs.writeFileSync(archive, 'previous download');
  assert.throws(() => requireCleanToolchain(prefix), { code: 'CLEAN_PREFIX_REQUIRED' });
  assert.equal(fs.readFileSync(archive, 'utf8'), 'previous download');
});
test('Python download deadline has its own retry hint and preserves ordinary install errors', async () => {
  const labels = { label: 'PYTHON_INSTALL_FAILED', timeoutLabel: 'PYTHON_DOWNLOAD_TIMEOUT' };
  await assert.rejects(run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { ...labels, timeout: 100 }),
    { code: 'PYTHON_DOWNLOAD_TIMEOUT' });
  await assert.rejects(run(process.execPath, ['-e', 'process.exit(1)'], labels), { code: 'PYTHON_INSTALL_FAILED' });
  assert.match(failureText({ code: 'PYTHON_DOWNLOAD_TIMEOUT' }), /同一目录用原命令重试/);
});
test('installation refuses unknown, shared, linked and project/vault directories without overwriting them', t => {
  const root = fixture(t), prefix = path.join(root, 'prefix');
  fs.mkdirSync(prefix, { mode: 0o700 }); fs.writeFileSync(path.join(prefix, 'mine'), 'public sentinel');
  assert.throws(() => claimPrefix(prefix), { code: 'INSTALL_DIRECTORY_UNKNOWN' }); assert.equal(fs.readFileSync(path.join(prefix, 'mine'), 'utf8'), 'public sentinel');
  const shared = path.join(root, 'shared'); fs.mkdirSync(shared, { mode: 0o755 }); fs.chmodSync(shared, 0o755);
  assert.throws(() => claimPrefix(shared), { code: 'INSTALL_DIRECTORY_INVALID' });
  const linked = path.join(root, 'linked'); fs.symlinkSync(prefix, linked);
  assert.throws(() => claimPrefix(linked), { code: 'INSTALL_DIRECTORY_INVALID' });
  fs.mkdirSync(path.join(root, '.obsidian')); assert.throws(() => canonicalTarget(path.join(root, 'new')), { code: 'INSTALL_DIRECTORY_INVALID' });
});
test('stop before a build gives a readable error and its help needs no build', t => {
  const root = fixture(t), script = path.join(root, 'stop.mjs'); fs.copyFileSync('scripts/stop.mjs', script);
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' }); assert.equal(help.status, 0);
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' }); assert.equal(result.status, 1);
  assert(result.stderr.includes('尚无完整构建')); assert(!result.stderr.includes(root));
});
test('OS installation lock excludes a second writer and releases on exception', { skip: process.platform !== 'darwin' }, async t => {
  const prefix = claimPrefix(path.join(fixture(t), 'prefix'));
  await withInstallLock(prefix, async () => { await assert.rejects(withInstallLock(prefix, async () => assert.fail()), { code: 'INSTALL_BUSY' }); });
  await assert.rejects(withInstallLock(prefix, async () => { throw new Error('fixture'); }), /fixture/);
  await withInstallLock(prefix, async () => {}); assert(fs.existsSync(path.join(prefix, '.operation-lock')));
});
test('managed environment uses only owned runtimes and excludes ambient credentials/configuration', () => {
  const env = cleanEnv('/private/example/release', '/private/example');
  assert.equal(env.NOTETRAIL_PYTHON, '/private/example/release/runtime/conversion/bin/python');
  assert.equal(env.NOTETRAIL_RG, '/private/example/release/runtime/rg/rg');
  for (const key of ['HOME', 'NODE_OPTIONS', 'PYTHONPATH', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'PI_CODING_AGENT_DIR']) assert.equal(env[key], undefined);
  assert.equal(env.npm_config_userconfig, '/dev/null'); assert.equal(env.UV_PYTHON_DOWNLOADS, 'never');
  assert(!Object.keys(sourceInventory(fs.realpathSync(process.cwd())).files).some(p => /node_modules|outputs|\.env/.test(p)));
  assert(!failureText({ message: 'PRIVATE_SENTINEL' }).includes('PRIVATE_SENTINEL'));
});
test('source package includes the desktop build and verification chain with one version', () => {
  const source = sourceInventory(fs.realpathSync(process.cwd()));
  const desktop = JSON.parse(fs.readFileSync('desktop/package.json'));
  assert.equal(source.version, desktop.version);
  for (const file of ['desktop/package.json', 'desktop/pnpm-lock.yaml', 'desktop/notetrail.icns', 'desktop/notetrail-dock.png', 'desktop/entitlements.plist',
    'scripts/build-desktop.mjs', 'scripts/build-renderer.mjs', 'scripts/js-install-lock.json', 'scripts/restore-js.py',
    'scripts/desktop-backend.mjs', 'scripts/package-desktop.mjs', 'scripts/verify-desktop.mjs',
    'src/server/conversion-parser.py', 'src/server/conversion-sandbox.ts', 'src/desktop/renderer/tsconfig.json']) assert(source.files[file], file);
});
test('desktop verification can be imported by a read-only stdin inspection', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
    input: "import { verifyDesktop } from './scripts/verify-desktop.mjs'; if (typeof verifyDesktop !== 'function') process.exit(1);",
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
});
test('OS installation lock is released when its owner is killed', { skip: process.platform !== 'darwin', timeout: 10000 }, async t => {
  const prefix = claimPrefix(path.join(fixture(t), 'prefix'));
  const code = `import { withInstallLock } from ${JSON.stringify(new URL('../scripts/distribution.mjs', import.meta.url).href)}; await withInstallLock(${JSON.stringify(prefix)}, async()=>{console.log('held'); await new Promise(()=>{});});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); await once(child.stdout, 'data');
  child.kill('SIGKILL'); await exited;
  await withInstallLock(prefix, async () => {}, 3);
});
test('control uses a short private socket even for long paths and requests graceful stop', async t => {
  const data = path.join(fixture(t), 'a'.repeat(100), 'b'.repeat(100)); fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  let control; control = await openControl(data, 43210, () => { void control.close(); });
  assert.deepEqual(await requestControl(data, 'status'), { protocol: 1, running: true, port: 43210 });
  await stopService(data); await stopService(data); assert.equal((await requestControl(data, 'status')).running, false);
});
test('formal server starts and stops through its own control socket, releases database ownership', { timeout: 20000 }, async t => {
  const root = fixture(t), data = path.join(root, 'data');
  const backend = launchBackend(['--port', '0', '--data-dir', data], { env: { PATH: '/usr/bin:/bin', PI_OFFLINE: '1' } });
  const { child, exited } = backend;
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const ready = await startupMessage(backend);
  assert.equal(ready.type, 'ready');
  let status;
  for (let i = 0; i < 100; i++) { status = await requestControl(data, 'status'); if (status.running) break; await delay(50); }
  assert(status.running, backend.logs());
  assert.equal((await fetch(`http://127.0.0.1:${status.port}/api/v1/health`)).status, 200);
  assert(!backend.logs().includes(ready.bootstrapToken));
  await stopService(data); assert.equal((await exited)[0], 0); openStorage(data).close();
});
