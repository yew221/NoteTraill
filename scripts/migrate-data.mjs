import path from 'node:path';
import { openStorage } from '../dist/server/storage.js';
import { verifyData } from '../dist/server/maintenance.js';
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--data-dir' || !path.isAbsolute(args[1])) throw new Error();
  const storage = openStorage(args[1]); storage.close();
  verifyData(args[1]);
  console.log(JSON.stringify({ ok: true, database: 'ok', sessions: 'ok', staging: 'ok' }));
} catch { console.error('数据或会话验证未通过；未切换到此副本。'); process.exitCode = 1; }
