#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const help = `先停止 NoteTrail，再运行（所有路径使用绝对路径）：
node scripts/maintenance.mjs backup --data-dir /现有数据目录 --to /新的备份目录
node scripts/maintenance.mjs restore --from /备份目录 --data-dir /新的数据目录
node scripts/maintenance.mjs diagnose --data-dir /现有数据目录
备份包含聊天、记忆、资料索引、费用记录、已提交的 Pi 会话和暂存原件，须按私人资料保管。
知识库中的原件和派生件须单独备份；不复制钥匙串密钥、日志或个人运行环境。
还原只写入新目录，不覆盖旧数据；还原后须重新填入模型密钥，未完成任务不会自动重跑。
诊断仅输出版本与数量，不含正文、路径或模型设置；不会上传任何内容。`;
try {
  const args = process.argv.slice(2), pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (args.length === 1 && args[0] === '--help') console.log(help);
  else {
    if (process.version !== `v${pkg.engines.node}` || !fs.existsSync(new URL('../dist/.ready', import.meta.url))) throw new Error('BUILD_REQUIRED');
    const command = args[0], expected = command === 'backup' ? ['--data-dir', '--to'] : command === 'restore' ? ['--from', '--data-dir'] : command === 'diagnose' ? ['--data-dir'] : [];
    if (!expected.length || args.length !== 1 + 2 * expected.length) throw new Error('ARGUMENTS_INVALID');
    const flags = new Map();
    for (let i = 1; i < args.length; i += 2) {
      if (!expected.includes(args[i]) || flags.has(args[i]) || !path.isAbsolute(args[i + 1]) || args[i + 1].includes('\0')) throw new Error('ARGUMENTS_INVALID');
      flags.set(args[i], args[i + 1]);
    }
    const { backupData, restoreData, diagnoseData } = await import('../dist/server/maintenance.js');
    const result = command === 'backup' ? backupData(flags.get('--data-dir'), flags.get('--to')) :
      command === 'restore' ? restoreData(flags.get('--from'), flags.get('--data-dir')) : diagnoseData(flags.get('--data-dir'));
    console.log(JSON.stringify({ ok: true, command, ...result }));
  }
} catch (error) {
  const messages = {
    BUILD_REQUIRED: '请使用锁定的 Node 版本并先运行 node scripts/build.mjs。',
    ARGUMENTS_INVALID: '参数无效；运行 node scripts/maintenance.mjs --help 查看用法。',
    DATABASE_BUSY: '请先停止正在使用此数据目录的 NoteTrail，再重试。',
    DATABASE_TOO_NEW: '数据版本较新，请使用兼容版本的程序。',
    DATABASE_INVALID: '数据库损坏或版本不兼容；原有文件已保留。',
    DATA_DIRECTORY_INVALID: '数据路径、归属或权限不符合要求；原有文件已保留。',
    DATA_DIRECTORY_UNRECOGNIZED: '无法识别已有 NoteTrail 数据目录；未初始化新数据。',
    BACKUP_INVALID: '备份不完整、版本不兼容，或文件权限不符合要求；原有文件已保留。',
    BACKUP_CONTENT_INVALID: '备份文件、会话或暂存原件未通过一致性校验；原有文件已保留。',
    DESTINATION_INVALID: '目标必须是现有父目录下尚不存在的独立目录，且不能在知识库或项目中。',
  };
  const code = error.code ?? error.publicError?.code ?? error.message;
  console.error(`维护未完成：${messages[code] ?? '文件校验或读写失败；原有文件与可能的半成品已保留，请检查后使用新的目标目录。'}`);
  process.exitCode = 1;
}
