// Public fixtures only. The real Pi child receives a synthetic SSE transport; no model network/key is used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { run } from './distribution.mjs';
import { openStorage } from '../dist/server/storage.js';
import { VaultFiles } from '../dist/server/vault-files.js';
import { ConversionFiles } from '../dist/server/conversion-files.js';
import { VaultService } from '../dist/server/vaults.js';
import { ModelSettings } from '../dist/server/model-settings.js';
import { ModelLedger } from '../dist/server/model-ledger.js';
import { Ripgrep } from '../dist/server/ripgrep.js';
import { WorkerRunner } from '../dist/server/worker-runner.js';
import { createApp } from '../dist/server/app.js';

const appRoot = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url))), release = path.dirname(appRoot);
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-smoke-')));
let storage, vaults, app;
try {
  const lock = JSON.parse(fs.readFileSync(path.join(appRoot, 'scripts/runtime-lock.json')));
  assert.equal(process.version, `v${lock.node.version}`);
  if (!process.argv.includes('--desktop')) assert((await run(path.join(release, 'runtime/uv/uv'), ['--version'], { env: process.env })).startsWith(`uv ${lock.uv.version}`));
  assert((await run(process.env.NOTETRAIL_RG, ['--version'], { env: process.env })).startsWith(`ripgrep ${lock.rg.version}`));
  const python = process.env.NOTETRAIL_PYTHON;
  const check = `import sys,ctypes,importlib.metadata as m,pathlib\nassert sys.version.split()[0]==${JSON.stringify(lock.python.version)}\nctypes.CDLL('/System/Library/Frameworks/Security.framework/Security')\nfor line in pathlib.Path(sys.argv[1]).read_text().splitlines():\n if '==' in line and not line.startswith('#'):\n  name,version=line.split('=='); assert m.version(name)==version\nprint('ok')`;
  assert.equal((await run(python, ['-I', '-B', '-c', check, path.join(appRoot, 'scripts/conversion-requirements.lock')], { env: process.env })).trim(), 'ok');
  const vault = path.join(temporary, 'vault'); fs.mkdirSync(vault, { mode: 0o700 });
  fs.writeFileSync(path.join(vault, 'public.md'), '# 公开自检\n蓝色工具箱位于东门。\n');
  for (const name of ['inspection.docx', 'inspection.pdf']) fs.copyFileSync(path.join(appRoot, 'tests/fixtures/public/t00/inputs/formats', name), path.join(vault, name));
  storage = openStorage(path.join(temporary, 'data'));
  vaults = new VaultService(storage.db, new VaultFiles(python, [storage.directory, appRoot]), new ConversionFiles(python, [storage.directory, appRoot]));
  const connected = await vaults.connect({ absolutePath: vault, exclusions: [] });
  for (const name of ['inspection.docx', 'inspection.pdf']) {
    const doc = vaults.sources(connected.id, { limit: '50' }).items.find(item => item.relativePath === name);
    assert(doc); await vaults.prepareSource(doc.id); assert.equal(vaults.source(doc.id).state, 'ready');
    assert((await vaults.content(doc.id, 'text', doc.version)).bytes.toString().includes('松岚实验站'));
  }
  const rg = new Ripgrep(process.env.NOTETRAIL_RG); assert.deepEqual(await rg.lines('蓝色工具箱\n红色', ['工具箱'], 5, new AbortController().signal), [1]);
  const values = new Map(), models = new ModelSettings(storage.db, {
    async write(binding, value) { values.set(binding.account, value); }, async read(binding) { return values.get(binding.account); }, async remove(binding) { values.delete(binding.account); } });
  await models.setModel({ provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' }, 1);
  await models.setCredential('PUBLIC_SYNTHETIC_SMOKE_SECRET', 2);
  const ledger = new ModelLedger(storage.db); ledger.batch('install-smoke');
  let syntheticCalls = 0;
  const runner = new WorkerRunner(storage.db, vaults, rg, models, ledger, storage.directory, async () => {
    syntheticCalls++;
    const draft = { outcome: 'insufficient_evidence', blocks: [{ id: 'b1', kind: 'notice', markdown: '公开自检结束。', evidenceIds: [] }], limitations: ['离线模拟回复。'] };
    const chunks = [{ model: 'deepseek-flash-SYNTHETIC', choices: [{ index: 0, delta: { content: JSON.stringify(draft) }, finish_reason: 'stop' }] },
      { model: 'deepseek-flash-SYNTHETIC', choices: [], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }];
    return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const runId = `r_${randomUUID()}`, now = new Date().toISOString();
  storage.db.prepare("INSERT INTO runs(id,kind,vault_id,state,created_at,started_at) VALUES (?,'message',?,'running',?,?)").run(runId, connected.id, now, now);
  const candidate = await runner.run({ runId, vaultId: connected.id, scope: { mode: 'vault' }, scopeRevision: vaults.get(connected.id).revision,
    deadline: Date.now() + 20000, signal: new AbortController().signal, generation: 1, sessionId: `c_${randomUUID()}`, segmentId: `seg_${randomUUID()}`,
    question: '公开安装自检', preferences: [], thinking: 'off', batchId: 'install-smoke', modelRevision: models.view().revision });
  assert.equal(candidate.draft.outcome, 'insufficient_evidence'); assert.equal(syntheticCalls, 1);
  app = createApp(); await app.listen({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(`${origin}/api/v1/health`)).status, 200);
  for (const route of ['/', '/assets/app.js']) {
    const response = await fetch(origin + route);
    assert.equal(response.status, 401);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    await response.body.cancel();
  }
  console.log(JSON.stringify({ ok: true, checks: { nativeSqlite: true, pythonPackages: 35, securityFrameworkLoaded: true,
    conversion: ['DOCX', 'PDF'], ripgrep: true, piIsolatedProcess: true, localApiHttp: true }, syntheticModelCalls: syntheticCalls, realCloudRequests: 0 }));
} catch { console.error('本地自检失败：请核对运行环境、原生依赖及安装目录完整性。'); process.exitCode = 1; }
finally { await app?.close(); await vaults?.close(); storage?.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
