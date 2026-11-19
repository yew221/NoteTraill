// Read-only verification. Never imports Python or writes into a signed application.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { inventory } from './package-desktop.mjs';

export function verifyDesktop(application, receiptFile = application + '.receipt.json') {
  if (!path.isAbsolute(application) || !application.endsWith('.app')) throw new Error('APPLICATION_PATH_REQUIRED');
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  if (receipt.format !== 'notetrail-desktop-package-v1') throw new Error('INVALID_PACKAGE_RECEIPT');
  const actual = inventory(fs.realpathSync(application));
  if (JSON.stringify(actual) !== JSON.stringify(receipt.inventory)) throw new Error('APPLICATION_CHANGED');
  const app = path.join(application, 'Contents/Resources/app');
  const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json')));
  const build = JSON.parse(fs.readFileSync(path.join(app, 'desktop-build.json')));
  const env = { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' };
  const info = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(application, 'Contents/Info.plist')], { env, encoding: 'utf8' }));
  if (receipt.version !== pkg.version || receipt.version !== build.version ||
      receipt.version !== `${info.CFBundleShortVersionString}-desktop.${info.CFBundleVersion}`) throw new Error('PACKAGE_VERSION_MISMATCH');
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', application], { env, stdio: 'pipe' });
  return { version: receipt.version, files: Object.keys(actual).length, integrity: 'verified', signing: receipt.signing, notarized: receipt.notarized };
}
if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length < 3 || process.argv.length > 4) throw new Error('Use /absolute/NoteTrail.app [receipt.json]');
    console.log(JSON.stringify(verifyDesktop(process.argv[2], process.argv[3])));
  } catch (error) { console.error('桌面校验未通过：' + error.message); process.exitCode = 1; }
}
