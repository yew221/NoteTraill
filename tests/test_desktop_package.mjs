import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { desktopPaths } from '../src/desktop/paths.mjs';
import { inventory, verifiedRuntime } from '../scripts/package-desktop.mjs';

test('installed desktop uses bundled runtimes and separate durable data, with validated isolation overrides', () => {
  const options = { packaged: true, resources: '/Applications/NoteTrail.app/Contents/Resources', home: '/Users/example',
    env: { NOTETRAIL_NODE: '/untrusted/node', NOTETRAIL_DATA_DIR: '/untrusted/data', NOTETRAIL_PYTHON: '/untrusted/python' } };
  const result = desktopPaths(options);
  assert.equal(result.dataDirectory, '/Users/example/Library/Application Support/NoteTrail');
  assert.equal(result.node, options.resources + '/runtime/node/bin/node');
  assert.equal(result.python, options.resources + '/runtime/python/bin/python3.12');
  assert.equal(desktopPaths({ ...options, args: ['--data-dir', '/test/data', '--profile-dir', '/test/profile'] }).dataDirectory, '/test/data');
  for (const args of [['--data-dir'], ['--data-dir', 'relative'], ['--data-dir', '/data', '--data-dir', '/second'],
    ['--inspect', '/x'], ['--profile-dir', '/data/profile', '--data-dir', '/data'], ['--profile-dir', '/same', '--data-dir', '/same']]) {
    assert.throws(() => desktopPaths({ ...options, args }));
  }
});

test('package inventory detects external links and runtime verification excludes only uncopied caches', t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-package-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const relative = 'releases/r_' + randomUUID(), release = path.join(dir, relative);
  fs.mkdirSync(release, { recursive: true, mode: 0o700 });
  for (const name of ['app', 'runtime', 'config']) fs.mkdirSync(path.join(release, name));
  const executable = path.join(release, 'runtime/python'); fs.writeFileSync(executable, 'CHECKED_RUNTIME', { mode: 0o700 });
  const expected = inventory(release);
  fs.writeFileSync(path.join(release, 'receipt.json'), JSON.stringify({ format: 'notetrail-install-v1', relative, dataDirectory: '/test/data', inventory: expected }), { mode: 0o600 });
  fs.symlinkSync(relative, path.join(dir, 'current'));
  fs.mkdirSync(path.join(release, 'app/__pycache__'));
  fs.writeFileSync(path.join(release, 'app/__pycache__/generated.pyc'), 'UNPACKAGED_CACHE');
  assert.equal(verifiedRuntime(dir).root, release);
  fs.writeFileSync(executable, 'CHANGED_RUNTIME');
  assert.throws(() => verifiedRuntime(dir), /INSTALL_CHANGED/);
  fs.writeFileSync(executable, 'CHECKED_RUNTIME');
  fs.writeFileSync(path.join(release, 'app/unlisted.js'), 'UNLISTED_EXECUTABLE');
  assert.throws(() => verifiedRuntime(dir), /INSTALL_CHANGED/);
  fs.unlinkSync(path.join(release, 'app/unlisted.js'));
  fs.symlinkSync('/usr/bin/true', path.join(release, 'runtime/external'));
  assert.throws(() => inventory(release), /EXTERNAL_BUNDLE_LINK/);
  assert.throws(() => verifiedRuntime(dir), /EXTERNAL_BUNDLE_LINK/);
});
