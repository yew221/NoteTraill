import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStorage } from '../dist/server/storage.js';
import { ModelSettings } from '../dist/server/model-settings.js';
import { ModelLedger } from '../dist/server/model-ledger.js';
import { ModelProbeService } from '../dist/server/model-probes.js';
import { RunService } from '../dist/server/runs.js';
import { BrowserSession } from '../dist/server/session.js';
import { createApp } from '../dist/server/app.js';
import { checkModelPayload, modelInputEnvelope } from '../dist/server/model-transport.js';
import { ApiError } from '../dist/server/contracts.js';

const key = () => randomUUID(), secret = 'PUBLIC_SYNTHETIC_PROBE_SECRET';
const config = { provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' };
const fails = code => error => error instanceof ApiError && error.publicError.code === code;
function response({ content = 'OK', reason = 'stop', usage = true, calls } = {}) {
  const model = 'deepseek-flash-SYNTHETIC';
  const chunks = [{ model, choices: [{ index: 0, delta: { content, ...(calls ? { tool_calls: calls } : {}) }, finish_reason: reason }] },
    ...(usage ? [{ model, choices: [], usage: { prompt_tokens: 200, completion_tokens: 2, total_tokens: 202 } }] : [])];
  return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
async function fixture(t, fetcher = () => response(), configured = true) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-probe-'))), storage = openStorage(path.join(directory, 'data'));
  const db = storage.db, vaultId = `v_${key()}`, values = new Map(), requests = [];
  db.prepare("INSERT INTO vaults(id,singleton,root_path,root_device,root_inode,exclusions_json) VALUES (?,1,?,'0','0','[]')").run(vaultId, path.join(directory, 'PRIVATE_PATH_MUST_NOT_BE_READ'));
  const vaults = { list: () => ({ items: [{ id: vaultId }], nextCursor: null }),
    get: () => ({ id: vaultId }), scan() { assert.fail('probe cannot scan a vault'); }, content() { assert.fail('probe cannot read sources'); } };
  const credentials = { reads: 0, async write(b, value) { values.set(b.account, value); }, async read(b) { this.reads++; return values.get(b.account); }, async remove(b) { values.delete(b.account); } };
  const models = new ModelSettings(db, credentials);
  if (configured) { await models.setModel(config, 1); await models.setCredential(secret, 2); }
  const ledger = new ModelLedger(db); ledger.batch('probe-tests');
  const probes = new ModelProbeService(db, models, ledger, 'probe-tests', async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) }); return fetcher(init, requests.length);
  });
  const runs = new RunService(db, vaults, undefined, undefined, probes);
  t.after(async () => { await runs.close(); storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, storage, db, vaultId, vaults, credentials, models, ledger, probes, runs, requests };
}
async function completed(f, ref) {
  const until = Date.now() + 5000;
  for (;;) {
    const run = f.runs.get(ref.runId);
    if (['succeeded','failed','cancelled','interrupted'].includes(run.state)) return run;
    assert(Date.now() < until); await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('model probe is an explicit protected HTTP operation with fixed data, metering and idempotent replay', async t => {
  const f = await fixture(t), token = 'P'.repeat(43);
  const app = createApp(new BrowserSession(token), f.models, f.vaults, f.runs);
  await app.listen({ host: '127.0.0.1', port: 0 }); t.after(() => app.close());
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const bootstrap = await fetch(origin + '/api/v1/bootstrap', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0], idempotency = key();
  const headers = { origin, cookie, 'idempotency-key': idempotency }, url = origin + '/api/v1/model/probe';
  assert.equal(f.requests.length, 0); assert.equal(f.credentials.reads, 0);
  assert.equal((await fetch(url, { method: 'POST', headers: { origin } })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, origin: 'https://outside.invalid' } })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', headers: { origin, cookie } })).status, 400);
  assert.equal((await fetch(url + '?repeat=1', { method: 'POST', headers })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{"text":"PRIVATE_OVERRIDE"}' })).status, 400);
  assert.equal(f.requests.length, 0);
  const accepted = await fetch(url, { method: 'POST', headers }); assert.equal(accepted.status, 202);
  const ref = (await accepted.json()).data, run = await completed(f, ref); assert.equal(run.state, 'succeeded', JSON.stringify(run.error));
  assert.equal(run.kind, 'model_probe'); assert.equal(run.sessionId, null); assert.deepEqual(run.result, { modelAvailable: true, modelRevision: 3 });
  assert.equal(run.usage.modelRequests, 1); assert.equal(run.usage.inputTokens, 200); assert.equal(run.usage.cost.value, 0.000416);
  assert.equal(run.usage.toolCalls, 0); assert.equal(run.usage.readBytes, 0);
  const again = await fetch(url, { method: 'POST', headers }); assert.equal((await again.json()).data.runId, ref.runId);
  assert.equal(f.requests.length, 1);
  const body = f.requests[0].body;
  assert.equal(body.tool_choice, 'none'); assert.equal(body.tools, undefined); assert.equal(body.max_tokens, 32); assert.equal(body.messages.length, 2);
  assert(!JSON.stringify(body).includes('PRIVATE_')); assert(!JSON.stringify(body).includes(secret));
  assert.throws(() => checkModelPayload(body), fails('MODEL_PROTOCOL_ERROR'), 'ordinary question validation stays strict');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM messages').get().n, 0); assert(!fs.existsSync(path.join(f.storage.directory, 'workers')));
  assert.equal(f.runs.events(run.id, 0).items.filter(e => e.type === 'run.completed').length, 1);
});

test('missing vault or model configuration fails before a probe or credentials are read', async t => {
  const f = await fixture(t, undefined, false);
  assert.throws(() => f.runs.probe(key()), fails('CONFIG_REQUIRED'));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM runs').get().n, 0);
  await f.models.setModel(config, 1); assert.throws(() => f.runs.probe(key()), fails('CONFIG_REQUIRED'));
  await f.models.setCredential(secret, 2); f.vaults.list = () => ({ items: [], nextCursor: null });
  assert.throws(() => f.runs.probe(key()), fails('CONFIG_REQUIRED'));
  assert.equal(f.requests.length, 0); assert.equal(f.credentials.reads, 0);
});

test('queued probe cancellation and shutdown never start a network request or restart it', async t => {
  const f = await fixture(t), idempotency = key(), ref = f.runs.probe(idempotency);
  assert.equal(f.runs.cancel(ref.runId).state, 'cancelled'); assert.equal(f.runs.probe(idempotency).runId, ref.runId);
  const queued = f.runs.probe(key()); await f.runs.close();
  assert.equal(f.runs.get(queued.runId).state, 'interrupted');
  const recovered = new RunService(f.db, f.vaults, undefined, undefined, f.probes);
  try { assert.equal(recovered.get(queued.runId).state, 'interrupted'); assert.equal(f.requests.length, 0); assert.equal(f.credentials.reads, 0); }
  finally { await recovered.close(); }
});

test('a queued probe cannot use credentials from a newer configuration, and success remains tied to its revision', async t => {
  const f = await fixture(t), ref = f.runs.probe(key());
  await f.models.setModel(config, 3);
  const run = await completed(f, ref); assert.equal(run.state, 'failed'); assert.equal(run.error.code, 'CONTEXT_CHANGED'); assert.equal(f.requests.length, 0);
  const execute = f.probes.execute.bind(f.probes);
  f.probes.execute = async (...args) => { const result = await execute(...args); await f.models.setModel(config, 4); return result; };
  const stale = await completed(f, f.runs.probe(key())); assert.equal(stale.state, 'failed'); assert.equal(stale.error.code, 'CONTEXT_CHANGED');
  assert.equal(stale.result, null); assert.equal(stale.usage.modelRequests, 1); assert.equal(stale.usage.cost.basis, 'estimate');
});

test('cancelling an in-flight probe keeps its unknown charge and permits an explicitly requested next probe', async t => {
  let entered; const enteredPromise = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, (_init, number) => { if (number > 1) return response(); entered(); return new Promise(() => {}); });
  const ref = f.runs.probe(key()); await enteredPromise; f.runs.cancel(ref.runId);
  const run = await completed(f, ref); assert.equal(run.state, 'cancelled'); assert.equal(run.usage.cost.basis, 'unknown');
  assert.equal(f.ledger.batchTotals('probe-tests').reservedMicroYuan, modelInputEnvelope(f.requests[0].body) * 2 + 32 * 8);
  const second = await completed(f, f.runs.probe(key())); assert.equal(second.state, 'succeeded'); assert.equal(f.requests.length, 2);
  assert.equal(f.db.prepare("SELECT state FROM model_attempts WHERE run_id=?").get(ref.runId).state, 'unknown');
});

test('changing model configuration aborts a running probe without reporting the old connection as current', async t => {
  let entered; const enteredPromise = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, () => { entered(); return new Promise(() => {}); });
  const ref = f.runs.probe(key()); await enteredPromise; await f.models.setModel(config, 3);
  const run = await completed(f, ref); assert.equal(run.state, 'failed'); assert.equal(run.error.code, 'CONTEXT_CHANGED');
  assert.equal(run.result, null); assert.equal(run.usage.cost.basis, 'unknown'); assert.equal(f.requests.length, 1);
});

test('model probe authentication and protocol errors keep truthful results and never execute tools or expose response text', async t => {
  const cases = [
    ['authentication', () => new Response(secret, { status: 401 }), 'MODEL_AUTH_FAILED', 'unknown'],
    ['missing usage', () => response({ usage: false }), 'MODEL_PROTOCOL_ERROR', 'unknown'],
    ['empty text', () => response({ content: '' }), 'MODEL_PROTOCOL_ERROR', 'estimate'],
    ['filtered', () => response({ reason: 'content_filter' }), 'MODEL_PROTOCOL_ERROR', 'estimate'],
    ['tool call', () => response({ reason: 'tool_calls', calls: [{ index: 0, id: 'injected', type: 'function', function: { name: 'vault_read', arguments: '{}' } }] }), 'MODEL_PROTOCOL_ERROR', 'estimate'],
    ['secret echo', () => response({ content: secret }), 'MODEL_PROTOCOL_ERROR', 'estimate'],
  ];
  for (const [name, fetcher, code, basis] of cases) await t.test(name, async t => {
    const f = await fixture(t, fetcher), run = await completed(f, f.runs.probe(key()));
    assert.equal(run.state, 'failed'); assert.equal(run.error.code, code); assert.equal(run.usage.cost.basis, basis);
    assert.equal(run.result, null); assert.equal(run.usage.modelRequests, 1); assert.equal(run.usage.toolCalls, 0);
    assert(!JSON.stringify(run).includes(secret)); assert(!JSON.stringify(f.runs.events(run.id, 0)).includes(secret));
  });
});

test('a definitely-unsent DNS failure retries once within the same probe budget', async t => {
  const f = await fixture(t, (_init, call) => {
    if (call === 1) throw Object.assign(new Error('synthetic dns'), { cause: { code: 'EAI_AGAIN', syscall: 'getaddrinfo', hostname: 'api.deepseek.com' } });
    return response();
  });
  const run = await completed(f, f.runs.probe(key())); assert.equal(run.state, 'succeeded'); assert.equal(run.usage.modelRequests, 2);
  assert.equal(f.ledger.totals(run.id).retries, 1); assert.equal(run.usage.cost.value, 0.000416);
});
