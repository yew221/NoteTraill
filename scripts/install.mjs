import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { claimPrefix, canonicalTarget, withInstallLock, currentRelease, sourceInventory, requireCleanToolchain, prepareRelease, activate, cleanEnv, run, failureText, DistributionError } from './distribution.mjs';

try {
  const args = process.argv.slice(2), flags = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--source', '--prefix', '--data-dir', '--bootstrap-archive', '--from-backup'].includes(args[i]) || flags.has(args[i]) ||
      !args[i + 1] || !path.isAbsolute(args[i + 1])) throw new DistributionError('ARGUMENTS_INVALID');
    flags.set(args[i], args[i + 1]);
  }
  const source = flags.get('--source'); if (!source) throw new DistributionError('SOURCE_INVALID');
  const original = sourceInventory(source);
  const prefix = claimPrefix(flags.get('--prefix') ?? path.join(os.homedir(), 'Library/Application Support/NoteTrail App'));
  await withInstallLock(prefix, async () => {
    requireCleanToolchain(prefix);
    const existing = currentRelease(prefix);
    if (existing) {
      if (!existing.receipt.runtimeLock.jsInstallSha256 || flags.has('--from-backup')) throw new DistributionError('CLEAN_PREFIX_REQUIRED');
      if (existing.receipt.sourceHash !== original.hash || (flags.has('--data-dir') && flags.get('--data-dir') !== existing.receipt.dataDirectory)) throw new DistributionError('UPGRADE_REQUIRED');
      console.log('相同版本已安装且校验通过，无需重复安装。'); return;
    }
    const dataDirectory = canonicalTarget(flags.get('--data-dir') ?? path.join(prefix, 'data', `d_${randomUUID()}`));
    if (dataDirectory === prefix || (!dataDirectory.startsWith(prefix + '/data/') && dataDirectory.startsWith(prefix + '/')) ||
      fs.existsSync(dataDirectory)) throw new DistributionError('DATA_DESTINATION_INVALID');
    const release = await prepareRelease({ prefix, source, dataDirectory, bootstrapArchive: flags.get('--bootstrap-archive'), progress: console.log });
    if (flags.has('--from-backup')) {
      await run(path.join(release.root, 'runtime/node/bin/node'), ['scripts/maintenance.mjs', 'restore',
        '--from', flags.get('--from-backup'), '--data-dir', dataDirectory],
        { cwd: path.join(release.root, 'app'), env: cleanEnv(release.root, prefix), label: 'MIGRATION_FAILED' });
    }
    await run(path.join(release.root, 'runtime/node/bin/node'), ['scripts/migrate-data.mjs', '--data-dir', dataDirectory],
      { cwd: path.join(release.root, 'app'), env: cleanEnv(release.root, prefix), label: 'MIGRATION_FAILED' });
    activate(prefix, release, null);
    console.log(`桌面运行环境已准备好。接下来请按 README 构建或打包桌面应用。\n本地诊断："${prefix}/notetrail" doctor`);
  });
} catch (error) { console.error(failureText(error)); process.exitCode = 1; }
