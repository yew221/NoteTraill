import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import Database from 'better-sqlite3';
import { openStorage, MIGRATIONS } from '../dist/server/storage.js';
import { VaultFiles } from '../dist/server/vault-files.js';
import { VaultService } from '../dist/server/vaults.js';
import { ConversionFiles } from '../dist/server/conversion-files.js';
import { IngestFiles } from '../dist/server/ingest-files.js';
import { IngestService } from '../dist/server/ingestions.js';
import { RunService } from '../dist/server/runs.js';
import { WebFetcher, publicAddress, webUrl, MAX_WEB_BYTES } from '../dist/server/web-fetch.js';
import { ApiError } from '../dist/server/contracts.js';
import { createApp } from '../dist/server/app.js';
import { BrowserSession, sessionCookie } from '../dist/server/session.js';

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const python = process.env.NOTETRAIL_PYTHON ?? path.join(os.homedir(), '.local/share/uv/tools/markitdown/bin/python');
const formats = path.join(root, 'tests/fixtures/public/t00/inputs/formats');
const fails = code => error => error.publicError?.code === code;
const page = Buffer.from('<html><head><title>公开文章</title><style>PRIVATE_STYLE</style></head><body><h1>公开资料</h1><p>巡检时间为周三。</p><script>PRIVATE_SCRIPT</script></body></html>');

