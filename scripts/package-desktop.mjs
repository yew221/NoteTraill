import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { currentRelease, checkPlatform } from './distribution.mjs';

const root = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', PYTHONDONTWRITEBYTECODE: '1' };
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
const fail = code => { throw new Error(code); };
const included = file => !file.split(path.sep).some(name => ['__pycache__', '.DS_Store', '.modules.yaml', '.pnpm-workspace-state-v1.json'].includes(name)) && !file.endsWith('.pyc');
const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false,
  filter: included }); };

export function inventory(directory, filter = () => true) {
  const files = {};
  function walk(relative = '') {
    if (!filter(relative)) return;
    const absolute = path.join(directory, relative), stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      if (!fs.realpathSync(absolute).startsWith(directory + '/')) fail('EXTERNAL_BUNDLE_LINK');
      files[relative] = { link: fs.readlinkSync(absolute) };
    } else if (stat.isDirectory()) for (const name of fs.readdirSync(absolute).sort()) walk(path.join(relative, name));
    else if (stat.isFile()) files[relative] = { sha256: digest(fs.readFileSync(absolute)), mode: stat.mode & 0o777 };
    else fail('INVALID_BUNDLE_FILE');
  }
  walk(); return files;
}
export function verifiedRuntime(prefix) {
  const installed = currentRelease(prefix, false); if (!installed) fail('VERIFIED_RUNTIME_REQUIRED');
  const actual = inventory(installed.root, relative => !relative || ['app', 'runtime', 'config'].includes(relative.split(path.sep)[0]) && included(relative));
  const expected = Object.fromEntries(Object.entries(installed.receipt.inventory).filter(([file]) => included(file)));
  if (Object.keys(actual).length !== Object.keys(expected).length || Object.entries(actual).some(([file, value]) => JSON.stringify(value) !== JSON.stringify(expected[file]))) fail('INSTALL_CHANGED');
  return installed;
}
function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2)); }
function plist(file, update) {
  const value = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file])); update(value);
  write(file, value); run('/usr/bin/plutil', ['-convert', 'xml1', file]);
}
function machFiles(directory) {
  const result = [], bundles = [];
  function walk(file) {
    const stat = fs.lstatSync(file); if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file)) walk(path.join(file, name));
      if (file.endsWith('.app') || file.endsWith('.framework')) bundles.push(file);
    } else if (stat.isFile() && stat.size >= 16) {
      const header = Buffer.alloc(16), fd = fs.openSync(file, 'r'); try { fs.readSync(fd, header, 0, 16, 0); } finally { fs.closeSync(fd); }
      if ([0xfeedfacf, 0xfeedface, 0xcafebabe, 0xbebafeca, 0xcffaedfe, 0xcefaedfe].includes(header.readUInt32BE(0))) result.push(file);
    }
  }
  walk(directory); return { result, bundles };
}

