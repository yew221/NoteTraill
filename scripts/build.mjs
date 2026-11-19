#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
try {
  if (process.version !== `v${pkg.engines.node}`) throw new Error(`请使用 Node ${pkg.engines.node}。`);
  if (process.argv.length !== 2) throw new Error('用法：node scripts/build.mjs');
  // Refuse to erase an unknown directory or follow a replacement symlink.
  if (fs.existsSync(dist)) {
    if (fs.lstatSync(dist).isSymbolicLink() || !fs.existsSync(path.join(dist, '.notetrail-build'))) {
      throw new Error('dist 已存在且不是本工具的构建目录，请先检查其内容。');
    }
    fs.rmSync(dist, { recursive: true });
  }
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, '.notetrail-build'), 'NoteTrail generated build\n', { flag: 'wx' });
  const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'en_US.UTF-8' };
  const tsc = path.join(root, 'node_modules/typescript/bin/tsc');
  const result = spawnSync(process.execPath, [tsc, '--project', path.join(root, 'tsconfig.server.json')], {
    cwd: root, env, stdio: 'inherit', timeout: 60_000, killSignal: 'SIGKILL',
  });
  if (result.status !== 0) throw new Error('本机后台检查失败，未生成可启动版本。');
  for (const helper of ['keychain.py', 'vault-files.py', 'ingest-files.py', 'conversion-files.py', 'conversion-parser.py', 'pi-worker.mjs']) {
    if (helper.endsWith('.mjs')) {
      const checked = spawnSync(process.execPath, ['--check', path.join(root, 'src/server', helper)], { cwd: root, env, stdio: 'inherit', timeout: 10000 });
      if (checked.status !== 0) throw new Error(`${helper} 语法检查失败。`);
    }
    fs.copyFileSync(path.join(root, 'src/server', helper), path.join(dist, 'server', helper), fs.constants.COPYFILE_EXCL);
  }
  fs.copyFileSync(path.join(root, 'scripts/conversion-requirements.lock'), path.join(dist, 'server/conversion-requirements.lock'), fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(path.join(dist, '.ready'), `${pkg.version}\n`, { flag: 'wx' });
  console.log('NoteTrail 本机后台构建完成。');
} catch (error) {
  console.error(`构建失败：${error.message}`);
  process.exitCode = 1;
}
