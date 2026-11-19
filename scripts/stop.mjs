#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export async function stopService(directory) {
  const { requestControl } = await import('../dist/server/control.js');
  const status = await requestControl(directory, 'stop');
  if (!status.running) return;
  const deadline = Date.now() + 6500;
  for (;;) {
    try { if (!(await requestControl(directory, 'status')).running) return; }
    catch { /* An acknowledged stop can close a status connection during shutdown; confirm again. */ }
    if (Date.now() > deadline) throw new Error('STOP_TIMEOUT');
    await delay(50);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--help') console.log('用法：node scripts/stop.mjs [--data-dir /绝对路径]。只请求对应NoteTrail正常退出，不按PID强杀进程。');
    else {
      if (args.length && !(args.length === 2 && args[0] === '--data-dir' && path.isAbsolute(args[1]))) throw new Error();
      const { defaultDataDirectory } = await import('../dist/server/storage.js');
      await stopService(args[1] ?? defaultDataDirectory()); console.log('NoteTrail 已停止，或尚未运行。');
    }
  } catch (error) {
    console.error(error.code === 'ERR_MODULE_NOT_FOUND' ? '尚无完整构建；请先运行 node scripts/build.mjs，或回到原启动终端按 Ctrl+C。' :
      '停止未完成：无法确认对应服务已退出，请回到启动终端按 Ctrl+C。'); process.exitCode = 1;
  }
}
