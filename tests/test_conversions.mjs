import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { launchBackend, connectBackend } from './fixtures/backend-process.mjs';
import Database from 'better-sqlite3';
import { openStorage } from '../dist/server/storage.js';
import { VaultFiles } from '../dist/server/vault-files.js';
import { VaultService } from '../dist/server/vaults.js';
import { ConversionFiles, conversionInput } from '../dist/server/conversion-files.js';
import { IngestFiles } from '../dist/server/ingest-files.js';
import { IngestService } from '../dist/server/ingestions.js';
import { RunService } from '../dist/server/runs.js';
import { createApp } from '../dist/server/app.js';
import { BrowserSession, sessionCookie } from '../dist/server/session.js';

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const python = process.env.NOTETRAIL_PYTHON ?? path.join(os.homedir(), '.local/share/uv/tools/markitdown/bin/python');
const fixtures = path.join(root, 'tests/fixtures/public/t00');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fails = code => error => error.publicError?.code === code;
async function fixture(t, names = ['inspection.pdf'], Converter = ConversionFiles) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-conversion-')));
  const vaultPath = path.join(directory, 'vault'); fs.mkdirSync(vaultPath);
  for (const name of names) fs.copyFileSync(path.join(fixtures, 'inputs/formats', name), path.join(vaultPath, name));
  const storage = openStorage(path.join(directory, 'data'));
  const converter = new Converter(python, [storage.directory, root]);
  const vaults = new VaultService(storage.db, new VaultFiles(python, [storage.directory, root]), converter);
  const cleanup = [];
  t.after(async () => { for (const close of cleanup) await close(); await vaults.close(); storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const vault = await vaults.connect({ absolutePath: vaultPath, exclusions: [] });
  const source = name => vaults.sources(vault.id, { limit: '50' }).items.find(item => item.relativePath === name);
  const prepare = async name => {
    try { await vaults.prepareSource(source(name).id); } catch { /* The asserted state below is authoritative. */ }
    return vaults.source(source(name).id);
  };
  return { directory, vaultPath, storage, converter, vaults, vault, source, prepare, cleanup };
}

test('warm discovery reuses verified derivatives but catches edits to current and old artifacts', { timeout: 30000 }, async t => {
  const f = await fixture(t, ['inspection.pdf', 'inspection.docx']);
  const pdf = await f.prepare('inspection.pdf'), docx = await f.prepare('inspection.docx');
  assert(pdf.readableRepresentation); assert(docx.readableRepresentation);
  const checks = [], check = f.converter.check.bind(f.converter);
  f.converter.check = (...args) => { checks.push(args[0].sourceId); return check(...args); };
  await f.vaults.scan(f.vault.id); checks.length = 0;
  for (let i = 0; i < 3; i++) await f.vaults.scan(f.vault.id);
  assert.deepEqual(checks, [], 'unchanged derived text must not cause full original/text reads');
  fs.appendFileSync(path.join(f.vaultPath, pdf.readableRepresentation.relativePath), '\n用户编辑了提取文本。');
  await f.vaults.scan(f.vault.id);
  assert.deepEqual(checks, [pdf.id]);
  assert.equal(f.vaults.source(pdf.id).state, 'needs_review');
  assert.equal(f.vaults.source(docx.id).state, docx.state);
  checks.length = 0;
  const derivedDir = path.dirname(path.join(f.vaultPath, docx.readableRepresentation.relativePath));
  fs.writeFileSync(path.join(derivedDir, `${'0'.repeat(64)}.md`), '未登记的旧版本');
  await f.vaults.scan(f.vault.id);
  assert.deepEqual(checks, [docx.id]);
  assert.equal(f.vaults.source(docx.id).state, 'needs_review');
});

test('real fixed format corpus preserves original bytes, table relationships and honest partial/empty/corrupt states', { timeout: 90000 }, async t => {
  const cases = JSON.parse(fs.readFileSync(path.join(root, 'tests/conversion_cases.json'))).cases;
  const f = await fixture(t, cases.map(item => path.basename(item.path)));
  for (const item of cases) {
    const name = path.basename(item.path), source = await f.prepare(name);
    const expected = { complete: 'ready', empty: 'failed', unsupported: 'unsupported', rejected_corrupt: 'failed', known_partial: 'partial' }[item.expectation];
    assert.equal(source.state, expected, `${item.id}: ${JSON.stringify(source.warnings)}`);
    assert.equal(source.originalSaved, true);
    assert.deepEqual(fs.readFileSync(path.join(f.vaultPath, name)), fs.readFileSync(path.join(fixtures, item.path)));
    if (!['ready', 'partial'].includes(expected)) {
      assert.equal(source.readableRepresentation, null);
      const code = { empty: 'EXTRACTION_EMPTY', unsupported: 'UNSUPPORTED_FORMAT', rejected_corrupt: 'CONVERSION_FAILED' }[item.expectation];
      assert.equal(source.warnings[0].code, code);
      await assert.rejects(f.vaults.content(source.id, 'text', source.version), fails('SOURCE_NOT_READY'));
      continue;
    }
    assert.equal(source.readableRepresentation.kind, 'extracted_markdown');
    const { bytes } = await f.vaults.content(source.id, 'text', source.version), text = bytes.toString();
    assert.equal(hash(bytes), source.readableRepresentation.hash);
    assert(text.includes(source.id)); assert(text.includes(source.version));
    for (const phrase of item.contains ?? []) assert(text.replace(/\s/g, '').includes(phrase.replace(/\s/g, '')), `${item.id}: missing expected phrase`);
    for (const row of item.rows ?? []) {
      const normalized = text.replaceAll('**', '');
      // PDF emits separate lines; Office tables emit pipes. Preserve record ordering in either representation.
      const pattern = new RegExp(row.map(cell => cell.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s|]+'));
      assert(pattern.test(normalized), `${item.id}: broken record ${row[0]}`);
    }
    for (const [sheet, rows] of Object.entries(item.sheets ?? {})) {
      const section = text.split(`## ${sheet}\n`)[1]?.split('\n## ')[0]; assert(section, 'Missing sheet');
      for (const row of rows) assert(section.split('\n').some(line => row.every(cell => line.includes(cell))), 'Values crossed rows/sheets');
    }
    if (expected === 'partial') {
      assert.deepEqual(source.warnings.map(w => w.code), ['EXTRACTION_PARTIAL']);
      assert(!item.unread_image_truth.some(phrase => text.includes(phrase)), 'No invented OCR text');
    }
  }
  await f.vaults.scan(f.vault.id);
  assert.equal(f.vaults.sources(f.vault.id, { limit: '50' }).items.length, cases.length);
  assert.equal(f.vaults.get(f.vault.id).discovery.scanned, cases.length);
  assert.equal(f.source('mixed.pdf').state, 'partial');
  assert.equal(f.source('corrupt.docx').state, 'failed', 'Routine scanning must not retry unchanged failed files');
});

test('formal restart recovers a derivative after SIGKILL between publication and representation registration', { timeout: 15000 }, async t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-derived-crash-')));
  const volume = process.env.NOTETRAIL_TEST_VOLUME;
  const vaultPath = volume ? fs.mkdtempSync(path.join(fs.realpathSync(volume), 'derived-crash-')) : path.join(directory, 'vault'), dataPath = path.join(directory, 'data');
  if (!volume) fs.mkdirSync(vaultPath);
  else { assert.notEqual(fs.statSync(vaultPath).dev, fs.statSync(directory).dev); t.diagnostic('Derived publication SIGKILL uses distinct real filesystem devices'); }
  const children = [];
  t.after(async () => {
    for (const item of children) {
      if (item.child.exitCode === null && item.child.signalCode === null) { item.child.kill('SIGKILL'); await item.exited; }
    }
    fs.rmSync(directory, { recursive: true, force: true });
    if (volume) fs.rmSync(vaultPath, { recursive: true, force: true });
  });
  async function launch(crash) {
    const injection = crash ? `const {ConversionFiles}=await import('./dist/server/conversion-files.js'); const publish=ConversionFiles.prototype.publish; ConversionFiles.prototype.publish=async function(...args){await publish.apply(this,args);process.kill(process.pid,'SIGKILL');};` : '';
    const backend = launchBackend(['--data-dir', dataPath, '--port', '0'], { beforeStart: injection, cwd: root, env: {
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'en_US.UTF-8', NOTETRAIL_PYTHON: python } });
    children.push(backend);
    return { ...backend, ...(await connectBackend(backend)) };
  }
  const first = await launch(true);
  const connected = await first.request('/api/v1/vaults', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ absolutePath: vaultPath, exclusions: [] }) });
  const vault = (await connected.json()).data, key = randomUUID();
  const body = new FormData(); body.set('meta', JSON.stringify({ vaultId: vault.id, input: { kind: 'upload', filePart: 'file' } }));
  const original = fs.readFileSync(path.join(fixtures, 'inputs/formats/inspection.docx'));
  body.set('file', new File([original], '正式.docx'));
  const accepted = await first.request('/api/v1/ingestions', { method: 'POST', headers: { 'idempotency-key': key }, body });
  assert.equal(accepted.status, 202); const ref = (await accepted.json()).data;
  assert.deepEqual(await first.exited, [null, 'SIGKILL']);
  const database = new Database(path.join(dataPath, 'state.sqlite'), { readonly: true }); let saved;
  try {
    saved = database.prepare('SELECT * FROM sources').get(); assert.equal(saved.state, 'processing');
    assert.equal(saved.original_saved, 1); assert.equal(database.prepare('SELECT count(*) AS n FROM representations').get().n, 0);
  } finally { database.close(); }
  const derivedPath = path.join(vaultPath, `助手资料/提取文本/${saved.id}/${saved.version}.md`), derivedInode = fs.statSync(derivedPath).ino;
  const originalPath = path.join(vaultPath, saved.relative_path), originalInode = fs.statSync(originalPath).ino;
  const restarted = await launch(false); let source;
  const deadline = performance.now() + 8000;
  do {
    source = (await (await restarted.request(`/api/v1/sources/${saved.id}`)).json()).data;
    assert(performance.now() < deadline, 'Restart failed to register the published derivative');
    if (source.state !== 'ready') await delay(20);
  } while (source.state !== 'ready');
  assert.equal(fs.statSync(derivedPath).ino, derivedInode); assert.equal(fs.statSync(originalPath).ino, originalInode);
  assert.deepEqual(fs.readFileSync(originalPath), original);
  const run = (await (await restarted.request(`/api/v1/runs/${ref.runId}`)).json()).data;
  assert.equal(run.state, 'interrupted'); assert.equal(run.error.code, 'RUN_INTERRUPTED');
  const content = await restarted.request(`/api/v1/sources/${saved.id}/content?view=text&expectedVersion=${source.version}`);
  assert.equal(content.status, 200); assert((await content.text()).includes('松岚实验站巡检说明'));
  const replay = await restarted.request('/api/v1/ingestions', { method: 'POST', headers: { 'idempotency-key': key }, body });
  assert.equal((await replay.json()).data.runId, ref.runId);
  const listing = (await (await restarted.request(`/api/v1/vaults/${vault.id}/sources`)).json()).data.items;
  assert.equal(listing.length, 1); assert.equal(listing[0].id, saved.id);
  restarted.child.kill('SIGTERM'); assert.deepEqual(await restarted.exited, [0, null]);
});

