import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStorage, MIGRATIONS } from '../dist/server/storage.js';
import { ModelSettings } from '../dist/server/model-settings.js';
import { ModelLedger } from '../dist/server/model-ledger.js';
import { ModelTransport } from '../dist/server/model-transport.js';
import { isSaveModelProfile, isModelCatalogRequest } from '../dist/shared/model-profiles.js';
import { requestRoute } from '../src/desktop/bridge.mjs';

const keyA = 'PUBLIC_SYNTHETIC_PROFILE_A_ONLY', keyB = 'PUBLIC_SYNTHETIC_PROFILE_B_ONLY';
const config = { provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' };
const compatible = { provider: 'openai-compatible', model: 'public-model', baseUrl: 'https://public-model.example/v1' };
const fails = code => error => error.publicError?.code === code;
function fixture(t, migrate = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-model-profiles-'))), directory = path.join(root, 'data');
  const values = new Map(), credentials = { reads: 0, async write(binding, secret) { await this.beforeWrite?.(); values.set(binding.account, secret); },
    async read(binding) { this.reads++; return values.get(binding.account); }, async remove(binding) { values.delete(binding.account); } };
  let storage = openStorage(directory, migrate ? MIGRATIONS.slice(0, 13) : MIGRATIONS);
  if (migrate) {
    const id = randomUUID(); values.set(id, keyA);
    storage.db.prepare('UPDATE model_settings SET revision=3,provider=?,model=?,base_url=?,credential_id=? WHERE singleton=1').run(config.provider, config.model, config.baseUrl, id);
    storage.close(); storage = openStorage(directory);
  }
  const models = new ModelSettings(storage.db, credentials);
  t.after(() => { storage.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const save = (change = {}) => models.saveProfile({ ...config, name: '公开配置', modelIds: ['deepseek-flash'], pricing: null, apiKey: keyA, expectedRevision: models.view().revision, ...change });
  return { root, directory, storage, models, credentials, values, save };
}
test('v13 migration preserves the existing key reference and creates a verified pre-migration backup', async t => {
  const f = fixture(t, true), view = f.models.profiles();
  assert.equal(view.activeId, 'mp_default'); assert.equal(view.profiles.length, 1);
  assert.equal(f.credentials.reads, 0); assert.equal(view.profiles[0].credentialConfigured, true);
  assert.deepEqual(view.profiles[0].pricing, { input: 2, output: 8 });
  assert.equal((await f.models.forRequest()).apiKey, keyA); assert(!JSON.stringify(view).includes(keyA));
  assert(fs.readdirSync(path.join(f.directory, 'backups')).some(name => name.startsWith('schema-13-')));
});
test('saved configurations retain independent keys through switching, cleanup, editing and deletion', async t => {
  const f = fixture(t); let view = await f.save(), first = view.activeId;
  view = await f.save({ ...compatible, name: '兼容接口', modelIds: ['public-model'], pricing: { input: 3, output: 12 }, apiKey: keyB });
  const second = view.profiles.find(p => p.id !== first).id;
  assert.equal(view.activeId, first); assert.equal(f.values.size, 2); assert.equal(f.credentials.reads, 0);
  view = f.models.activateProfile(second, view.revision);
  assert.equal((await f.models.forRequest()).apiKey, keyB); assert.deepEqual(f.models.activePricing(), { input: 3, output: 12 });
  await f.models.cleanupRetired(); assert.equal(f.values.size, 2);
  view = f.models.activateProfile(first, view.revision); assert.equal((await f.models.forRequest()).apiKey, keyA);
  view = await f.save({ ...compatible, id: second, baseUrl: 'https://new-public.example/v1', apiKey: undefined });
  assert.equal(view.profiles.find(p => p.id === second).credentialConfigured, false); assert.equal(f.values.size, 1);
  view = await f.models.deleteProfile(first, view.revision); assert.equal(view.activeId, null); assert.equal(f.models.view().model, null); assert.equal(f.values.size, 0);
  assert(!JSON.stringify(view).includes(keyA));
});
test('profile edits and switching reject busy runs and stale writes without losing the old key', async t => {
  const f = fixture(t); let view = await f.save();
  const vault = `v_${randomUUID()}`, run = `r_${randomUUID()}`;
  f.storage.db.prepare("INSERT INTO vaults(id,singleton,root_path,root_device,root_inode,exclusions_json) VALUES (?,1,'/public','0','0','[]')").run(vault);
  f.storage.db.prepare("INSERT INTO runs(id,kind,vault_id,state,created_at) VALUES (?,'message',?,'queued',?)").run(run, vault, new Date().toISOString());
  assert.throws(() => f.models.activateProfile(view.activeId, view.revision), fails('MODEL_SETTINGS_BUSY'));
  await assert.rejects(f.save(), fails('MODEL_SETTINGS_BUSY')); assert.equal(f.values.size, 1);
  f.storage.db.prepare("UPDATE runs SET state='cancelled' WHERE id=?").run(run);
  f.credentials.beforeWrite = async () => { f.models.activateProfile(view.activeId, view.revision); };
  await assert.rejects(f.save({ id: view.activeId, apiKey: keyB }), fails('REVISION_CONFLICT'));
  assert.equal(f.values.size, 1); assert.equal((await f.models.forRequest()).apiKey, keyA);
});
test('model catalog uses the chosen endpoint and credential, cannot reuse a key at a changed host, and never returns secrets', async t => {
  const f = fixture(t); const view = await f.save();
  const input = { provider: 'deepseek', baseUrl: config.baseUrl, id: view.activeId, expectedRevision: view.revision };
  const catalog = await f.models.catalog(input, async (url, init) => {
    assert.equal(url, config.baseUrl + '/models'); assert.equal(init.redirect, 'error'); assert.equal(init.headers.authorization, `Bearer ${keyA}`);
    return Response.json({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-flash' }, { id: '../bad id' }, { id: 'deepseek-v4-pro' }] });
  });
  assert.deepEqual(catalog.models, ['deepseek-flash', 'deepseek-v4-pro']);
  await assert.rejects(f.models.catalog({ ...input, ...compatible }, () => { throw new Error('must not call'); }), fails('BAD_REQUEST'));
  await assert.rejects(f.models.catalog({ ...input, provider: 'openai-compatible', baseUrl: compatible.baseUrl }, () => { throw new Error('must not call'); }), fails('CONFIG_REQUIRED'));
  await assert.rejects(f.models.catalog(input, async () => Response.json({ data: [{ id: keyA }] })), fails('MODEL_PROTOCOL_ERROR'));
  const escapedKey = [...keyA].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  await assert.rejects(f.models.catalog(input, async () => new Response(`{"data":[{"id":"${escapedKey}"}]}`)), fails('MODEL_PROTOCOL_ERROR'));
  const fresh = await f.models.catalog({ provider: compatible.provider, baseUrl: compatible.baseUrl, apiKey: keyB, expectedRevision: view.revision }, async (_url, init) => {
    assert.equal(init.headers.authorization, `Bearer ${keyB}`); return Response.json({ data: [{ id: 'public-model' }] });
  });
  assert.deepEqual(fresh.models, ['public-model']); assert.equal(f.values.size, 1, 'catalog does not save new credentials');
});
test('unknown price blocks before network, while each settled request uses its frozen model price', async t => {
  const f = fixture(t); await f.save({ ...compatible, pricing: null });
  const db = f.storage.db, vault = `v_${randomUUID()}`, run = `r_${randomUUID()}`, now = new Date().toISOString();
  db.prepare("INSERT INTO vaults(id,singleton,root_path,root_device,root_inode,exclusions_json) VALUES (?,1,'/public','0','0','[]')").run(vault);
  db.prepare("INSERT INTO runs(id,kind,vault_id,state,created_at,started_at) VALUES (?,'model_probe',?,'running',?,?)").run(run, vault, now, now);
  const ledger = new ModelLedger(db); ledger.batch('public'); ledger.start(run, 'public');
  const transport = new ModelTransport(ledger, f.models, run, f.models.view().revision, new AbortController().signal, () => { assert.fail('network must not run'); });
  try { await assert.rejects(transport.probe(), fails('MODEL_PRICING_REQUIRED')); } finally { transport.close(); }
  assert.equal(ledger.totals(run).modelRequests, 0);
  const reservation = ledger.reserve(run, { input: 3, output: 11 }, compatible);
  ledger.sent(reservation.id, 100, 'a'.repeat(64)); ledger.settle(reservation.id, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }, 'public-model');
  assert.equal(ledger.totals(run).costMicroYuan, 520);
  assert.deepEqual(JSON.parse(db.prepare('SELECT model_config_json FROM model_attempts').get().model_config_json), compatible);
});
test('profile routes validate named operations and never permit credential-bearing read requests', () => {
  const input = { ...config, name: '公开', pricing: null, modelIds: ['deepseek-flash'], apiKey: keyA, expectedRevision: 1 };
  assert(isSaveModelProfile(input)); assert.equal(requestRoute({ op: 'saveModelProfile', input }).method, 'PUT');
  assert.equal(requestRoute({ op: 'modelProfiles' }).method, 'GET');
  assert(!isSaveModelProfile({ ...input, provider: 'anthropic' }));
  assert(!isSaveModelProfile({ ...input, pricing: { input: -1, output: 0 } }));
  assert(!isModelCatalogRequest({ provider: 'openai-compatible', baseUrl: 'http://public-model.example', expectedRevision: 1 }));
  assert.throws(() => requestRoute({ op: 'modelProfiles', apiKey: keyA }), { code: 'BAD_REQUEST' });
});

test('web search reuses only an official DeepSeek credential while compatible inference keeps its own key', async t => {
  const f = fixture(t); let view = await f.save(); const deepseek = view.activeId;
  view = await f.save({ ...compatible, name: '兼容接口', modelIds: ['public-model'], pricing: { input: 3, output: 12 }, apiKey: keyB });
  const other = view.profiles.find(p => p.id !== deepseek).id;
  view = f.models.activateProfile(other, view.revision);
  assert.equal((await f.models.forRequest()).apiKey, keyB);
  assert.equal((await f.models.forSearch()).apiKey, keyA);
  await f.models.deleteProfile(deepseek, view.revision);
  await assert.rejects(f.models.forSearch(), fails('SEARCH_CONFIG_REQUIRED'));
});
