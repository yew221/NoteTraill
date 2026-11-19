import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { ROOT, createRunDir } from '../scripts/verify_pi.mjs';
import { sqliteSandbox } from '../scripts/verify_storage.mjs';

test('SQLite native writes and network stay within the verification sandbox', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-storage-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runDir = createRunDir(root, 'guard', 'storage');
  const requireSqlite = path.join(ROOT, 'node_modules/better-sqlite3');
  const script = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const Database = require(${JSON.stringify(requireSqlite)});
    new Database(${JSON.stringify(path.join(runDir, 'allowed.sqlite'))}).close();
    assert.throws(() => new Database(${JSON.stringify(path.join(root, 'outside.sqlite'))}));
    assert.throws(() => fs.writeFileSync(${JSON.stringify(path.join(root, 'outside.txt'))}, 'x'), { code: 'EPERM' });
    const socket = require('node:net').connect({ host: '127.0.0.1', port: 9 });
    socket.on('connect', () => { throw new Error('network guard missing'); });
    socket.on('error', error => { assert.equal(error.code, 'EPERM'); });
  `;
  const child = spawnSync('/usr/bin/sandbox-exec', ['-p', sqliteSandbox(runDir), process.execPath, '-e', script],
    { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin' } });
  assert.equal(child.status, 0, child.stderr);
  assert(!fs.existsSync(path.join(root, 'outside.sqlite')));
  assert.throws(() => sqliteSandbox('/path\nwith-injection'), /invalid sandbox/);
});

test('Keychain probe rejects outside/reused targets before loading the native framework', (t) => {
  const runDir = createRunDir(ROOT, `keychain-guard-${process.pid}-${Date.now()}`, 'storage');
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const script = `
import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location('probe', ${JSON.stringify(path.join(ROOT, 'scripts/keychain_probe.py'))})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
target = module.target_path(${JSON.stringify(runDir)})
target.write_text('keep')
for directory in [${JSON.stringify(runDir)}, ${JSON.stringify(ROOT)}]:
    try: module.target_path(directory)
    except AssertionError: pass
    else: raise AssertionError('unsafe target accepted')
assert target.read_text() == 'keep'
`;
  const python = process.env.NOTETRAIL_PYTHON ?? path.join(os.homedir(), '.local/share/uv/tools/markitdown/bin/python');
  const child = spawnSync(python, ['-I', '-B', '-c', script], { encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(child.status, 0, child.stderr);
});
