import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const MARKER = 'NoteTrail managed installation v1\n';
const SOURCE = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.server.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'DEPENDENCIES.md', 'src',
  'desktop/PI_GUI_LICENSE', 'desktop/package.json', 'desktop/pnpm-lock.yaml', 'desktop/README.md', 'desktop/upstream.json',
  'desktop/entitlements.plist', 'desktop/icon.swift', 'WEB_SEARCH.md', 'RELEASE_CHECKLIST.md', 'READINESS_REPAIR.md', 'LIVING_ANSWERS.md',
  'scripts/build.mjs', 'scripts/build-renderer.mjs', 'scripts/stop.mjs', 'scripts/maintenance.mjs', 'scripts/distribution.mjs',
  'scripts/restore-js.py', 'scripts/freeze-js.py', 'scripts/js-install-lock.json',
  'scripts/verify_pi.mjs',
  'scripts/build-desktop.mjs', 'scripts/desktop.mjs', 'scripts/desktop-backend.mjs', 'scripts/package-desktop.mjs',
  'scripts/verify-desktop.mjs', 'scripts/package-source.mjs', 'scripts/source-package-readme.md',
  'scripts/installed.mjs', 'scripts/install.mjs', 'scripts/install.sh', 'scripts/runtime-lock.json', 'scripts/smoke.mjs',
  'scripts/migrate-data.mjs', 'scripts/conversion-requirements.lock', 'scripts/conversion-requirements-hashed.lock',
  'tests/fixtures/public/t00/inputs/formats/inspection.docx', 'tests/fixtures/public/t00/inputs/formats/inspection.pdf'];