async function webFixture(t) {
  const requests = [], resolved = [], pinned = [];
  const server = http.createServer((request, response) => {
    requests.push({ path: request.url, headers: request.headers });
    const route = request.url;
    if (route === '/redirect') { response.writeHead(302, { location: '/page', 'set-cookie': 'notetrail_test=do-not-forward' }); response.end(); return; }
    if (route === '/private') { response.writeHead(302, { location: 'http://127.0.0.1/private' }); response.end(); return; }
    if (route === '/loop') { response.writeHead(302, { location: '/loop' }); response.end(); return; }
    if (route === '/auth') { response.writeHead(403); response.end('DENIED'); return; }
    if (route === '/slow') return;
    if (route === '/wrong-type') { response.writeHead(200, { 'content-type': 'application/pdf' }); response.end('NOT_HTML'); return; }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (['/gzip', '/deflate', '/br', '/bomb', '/bad-gzip'].includes(route)) {
      const encoding = route === '/deflate' ? 'deflate' : route === '/br' ? 'br' : 'gzip';
      response.setHeader('content-encoding', encoding);
      const compress = encoding === 'deflate' ? deflateSync : encoding === 'br' ? brotliCompressSync : gzipSync;
      response.end(route === '/bad-gzip' ? 'INVALID_GZIP' : compress(route === '/bomb' ? Buffer.alloc(MAX_WEB_BYTES + 1, 65) : page)); return;
    }
    if (route === '/oversize') { response.setHeader('content-length', String(MAX_WEB_BYTES + 1)); response.end(); return; }
    if (route === '/blank') { response.end('<html><body><script>ONLY_JS</script></body></html>'); return; }
    if (route === '/login') { response.end('<html><body><form><input type="password"></form></body></html>'); return; }
    if (route === '/text') { response.setHeader('content-type', 'text/plain; charset=utf-8'); response.end('公开纯文本。'); return; }
    response.end(page);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  class LocalWeb extends WebFetcher {
    async addresses(hostname) {
      resolved.push(hostname);
      return hostname === 'mixed.example.com' ? [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]
        : [{ address: '93.184.216.34', family: 4 }];
    }
    request(url, address, signal) {
      pinned.push({ hostname: url.hostname, address: address.address });
      // Only the test transport substitutes loopback after the production target policy passes.
      return super.request(new URL(`http://127.0.0.1:${server.address().port}${url.pathname}`), { address: '127.0.0.1', family: 4 }, signal);
    }
  }
  return { web: new LocalWeb(), requests, resolved, pinned };
}
async function fixture(t, names = [], Converter = ConversionFiles, web = new WebFetcher()) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-completion-'))), vaultPath = path.join(directory, 'vault');
  fs.mkdirSync(vaultPath);
  for (const name of names) fs.copyFileSync(path.join(formats, name), path.join(vaultPath, name));
  const storage = openStorage(path.join(directory, 'data'));
  const converter = new Converter(python, [storage.directory, root]);
  const vaults = new VaultService(storage.db, new VaultFiles(python, [storage.directory, root]), converter);
  const ingestions = new IngestService(storage.db, vaults, new IngestFiles(python, storage.directory, root), web);
  const runs = new RunService(storage.db, vaults, ingestions);
  const token = randomBytes(32).toString('base64url'), session = new BrowserSession(token);
  const app = createApp(session, undefined, vaults, runs);
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const cookie = sessionCookie(session.exchange(token), app.server.address().port).split(';')[0];
  t.after(async () => { await app.close(); await runs.close(); ingestions.close(); await vaults.close(); storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const vault = await vaults.connect({ absolutePath: vaultPath, exclusions: [] });
  const request = (route, options = {}) => fetch(origin + route, { ...options, headers: { origin, cookie, ...options.headers } });
  const source = name => vaults.sources(vault.id, { limit: '50' }).items.find(source => source.relativePath === name);
  const retry = (id, key = randomUUID(), options = {}) => request(`/api/v1/sources/${id}/retry`, {
    method: 'POST', ...options, headers: { 'idempotency-key': key, ...options.headers } });
  const ingest = (input, key = randomUUID()) => request('/api/v1/ingestions', { method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ vaultId: vault.id, input }) });
  return { directory, vaultPath, storage, converter, vaults, ingestions, runs, vault, source, request, retry, ingest };
}
async function finish(f, ref, signal = AbortSignal.timeout(10000)) {
  while (!['succeeded', 'failed', 'cancelled', 'interrupted'].includes(f.runs.get(ref.runId).state)) {
    assert(!signal.aborted, 'Run did not finish'); await delay(10);
  }
  return f.runs.get(ref.runId);
}
async function prepared(f, name) {
  try { await f.vaults.prepareSource(f.source(name).id); } catch {}
  return f.vaults.source(f.source(name).id);
}

test('public URL policy blocks special addresses, alternative local encodings, credentials and unsupported schemes', () => {
  for (const address of ['0.0.0.0', '10.0.0.1', '127.0.0.1', '100.64.0.1', '169.254.169.254', '172.31.255.255',
    '192.168.1.1', '192.0.2.4', '192.88.99.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '64:ff9b::a00:1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2002:a00::1', '3fff::1']) assert.equal(publicAddress(address), false, address);
  for (const address of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2001:4860:4860::8888', '2606:4700:4700::1111']) assert.equal(publicAddress(address), true, address);
  for (const url of ['http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://[::1]/', 'http://localhost./',
    'http://printer.local/', 'http://private.internal/', 'file:///etc/passwd', 'ftp://example.com/', 'https://user:secret@example.com/', 'https://example.com\\@127.0.0.1/', ' http://example.com']) assert.throws(() => webUrl(url), fails('URL_BLOCKED'), url);
  assert.equal(webUrl('https://example.com/page#section').href, 'https://example.com/page');
});

test('web fetching checks every DNS/redirect target, pins the selected address and never forwards website cookies', { timeout: 10000 }, async t => {
  const f = await webFixture(t), abort = new AbortController();
  const result = await f.web.fetch('http://public.example.com/redirect', abort.signal);
  assert.deepEqual(result.bytes, page); assert.equal(result.sourceUrl, 'http://public.example.com/page');
  assert.equal(result.filename, '网页.html'); assert(!Number.isNaN(Date.parse(result.capturedAt)));
  assert.deepEqual(f.resolved, ['public.example.com', 'public.example.com']);
  assert(f.pinned.every(item => item.address === '93.184.216.34'));
  for (const request of f.requests) { assert.equal(request.headers.cookie, undefined); assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.referer, undefined); }
  const before = f.requests.length;
  await assert.rejects(f.web.fetch('http://mixed.example.com/page', abort.signal), fails('URL_BLOCKED'));
  assert.equal(f.requests.length, before);
  await assert.rejects(f.web.fetch('http://public.example.com/private', abort.signal), fails('URL_BLOCKED'));
  assert.equal(f.requests.length, before + 1, 'Private redirect target must never be fetched');
  await assert.rejects(f.web.fetch('http://public.example.com/loop', abort.signal), fails('URL_FETCH_FAILED'));
  assert.equal(f.requests.filter(item => item.path === '/loop').length, 4);
});

test('the production HTTP request pins its approved lookup result while preserving the intended hostname', async t => {
  const observed = [];
  t.mock.method(http, 'request', (url, options, callback) => {
    observed.push({ hostname: url.hostname, family: options.family, agent: options.agent, headers: options.headers });
    options.lookup(url.hostname, {}, (error, address, family) => {
      assert.equal(error, null); assert.equal(address, '93.184.216.34'); assert.equal(family, 4);
    });
    const request = new EventEmitter(); request.end = () => {
      const response = Readable.from([page]); response.headers = { 'content-type': 'text/html' }; response.statusCode = 200;
      callback(response);
    }; return request;
  });
  class DNS extends WebFetcher { async addresses() { return [{ address: '93.184.216.34', family: 4 }]; } }
  const snapshot = await new DNS().fetch('http://public.example.com/page', new AbortController().signal);
  assert.deepEqual(snapshot.bytes, page); assert.equal(observed[0].hostname, 'public.example.com');
  assert.equal(observed[0].family, 4); assert.equal(observed[0].agent, false);
  assert.equal(observed[0].headers.authorization, undefined); assert.equal(observed.length, 1);
});

test('web content decoding enforces limits and cancellation closes the active request', { timeout: 10000 }, async t => {
  const f = await webFixture(t), signal = new AbortController().signal;
  for (const encoding of ['gzip', 'deflate', 'br']) assert.deepEqual((await f.web.fetch(`http://public.example.com/${encoding}`, signal)).bytes, page);
  for (const route of ['bomb', 'oversize']) await assert.rejects(f.web.fetch(`http://public.example.com/${route}`, signal), fails('FILE_TOO_LARGE'));
  for (const route of ['auth', 'wrong-type', 'bad-gzip']) await assert.rejects(f.web.fetch(`http://public.example.com/${route}`, signal), fails('URL_FETCH_FAILED'));
  const abort = new AbortController(), pending = f.web.fetch('http://public.example.com/slow', abort.signal);
  const rejected = assert.rejects(pending, fails('RUN_INTERRUPTED'));
  while (!f.requests.some(item => item.path === '/slow')) await delay(5);
  abort.abort(); await rejected;
});

test('URL intake saves the actual HTML snapshot and source metadata, converts readable text, and replays without a second fetch', { timeout: 15000 }, async t => {
  const web = await webFixture(t), f = await fixture(t, [], ConversionFiles, web.web), key = randomUUID();
  const input = { kind: 'url', url: 'http://public.example.com/redirect' };
  const response = await f.ingest(input, key); assert.equal(response.status, 202);
  const ref = (await response.json()).data, run = await finish(f, ref); assert.equal(run.state, 'succeeded', JSON.stringify(run.error));
  const source = f.vaults.source(run.result.sourceId); assert.equal(source.state, 'ready'); assert.equal(source.origin, 'web_snapshot');
  assert.equal(source.sourceUrl, 'http://public.example.com/page'); assert(!Number.isNaN(Date.parse(source.capturedAt)));
  assert.deepEqual(fs.readFileSync(path.join(f.vaultPath, source.relativePath)), page);
  const text = (await f.vaults.content(source.id, 'text', source.version)).bytes.toString();
  assert(text.includes('巡检时间为周三。')); assert(!text.includes('PRIVATE_SCRIPT')); assert(!text.includes('PRIVATE_STYLE'));
  const stages = f.runs.events(run.id, 0).items.filter(event => event.type === 'run.state').map(event => event.payload.stage);
  assert(stages.includes('fetching')); assert(stages.includes('converting'));
  const download = await f.request(`/api/v1/sources/${source.id}/content?view=original&expectedVersion=${source.version}`);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream'); assert(download.headers.get('content-disposition').startsWith('attachment;'));
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), page);
  const count = web.requests.length, inode = fs.statSync(path.join(f.vaultPath, source.relativePath)).ino;
  const replay = await f.ingest(input, key); assert.equal((await replay.json()).data.runId, ref.runId);
  const retried = await f.retry(source.id); assert.equal((await finish(f, (await retried.json()).data)).state, 'succeeded');
  assert.equal(web.requests.length, count); assert.equal(fs.statSync(path.join(f.vaultPath, source.relativePath)).ino, inode);
  assert.equal(f.vaults.sources(f.vault.id, {}).items.length, 1);
});

test('ordinary pasted URLs do not trigger fetching and invalid URL requests do not create records', { timeout: 10000 }, async t => {
  const web = await webFixture(t), f = await fixture(t, [], ConversionFiles, web.web);
  const response = await f.ingest({ kind: 'text', text: '只保存这句话：http://127.0.0.1/private' });
  const run = await finish(f, (await response.json()).data); assert.equal(run.state, 'succeeded'); assert.equal(web.requests.length, 0);
  for (const input of [{ kind: 'url', url: 'http://127.0.0.1/private' }, { kind: 'url', url: 'https://user:password@example.com/' },
    { kind: 'url', url: 'http://public.example.com/page', headers: { authorization: 'not-allowed' } }]) {
    const rejected = await f.ingest(input); assert([400, 403].includes(rejected.status)); await rejected.text();
  }
  assert.equal(f.vaults.sources(f.vault.id, {}).items.length, 1); assert.equal(web.requests.length, 0);
  const key = randomUUID(), initial = await f.ingest({ kind: 'url', url: 'http://public.example.com/page' }, key);
  await finish(f, (await initial.json()).data);
  const conflict = await f.ingest({ kind: 'url', url: 'http://public.example.com/text' }, key);
  assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(web.requests.length, 1);
});

test('a failed URL fetch can be retried on the same source; script-only and password pages never become ready', { timeout: 15000 }, async t => {
  const web = await webFixture(t); let fail = true, calls = 0;
  const fetchPage = web.web.fetch.bind(web.web);
  web.web.fetch = async (...args) => { calls++; if (fail) throw new ApiError('URL_FETCH_FAILED'); return fetchPage(...args); };
  const f = await fixture(t, [], ConversionFiles, web.web);
  let response = await f.ingest({ kind: 'url', url: 'http://public.example.com/page' });
  let run = await finish(f, (await response.json()).data); assert.equal(run.state, 'failed');
  const sourceId = run.error.details.sourceId; assert.equal(f.vaults.source(sourceId).originalSaved, false);
  fail = false; response = await f.retry(sourceId); run = await finish(f, (await response.json()).data);
  assert.equal(run.state, 'succeeded'); assert.equal(run.result.sourceId, sourceId); assert.equal(calls, 2);
  for (const [route, code] of [['blank', 'EXTRACTION_EMPTY'], ['login', 'URL_FETCH_FAILED']]) {
    response = await f.ingest({ kind: 'url', url: `http://public.example.com/${route}` });
    run = await finish(f, (await response.json()).data); assert.equal(run.state, 'failed'); assert.equal(run.error.code, code);
    const source = f.vaults.source(run.error.details.sourceId); assert.equal(source.originalSaved, true); assert.equal(source.readableRepresentation, null);
  }
});

test('stopping or revising scope during URL fetching leaves no saved original and cannot report a late success', { timeout: 15000 }, async t => {
  for (const mode of ['cancel', 'scope']) {
    const web = await webFixture(t), f = await fixture(t, [], ConversionFiles, web.web);
    const response = await f.ingest({ kind: 'url', url: 'http://public.example.com/slow' }); assert.equal(response.status, 202);
    const ref = (await response.json()).data;
    while (!web.requests.some(item => item.path === '/slow')) await delay(5);
    if (mode === 'cancel') f.runs.cancel(ref.runId);
    else f.vaults.update(f.vault.id, { expectedRevision: f.vault.revision, exclusions: ['助手资料/'] });
    const run = await finish(f, ref); assert.equal(run.state, mode === 'cancel' ? 'cancelled' : 'failed');
    if (mode === 'scope') assert.equal(run.error.code, 'CONTEXT_CHANGED');
    const [source] = f.vaults.sources(f.vault.id, {}).items; assert.equal(source.originalSaved, false);
    assert(!fs.existsSync(path.join(f.vaultPath, '助手资料')));
  }
});

test('conversion retry is idempotent, uses the same original and does not erase user edits', { timeout: 15000 }, async t => {
  class OnceFailing extends ConversionFiles { calls = 0; async extract(...args) {
    if (++this.calls === 1) throw new ApiError('CONVERSION_FAILED'); return super.extract(...args);
  } }
  const f = await fixture(t, ['inspection.pdf'], OnceFailing), source = await prepared(f, 'inspection.pdf'); assert.equal(source.state, 'failed');
  const original = path.join(f.vaultPath, source.relativePath), inode = fs.statSync(original).ino, key = randomUUID();
  const responses = await Promise.all([f.retry(source.id, key), f.retry(source.id, key)]);
  const refs = await Promise.all(responses.map(async response => { assert.equal(response.status, 202); return (await response.json()).data; }));
  assert.equal(refs[0].runId, refs[1].runId); assert.equal((await finish(f, refs[0])).state, 'succeeded');
  assert.equal(f.converter.calls, 2); assert.equal(fs.statSync(original).ino, inode);
  const ready = f.vaults.source(source.id), derived = path.join(f.vaultPath, ready.readableRepresentation.relativePath), content = fs.readFileSync(derived);
  fs.appendFileSync(derived, '\nUSER_EDIT');
  let response = await f.retry(source.id), run = await finish(f, (await response.json()).data);
  assert.equal(run.state, 'failed'); assert.equal(run.error.code, 'DERIVED_MODIFIED'); assert.equal(f.vaults.source(source.id).state, 'needs_review');
  assert(fs.readFileSync(derived, 'utf8').endsWith('USER_EDIT'));
  fs.writeFileSync(derived, content);
  response = await f.retry(source.id); run = await finish(f, (await response.json()).data); assert.equal(run.state, 'succeeded');
  assert.equal(f.converter.calls, 2, 'Restored output should be verified without re-extracting');
});

test('retry can publish a cancelled staged intake without duplicating its source or original', { timeout: 10000 }, async t => {
  const f = await fixture(t), ref = await f.runs.ingest({ vaultId: f.vault.id, input: { kind: 'text', text: 'STAGED' } }, randomUUID());
  f.runs.cancel(ref.runId);
  const [source] = f.vaults.sources(f.vault.id, {}).items; assert.equal(source.originalSaved, false);
  const response = await f.retry(source.id); const run = await finish(f, (await response.json()).data);
  assert.equal(run.state, 'succeeded'); assert.equal(run.result.sourceId, source.id);
  assert.equal(f.vaults.sources(f.vault.id, {}).items.length, 1);
  assert.equal(fs.readFileSync(path.join(f.vaultPath, f.vaults.source(source.id).relativePath), 'utf8'), 'STAGED');
});

test('retry routes enforce request/authentication boundaries and reject deleted, excluded or changed originals', { timeout: 15000 }, async t => {
  const f = await fixture(t, ['inspection.pdf']), source = await prepared(f, 'inspection.pdf');
  for (const options of [{ body: '{}', headers: { 'content-type': 'application/json' } }, { headers: { 'idempotency-key': '' } },
    { headers: { cookie: '' } }, { headers: { origin: 'https://outside.invalid' } }]) {
    const response = await f.retry(source.id, randomUUID(), options); assert([400, 401, 403].includes(response.status)); await response.text();
  }
  const initialKey = randomUUID(), response = await f.retry(source.id, initialKey), initial = (await response.json()).data; await finish(f, initial);
  const changed = f.runs.retry(source.id, randomUUID());
  fs.copyFileSync(path.join(formats, 'mixed.pdf'), path.join(f.vaultPath, source.relativePath));
  const run = await finish(f, changed); assert.equal(run.state, 'failed'); assert.equal(run.error.code, 'SOURCE_CHANGED');
  f.vaults.update(f.vault.id, { expectedRevision: f.vaults.get(f.vault.id).revision, exclusions: [source.relativePath] });
  assert.equal((await f.retry(source.id)).status, 403);
  assert.equal((await (await f.retry(source.id, initialKey)).json()).data.runId, initial.runId);
  f.vaults.update(f.vault.id, { expectedRevision: f.vaults.get(f.vault.id).revision, exclusions: [] });
  fs.unlinkSync(path.join(f.vaultPath, source.relativePath)); await f.vaults.scan(f.vault.id);
  assert.equal((await f.retry(source.id)).status, 410);
});

test('refresh waits for conversion and reports complete state counts instead of treating pending files as ready', { timeout: 20000 }, async t => {
  const names = ['inspection.pdf', 'inspection.docx', 'stock.xlsx', 'stock.xls', 'scanned.pdf', 'inspection.doc', 'corrupt.docx', 'mixed.pdf'];
  const f = await fixture(t, names);
  const ref = f.runs.refresh(f.vault.id, randomUUID()), run = await finish(f, ref, t.signal);
  assert.equal(run.state, 'succeeded', JSON.stringify(run.error));
  assert.deepEqual({ ...run.result, skipped: 0 }, { scanned: 8, ready: 4, partial: 1, failed: 2, unsupported: 1,
    needsReview: 0, pending: 0, missing: 0, excluded: 0, skipped: 0 });
  assert(f.runs.events(run.id, 0).items.some(event => event.type === 'source.updated' && event.payload.sourceState === 'processing'));
});

test('refresh cancellation stops all joined conversion work and preserves originals', { timeout: 10000 }, async t => {
  let entered, calls = 0; const started = new Promise(resolve => { entered = resolve; });
  class Waiting extends ConversionFiles { async extract(_input, signal) {
    calls++; entered(); await new Promise((resolve, reject) => {
      if (signal.aborted) reject(new ApiError('RUN_INTERRUPTED'));
      else signal.addEventListener('abort', () => reject(new ApiError('RUN_INTERRUPTED')), { once: true });
    });
  } }
  const f = await fixture(t, ['inspection.pdf', 'inspection.docx'], Waiting); await started;
  const ref = f.runs.refresh(f.vault.id, randomUUID());
  while (!f.runs.events(ref.runId, 0).items.some(event => event.type === 'source.updated')) await delay(5);
  f.runs.cancel(ref.runId); const run = await finish(f, ref); assert.equal(run.state, 'cancelled'); assert.equal(calls, 1);
  assert.equal(f.runs.cancel(ref.runId).state, 'cancelled');
  assert.equal(f.runs.events(ref.runId, 0).items.filter(event => event.type === 'run.completed').length, 1);
  assert(f.vaults.sources(f.vault.id, {}).items.every(source => source.state === 'failed' && source.originalSaved));
});

test('v5 migration retains original operations and adds retry and URL state without changing the backup', async t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-web-migration-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const data = path.join(directory, 'data'), legacy = openStorage(data, MIGRATIONS.slice(0, 5)); legacy.close();
  const current = openStorage(data);
  try {
    assert.equal(current.db.pragma('user_version', { simple: true }), MIGRATIONS.length);
    assert(current.db.prepare("SELECT name FROM sqlite_schema WHERE name='web_inputs'").get());
    const backup = new Database(path.join(data, 'backups', fs.readdirSync(path.join(data, 'backups'))[0]), { readonly: true });
    try { assert.equal(backup.pragma('user_version', { simple: true }), 5); assert(!backup.prepare("SELECT name FROM sqlite_schema WHERE name='web_inputs'").get()); }
    finally { backup.close(); }
  } finally { current.close(); }
});
