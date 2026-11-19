import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildRenderer } from './build-renderer.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (process.version !== `v${pkg.engines.node}` || process.argv.length !== 2) throw new Error('DESKTOP_BUILD_ARGUMENTS');
if (!fs.existsSync(path.join(root, 'dist/.ready'))) throw new Error('BUILD_BACKEND_FIRST');
const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'en_US.UTF-8' };
for (const file of ['src/desktop/main.mjs', 'src/desktop/preload.cjs', 'src/desktop/service.mjs', 'src/desktop/bridge.mjs', 'src/desktop/vault-workspaces.mjs',
  'src/desktop/assets.mjs', 'src/desktop/client.mjs', 'src/desktop/files.mjs', 'src/desktop/workspace.mjs', 'src/desktop/paths.mjs', 'src/desktop/vault-discovery.mjs', 'scripts/desktop-backend.mjs', 'scripts/desktop.mjs']) {
  if (spawnSync(process.execPath, ['--check', file], { cwd: root, env, stdio: 'inherit' }).status !== 0) throw new Error('DESKTOP_SYNTAX_FAILED');
}
if (spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'src/desktop/renderer/tsconfig.json'],
  { cwd: root, env, stdio: 'inherit' }).status !== 0) throw new Error('DESKTOP_TYPECHECK_FAILED');
await buildRenderer(path.join(root, 'src/desktop/renderer'), path.join(root, 'dist/desktop'), './');
console.log('NoteTrail 桌面构建完成。');