test('derived access refuses unknown directories, links, and invalid requests without modifying user files', { timeout: 15000 }, async t => {
  const f = await fixture(t, []);
  const managed = path.join(f.vaultPath, '助手资料'); fs.mkdirSync(managed); fs.writeFileSync(path.join(managed, 'user.md'), 'USER');
  fs.copyFileSync(path.join(fixtures, 'inputs/formats/inspection.pdf'), path.join(f.vaultPath, 'inspection.pdf'));
  await f.vaults.scan(f.vault.id); const rejected = await f.prepare('inspection.pdf');
  assert.equal(rejected.state, 'failed'); assert.equal(rejected.warnings[0].code, 'VAULT_ACCESS_DENIED');
  assert.deepEqual(fs.readdirSync(managed), ['user.md']); assert.equal(fs.readFileSync(path.join(managed, 'user.md'), 'utf8'), 'USER');
  const g = await fixture(t), source = await g.prepare('inspection.pdf');
  const derived = path.join(g.vaultPath, source.readableRepresentation.relativePath), outside = path.join(g.directory, 'outside.md');
  fs.writeFileSync(outside, 'OUTSIDE'); fs.unlinkSync(derived); fs.symlinkSync(outside, derived);
  await assert.rejects(g.vaults.content(source.id, 'text', source.version), fails('DERIVED_MODIFIED'));
  assert.equal(g.vaults.source(source.id).state, 'needs_review');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE');
  const result = spawnSync(python, ['-I', '-B', path.join(root, 'dist/server/conversion-files.py')], {
    input: JSON.stringify({ op: 'derived_read', relativePath: '../outside.md' }), encoding: 'utf8', timeout: 5000 });
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, error: 'BAD_REQUEST' });
});

