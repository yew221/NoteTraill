import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import Database from 'better-sqlite3';
import { openStorage, MIGRATIONS } from '../dist/server/storage.js';
import { ModelSettings } from '../dist/server/model-settings.js';
import { KeychainCredentials, credentialBinding } from '../dist/server/credentials.js';
import { ApiError } from '../dist/server/contracts.js';
import { createApp } from '../dist/server/app.js';
import { BrowserSession, sessionCookie } from '../dist/server/session.js';
import { canonicalModelUrl, isModelSettingsView, isCredentialSaved, isModelRequest, isCredentialRequest } from '../dist/shared/model.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const python = process.env.NOTETRAIL_PYTHON ?? path.join(os.homedir(), '.local/share/uv/tools/markitdown/bin/python');
const config = { provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' };
const secret = 'PUBLIC_SYNTHETIC_API_KEY_NOT_A_REAL_SECRET';
const replacement = 'PUBLIC_SYNTHETIC_REPLACEMENT_NOT_A_REAL_SECRET';
const failsWith = code => error => error instanceof ApiError && error.publicError.code === code && !error.message.includes(secret);
class FakeCredentials {
  values = new Map(); writes = 0; reads = 0;
  key(binding) { return `${binding.service}/${binding.account}`; }
  async write(binding, value) { this.writes++; await this.beforeWrite?.(); this.values.set(this.key(binding), value); }
  async read(binding) {
    this.reads++; const value = this.values.get(this.key(binding)); await this.beforeRead?.();
    if (!value) throw new ApiError('CONFIG_REQUIRED'); return value;
  }
  async remove(binding) { await this.beforeRemove?.(); this.values.delete(this.key(binding)); }
}
function fixture(t, credentials = new FakeCredentials()) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-credentials-')));
  const stores = [];
  t.after(() => { for (const store of stores.reverse()) store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  function open() { const storage = openStorage(path.join(directory, 'app')); stores.push(storage); return storage; }
  const storage = open();
  return { directory, storage, credentials, models: new ModelSettings(storage.db, credentials), open };
}

async function httpFixture(t) {
  const f = fixture(t), token = randomBytes(32).toString('base64url'), session = new BrowserSession(token);
  const app = createApp(session, f.models);
  t.after(() => app.close());
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const cookie = sessionCookie(session.exchange(token), app.server.address().port).split(';')[0];
  return { ...f, app, origin, cookie, async request(route, method = 'GET', body, headers = {}) {
    const response = await fetch(`${origin}${route}`, { method, headers: { cookie, origin, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); assert(!text.includes(secret) && !text.includes(replacement));
    return { status: response.status, body: JSON.parse(text), text };
  } };
}

test('configuration guards reject secret-bearing extras and unsafe service URLs', () => {
  assert.equal(canonicalModelUrl('https://api.deepseek.com/'), config.baseUrl);
  assert(isModelRequest({ ...config, expectedRevision: 1 }));
  for (const baseUrl of ['http://api.deepseek.com', 'https://user:password@example.com', 'https://example.com/?apiKey=value',
    'https://example.com/#value', ' https://example.com', 'https://example.com\\evil', 'https://example.com/path\0',
    `https://example.com/${'资料'.repeat(150)}`]) assert.equal(canonicalModelUrl(baseUrl), null);
  for (const input of [{ ...config, expectedRevision: 1, apiKey: secret }, { ...config, expectedRevision: '1' },
    { ...config, provider: '../deepseek', expectedRevision: 1 }, { ...config, model: '', expectedRevision: 1 }]) assert(!isModelRequest(input));
  for (const apiKey of ['', 'short', 'with spaces in a credential', 'a'.repeat(513), ['not-a-string']]) {
    assert(!isCredentialRequest({ apiKey, expectedRevision: 1 }));
  }
  assert(!isModelSettingsView({ revision: 1, model: null, credentialConfigured: true }));
  assert(!isModelSettingsView({ revision: 2, model: config, credentialConfigured: true, apiKey: secret }));
  assert(!isCredentialSaved({ configured: true, revision: 3, apiKey: secret }));
});

test('model and credential share revisions, persist safe configuration, and read secrets only on demand', async t => {
  const f = fixture(t);
  assert.deepEqual(f.models.view(), { revision: 1, model: null, credentialConfigured: false });
  await assert.rejects(f.models.setCredential(secret, 1), failsWith('CONFIG_REQUIRED'));
  const selected = await f.models.setModel(config, 1); assert.equal(selected.revision, 2);
  assert.deepEqual(await f.models.setCredential(secret, 2), { configured: true, revision: 3 });
  assert.equal(f.credentials.reads, 0);
  assert(isModelSettingsView(f.models.view()));
  assert(!JSON.stringify(f.models.view()).includes(secret));
  const request = await f.models.forRequest(); assert.equal(request.apiKey, secret); assert.equal(request.revision, 3);
  f.storage.close();
  const reopened = f.open(), models = new ModelSettings(reopened.db, f.credentials);
  assert.equal(models.view().revision, 3); assert.equal((await models.forRequest()).apiKey, secret);
  for (const name of fs.readdirSync(reopened.directory)) {
    const file = path.join(reopened.directory, name);
    if (fs.statSync(file).isFile()) assert(!fs.readFileSync(file).includes(Buffer.from(secret)));
  }
});

test('replacement retires the previous key and stale updates never write another credential', async t => {
  const f = fixture(t);
  await f.models.setModel(config, 1); await f.models.setCredential(secret, 2);
  await assert.rejects(f.models.setCredential(replacement, 2), failsWith('REVISION_CONFLICT'));
  assert.equal(f.credentials.writes, 1);
  await f.models.setCredential(replacement, 3);
  assert.equal(f.credentials.values.size, 1);
  assert.equal((await f.models.forRequest()).apiKey, replacement);
  assert(![...f.credentials.values.values()].includes(secret));
  f.credentials.values.clear();
  await assert.rejects(f.models.forRequest(), failsWith('CONFIG_REQUIRED'));
});

test('changing provider or service clears the active key; changing only model preserves its service binding', async t => {
  const f = fixture(t);
  await f.models.setModel({ ...config, baseUrl: `${config.baseUrl}/` }, 1);
  await f.models.setCredential(secret, 2);
  const otherModel = await f.models.setModel({ ...config, model: 'public-other-model' }, 3);
  assert.equal(otherModel.credentialConfigured, true);
  assert.equal((await f.models.forRequest()).apiKey, secret);
  const changed = await f.models.setModel({ ...config, baseUrl: 'https://public-model.example/v1' }, 4);
  assert.equal(changed.credentialConfigured, false); assert.equal(f.credentials.values.size, 0);
  await assert.rejects(f.models.forRequest(), failsWith('CONFIG_REQUIRED'));
  await f.models.setModel(config, 5);
  await assert.rejects(f.models.forRequest(), failsWith('CONFIG_REQUIRED'));
  await f.models.setCredential(replacement, 6);
  await f.models.setModel({ ...config, provider: 'public-other-provider' }, 7);
  await assert.rejects(f.models.forRequest(), failsWith('CONFIG_REQUIRED'));
});

test('configuration changes during a key write reject the stale reference and remove the unused key', async t => {
  const f = fixture(t); await f.models.setModel(config, 1);
  let release;
  f.credentials.beforeWrite = () => new Promise(resolve => { release = resolve; });
  const writing = f.models.setCredential(secret, 2);
  await f.models.setModel({ ...config, baseUrl: 'https://public-changed.example' }, 2);
  release(); await assert.rejects(writing, failsWith('REVISION_CONFLICT'));
  assert.equal(f.credentials.values.size, 0); assert.equal(f.models.view().credentialConfigured, false);
});

test('configuration changes during a key read prevent the old secret being returned for a model request', async t => {
  const f = fixture(t); await f.models.setModel(config, 1); await f.models.setCredential(secret, 2);
  let release;
  f.credentials.beforeRead = () => new Promise(resolve => { release = resolve; });
  const reading = f.models.forRequest();
  await f.models.setModel({ ...config, baseUrl: 'https://public-changed.example' }, 3);
  release(); await assert.rejects(reading, failsWith('REVISION_CONFLICT'));
});

test('two concurrent credential saves from the same revision commit exactly one active key', async t => {
  const f = fixture(t); await f.models.setModel(config, 1);
  const other = new ModelSettings(f.storage.db, f.credentials);
  const release = [];
  f.credentials.beforeWrite = () => new Promise(resolve => release.push(resolve));
  const results = Promise.allSettled([f.models.setCredential(secret, 2), other.setCredential(replacement, 2)]);
  assert.equal(release.length, 2); release.forEach(done => done());
  const settled = await results;
  assert.equal(settled.filter(item => item.status === 'fulfilled').length, 1);
  assert(failsWith('REVISION_CONFLICT')(settled.find(item => item.status === 'rejected').reason));
  assert.equal(f.models.view().revision, 3); assert.equal(f.credentials.values.size, 1);
  assert([secret, replacement].includes((await f.models.forRequest()).apiKey));
});

test('unavailable stores fail safely; unsuccessful cleanup retains only an inactive non-secret reference', async t => {
  const f = fixture(t); await f.models.setModel(config, 1);
  f.credentials.beforeWrite = () => { throw new Error(secret); };
  await assert.rejects(f.models.setCredential(secret, 2), failsWith('CREDENTIAL_STORE_UNAVAILABLE'));
  assert.equal(f.models.view().revision, 2); assert.equal(f.models.view().credentialConfigured, false);
  f.credentials.beforeWrite = undefined; await f.models.setCredential(secret, 2);
  f.credentials.beforeRead = () => { throw new Error(secret); };
  await assert.rejects(f.models.forRequest(), failsWith('CREDENTIAL_STORE_UNAVAILABLE'));
  f.credentials.beforeRead = undefined;
  f.credentials.beforeRemove = () => { throw new Error(secret); };
  await f.models.setModel({ ...config, baseUrl: 'https://public-new.example' }, 3);
  assert.equal(f.models.view().credentialConfigured, false);
  assert.equal(f.storage.db.prepare('SELECT count(*) AS n FROM retired_credentials').get().n, 1);
  assert(!JSON.stringify(f.storage.db.prepare('SELECT * FROM retired_credentials').all()).includes(secret));
  f.credentials.beforeRemove = undefined;
  assert.equal(await f.models.cleanupRetired(), true); assert.equal(f.credentials.values.size, 0);
});

test('revision overflow fails before creating a new secret or changing settings', async t => {
  const f = fixture(t); await f.models.setModel(config, 1);
  f.storage.db.prepare('UPDATE model_settings SET revision=?').run(Number.MAX_SAFE_INTEGER);
  await assert.rejects(f.models.setCredential(secret, Number.MAX_SAFE_INTEGER), failsWith('SERVICE_UNAVAILABLE'));
  assert.equal(f.credentials.writes, 0);
  await assert.rejects(f.models.setModel(config, Number.MAX_SAFE_INTEGER), failsWith('SERVICE_UNAVAILABLE'));
});

test('real HTTP configuration and credential routes preserve origin, session, revision and secret boundaries', async t => {
  const f = await httpFixture(t);
  assert.equal((await f.request('/api/v1/settings', 'GET', undefined, { cookie: '' })).status, 401);
  assert.equal((await f.request('/api/v1/model', 'PUT', { ...config, expectedRevision: 1 }, { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await f.request('/api/v1/settings?apiKey=not-a-real-key')).status, 400);
  assert.equal((await f.request('/api/v1/model', 'PUT', { ...config, expectedRevision: 1, apiKey: secret })).status, 400);
  const before = await f.request('/api/v1/settings'); assert(isModelSettingsView(before.body.data));
  const selected = await f.request('/api/v1/model', 'PUT', { ...config, expectedRevision: 1 }); assert.equal(selected.status, 200);
  const saved = await f.request('/api/v1/model/credential', 'PUT', { apiKey: secret, expectedRevision: 2 });
  assert.equal(saved.status, 200); assert(isCredentialSaved(saved.body.data));
  const read = await f.request('/api/v1/settings'); assert.equal(read.body.data.credentialConfigured, true);
  assert.equal(f.credentials.reads, 0);
  const stale = await f.request('/api/v1/model/credential', 'PUT', { apiKey: replacement, expectedRevision: 2 });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.details.currentRevision, 3);
  assert.equal((await f.request('/api/v1/model/credential')).status, 404);
  assert.equal((await f.request('/api/v1/model/credential', 'PUT', { apiKey: 'a'.repeat(2000), expectedRevision: 3 })).status, 413);
  f.credentials.beforeWrite = () => { throw new Error(secret); };
  const failed = await f.request('/api/v1/model/credential', 'PUT', { apiKey: replacement, expectedRevision: 3 });
  assert.equal(failed.status, 503); assert.equal(failed.body.error.code, 'CREDENTIAL_STORE_UNAVAILABLE');
});

test('existing v1 data is backed up before current migrations, with no repeated backup on restart', t => {
  const f = fixture(t), directory = path.join(f.directory, 'legacy');
  const legacy = openStorage(directory, MIGRATIONS.slice(0, 1));
  legacy.db.exec("CREATE TABLE public_legacy (value TEXT); INSERT INTO public_legacy VALUES ('PUBLIC_OLD_DATA');");
  legacy.close();
  const upgraded = openStorage(directory);
  try {
    assert.equal(upgraded.db.pragma('user_version', { simple: true }), MIGRATIONS.length);
    assert.equal(upgraded.db.prepare('SELECT value FROM public_legacy').get().value, 'PUBLIC_OLD_DATA');
    const names = fs.readdirSync(path.join(directory, 'backups'));
    assert.equal(names.length, 1); assert.match(names[0], /^schema-1-[0-9a-f-]+\.sqlite$/);
    const file = path.join(directory, 'backups', names[0]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const backup = new Database(file, { readonly: true, fileMustExist: true });
    try {
      assert.equal(backup.pragma('user_version', { simple: true }), 1);
      assert.equal(backup.prepare('SELECT value FROM public_legacy').get().value, 'PUBLIC_OLD_DATA');
      assert.equal(backup.prepare("SELECT name FROM sqlite_schema WHERE name='model_settings'").get(), undefined);
    } finally { backup.close(); }
  } finally { upgraded.close(); }
  openStorage(directory).close();
  assert.equal(fs.readdirSync(path.join(directory, 'backups')).length, 1);
});

test('backup failure stops an upgrade before schema changes and preserves unrelated files', t => {
  const f = fixture(t), directory = path.join(f.directory, 'legacy-blocked');
  openStorage(directory, MIGRATIONS.slice(0, 1)).close();
  const outside = path.join(f.directory, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(directory, 'backups'));
  assert.throws(() => openStorage(directory), { code: 'DATA_DIRECTORY_INVALID' });
  const db = new Database(path.join(directory, 'state.sqlite'), { readonly: true });
  try { assert.equal(db.pragma('user_version', { simple: true }), 1); } finally { db.close(); }
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('native bridge rejects missing executables, oversized or malformed responses and timeout without exposing raw errors',
  { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t), binding = credentialBinding(config, randomUUID());
  await assert.rejects(new KeychainCredentials('/missing/notetrail-python').read(binding), failsWith('CREDENTIAL_STORE_UNAVAILABLE'));
  for (const [name, code] of [
    ['raw', `import sys; sys.stderr.write(${JSON.stringify(secret)}); print(${JSON.stringify(secret)})`],
    ['oversize', "print('x' * 5000)"], ['timeout', 'import time; time.sleep(20)'],
  ]) {
    const helper = path.join(f.directory, `${name}.py`); fs.writeFileSync(helper, code);
    await assert.rejects(new KeychainCredentials(python, helper).read(binding), failsWith('CREDENTIAL_STORE_UNAVAILABLE'));
  }
  const helper = path.join(f.directory, 'pipe-only.py');
  fs.writeFileSync(helper, `import json,os,sys\nbody=json.load(sys.stdin)\nassert body['secret'] not in '\\0'.join(sys.argv)\nassert body['secret'] not in '\\0'.join(os.environ.values())\nprint('{"ok":true}')\n`);
  await new KeychainCredentials(python, helper).write(binding, secret);
});

test('production Python entry rejects unrelated namespaces, extra fields and oversized input before native access',
  { skip: process.platform !== 'darwin' }, () => {
  const helper = path.join(root, 'dist/server/keychain.py');
  const binding = credentialBinding(config, randomUUID());
  for (const input of [JSON.stringify({ op: 'read', service: 'com.unrelated.private', account: binding.account }),
    JSON.stringify({ op: 'read', ...binding, isolated_keychain: '/not/allowed' }), 'x'.repeat(4097),
    JSON.stringify({ op: 'write', ...binding, secret: 'short' })]) {
    const run = spawnSync(python, ['-I', '-B', helper], { input, encoding: 'utf8', timeout: 5000 });
    assert.equal(run.status, 0); assert.equal(run.stderr, '');
    assert.deepEqual(JSON.parse(run.stdout), { ok: false, error: 'invalid_request' });
  }
});

test('real isolated Keychain round trip, replacement, lock, deletion and cleanup use the production bridge',
  { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t), target = path.join(f.directory, 'probe.keychain-db'), wrapper = path.join(f.directory, 'host.py');
  const helper = path.join(root, 'dist/server/keychain.py');
  fs.writeFileSync(wrapper, `import sys\nsys.path.insert(0,${JSON.stringify(path.join(root, 'tests'))})\nfrom keychain_host import main\nmain(${JSON.stringify(target)},${JSON.stringify(helper)})\n`);
  const configuration = () => ['list-keychains', 'default-keychain'].map(name => {
    const result = spawnSync('/usr/bin/security', [name, '-d', 'user'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0); return result.stdout;
  });
  const before = configuration();
  function control(command) {
    const result = spawnSync(python, ['-I', '-B', wrapper], { input: JSON.stringify({ control: command }), encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0); assert.deepEqual(JSON.parse(result.stdout), { ok: true });
  }
  control('create');
  let app;
  try {
    const credentials = new KeychainCredentials(python, wrapper), models = new ModelSettings(f.storage.db, credentials);
    const token = randomBytes(32).toString('base64url'), session = new BrowserSession(token);
    app = createApp(session, models);
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const cookie = sessionCookie(session.exchange(token), app.server.address().port).split(';')[0];
    async function put(route, body, expectedStatus = 200) {
      const response = await fetch(`${origin}${route}`, { method: 'PUT', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const text = await response.text(); assert.equal(response.status, expectedStatus);
      assert(!text.includes(secret) && !text.includes(replacement)); return JSON.parse(text);
    }
    await put('/api/v1/model', { ...config, expectedRevision: 1 });
    await put('/api/v1/model/credential', { apiKey: secret, expectedRevision: 2 });
    assert.equal((await models.forRequest()).apiKey, secret);
    await put('/api/v1/model/credential', { apiKey: replacement, expectedRevision: 3 });
    assert.equal((await models.forRequest()).apiKey, replacement);
    assert(!JSON.stringify(models.view()).includes(replacement));
    assert(!fs.readFileSync(target).includes(Buffer.from(replacement)));
    control('lock');
    await assert.rejects(models.forRequest(), failsWith('CREDENTIAL_STORE_UNAVAILABLE'));
    const failed = await put('/api/v1/model/credential', { apiKey: secret, expectedRevision: 4 }, 503);
    assert.equal(failed.error.code, 'CREDENTIAL_STORE_UNAVAILABLE'); assert.equal(models.view().revision, 4);
    control('unlock'); assert.equal((await models.forRequest()).apiKey, replacement);
    await models.cleanupRetired();
    const row = f.storage.db.prepare('SELECT credential_id FROM model_settings').get();
    await credentials.remove(credentialBinding(config, row.credential_id));
    await assert.rejects(models.forRequest(), failsWith('CONFIG_REQUIRED'));
    await credentials.remove(credentialBinding(config, row.credential_id));
  } finally {
    await app?.close();
    control('unlock'); control('delete');
    assert(!fs.existsSync(target)); assert.deepEqual(configuration(), before);
  }
});
