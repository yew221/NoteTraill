import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { claimPrefix, currentRelease, withInstallLock, cleanEnv, upgradeRelease, run, failureText, DistributionError } from './distribution.mjs';
import { stopService } from './stop.mjs';

const root = fs.realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const prefix = path.dirname(path.dirname(root));
async function launch(release, script, args) {
  const child = spawn(path.join(release.root, 'runtime/node/bin/node'), [script, ...args],
    { cwd: path.join(release.root, 'app'), env: cleanEnv(release.root, prefix), stdio: 'inherit' });
  const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try { const [code, signal] = await once(child, 'exit'); process.exitCode = code ?? (signal ? 1 : 0); }
  finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
}
try {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help') console.log(`NoteTrail 本地命令：
stop                  正常停止对应服务，可重复运行
doctor                运行离线自检，不调用云模型或读写密钥
upgrade --source /新源码目录   升级独立运行环境和它登记的单个应用数据目录
maintenance …         备份/还原/诊断（maintenance --help 查看参数）`);
  else {
    claimPrefix(prefix);
    // Stop still works when files were edited; it never launches that code or kills a PID.
    if (command === 'stop' && !args.length) {
      const release = currentRelease(prefix, false); if (!release) throw new DistributionError('NOT_INSTALLED');
      await stopService(release.receipt.dataDirectory); console.log('NoteTrail 已停止，或尚未运行。');
    } else if (command === 'upgrade' && args.length === 2 && args[0] === '--source' && path.isAbsolute(args[1])) {
      const release = currentRelease(prefix); if (!release) throw new DistributionError('NOT_INSTALLED');
      await stopService(release.receipt.dataDirectory);
      await withInstallLock(prefix, async () => {
        await upgradeRelease({ prefix, source: args[1], progress: console.log });
        console.log('运行环境和应用数据副本已验证。旧程序和原数据已保留。');
      }, 8);
    } else if (['doctor', 'maintenance'].includes(command)) {
      await withInstallLock(prefix, async () => {
        const release = currentRelease(prefix); if (!release) throw new DistributionError('NOT_INSTALLED');
        if (command === 'doctor' && !args.length) {
          const result = await run(path.join(release.root, 'runtime/node/bin/node'), ['scripts/smoke.mjs'],
            { cwd: path.join(release.root, 'app'), env: cleanEnv(release.root, prefix), label: 'SELF_CHECK_FAILED', timeout: 60000 });
          const { verifyData, diagnoseData } = await import('../dist/server/maintenance.js');
          verifyData(release.receipt.dataDirectory);
          console.log(JSON.stringify({ ...JSON.parse(result), data: diagnoseData(release.receipt.dataDirectory) }));
        } else if (command === 'maintenance') await launch(release, 'scripts/maintenance.mjs', args);
        else throw new DistributionError('ARGUMENTS_INVALID');
      });
    } else throw new DistributionError('ARGUMENTS_INVALID');
  }
} catch (error) { console.error(failureText(error)); process.exitCode = 1; }
