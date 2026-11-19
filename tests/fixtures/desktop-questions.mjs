import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { openStorage } from '../../dist/server/storage.js';
import { VaultService } from '../../dist/server/vaults.js';
import { VaultFiles } from '../../dist/server/vault-files.js';
import { ConversionFiles } from '../../dist/server/conversion-files.js';
import { ModelSettings } from '../../dist/server/model-settings.js';
import { ModelLedger } from '../../dist/server/model-ledger.js';
import { WorkerRunner } from '../../dist/server/worker-runner.js';
import { Ripgrep } from '../../dist/server/ripgrep.js';
import { ConversationService } from '../../dist/server/conversations.js';
import { AnswerService } from '../../dist/server/answers.js';
import { QuestionService } from '../../dist/server/questions.js';
import { RunService } from '../../dist/server/runs.js';
import { BrowserSession } from '../../dist/server/session.js';
import { createApp } from '../../dist/server/app.js';
import { IngestService } from '../../dist/server/ingestions.js';
import { IngestFiles } from '../../dist/server/ingest-files.js';
import { ModelProbeService } from '../../dist/server/model-probes.js';

const root = fs.realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
function stream(calls, answer, delayMs = 0) {
  const model = 'deepseek-flash-SYNTHETIC', chunks = [{ model, choices: [{ index: 0,
    delta: calls ? { tool_calls: calls.map((call, index) => ({ index, id: `read_${randomUUID()}`, type: 'function', function: {
      name: 'vault_read', arguments: JSON.stringify(call) } })) } : { content: JSON.stringify(answer) }, finish_reason: calls ? 'tool_calls' : 'stop' }] },
  { model, choices: [], usage: { prompt_tokens: 600, completion_tokens: 100, total_tokens: 700 } }];
  if (!calls && delayMs) {
    const text = JSON.stringify(answer), fragments = [];
    for (let at = 0; at < text.length; at += 8) fragments.push({ model, choices: [{ index: 0, delta: { content: text.slice(at, at + 8) }, finish_reason: null }] });
    fragments.push({ model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, chunks.at(-1));
    const lines = [...fragments.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`), 'data: [DONE]\n\n'];
    let timer, index = 0;
    return new Response(new ReadableStream({ start(controller) {
      const next = () => { if (index === lines.length) { controller.close(); return; } controller.enqueue(Buffer.from(lines[index++])); timer = setTimeout(next, delayMs); }; next();
    }, cancel() { clearTimeout(timer); } }), { headers: { 'content-type': 'text/event-stream' } });
  }
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}

// Real storage, HTTP, Pi worker, tools and citation validation; only the model transport is synthetic.
export async function desktopQuestions(directory, { streamDelayMs = 0, syntheticCatalog = false } = {}) {
  const vaultPath = path.join(directory, 'vault'), dataDirectory = path.join(directory, 'data');
  fs.mkdirSync(vaultPath, { recursive: true, mode: 0o700 });
  const note = path.join(vaultPath, 'notes.md');
  if (!fs.existsSync(note)) fs.writeFileSync(note, '# 桌面公开样本\n蓝盒在北柜第二层。\n交接截止时间为周五 15:00。\n');
  const storage = openStorage(dataDirectory), db = storage.db;
  const python = process.env.NOTETRAIL_PYTHON, rg = process.env.NOTETRAIL_RG;
  if (!python || !rg) { storage.close(); throw new Error('Synthetic desktop requires the pinned test Python and ripgrep.'); }
  const vaults = new VaultService(db, new VaultFiles(python, [storage.directory, root]), new ConversionFiles(python, [storage.directory, root]));
  const vault = vaults.list().items[0] ?? await vaults.connect({ absolutePath: vaultPath, exclusions: [] });
  const credentials = new Map();
  const models = new ModelSettings(db, { async write(binding, value) { credentials.set(binding.account, value); },
    async read(binding) { return credentials.get(binding.account); }, async remove(binding) { credentials.delete(binding.account); } });
  if (!models.view().model) await models.setModel({ provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' }, models.view().revision);
  await models.setCredential('PUBLIC_SYNTHETIC_DESKTOP_ONLY', models.view().revision);
  if (syntheticCatalog) { const catalog = models.catalog.bind(models); models.catalog = input => catalog(input, async () => Response.json({ data: [{ id: 'public-chat' }, { id: 'public-mini' }] })); }
  const ledger = new ModelLedger(db); ledger.recover(); ledger.batch('synthetic-desktop');
  const requests = [];
  const runner = new WorkerRunner(db, vaults, new Ripgrep(rg), models, ledger, storage.directory, async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    const lastUser = body.messages.findLastIndex(message => message.role === 'user');
    const prompt = JSON.stringify(body.messages[lastUser].content);
    if (/停止测试|STOP_TEST/.test(prompt)) return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new DOMException('Synthetic aborted', 'AbortError')); };
      const timer = setTimeout(() => { init.signal.removeEventListener('abort', abort); resolve(stream(null,
        { outcome: 'insufficient_evidence', blocks: [{ id: 'b1', kind: 'notice', markdown: '停止测试等待结束。', evidenceIds: [] }], limitations: [] })); }, 60_000);
      init.signal.addEventListener('abort', abort, { once: true }); if (init.signal.aborted) abort();
    });
    const results = body.messages.slice(lastUser + 1).filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
    if (!results.length) {
      let cursor, source;
      do {
        const page = vaults.sources(vault.id, { limit: '50', ...(cursor ? { cursor } : {}) });
        source = page.items.find(item => item.relativePath === 'notes.md'); cursor = page.nextCursor;
      } while (!source && cursor);
      return stream([{ sourceId: source.id, startLine: 2, maxLines: 2 }]);
    }
    const evidence = results.find(result => result.ok && result.data.evidence)?.data.evidence;
    return stream(null, evidence ? { outcome: 'answered', blocks: [{ id: 'b1', kind: 'grounded',
      markdown: evidence.excerpt.trim(), evidenceIds: [evidence.id] }], limitations: ['公开样本与离线模拟响应，仅用于桌面流程验收。'] } :
      { outcome: 'insufficient_evidence', blocks: [{ id: 'b1', kind: 'notice', markdown: '所选范围没有取得可引用的资料。', evidenceIds: [] }], limitations: [] }, streamDelayMs);
  });
  const conversations = new ConversationService(db, vaults, models), answers = new AnswerService(db, vaults);
  const questions = new QuestionService(db, vaults, models, conversations, answers, runner, ledger, storage.directory, 'synthetic-desktop');
  const webRequests = [];
  const ingestions = new IngestService(db, vaults, new IngestFiles(python, storage.directory, root), {
    async fetch(url) {
      webRequests.push(url);
      return { bytes: Buffer.from('<html><head><title>桌面公开网页样本</title></head><body><h1>公开网页</h1><p>公开巡检日为周三。</p></body></html>'),
        sourceUrl: url, filename: '网页.html', capturedAt: new Date().toISOString() };
    },
  });
  const probes = new ModelProbeService(db, models, ledger, 'synthetic-desktop', async () => new Response([
    { model: 'deepseek-flash-SYNTHETIC', choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] },
    { model: 'deepseek-flash-SYNTHETIC', choices: [], usage: { prompt_tokens: 30, completion_tokens: 1, total_tokens: 31 } },
  ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  const runs = new RunService(db, vaults, ingestions, questions, probes);
  const bootstrapToken = randomBytes(32).toString('base64url');
  const app = createApp(new BrowserSession(bootstrapToken,
    () => performance.now() + (fs.existsSync(path.join(directory, 'expire-session')) ? 8 * 60 * 60 * 1000 + 1 : 0)), models, vaults, runs, questions);
  await app.listen({ host: '127.0.0.1', port: 0 });
  let stopped = false;
  return { db, models, vaults, vault, runs, conversations, answers, requests, webRequests, note, dataDirectory,
    connection: { origin: `http://127.0.0.1:${app.server.address().port}`, bootstrapToken },
    async stop() { if (stopped) return; stopped = true; await runs.close(); await app.close(); ingestions.close(); await vaults.close(); storage.close(); } };
}

export function desktopSandbox(directory, options = {}) {
  const sandbox = path.join(directory, 'application');
  fs.mkdirSync(path.join(sandbox, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'desktop')); fs.mkdirSync(path.join(sandbox, 'src'));
  fs.cpSync(path.join(root, 'src/desktop'), path.join(sandbox, 'src/desktop'), { recursive: true });
  fs.cpSync(path.join(root, 'dist'), path.join(sandbox, 'dist'), { recursive: true });
  for (const file of ['package.json', 'desktop/package.json', 'scripts/desktop.mjs']) fs.copyFileSync(path.join(root, file), path.join(sandbox, file));
  fs.symlinkSync(path.join(root, 'desktop/node_modules'), path.join(sandbox, 'desktop/node_modules'));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(sandbox, 'node_modules'));
  fs.writeFileSync(path.join(sandbox, 'scripts/desktop-backend.mjs'), `import { desktopQuestions } from ${JSON.stringify(new URL('./desktop-questions.mjs', import.meta.url).href)};
import fs from 'node:fs';
import path from 'node:path';
const dataDirectory = process.argv[process.argv.indexOf('--data-dir') + 1];
const fixture = await desktopQuestions(path.dirname(dataDirectory), ${JSON.stringify(options)});
fs.writeFileSync(path.join(path.dirname(dataDirectory), 'synthetic-backend-pid'), String(process.pid));
process.send({ type: 'ready', protocol: 1, ...fixture.connection });
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; await fixture.stop(); if (process.connected) process.disconnect(); };
process.on('message', message => { if (message?.type === 'stop') void stop(); });
process.on('disconnect', () => void stop());
`);
  return sandbox;
}
