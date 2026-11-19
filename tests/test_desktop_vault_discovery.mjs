import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverVaults } from '../src/desktop/vault-discovery.mjs';
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-vault-discovery-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
test('Obsidian registry discovery deduplicates aliases, reports missing paths and never reads notes', async t => {
  const root = fixture(t), vault = path.join(root, '公开库'), alias = path.join(root, 'alias'), registry = path.join(root, 'obsidian.json');
  fs.mkdirSync(vault); fs.symlinkSync(vault, alias); fs.writeFileSync(path.join(vault, 'unreadable.md'), 'PUBLIC_ONLY', { mode: 0 });
  fs.writeFileSync(registry, JSON.stringify({ vaults: { a: { path: vault }, b: { path: alias }, c: { path: path.join(root, 'missing') }, d: { path: '../invalid' } } }));
  const found = await discoverVaults({ registry }); assert.equal(found.items.length, 2);
  assert.equal(found.items.find(item => item.name === '公开库').state, 'available');
  assert.equal(found.items.find(item => item.name === 'missing').state, 'missing');
  assert.equal(found.warnings.length, 0);
});
test('optional folder scan is bounded, skips symlinks and private application directories', async t => {
  const root = fixture(t), chosen = path.join(root, 'chosen'); fs.mkdirSync(chosen);
  for (const name of ['nested/vault', '.hidden/vault', 'Library/vault', 'node_modules/vault']) fs.mkdirSync(path.join(chosen, name, '.obsidian'), { recursive: true });
  fs.mkdirSync(path.join(root, 'outside', '.obsidian'), { recursive: true }); fs.symlinkSync(path.join(root, 'outside'), path.join(chosen, 'linked'));
  const found = await discoverVaults({ registry: path.join(root, 'absent'), scanRoot: chosen });
  assert.deepEqual(found.items.map(item => item.absolutePath), [path.join(chosen, 'nested/vault')]); assert.equal(found.warnings.length, 1);
  assert.equal((await discoverVaults({ scanRoot: chosen, maxDepth: 1 })).items.length, 0);
  fs.writeFileSync(path.join(root, 'broken'), '{'); assert.equal((await discoverVaults({ registry: path.join(root, 'broken') })).warnings.length, 1);
});
