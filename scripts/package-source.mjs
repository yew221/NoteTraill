#!/usr/bin/env node
// Local candidate creation only; never uploads or publishes.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { sourceInventory, digest } from './distribution.mjs';

const root = fs.realpathSync(process.cwd()), output = process.argv[2];
assert(output && path.isAbsolute(output) && !fs.existsSync(output), 'Provide a new absolute output directory.');
const inventory = sourceInventory(root), files = { ...inventory.files,
  'README.md': digest(fs.readFileSync(path.join(root, 'scripts/source-package-readme.md'))) };
fs.mkdirSync(output, { mode: 0o700 }); const staging = path.join(output, 'notetrail-source'); fs.mkdirSync(staging, { mode: 0o700 });
for (const [file, hash] of Object.entries(files)) {
  assert(!file.split('/').some(p => ['outputs','node_modules','.git','.obsidian','dist'].includes(p)));
  assert(!/\.(sqlite|jsonl)$|(^|\/)\.env/.test(file));
  const bytes = fs.readFileSync(path.join(root, file === 'README.md' ? 'scripts/source-package-readme.md' : file));
  assert.equal(digest(bytes), hash, 'Source changed during packaging.');
  if (!/\.(pdf|docx)$/.test(file)) {
    const text = bytes.toString('utf8').replaceAll('/Users/你的用户名/', '<public-example>/');
    assert(!/\/Users\/[^/]+\/|#bootstrap=[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9_-]{20,}/.test(text), `Private-looking content: ${file}`);
  }
  const target = path.join(staging, file); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' });
}
const archive = path.join(output, 'notetrail-source-candidate.tar.gz');
const tar = spawnSync('/usr/bin/tar', ['-czf', archive, '-C', output, 'notetrail-source'], { env: { PATH: '/usr/bin:/bin', COPYFILE_DISABLE: '1' }, encoding: 'utf8' });
assert.equal(tar.status, 0, 'Archive failed.'); fs.chmodSync(archive, 0o600);
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ format: 'notetrail-source-candidate-v1', version: inventory.version,
  formalReleaseReady: false, files, fileCount: Object.keys(files).length, archiveSha256: digest(fs.readFileSync(archive)),
  checks: ['explicit runtime source allowlist', 'no private data directories or state files', 'credential and home path pattern scan', 'source hashes verified'],
  limitations: ['Pattern scanning is not proof of absence of all secrets.', 'Does not include dependency binaries or claim complete redistribution license audit.'] }, null, 2), { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ fileCount: Object.keys(files).length, archive, formalReleaseReady: false }));