export function packageDesktop({ prefix, destination, identity = '-' }) {
  const lock = json(path.join(root, 'scripts/runtime-lock.json')); checkPlatform(lock);
  if (process.version !== `v${lock.node.version}` || !path.isAbsolute(prefix) || !path.isAbsolute(destination) || !destination.endsWith('.app') || fs.existsSync(destination)) fail('INVALID_PACKAGE_ARGUMENTS');
  if (identity !== '-' && !/^Developer ID Application: [^\r\n]{1,200}$/.test(identity)) fail('DEVELOPER_ID_REQUIRED');
  const installed = verifiedRuntime(fs.realpathSync(prefix));
  const oldApp = path.join(installed.root, 'app');
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'desktop/pnpm-lock.yaml',
    'scripts/runtime-lock.json', 'scripts/js-install-lock.json', 'scripts/conversion-requirements-hashed.lock']) {
    if (digest(fs.readFileSync(path.join(oldApp, file))) !== digest(fs.readFileSync(path.join(root, file)))) fail('RUNTIME_LOCK_MISMATCH');
  }
  const desktop = json(path.join(root, 'desktop/package.json'));
  const version = /^(\d+\.\d+\.\d+)-desktop\.(\d+)$/.exec(desktop.version);
  if (!version || json(path.join(root, 'package.json')).version !== desktop.version) fail('PACKAGE_VERSION_MISMATCH');
  run(process.execPath, ['scripts/build.mjs'], { cwd: root });
  run(process.execPath, ['scripts/build-desktop.mjs'], { cwd: root });
  const contents = path.join(destination, 'Contents'), resources = path.join(contents, 'Resources'), app = path.join(resources, 'app'), runtime = path.join(resources, 'runtime');
  const staging = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'notetrail-electron-'));
  try {
    run(path.join(installed.root, 'runtime/python/bin/python3.12'), ['-I', '-B', 'scripts/restore-js.py', 'desktop',
      '--cache', path.join(prefix, 'cache/js-archives'), '--output', staging], { cwd: oldApp, timeout: 1200000 });
    const dist = path.join(staging, 'node_modules/electron/dist');
    if (fs.readFileSync(path.join(dist, 'version'), 'utf8').trim() !== desktop.devDependencies.electron) fail('ELECTRON_VERSION_MISMATCH');
    copy(path.join(dist, 'Electron.app'), destination);
    for (const name of ['LICENSE', 'LICENSES.chromium.html']) copy(path.join(dist, name), path.join(resources, 'licenses', 'electron-' + name));
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  fs.rmSync(path.join(resources, 'default_app.asar'), { force: true });
  for (const segment of ['dist/server', 'dist/shared', 'dist/desktop', 'src/desktop']) copy(path.join(root, segment), path.join(app, segment));
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'DEPENDENCIES.md', 'WEB_SEARCH.md', 'RELEASE_CHECKLIST.md', 'READINESS_REPAIR.md', 'pnpm-lock.yaml', 'desktop/pnpm-lock.yaml', 'desktop/PI_GUI_LICENSE', 'desktop/upstream.json', 'desktop/README.md',
    'scripts/desktop-backend.mjs', 'scripts/distribution.mjs', 'scripts/smoke.mjs', 'scripts/maintenance.mjs', 'dist/.ready', 'scripts/runtime-lock.json', 'scripts/conversion-requirements.lock', 'scripts/conversion-requirements-hashed.lock',
    'tests/fixtures/public/t00/inputs/formats/inspection.docx', 'tests/fixtures/public/t00/inputs/formats/inspection.pdf']) {
    copy(path.join(root, file), path.join(app, file));
  }
  const pkg = json(path.join(root, 'package.json')); write(path.join(app, 'package.json'), { ...pkg, version: desktop.version, main: 'src/desktop/main.mjs' });
  copy(path.join(oldApp, 'node_modules'), path.join(app, 'node_modules'));
  copy(path.join(installed.root, 'runtime/node/bin/node'), path.join(runtime, 'node/bin/node'));
  copy(path.join(installed.root, 'runtime/node/LICENSE'), path.join(runtime, 'node/LICENSE'));
  copy(path.join(installed.root, 'runtime/rg'), path.join(runtime, 'rg'));
  copy(path.join(installed.root, 'runtime/python'), path.join(runtime, 'python'));
  // Use the relocatable standalone interpreter, with the locked wheel contents; no absolute-path venv.
  fs.rmSync(path.join(runtime, 'python/lib/python3.12/site-packages'), { recursive: true, force: true });
  copy(path.join(installed.root, 'runtime/conversion/lib/python3.12/site-packages'), path.join(runtime, 'python/lib/python3.12/site-packages'));
  fs.renameSync(path.join(contents, 'MacOS/Electron'), path.join(contents, 'MacOS/NoteTrail'));
  plist(path.join(contents, 'Info.plist'), info => {
    Object.assign(info, { CFBundleDisplayName: 'NoteTrail', CFBundleName: 'NoteTrail', CFBundleExecutable: 'NoteTrail',
      CFBundleIdentifier: 'org.notetrail.desktop', CFBundleShortVersionString: version[1], CFBundleVersion: version[2],
      LSApplicationCategoryType: 'public.app-category.productivity', LSMinimumSystemVersion: lock.support.macOS, CFBundleIconFile: 'notetrail.icns' });
    delete info.ElectronAsarIntegrity;
    for (const key of Object.keys(info)) if (/^NS(Audio|Bluetooth|Camera|Microphone)/.test(key)) delete info[key];
  });
  for (const name of fs.readdirSync(path.join(contents, 'Frameworks')).filter(name => /^Electron Helper.*\.app$/.test(name))) {
    const oldName = name.slice(0, -4), newName = oldName.replace('Electron', 'NoteTrail'), helper = path.join(contents, 'Frameworks', name);
    plist(path.join(helper, 'Contents/Info.plist'), info => {
      Object.assign(info, { CFBundleDisplayName: newName, CFBundleName: newName, CFBundleExecutable: newName,
        CFBundleIdentifier: info.CFBundleIdentifier.replace('com.github.Electron', 'org.notetrail.desktop') });
    });
    fs.renameSync(path.join(helper, 'Contents/MacOS', oldName), path.join(helper, 'Contents/MacOS', newName));
    fs.renameSync(helper, path.join(contents, 'Frameworks', newName + '.app'));
  }
  copy(path.join(root, 'desktop/notetrail.icns'), path.join(resources, 'notetrail.icns'));
  write(path.join(app, 'desktop-build.json'), { format: 'notetrail-desktop-v1', version: desktop.version, electron: desktop.devDependencies.electron,
    platform: lock.support, signing: identity === '-' ? 'ad-hoc-local-only' : 'developer-id', source: digest(JSON.stringify(inventory(path.join(root, 'src')))) });
  // Check relocation before signing; no bundled symlink may depend on a development machine.
  inventory(destination);
  const { result: binaries, bundles } = machFiles(destination);
  for (const file of binaries) run('/usr/bin/codesign', ['--force', '--sign', identity, ...(identity === '-' ? [] : ['--timestamp', '--options', 'runtime']),
    '--entitlements', path.join(root, 'desktop/entitlements.plist'), file]);
  for (const file of bundles) run('/usr/bin/codesign', ['--force', '--sign', identity, ...(identity === '-' ? [] : ['--timestamp', '--options', 'runtime']),
    ...(file.endsWith('.app') ? ['--entitlements', path.join(root, 'desktop/entitlements.plist')] : []), file]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', destination]);
  const smoke = JSON.parse(run(path.join(runtime, 'node/bin/node'), [path.join(app, 'scripts/smoke.mjs'), '--desktop'], { cwd: app,
    env: { ...env, NOTETRAIL_PYTHON: path.join(runtime, 'python/bin/python3.12'), NOTETRAIL_RG: path.join(runtime, 'rg/rg'), NOTETRAIL_INSTALL_ROOT: app }, timeout: 90000 }));
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', destination]);
  const record = { format: 'notetrail-desktop-package-v1', version: desktop.version, createdAt: new Date().toISOString(),
    signing: identity === '-' ? 'ad-hoc-local-only' : 'developer-id', notarized: false, smoke, inventory: inventory(destination) };
  write(destination + '.receipt.json', record);
  return { application: destination, version: desktop.version, signing: record.signing, notarized: false, smoke };
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {}; const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i += 2) {
      const key = { '--runtime-prefix': 'prefix', '--output': 'destination', '--identity': 'identity' }[args[i]];
      if (!key || options[key] || !args[i + 1]) fail('INVALID_PACKAGE_ARGUMENTS'); options[key] = args[i + 1];
    }
    if (!options.prefix || !options.destination) fail('Use --runtime-prefix /verified/install --output /new/NoteTrail.app [--identity "Developer ID Application: …"]');
    console.log(JSON.stringify(packageDesktop(options), null, 2));
  } catch (error) { console.error('桌面打包未完成：' + error.message); process.exitCode = 1; }
}
