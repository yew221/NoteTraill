import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRunDir, hash, readFixture, workerEnvironment } from '../scripts/verify_pi.mjs';

function scratch(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-pi-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('run outputs reject reuse, traversal and directory symlinks', (t) => {
  const root = scratch(t);
  const output = createRunDir(root, 'first');
  fs.writeFileSync(path.join(output, 'keep'), 'original');
  assert.throws(() => createRunDir(root, 'first'), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(path.join(output, 'keep'), 'utf8'), 'original');
  for (const name of ['', '../escape', '/tmp/path', 'a/b', 'a'.repeat(65)]) {
    assert.throws(() => createRunDir(root, name), /invalid run ID/);
  }
  assert.throws(() => createRunDir(root, 'bad-category', '../escape'), /invalid verification category/);
  const second = scratch(t);
  fs.symlinkSync(root, path.join(second, 'outputs'));
  assert.throws(() => createRunDir(second, 'bad'), /symlinks/);
});

test('fixture reads reject changed bytes, oversized input and symlinks', (t) => {
  // macOS /var is a system symlink; normalize the test root as the launcher does.
  const root = fs.realpathSync(scratch(t));
  const file = path.join(root, 'sample.md');
  const text = '公开资料\n';
  const record = { bytes: Buffer.byteLength(text), sha256: hash(text) };
  fs.writeFileSync(file, text);
  assert.equal(readFixture(file, record), text);
  fs.writeFileSync(file, '其他资料\n');
  assert.throws(() => readFixture(file, record), /hash changed/);
  fs.writeFileSync(file, 'x'.repeat(16 * 1024 + 1));
  assert.throws(() => readFixture(file, record), /at most 16 KiB/);
  fs.writeFileSync(file, '\n'.repeat(201));
  assert.throws(() => readFixture(file, { bytes: 201, sha256: hash('\n'.repeat(201)) }), /200 lines/);
  const link = path.join(root, 'linked.md');
  fs.symlinkSync(file, link);
  assert.throws(() => readFixture(link, record), /symlinks/);
});

test('worker environment does not inherit credentials or Node startup hooks', () => {
  const old = process.env.NOTETRAIL_TEST_SECRET;
  process.env.NOTETRAIL_TEST_SECRET = 'must-not-cross';
  try {
    const env = workerEnvironment('/public-run');
    assert.equal(env.NOTETRAIL_TEST_SECRET, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.HOME, undefined);
    assert.deepEqual(Object.keys(env).sort(), ['LANG', 'PATH', 'PI_CODING_AGENT_DIR', 'PI_OFFLINE']);
  } finally {
    if (old === undefined) delete process.env.NOTETRAIL_TEST_SECRET;
    else process.env.NOTETRAIL_TEST_SECRET = old;
  }
});
