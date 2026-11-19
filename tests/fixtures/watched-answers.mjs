import { MODEL_LIMITS } from '../../dist/shared/model-run.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openStorage, MIGRATIONS } from '../../dist/server/storage.js';
import { VaultFiles } from '../../dist/server/vault-files.js';
import { VaultService } from '../../dist/server/vaults.js';
import { VaultToolSession } from '../../dist/server/vault-tools.js';
import { Ripgrep } from '../../dist/server/ripgrep.js';
import { ModelSettings } from '../../dist/server/model-settings.js';
import { ModelLedger } from '../../dist/server/model-ledger.js';
import { WorkerRunner } from '../../dist/server/worker-runner.js';
import { AnswerService } from '../../dist/server/answers.js';
import { ConversationService } from '../../dist/server/conversations.js';
import { QuestionService } from '../../dist/server/questions.js';
import { RunService } from '../../dist/server/runs.js';
import { BrowserSession } from '../../dist/server/session.js';
import { createApp } from '../../dist/server/app.js';
import { ApiError } from '../../dist/server/contracts.js';
import { ConversionFiles } from '../../dist/server/conversion-files.js';
import Database from 'better-sqlite3';
import { IngestService } from '../../dist/server/ingestions.js';
import { IngestFiles } from '../../dist/server/ingest-files.js';
import { backupData, restoreData } from '../../dist/server/maintenance.js';
import { readSessionFile } from '../../dist/server/session-files.js';

const python = process.env.NOTETRAIL_PYTHON ?? path.join(os.homedir(), '.local/share/uv/tools/markitdown/bin/python');
const rg = process.env.NOTETRAIL_RG ?? ['/opt/homebrew/bin/rg','/usr/local/bin/rg','/Applications/ChatGPT.app/Contents/Resources/codex-cli/codex-path/rg'].find(fs.existsSync);
const options = { skip: process.platform !== 'darwin', timeout: 20000 };
const fails = code => error => error instanceof ApiError && error.publicError.code === code;
const key = () => randomUUID();
const notices = () => ({ outcome: 'insufficient_evidence', blocks: [{ id: 'b1', kind: 'notice', markdown: '当前资料不足。', evidenceIds: [] }], limitations: [] });
const grounded = evidence => ({ outcome: 'answered', blocks: [{ id: 'b1', kind: 'grounded', markdown: evidence.excerpt.trim(), evidenceIds: [evidence.id] }], limitations: [] });
const evidenceFrom = body => body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content)).filter(r => r.ok && r.data.evidence).map(r => r.data.evidence);
export function response({ calls, answer = notices() } = {}) {
  const model = 'deepseek-flash-SYNTHETIC', chunks = [];
  if (calls) chunks.push({ model, choices: [{ index: 0, delta: { tool_calls: calls.map((c, index) => ({ index, id: c.id, type: 'function',
    function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) }, finish_reason: 'tool_calls' }] });
  else chunks.push({ model, choices: [{ index: 0, delta: { content: JSON.stringify(answer) }, finish_reason: 'stop' }] });
  chunks.push({ model, choices: [], usage: { prompt_tokens: 600, completion_tokens: 100, total_tokens: 700 } });
  return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
export async function fixture(t, model) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-questions-'))), vault = path.join(directory, 'vault');
  fs.mkdirSync(path.join(vault, 'allowed'), { recursive: true }); fs.mkdirSync(path.join(vault, 'other'));
  fs.writeFileSync(path.join(vault, 'allowed/a.md'), '# 甲方案\n旧事实甲：工具箱在三楼。\n');
  fs.writeFileSync(path.join(vault, 'allowed/b.md'), '# 乙方案\n事实乙：工具箱在二楼。\n');
  fs.writeFileSync(path.join(vault, 'other/outside.md'), '不在所选目录的事实。\n');
  const storage = openStorage(path.join(directory, 'data')), db = storage.db;
  const roots = [storage.directory, fs.realpathSync(process.cwd())];
  const vaults = new VaultService(db, new VaultFiles(python, roots), new ConversionFiles(python, roots));
  const connected = await vaults.connect({ absolutePath: vault, exclusions: [] }), credentials = new Map();
  const models = new ModelSettings(db, { async write(binding, value) { credentials.set(binding.account, value); },
    async read(binding) { return credentials.get(binding.account); }, async remove(binding) { credentials.delete(binding.account); } });
  await models.setModel({ provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' }, 1);
  await models.setCredential('PUBLIC_SYNTHETIC_QUESTION_SECRET_ONLY', 2);
  const ledger = new ModelLedger(db); ledger.batch('synthetic');
  const requests = [], runner = new WorkerRunner(db, vaults, new Ripgrep(rg), models, ledger, storage.directory, async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body); return model(body, requests.length - 1, init);
  });
  const conversations = new ConversationService(db, vaults, models), answers = new AnswerService(db, vaults);
  const questions = new QuestionService(db, vaults, models, conversations, answers, runner, ledger, storage.directory, 'synthetic');
  const ingestions = new IngestService(db, vaults, new IngestFiles(python, storage.directory, roots[1]));
  const runs = new RunService(db, vaults, ingestions, questions), conversation = conversations.create({ vaultId: connected.id });
  const sources = vaults.sources(connected.id, { limit: '50' }).items, a = sources.find(s => s.relativePath === 'allowed/a.md'), b = sources.find(s => s.relativePath === 'allowed/b.md');
  let stopped = false;
  const stop = async () => { if (stopped) return; stopped = true; await runs.close(); ingestions.close(); await vaults.close(); };
  t.after(async () => { await stop(); storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, vault, storage, db, vaults, models, ledger, runner, conversations, answers, questions, runs, ingestions, conversation, requests, a, b, stop,
    ask(text = '比较甲方案与乙方案', extra = {}, idempotencyKey = key()) {
      return runs.message(conversation.id, { text, scope: { mode: 'selected', paths: ['allowed/'] }, answerPolicy: 'vault_only', ...extra }, idempotencyKey);
    },
  };
}
export async function completed(f, ref) {
  const deadline = Date.now() + 12000;
  for (;;) {
    const run = f.runs.get(ref.runId);
    if (['succeeded','failed','cancelled','interrupted'].includes(run.state)) return run;
    assert(Date.now() < deadline, 'question did not finish');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function reading(f, id, source = f.a) {
  return { id, name: 'vault_read', arguments: { sourceId: source.id, startLine: 1, maxLines: 2 } };
}
