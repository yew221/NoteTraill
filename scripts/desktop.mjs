import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const root = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
try {
  if (process.argv[2] === '--help' && process.argv.length === 3) {
    console.log('用法：node scripts/desktop.mjs [--data-dir /绝对路径] [--profile-dir /绝对路径]\n默认连接现有 NoteTrail 本机数据，支持提问、停止、范围选择和引用核对。');
  } else {
    if (process.version !== `v${pkg.engines.node}`) throw new Error(`请使用 Node ${pkg.engines.node}。`);
    if (!fs.existsSync(path.join(root, 'dist/desktop/index.html'))) throw new Error('请先运行 node scripts/build.mjs 和 node scripts/build-desktop.mjs。');
    let dataDirectory = path.join(os.homedir(), 'Library/Application Support/NoteTrail');
    let profile = path.join(os.homedir(), 'Library/Application Support/NoteTrail Desktop');
    const seen = new Set();
    for (let i = 2; i < process.argv.length; i += 2) {
      const name = process.argv[i], value = process.argv[i + 1];
      if (seen.has(name) || !value || !path.isAbsolute(value) || value.includes('\0')) throw new Error('启动参数不正确，请查看 --help。');
      seen.add(name);
      if (name === '--data-dir') dataDirectory = path.normalize(value);
      else if (name === '--profile-dir') profile = path.normalize(value);
      else throw new Error('启动参数不正确，请查看 --help。');
    }
    // Electron cache files must never occupy the backend's private data directory.
    if (profile === dataDirectory || profile.startsWith(dataDirectory + '/') || dataDirectory.startsWith(profile + '/')) {
      throw new Error('桌面缓存与知识库数据必须使用分开的目录。');
    }
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(profile);
    if (!stat.isDirectory() || fs.realpathSync(profile) !== profile || stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0) throw new Error('桌面缓存目录权限不符合要求。');
    const electron = createRequire(path.join(root, 'desktop/package.json'))('electron');
    const child = spawn(electron, [path.join(root, 'desktop')], { cwd: root, stdio: 'inherit', env: {
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: os.homedir(), LANG: 'en_US.UTF-8',
      NOTETRAIL_NODE: process.execPath, NOTETRAIL_DATA_DIR: dataDirectory, NOTETRAIL_DESKTOP_PROFILE: profile,
      ...(process.env.NOTETRAIL_PYTHON ? { NOTETRAIL_PYTHON: process.env.NOTETRAIL_PYTHON } : {}),
      ...(process.env.NOTETRAIL_RG ? { NOTETRAIL_RG: process.env.NOTETRAIL_RG } : {}),
    } });
    const stop = () => child.kill('SIGTERM');
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    child.once('error', () => { console.error('桌面运行组件不可用，请安装 desktop 依赖。'); process.exitCode = 1; });
    child.once('close', code => { process.off('SIGINT', stop); process.off('SIGTERM', stop); process.exitCode = code ?? 1; });
  }
} catch (error) {
  console.error(error.code === 'MODULE_NOT_FOUND' ? '请按 README 的源码步骤恢复锁定的桌面依赖。' : error.message);
  process.exitCode = 1;
}
