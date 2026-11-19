import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openStorage } from '../../dist/server/storage.js';
import { VaultService } from '../../dist/server/vaults.js';
import { VaultFiles } from '../../dist/server/vault-files.js';
import { ConversationService } from '../../dist/server/conversations.js';
import { newId } from '../../dist/server/contracts.js';

// Deliberately pre-seeded synthetic history, not a model-quality acceptance fixture.
export async function desktopData(directory, count = 2) {
  const dataDirectory = path.join(directory, 'data'), vaultPath = path.join(directory, 'vault');
  fs.mkdirSync(vaultPath, { mode: 0o700 });
  fs.writeFileSync(path.join(vaultPath, 'notes.md'), '# 桌面公开样本\n蓝盒在北柜第二层。\n交接截止时间为周五 15:00。\n');
  const storage = openStorage(dataDirectory), db = storage.db;
  const python = process.env.NOTETRAIL_PYTHON ?? path.join(os.homedir(), '.local/share/uv/tools/markitdown/bin/python');
  const vaults = new VaultService(db, new VaultFiles(python, [dataDirectory, fs.realpathSync(process.cwd())]));
  try {
    const vault = await vaults.connect({ absolutePath: vaultPath, exclusions: [] });
    const conversations = new ConversationService(db, vaults, {});
    const sessions = Array.from({ length: count }, (_, i) => conversations.create({ vaultId: vault.id,
      title: i === 0 ? '蓝盒的位置（公开样本）' : i === 1 ? '交接安排（公开样本）' : `分页样本 ${i + 1}` }));
    const now = new Date().toISOString(), answers = [];
    for (const [index, session] of sessions.slice(0, 2).entries()) {
      const runId = newId('run'), messageId = newId('message'), answerId = newId('answer');
      const text = index ? '交接截止时间是什么时候？' : '蓝盒放在哪里？';
      const markdown = index ? '公开样本中的交接截止时间为周五 15:00。' : '公开样本中的蓝盒在北柜第二层。';
      db.prepare("INSERT INTO runs(id,kind,vault_id,state,created_at,started_at,ended_at,session_id,resolved_action) VALUES (?,?,?,'succeeded',?,?,?,?,'ask')")
        .run(runId, 'question', vault.id, now, now, now, session.id);
      db.prepare('INSERT INTO messages(id,session_id,run_id,ordinal,text,input_json,scope_revision,model_revision,context_generation,created_at,memory_generation) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(messageId, session.id, runId, 1, text, JSON.stringify({ text, scope: { mode: 'vault' }, answerPolicy: 'vault_only', action: 'ask' }), 1, 1, 1, now, 1);
      const answer = { id: answerId, runId, sessionId: session.id, createdAt: now, checkedAt: now, revision: 1,
        outcome: 'answered', blocks: [{ id: 'public', kind: 'notice', markdown, evidenceIds: [] }], limitations: [], markdown, citations: [] };
      db.prepare('INSERT INTO answers(id,run_id,session_id,body_json) VALUES (?,?,?,?)').run(answerId, runId, session.id, JSON.stringify(answer));
      answers.push(answer);
    }
    return { dataDirectory, vaultPath, vault, sessions, answers };
  } finally { await vaults.close(); storage.close(); }
}