test('the real extraction helper caps generated text and blocks Python network access with sanitized errors', { timeout: 10000 }, async t => {
  const f = await fixture(t), source = await f.prepare('inspection.pdf');
  for (const [behavior, expected] of [['oversize', 'FILE_TOO_LARGE'], ['network', 'CONVERSION_FAILED']]) {
    const code = `import importlib.util,sys,types,socket\nfrom markitdown import MarkItDown\nspec=importlib.util.spec_from_file_location('conversion',${JSON.stringify(path.join(root, 'dist/server/conversion-parser.py'))})\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\ndef replacement(*args,**kwargs):\n    ${behavior === 'oversize' ? "return types.SimpleNamespace(markdown='X'*(m.MAX_OUTPUT+1))" : "socket.create_connection(('127.0.0.1',9),timeout=0.1); raise RuntimeError('Network should have been blocked')"}\nMarkItDown.convert_stream=replacement\nsys.argv=['conversion-parser.py',${JSON.stringify(path.join(f.vaultPath, 'inspection.pdf'))},'.pdf']\nm.main()\n`;
    const result = spawnSync(python, ['-I', '-B', '-c', code], { encoding: 'utf8', timeout: 5000,
      env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' } });
    assert.equal(result.status, 0); assert.deepEqual(JSON.parse(result.stdout), { ok: false, error: expected });
  }
  assert.equal(f.vaults.source(source.id).state, 'ready');
});

test('conversion subprocess cancellation and protocol limits terminate the worker', { timeout: 10000 }, async t => {
  const f = await fixture(t, []);
  const helper = path.join(f.directory, 'probe.py'), pidPath = path.join(f.directory, 'pid');
  fs.writeFileSync(helper, `import os,json,sys,time\nrequest=json.load(sys.stdin)\nwith open(${JSON.stringify(pidPath + '.tmp')},'w') as f: f.write(str(os.getpid()))\nos.replace(${JSON.stringify(pidPath + '.tmp')},${JSON.stringify(pidPath)})\nif request['mode']=='flood':\n    sys.stdout.write('X'*(29*1024*1024));sys.stdout.flush()\ntime.sleep(30)\n`);
  class Probe extends VaultFiles { probe(mode, signal) { return this.execute('extract', { mode }, signal); } }
  const probe = new Probe(python, [f.storage.directory, root], helper);
  f.cleanup.push(() => probe.close());
  for (const mode of ['cancel', 'flood']) {
    fs.rmSync(pidPath, { force: true });
    const abort = new AbortController(), pending = probe.probe(mode, abort.signal);
    const rejection = assert.rejects(pending, fails(mode === 'cancel' ? 'RUN_INTERRUPTED' : 'SERVICE_UNAVAILABLE'));
    while (!fs.existsSync(pidPath)) await delay(10);
    const pid = Number(fs.readFileSync(pidPath, 'utf8'));
    assert(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid);
    if (mode === 'cancel') abort.abort();
    await rejection;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'Worker must be reaped before operation settles');
  }
});

test('a directly added attachment is discovered and converted by normal monitoring without an upload or refresh', { timeout: 10000 }, async t => {
  const f = await fixture(t, []); f.vaults.startMonitoring();
  const started = performance.now(), emptyCatalog = f.vaults.catalogRevision(f.vault.id);
  fs.copyFileSync(path.join(fixtures, 'inputs/formats/inspection.docx'), path.join(f.vaultPath, 'direct.docx'));
  let source;
  while ((source = f.source('direct.docx'))?.state !== 'ready') {
    assert(performance.now() - started < 5000, `Direct attachment state: ${source?.state}`); await delay(20);
  }
  const bytes = (await f.vaults.content(source.id, 'text', source.version)).bytes;
  assert(bytes.toString().includes('松岚实验站巡检说明')); assert.equal(source.origin, 'existing_file');
  const readyCatalog=f.vaults.catalogRevision(f.vault.id); assert(readyCatalog > emptyCatalog);
  await f.vaults.scan(f.vault.id); assert.equal(f.vaults.catalogRevision(f.vault.id), readyCatalog, 'unchanged scans do not reload the UI');
  fs.unlinkSync(path.join(f.vaultPath,'direct.docx')); await f.vaults.scan(f.vault.id); assert(f.vaults.catalogRevision(f.vault.id) > readyCatalog);
  t.diagnostic(JSON.stringify({ scenario: 'direct_attachment_monitoring', discoveredAndReadyMs: Math.round(performance.now() - started) }));
});

test('intake rejects a replacement version observed after preparation instead of reporting the submitted version ready', { timeout: 10000 }, async t => {
  const f = await fixture(t, []);
  const ingestions = new IngestService(f.storage.db, f.vaults, new IngestFiles(python, f.storage.directory, root));
  const runs = new RunService(f.storage.db, f.vaults, ingestions);
  f.cleanup.push(async () => { await runs.close(); ingestions.close(); });
  f.vaults.prepareSource = async id => {
    const source = f.vaults.source(id);
    fs.writeFileSync(path.join(f.vaultPath, source.relativePath), 'USER_REPLACEMENT');
    await f.vaults.scan(f.vault.id);
    return f.vaults.source(id);
  };
  const ref = await runs.ingest({ vaultId: f.vault.id, input: { kind: 'text', text: 'SUBMITTED_VERSION' } }, randomUUID());
  while (!['succeeded', 'failed'].includes(runs.get(ref.runId).state)) await delay(10);
  const run = runs.get(ref.runId); assert.equal(run.state, 'failed'); assert.equal(run.error.code, 'SOURCE_CHANGED');
  const source = f.vaults.source(run.error.details.sourceId);
  assert.equal(source.version, hash('USER_REPLACEMENT')); assert.equal(source.state, 'ready');
  assert.equal(fs.readFileSync(path.join(f.vaultPath, source.relativePath), 'utf8'), 'USER_REPLACEMENT');
});

test('modified derivative is rejected immediately and remains protected across original versions', { timeout: 20000 }, async t => {
  const f = await fixture(t), source = await f.prepare('inspection.pdf'); assert.equal(source.state, 'ready');
  const derivedPath = path.join(f.vaultPath, source.readableRepresentation.relativePath);
  const modified = fs.readFileSync(derivedPath, 'utf8') + '\n用户手工说明。'; fs.writeFileSync(derivedPath, modified);
  await assert.rejects(f.vaults.content(source.id, 'text', source.version), fails('DERIVED_MODIFIED'));
  assert.equal(f.vaults.source(source.id).state, 'needs_review');
  fs.copyFileSync(path.join(fixtures, 'inputs/formats/mixed.pdf'), path.join(f.vaultPath, 'inspection.pdf'));
  await f.vaults.scan(f.vault.id); const current = await f.prepare('inspection.pdf');
  assert.equal(current.id, source.id); assert.notEqual(current.version, source.version);
  assert.equal(current.state, 'needs_review'); assert.equal(current.readableRepresentation, null);
  assert.equal(fs.readFileSync(derivedPath, 'utf8'), modified);
  assert.equal(fs.readdirSync(path.dirname(derivedPath)).filter(name => name.endsWith('.md')).length, 1);
});

test('unchanged derivatives survive scans/renames; changed originals get a new version and deleted/excluded ones cannot revive', { timeout: 25000 }, async t => {
  const f = await fixture(t), source = await f.prepare('inspection.pdf'); assert.equal(source.state, 'ready');
  const oldPath = path.join(f.vaultPath, source.readableRepresentation.relativePath), oldInode = fs.statSync(oldPath).ino;
  fs.renameSync(path.join(f.vaultPath, 'inspection.pdf'), path.join(f.vaultPath, 'renamed.pdf'));
  await f.vaults.scan(f.vault.id); const renamed = f.source('renamed.pdf'); assert.equal(renamed.id, source.id);
  await f.vaults.content(renamed.id, 'text', renamed.version); assert.equal(fs.statSync(oldPath).ino, oldInode);
  fs.copyFileSync(path.join(fixtures, 'inputs/formats/mixed.pdf'), path.join(f.vaultPath, 'renamed.pdf'));
  await assert.rejects(f.vaults.content(source.id, 'text', source.version), fails('SOURCE_CHANGED'));
  await f.vaults.scan(f.vault.id); const current = await f.prepare('renamed.pdf');
  assert.equal(current.state, 'partial'); assert.notEqual(current.readableRepresentation.relativePath, source.readableRepresentation.relativePath);
  assert.equal(fs.statSync(oldPath).ino, oldInode);
  f.vaults.update(f.vault.id, { expectedRevision: f.vaults.get(f.vault.id).revision, exclusions: ['renamed.pdf'] });
  await assert.rejects(f.vaults.content(source.id, 'text', current.version), fails('SOURCE_EXCLUDED'));
  await f.vaults.scan(f.vault.id); assert.equal(f.vaults.sources(f.vault.id, {}).items.length, 1);
  fs.unlinkSync(path.join(f.vaultPath, 'renamed.pdf'));
  f.vaults.update(f.vault.id, { expectedRevision: f.vaults.get(f.vault.id).revision, exclusions: [] });
  await f.vaults.scan(f.vault.id); assert.equal(f.vaults.source(source.id).state, 'missing');
  assert.equal(f.vaults.get(f.vault.id).discovery.scanned, 0);
});

test('version or scope changes after extraction prevent publication and stop exposes no readable stale output', { timeout: 30000 }, async t => {
  for (const change of ['original', 'scope', 'cancel']) {
    let extracted, release;
    const ready = new Promise(resolve => { extracted = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    class Paused extends ConversionFiles { async extract(input, signal) {
      const result = await super.extract(input, signal); extracted(); await gate; return result;
    } }
    const f = await fixture(t, ['inspection.pdf'], Paused), source = f.source('inspection.pdf');
    const abort = new AbortController();
    const pending = f.vaults.prepareSource(source.id, abort.signal).catch(error => error);
    await ready;
    if (change === 'original') fs.copyFileSync(path.join(fixtures, 'inputs/formats/mixed.pdf'), path.join(f.vaultPath, 'inspection.pdf'));
    else if (change === 'scope') f.vaults.update(f.vault.id, { expectedRevision: f.vault.revision, exclusions: ['inspection.pdf'] });
    else abort.abort();
    release(); const result = await pending; assert(result instanceof Error, change);
    assert.equal(f.vaults.source(source.id).readableRepresentation, null);
    assert(!fs.existsSync(path.join(f.vaultPath, '助手资料')), 'No stale output should reach the vault');
  }
});

test('published conversion is recovered without rewriting when registration fails', { timeout: 20000 }, async t => {
  class FailedRegistration extends ConversionFiles {
    async readDerived() { throw new Error('Synthetic failure after file publication'); }
  }
  const f = await fixture(t, ['inspection.pdf'], FailedRegistration), failed = await f.prepare('inspection.pdf');
  assert.equal(failed.state, 'failed');
  const relativePath = `助手资料/提取文本/${failed.id}/${failed.version}.md`, inode = fs.statSync(path.join(f.vaultPath, relativePath)).ino;
  await f.vaults.close();
  f.storage.db.prepare("UPDATE sources SET state='processing' WHERE id=?").run(failed.id);
  const converter = new ConversionFiles(python, [f.storage.directory, root]);
  converter.extract = async () => { throw new Error('Recovery must use the already published output'); };
  const restarted = new VaultService(f.storage.db, new VaultFiles(python, [f.storage.directory, root]), converter);
  f.cleanup.push(() => restarted.close());
  const source = await restarted.prepareSource(failed.id); assert.equal(source.state, 'ready');
  assert.equal(fs.statSync(path.join(f.vaultPath, relativePath)).ino, inode);
});

test('real multipart PDF intake waits for conversion and publishes partial limitations in the source', { timeout: 20000 }, async t => {
  const f = await fixture(t, []);
  const ingestions = new IngestService(f.storage.db, f.vaults, new IngestFiles(python, f.storage.directory, root));
  const runs = new RunService(f.storage.db, f.vaults, ingestions);
  // Use the documented bootstrap exchange rather than logging any credential.
  const token = randomBytes(32).toString('base64url'), browser = new BrowserSession(token);
  const app = createApp(browser, undefined, f.vaults, runs);
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const cookie = sessionCookie(browser.exchange(token), app.server.address().port).split(';')[0];
  f.cleanup.push(async () => { await app.close(); await runs.close(); ingestions.close(); });
  const form = new FormData(); form.set('meta', JSON.stringify({ vaultId: f.vault.id, input: { kind: 'upload', filePart: 'file' } }));
  form.set('file', new File([fs.readFileSync(path.join(fixtures, 'inputs/formats/mixed.pdf'))], '混合.pdf'));
  const response = await fetch(origin + '/api/v1/ingestions', { method: 'POST', body: form, headers: { origin, cookie, 'idempotency-key': randomUUID() } });
  assert.equal(response.status, 202); const ref = (await response.json()).data;
  while (!['succeeded', 'failed'].includes(runs.get(ref.runId).state)) await delay(10);
  const run = runs.get(ref.runId); assert.equal(run.state, 'succeeded', JSON.stringify(run.error));
  assert.equal(run.result.sourceState, 'partial');
  const stages = runs.events(run.id, 0).items.filter(event => event.type === 'source.updated').map(event => event.payload.sourceState);
  assert(stages.includes('processing')); assert.equal(stages.at(-1), 'partial');
  const source = f.vaults.source(run.result.sourceId);
  const content = await fetch(`${origin}/api/v1/sources/${source.id}/content?view=text&expectedVersion=${source.version}`, { headers: { origin, cookie } });
  assert.equal(content.status, 200); assert((await content.text()).replace(/\s/g, '').includes('正文记录数量为8'));
});


test('a 6 MiB extracted body publishes and reopens without the old 5 MiB ceiling', { timeout: 30000 }, async t => {
  const f = await fixture(t), source = f.source('inspection.pdf');
  const input = conversionInput(f.vaults.context(f.vault.id), source), bytes = Buffer.alloc(6 * 1024 * 1024, 65);
  const extracted = { state: 'ready', warningCodes: [], hash: hash(bytes), extractorVersion: 'markitdown/0.1.9;notetrail/1', base64: bytes.toString('base64') };
  const result = await f.converter.publish(input, extracted); assert.equal(result.hash, extracted.hash);
  assert.equal(hash(await f.converter.readDerived(input, result.hash)), extracted.hash);
});