const RELEASE = /^releases\/r_[a-f0-9-]{36}$/;
const PYTHON_SYNC_MINUTES = 45;
export class DistributionError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new DistributionError(code); };
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function flush(directory) { const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
export function writeNew(file, bytes, mode = 0o600) {
  const fd = fs.openSync(file, 'wx', mode);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  flush(path.dirname(file));
}
export function privateDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700 || fs.realpathSync(directory) !== directory) fail('INSTALL_DIRECTORY_INVALID');
}
function privateFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) fail('INSTALL_DIRECTORY_INVALID');
}
export function canonicalTarget(input) {
  if (!path.isAbsolute(input) || path.normalize(input) !== input || input.includes('\0') || input === '/') fail('INSTALL_DIRECTORY_INVALID');
  for (let current = input; ; current = path.dirname(current)) {
    if (fs.existsSync(current) && (!fs.lstatSync(current).isDirectory() || fs.realpathSync(current) !== current)) fail('INSTALL_DIRECTORY_INVALID');
    if (['.git', '.obsidian', '.notetrail-data'].some(marker => fs.existsSync(path.join(current, marker)))) fail('INSTALL_DIRECTORY_INVALID');
    if (path.dirname(current) === current) break;
  }
  return input;
}
export function claimPrefix(input) {
  const prefix = canonicalTarget(input), marker = path.join(prefix, '.notetrail-install');
  if (!fs.existsSync(prefix)) fs.mkdirSync(prefix, { recursive: true, mode: 0o700 });
  privateDirectory(prefix);
  if (!fs.existsSync(marker)) {
    if (fs.readdirSync(prefix).length) fail('INSTALL_DIRECTORY_UNKNOWN');
    writeNew(marker, MARKER);
  }
  privateFile(marker); if (fs.readFileSync(marker, 'utf8') !== MARKER) fail('INSTALL_DIRECTORY_UNKNOWN');
  for (const name of ['releases', 'cache', 'backups', 'data']) {
    const dir = path.join(prefix, name); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 }); privateDirectory(dir);
  }
  const lock = path.join(prefix, '.operation-lock');
  try { writeNew(lock, ''); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  privateFile(lock);
  return prefix;
}
export async function withInstallLock(prefix, action, waitSeconds = 0) {
  // The OS releases this lock even if the installer is killed; no stale PID file needs deletion.
  const holder = spawn('/usr/bin/lockf', ['-k', '-n', '-s', '-t', String(waitSeconds), path.join(prefix, '.operation-lock'), process.execPath,
    '-e', "process.stdout.write('locked\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"],
  { env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, stdio: ['pipe', 'pipe', 'ignore'] });
  const exited = once(holder, 'exit');
  await Promise.race([once(holder.stdout, 'data'), exited.then(() => fail('INSTALL_BUSY'))]);
  try { return await action(); }
  finally { holder.stdin.end(); await exited; }
}
export function checkPlatform(lock) {
  if (lock.format !== 'notetrail-runtime-v1' || process.platform !== lock.support.platform || process.arch !== lock.support.arch ||
      execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim() !== lock.support.macOS) fail('PLATFORM_UNSUPPORTED');
}
export function cleanEnv(release, prefix) {
  return { PATH: `${path.join(release, 'runtime/node/bin')}:/usr/bin:/bin`, LANG: 'en_US.UTF-8', PI_OFFLINE: '1',
    NOTETRAIL_PYTHON: path.join(release, 'runtime/conversion/bin/python'), NOTETRAIL_RG: path.join(release, 'runtime/rg/rg'),
    NOTETRAIL_INSTALL_ROOT: prefix, XDG_CONFIG_HOME: path.join(release, 'config'), XDG_CACHE_HOME: path.join(prefix, 'cache'),
    npm_config_userconfig: '/dev/null', npm_config_globalconfig: '/dev/null', UV_NO_CONFIG: '1',
    UV_PYTHON_DOWNLOADS: 'never', UV_CACHE_DIR: path.join(prefix, 'cache/uv'), PYTHONDONTWRITEBYTECODE: '1' };
}
export async function run(command, args, { cwd, env, log, label, timeout = 180000, timeoutLabel = label } = {}) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; const capture = bytes => { if (output.length < 2 * 1024 * 1024) output += bytes; };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = child.kill('SIGKILL'); }, timeout);
  let code;
  try { [code] = await once(child, 'close'); }
  finally { clearTimeout(timer); }
  if (log) {
    const sanitized = [cwd, os.homedir()].filter(Boolean).reduce((text, item) => text.replaceAll(item, '<local>'), output);
    writeNew(log, sanitized);
  }
  if (code !== 0) fail((timedOut ? timeoutLabel : label) ?? 'INSTALL_STEP_FAILED');
  return output;
}
export function sourceInventory(source) {
  const files = {};
  function visit(relative) {
    const file = path.join(source, relative), stat = fs.lstatSync(file);
    if (stat.isDirectory()) { for (const name of fs.readdirSync(file).sort()) visit(`${relative}/${name}`); }
    else if (stat.isFile() && stat.nlink === 1) files[relative] = digest(fs.readFileSync(file));
    else fail('SOURCE_INVALID');
  }
  for (const item of SOURCE) visit(item);
  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
  if (pkg.name !== 'notetrail') fail('SOURCE_INVALID');
  return { files, hash: digest(JSON.stringify(files)), version: pkg.version };
}
function installedInventory(root) {
  const files = {};
  function visit(relative) {
    const file = path.join(root, relative), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      const target = fs.realpathSync(file);
      if (!target.startsWith(root + '/')) fail('INSTALL_DIRECTORY_INVALID');
      files[relative] = { link: fs.readlinkSync(file) };
    } else if (stat.isDirectory()) { for (const name of fs.readdirSync(file).sort()) visit(`${relative}/${name}`); }
    else if (stat.isFile()) files[relative] = { sha256: digest(fs.readFileSync(file)), mode: stat.mode & 0o777 };
    else fail('INSTALL_DIRECTORY_INVALID');
  }
  for (const name of ['app', 'runtime', 'config']) visit(name);
  return files;
}
export function currentRelease(prefix, verify = true) {
  const pointer = path.join(prefix, 'current');
  try { fs.lstatSync(pointer); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!fs.lstatSync(pointer).isSymbolicLink()) fail('INSTALL_CHANGED');
  const relative = fs.readlinkSync(pointer); if (!RELEASE.test(relative)) fail('INSTALL_CHANGED');
  return inspectRelease(prefix, relative, verify);
}
function inspectRelease(prefix, relative, verify = true) {
  if (!RELEASE.test(relative)) fail('INSTALL_CHANGED');
  const root = path.join(prefix, relative); privateDirectory(root);
  const record = path.join(root, 'receipt.json'); privateFile(record);
  const receipt = JSON.parse(fs.readFileSync(record));
  if (receipt.format !== 'notetrail-install-v1' || receipt.relative !== relative || !path.isAbsolute(receipt.dataDirectory)) fail('INSTALL_CHANGED');
  if (verify && JSON.stringify(installedInventory(root)) !== JSON.stringify(receipt.inventory)) fail('INSTALL_CHANGED');
  return { root, receipt, relative };
}
async function artifact(prefix, name, item, supplied, log) {
  if (!/^[a-f0-9]{64}$/.test(item.sha256) || !['https://nodejs.org/', 'https://github.com/', 'https://registry.npmjs.org/'].some(host => item.url.startsWith(host))) fail('ARTIFACT_INVALID');
  const file = path.join(prefix, 'cache', `${name}-${item.sha256}.archive`);
  if (fs.existsSync(file)) { privateFile(file); if (digest(fs.readFileSync(file)) !== item.sha256) fail('ARTIFACT_HASH_MISMATCH'); return file; }
  const pending = file + `.${randomUUID()}.partial`;
  if (supplied) { if (digest(fs.readFileSync(supplied)) !== item.sha256) fail('ARTIFACT_HASH_MISMATCH'); writeNew(pending, fs.readFileSync(supplied)); }
  else await run('/usr/bin/curl', ['-q', '--proto', '=https', '--proto-redir', '=https', '--fail', '--location', '--silent', '--show-error',
    '--retry', '4', '--retry-all-errors', '--retry-max-time', '900', '--speed-limit', '1', '--speed-time', '60',
    '--connect-timeout', '15', '--max-time', '900', '--max-filesize', '268435456', item.url, '-o', pending],
    { env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, log, label: 'DOWNLOAD_FAILED', timeout: 1820000 });
  fs.chmodSync(pending, 0o600);
  if (digest(fs.readFileSync(pending)) !== item.sha256) fail('ARTIFACT_HASH_MISMATCH');
  fs.linkSync(pending, file); fs.unlinkSync(pending); flush(path.dirname(file)); return file;
}
export function requireCleanToolchain(prefix) {
  const legacyNode = 'node-654ba79de6155647e22321932b45f2a1ccb705976cc337c9b8e278beb085a628.';
  if (fs.readdirSync(path.join(prefix, 'cache')).some(name => name.startsWith('pnpm-') || name.startsWith(legacyNode))) fail('CLEAN_PREFIX_REQUIRED');
  for (const entry of fs.readdirSync(path.join(prefix, 'releases'))) {
    if (!RELEASE.test('releases/' + entry)) fail('CLEAN_PREFIX_REQUIRED');
    const base = path.join(prefix, 'releases', entry);
    privateDirectory(base);
    for (const part of ['app', 'app/scripts', 'runtime', 'runtime/node']) {
      const stat = fs.lstatSync(path.join(base, part), { throwIfNoEntry: false });
      if (stat && !stat.isDirectory()) fail('CLEAN_PREFIX_REQUIRED');
    }
    const file = path.join(base, 'app/scripts/runtime-lock.json');
    if (fs.lstatSync(path.join(base, 'runtime/pnpm'), { throwIfNoEntry: false }) ||
        fs.lstatSync(path.join(base, 'runtime/node/lib'), { throwIfNoEntry: false })) fail('CLEAN_PREFIX_REQUIRED');
    if (fs.lstatSync(file, { throwIfNoEntry: false })) {
      privateFile(file);
      if (!JSON.parse(fs.readFileSync(file)).jsInstallSha256) fail('CLEAN_PREFIX_REQUIRED');
    }
  }
}
export async function prepareRelease({ prefix, source, dataDirectory, bootstrapArchive, progress = () => {} }) {
  requireCleanToolchain(prefix);
  const original = sourceInventory(source), lock = JSON.parse(fs.readFileSync(path.join(source, 'scripts/runtime-lock.json'))); checkPlatform(lock);
  const relative = `releases/r_${randomUUID()}`, root = path.join(prefix, relative), app = path.join(root, 'app');
  fs.mkdirSync(root, { mode: 0o700 });
  for (const name of ['app', 'runtime', 'config', 'logs']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  for (const [file, expected] of Object.entries(original.files)) {
    const bytes = fs.readFileSync(path.join(source, file)); if (digest(bytes) !== expected) fail('SOURCE_CHANGED');
    fs.mkdirSync(path.dirname(path.join(app, file)), { recursive: true, mode: 0o700 }); writeNew(path.join(app, file), bytes);
  }
  const env = cleanEnv(root, prefix), node = path.join(root, 'runtime/node/bin/node');
  progress('下载并核对锁定的运行环境');
  for (const name of ['node', 'uv', 'python', 'rg']) {
    const archive = await artifact(prefix, name, lock[name], name === 'node' ? bootstrapArchive : undefined,
      path.join(root, 'logs', `download-${name}.log`));
    const target = path.join(root, 'runtime', name);
    fs.mkdirSync(target, { mode: 0o700 });
    const members = name === 'node' ? ['package/bin/node', 'package/LICENSE'] : [];
    await run('/usr/bin/tar', ['-xf', archive, '-C', target, '--strip-components', '1', ...members], { env, label: 'ARTIFACT_INVALID' });
  }
  if (digest(fs.readFileSync(node)) !== lock.node.binarySha256 ||
      digest(fs.readFileSync(path.join(root, 'runtime/node/LICENSE'))) !== lock.node.licenseSha256) fail('ARTIFACT_HASH_MISMATCH');
  const uv = path.join(root, 'runtime/uv/uv');
  if ((await run(node, ['--version'], { env })).trim() !== `v${lock.node.version}`) fail('ARTIFACT_INVALID');
  progress('按锁文件安装 JavaScript 依赖');
  await run(path.join(root, 'runtime/python/bin/python3.12'), ['-I', '-B', 'scripts/restore-js.py',
    'root', '--cache', path.join(prefix, 'cache/js-archives')],
    { cwd: app, env, log: path.join(root, 'logs/javascript.log'), label: 'JAVASCRIPT_INSTALL_FAILED', timeout: 1200000 });
  progress(`安装并校验 Python 转换环境。慢网下载可能需要较长时间，这一步最多等待 ${PYTHON_SYNC_MINUTES} 分钟。`);
  await run(uv, ['--no-config', 'venv', '--python', path.join(root, 'runtime/python/bin/python3.12'), '--no-python-downloads', path.join(root, 'runtime/conversion')], { env, label: 'PYTHON_INSTALL_FAILED' });
  await run(uv, ['--no-config', 'pip', 'sync', '--python', env.NOTETRAIL_PYTHON, '--require-hashes', '--only-binary', ':all:', '--link-mode', 'copy',
    '--default-index', 'https://pypi.org/simple', path.join(app, 'scripts/conversion-requirements-hashed.lock')],
    { cwd: app, env: { ...env, UV_HTTP_RETRIES: '6', UV_CONCURRENT_DOWNLOADS: '4' },
      log: path.join(root, 'logs/python.log'), label: 'PYTHON_INSTALL_FAILED',
      timeout: PYTHON_SYNC_MINUTES * 60_000, timeoutLabel: 'PYTHON_DOWNLOAD_TIMEOUT' });
  progress('构建本机后台并运行离线自检');
  await run(node, ['scripts/build.mjs'], { cwd: app, env, log: path.join(root, 'logs/build.log'), label: 'BUILD_FAILED' });
  const smoke = await run(node, ['scripts/smoke.mjs'], { cwd: app, env, log: path.join(root, 'logs/smoke.log'), label: 'SELF_CHECK_FAILED', timeout: 60000 });
  if (sourceInventory(source).hash !== original.hash) fail('SOURCE_CHANGED');
  const receipt = { format: 'notetrail-install-v1', relative, sourceHash: original.hash, version: original.version,
    dataDirectory, createdAt: new Date().toISOString(), runtimeLock: lock, smoke: JSON.parse(smoke), inventory: installedInventory(root) };
  writeNew(path.join(root, 'receipt.json'), JSON.stringify(receipt));
  flush(root); return { root, relative, receipt };
}
export function activate(prefix, release, previous) {
  const old = currentRelease(prefix, false);
  if ((old?.relative ?? null) !== (previous?.relative ?? null)) fail('INSTALL_CHANGED');
  const launcher = path.join(prefix, 'notetrail');
  const body = '#!/bin/sh\nset -eu\nNOTETRAIL_INSTALL_ROOT=$(CDPATH= cd "$(dirname "$0")" && pwd -P)\nexec /usr/bin/env -i PATH=/usr/bin:/bin LANG=en_US.UTF-8 "$NOTETRAIL_INSTALL_ROOT/current/runtime/node/bin/node" "$NOTETRAIL_INSTALL_ROOT/current/app/scripts/installed.mjs" "$@"\n';
  if (!fs.existsSync(launcher)) writeNew(launcher, body, 0o700);
  else { privateFile(launcher); if (fs.readFileSync(launcher, 'utf8') !== body) fail('INSTALL_CHANGED'); }
  const pending = path.join(prefix, `.current-${randomUUID()}`); fs.symlinkSync(release.relative, pending);
  fs.renameSync(pending, path.join(prefix, 'current')); flush(prefix);
}
function updateRecord(file, value) {
  const pending = file + `.${randomUUID()}.pending`; writeNew(pending, JSON.stringify(value)); fs.renameSync(pending, file); flush(path.dirname(file));
}
export async function upgradeRelease({ prefix, source, progress = () => {} }) {
  const previous = currentRelease(prefix); if (!previous) fail('NOT_INSTALLED');
  const oldMaintenance = await import(pathToFileURL(path.join(previous.root, 'app/dist/server/maintenance.js')).href);
  const id = `u_${randomUUID()}`, folder = path.join(prefix, 'backups', id), dataDirectory = path.join(prefix, 'data', `d_${randomUUID()}`);
  fs.mkdirSync(folder, { mode: 0o700 }); const recordFile = path.join(folder, 'upgrade.json');
  const record = { format: 'notetrail-upgrade-v1', previous: previous.relative, state: 'pending', createdAt: new Date().toISOString() };
  writeNew(recordFile, JSON.stringify(record));
  try {
    progress('备份旧版本数据'); oldMaintenance.backupData(previous.receipt.dataDirectory, path.join(folder, 'snapshot'));
    oldMaintenance.restoreData(path.join(folder, 'snapshot'), dataDirectory);
    const candidate = await prepareRelease({ prefix, source, dataDirectory, progress });
    progress('在副本上迁移并验证，原数据保持可用');
    await run(path.join(candidate.root, 'runtime/node/bin/node'), ['scripts/migrate-data.mjs', '--data-dir', dataDirectory],
      { cwd: path.join(candidate.root, 'app'), env: cleanEnv(candidate.root, prefix), log: path.join(candidate.root, 'logs/migration.log'), label: 'MIGRATION_FAILED' });
    currentRelease(prefix); // Refuse a changed old installation before switching the paired program/data pointer.
    activate(prefix, candidate, previous); record.state = 'complete'; record.current = candidate.relative; updateRecord(recordFile, record);
    const retained = await retainUpgradeBackups(prefix); return { candidate, retained };
  } catch (error) {
    // If the atomic switch already happened, do not label the now-active version as a failed migration.
    record.state = currentRelease(prefix, false)?.relative === previous.relative ? 'failed' : 'complete';
    updateRecord(recordFile, record); throw error;
  }
}
export async function retainUpgradeBackups(prefix) {
  const root = path.join(prefix, 'backups'), verified = [];
  for (const name of fs.readdirSync(root)) {
    if (!/^u_[a-f0-9-]{36}$/.test(name)) continue;
    const folder = path.join(root, name);
    try {
      privateDirectory(folder); privateFile(path.join(folder, 'upgrade.json'));
      const record = JSON.parse(fs.readFileSync(path.join(folder, 'upgrade.json')));
      if (record.format !== 'notetrail-upgrade-v1' || record.state !== 'complete' || !RELEASE.test(record.previous) ||
          typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) continue;
      const { root: old } = inspectRelease(prefix, record.previous);
      const maintenance = await import(pathToFileURL(path.join(old, 'app/dist/server/maintenance.js')).href);
      maintenance.verifyBackup(path.join(folder, 'snapshot'));
      // Preserve user additions too: validation of listed payloads alone does not authorize deleting extra files.
      const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'snapshot/manifest.json')));
      const expected = new Set(['upgrade.json', 'snapshot/manifest.json', ...manifest.files.map(file => `snapshot/data/${file.path}`)]);
      function checkTree(relative = '') {
        const directory = path.join(folder, relative); privateDirectory(directory);
        for (const name of fs.readdirSync(directory)) {
          const child = relative ? `${relative}/${name}` : name, file = path.join(folder, child);
          if (fs.lstatSync(file).isDirectory()) {
            if (![...expected].some(item => item.startsWith(child + '/'))) fail('INSTALL_CHANGED');
            checkTree(child);
          } else { privateFile(file); if (!expected.has(child)) fail('INSTALL_CHANGED'); }
        }
      }
      checkTree();
      verified.push({ folder, date: record.createdAt });
    } catch { /* Unknown, modified or failed backup directories are retained for inspection. */ }
  }
  verified.sort((a, b) => b.date.localeCompare(a.date));
  for (const item of verified.slice(3)) fs.rmSync(item.folder, { recursive: true });
  flush(root); return Math.min(3, verified.length);
}
export const failureText = error => ({
  ENOSPC: '磁盘空间不足，未完成操作；原版本和已有数据保留。请腾出空间后重试。',
  EACCES: '文件访问被拒绝；请检查目标目录权限，或使用新的独立目录。',
  EPERM: '系统拒绝文件操作；请检查本机权限设置，已有数据保留。',
  ARGUMENTS_INVALID: '参数无效，请运行 --help 查看用法；路径须为绝对路径。',
  UPGRADE_REQUIRED: '已有不同版本或数据目录，请通过 notetrail upgrade --source /新源码目录升级。',
  CLEAN_PREFIX_REQUIRED: '旧安装或备份迁移需要新的安装目录。先备份原数据，再对新目录运行 install.sh --from-backup /备份目录。',
  DATA_DESTINATION_INVALID: '首次安装的数据目录必须是尚不存在的独立目录；已有数据请使用备份还原流程。',
  NOT_INSTALLED: '尚无完整安装，请先运行安装脚本。',
  ARTIFACT_INVALID: '运行环境制品或版本不符合锁定要求，未启用新版本。',
  INSTALL_BUSY: '另一个启动、安装或升级操作正在进行，请先停止服务再重试。',
  PLATFORM_UNSUPPORTED: '当前只验证了 macOS 26.6 arm64，未执行安装。',
  INSTALL_DIRECTORY_INVALID: '安装目录的路径、权限或归属不符合要求，请选择独立的新目录。',
  INSTALL_DIRECTORY_UNKNOWN: '目标目录有未知内容，未覆盖。请使用新的独立目录。',
  INSTALL_CHANGED: '安装文件缺失或被修改，已停止切换；请保留改动并使用独立安装目录。',
  SOURCE_INVALID: '程序源码不完整或包含不支持的链接，请使用完整的独立源码目录。',
  SOURCE_CHANGED: '安装期间源码发生变化，未切换版本，请检查后重试。',
  ARTIFACT_HASH_MISMATCH: '下载或缓存散列不符，未执行该制品；请检查私有安装缓存后重试。',
  DOWNLOAD_FAILED: '运行环境下载未完成，原版本保留；检查网络后重新运行。',
  JAVASCRIPT_INSTALL_FAILED: 'JavaScript 依赖未能按锁文件安装，原版本保留。',
  PYTHON_DOWNLOAD_TIMEOUT: 'Python 依赖下载阶段超时。网络恢复后，在同一目录用原命令重试，可复用已校验的下载。',
  PYTHON_INSTALL_FAILED: 'Python 依赖未能按哈希锁安装，原版本保留。',
  BUILD_FAILED: '正式构建失败，未启用新版本。', SELF_CHECK_FAILED: '本地自检失败，未启用新版本。',
  MIGRATION_FAILED: '数据副本验证失败，原程序和原数据未切换；可重新启动原版本。',
  DATABASE_BUSY: '数据正被服务使用，请先停止服务再重试。',
}[error.code ?? error.message] ?? '操作未完成，已保留现有程序、数据和检查记录；请检查后重试。');
