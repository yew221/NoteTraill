// Disposable public fault fixture. Uses the formal server entry; all provider traffic is replaced here.
import fs from 'node:fs';
import { openStorage } from '../../dist/server/storage.js';
import { ModelSettings } from '../../dist/server/model-settings.js';
import { KeychainCredentials } from '../../dist/server/credentials.js';
import { RunService } from '../../dist/server/runs.js';
import { WorkerRunner } from '../../dist/server/worker-runner.js';
import { start } from '../../dist/server/index.js';

const config = JSON.parse(process.argv[2]), stats = { messagePosts: 0, modelCalls: 0, realCloudCalls: 0, pid: process.pid };
const report = () => { if (config.report) fs.writeFileSync(config.report, JSON.stringify(stats)); process.send?.({ type: 'stats', ...stats }); };
const storage = openStorage(config.data), models = new ModelSettings(storage.db, { async write() {}, async read() { return 'PUBLIC_FAULT_FIXTURE_ONLY'; }, async remove() {} });
if (!models.view().model) {
  await models.setModel({ provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' }, 1);
  await models.setCredential('PUBLIC_FAULT_FIXTURE_ONLY', 2);
}
storage.close();
KeychainCredentials.prototype.read = async () => 'PUBLIC_FAULT_FIXTURE_ONLY';
KeychainCredentials.prototype.remove = async () => {};
let activeWorker;
const drive = WorkerRunner.prototype.drive;
WorkerRunner.prototype.drive = function(child, ...args) { activeWorker = child; return drive.call(this, child, ...args); };
const message = RunService.prototype.message;
RunService.prototype.message = function(...args) { stats.messagePosts++; report(); return message.apply(this, args); };
const finish = RunService.prototype.finish;
RunService.prototype.finish = function(id, state, ...args) {
  if (state === 'succeeded' && config.fault === 'commit-before') {
    this.db.function('test_crash', () => process.kill(process.pid, 'SIGKILL'));
    this.db.exec("CREATE TEMP TRIGGER crash_commit BEFORE INSERT ON run_events WHEN NEW.type='run.completed' BEGIN SELECT test_crash(); END");
  }
  const result = finish.call(this, id, state, ...args);
  if (state === 'succeeded' && config.fault === 'commit-after') process.kill(process.pid, 'SIGKILL');
  return result;
};
globalThis.fetch = async (url, init) => {
  if (String(url) !== 'https://api.deepseek.com/chat/completions') throw new Error('Fixture refuses non-model network');
  stats.modelCalls++; report();
  if (config.fault === 'worker') { activeWorker.kill('SIGKILL'); throw new Error('synthetic worker crash'); }
  const body = JSON.parse(init.body), question = JSON.stringify(body.messages.findLast(m => m.role === 'user')?.content);
  if (config.fault === 'hold' || question.includes('恢复验收慢速')) {
    await new Promise((resolve, reject) => {
      const release = () => { init.signal.removeEventListener('abort', aborted); resolve(); };
      const aborted = () => { process.off('SIGUSR1', release); reject(new Error('synthetic abort')); };
      process.once('SIGUSR1', release); init.signal.addEventListener('abort', aborted, { once: true });
      if (init.signal.aborted) aborted();
    });
  }
  const answer = { outcome: 'insufficient_evidence', blocks: [{ id: 'notice', kind: 'notice', markdown: '公开恢复验收：当前资料不足。', evidenceIds: [] }], limitations: [] };
  const chunks = [{ model: 'deepseek-flash-SYNTHETIC', choices: [{ index: 0, delta: { content: JSON.stringify(answer) }, finish_reason: 'stop' }] },
    { model: 'deepseek-flash-SYNTHETIC', choices: [], usage: { prompt_tokens: 600, completion_tokens: 100, total_tokens: 700 } }];
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
};
await start(['--data-dir', config.data, '--port', String(config.port ?? 0)], {
  ready: connection => process.send({ type: 'ready', ...connection }),
});
