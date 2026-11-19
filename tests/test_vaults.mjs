import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { launchBackend, connectBackend } from './fixtures/backend-process.mjs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { openStorage, MIGRATIONS } from '../dist/server/storage.js';
import { VaultFiles } from '../dist/server/vault-files.js';
import { VaultService } from '../dist/server/vaults.js';
import { createApp } from '../dist/server/app.js';
import { BrowserSession, sessionCookie } from '../dist/server/session.js';
import { isVaultInput, isRelativePath, isExclusions, isExcluded, MAX_FILE_BYTES } from '../dist/shared/vault.js';
import { discoverVaults } from '../src/desktop/vault-discovery.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const python = process.env.NOTETRAIL_PYTHON ?? path.join(os.homedir(), '.local/share/uv/tools/markitdown/bin/python');
const hash = content => createHash('sha256').update(content).digest('hex');
const fails = code => error => error.publicError?.code === code;
const input = (f, exclusions = []) => ({ absolutePath: f.vault, exclusions });
function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-vault-')));
  const vault = path.join(directory, 'vault'); fs.mkdirSync(vault);
  const storage = openStorage(path.join(directory, 'data'));
  const files = new VaultFiles(python, [storage.directory, root]);
  const service = new VaultService(storage.db, files);
  t.after(async () => { await service.close(); storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, vault, storage, files, service, write(name, content = '# Public fixture\nPUBLIC_BODY\n') {
    const file = path.join(vault, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file;
  } };
}
async function http(t, f) {
  const token = randomBytes(32).toString('base64url'), session = new BrowserSession(token);
  const app = createApp(session, undefined, f.service);
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const cookie = sessionCookie(session.exchange(token), app.server.address().port).split(';')[0];
  t.after(() => app.close());
  return async (route, { method = 'GET', body, headers = {}, authenticated = true } = {}) => {
    const response = await fetch(`${origin}${route}`, { method, headers: { origin, ...(authenticated ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text,
      json: response.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(text) : undefined };
  };
}

test('warm scans read no unchanged bodies and rehash only changed files, including unsupported files', async t => {
  const f = fixture(t), note = f.write('note.md', 'version one\n');
  for (let i = 0; i < 3; i++) f.write(`large-${i}.bin`, Buffer.alloc(4 * 1024 * 1024, i));
  const log = path.join(f.directory, 'reads.jsonl'), helper = path.join(f.directory, 'counted-scan.py');
  fs.writeFileSync(log, '');
  fs.writeFileSync(helper, `import importlib.util, json\nspec = importlib.util.spec_from_file_location('gateway', ${JSON.stringify(path.join(root, 'dist/server/vault-files.py'))})\ngateway = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(gateway)\nread = gateway.read_file\ndef counted(tree, name):\n    result = read(tree, name)\n    with open(${JSON.stringify(log)}, 'a') as out:\n        out.write(json.dumps({'name': name, 'bytes': len(result)}) + '\\n')\n    return result\ngateway.read_file = counted\ngateway.main()\n`);
  f.files.helper = helper;
  const reads = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const vault = await f.service.connect(input(f));
  assert.equal(reads().reduce((n, r) => n + r.bytes, 0), 12 * 1024 * 1024 + 12);
  fs.truncateSync(log);
  for (let i = 0; i < 3; i++) await f.service.scan(vault.id);
  assert.deepEqual(reads(), [], 'unchanged scans must not read even unsupported binary bodies');
  const previous = fs.statSync(note); fs.writeFileSync(note, 'version two\n'); fs.utimesSync(note, previous.atime, previous.mtime);
  await f.service.scan(vault.id);
  assert.deepEqual(reads(), [{ name: 'note.md', bytes: 12 }]);
  assert.equal(f.service.sources(vault.id, {}).items.find(s => s.relativePath === 'note.md').version, hash('version two\n'));
  fs.truncateSync(log);
  await f.service.scan(vault.id, undefined, true);
  assert.equal(reads().length, 4, 'explicit full scans must bypass the metadata cache');
  fs.truncateSync(log);
  const restarted = new VaultFiles(python, [f.storage.directory, root], helper);
  const { revision, ...location } = f.service.context(vault.id);
  try { await restarted.snapshot(location); } finally { restarted.close(); }
  assert.equal(reads().length, 4, 'a new process must establish its own verified baseline');
});

test('vault inputs and exclusions are bounded literal paths without traversal or ambiguous fields', () => {
  assert(isVaultInput({ absolutePath: '/public/资料库', exclusions: ['private/', '欢迎.md'] }));
  assert(isRelativePath('资料/😀.md'));
  for (const name of ['资料[1].md', 'a*.md', 'a?.md', 'a:b.md']) assert(isRelativePath(name));
  for (const value of ['', '/', '/root/a', '../a', 'a/../b', './a', 'a//b', 'a\\b', 'a\0b', 'a\nb', '\ud800.md']) {
    assert.equal(isRelativePath(value), false, value);
  }
  for (const value of [null, {}, { ...input({ vault: '/a' }), key: 'extra' }, input({ vault: '/' }),
    input({ vault: '/a/../b' }), input({ vault: '/a/' }), input({ vault: '/a' }, ['private', 'PRIVATE'])]) assert(!isVaultInput(value));
  assert(!isExclusions(Array(51).fill('a')));
  assert(isExcluded('.Obsidian/config.json', [])); assert(isExcluded('private/a.md', ['PRIVATE/']));
  assert(isExcluded('nested/.git/config', [])); assert(isExcluded('notes/.DS_Store', []));
  assert(!isExcluded('private-other/a.md', ['private/']));
  assert(isExcluded('助手资料/提取文本/orphan.md', []));
});

test('real HTTP discovers existing Markdown, honors exclusions and serves only versioned authorized content', async t => {
  const f = fixture(t), one = f.write('资料/one.md', '# Public\nOriginal fact.\n'); f.write('second.md');
  f.write('.obsidian/config.md', 'PUBLIC_EXCLUDED_CONFIG'); f.write('private/hidden.md', 'PUBLIC_EXCLUDED_BODY');
  f.write('助手资料/提取文本/orphan.md', 'PUBLIC_ORPHAN');
  fs.chmodSync(path.join(f.vault, 'private/hidden.md'), 0);
  const before = hash(fs.readFileSync(one)), request = await http(t, f), start = performance.now();
  const connected = await request('/api/v1/vaults', { method: 'POST', body: input(f, ['private/']) });
  assert.equal(connected.status, 201); const vault = connected.json.data;
  const registry = path.join(f.directory, 'obsidian.json');
  fs.writeFileSync(registry, JSON.stringify({ vaults: { public: { path: f.vault } } }));
  assert.equal((await discoverVaults({ registry })).items[0].locationKey, vault.locationKey);
  assert.equal(vault.discovery.state, 'ready'); assert.equal(vault.discovery.scanned, 2); assert.equal(vault.discovery.skipped, 3);
  assert(performance.now() - start < 10000); assert(!connected.text.includes(f.vault));
  const listed = await request(`/api/v1/vaults/${vault.id}/sources?state=ready&limit=20`); assert.equal(listed.status, 200);
  assert.deepEqual(listed.json.data.items.map(s => s.relativePath).sort(), ['second.md', '资料/one.md']);
  const source = listed.json.data.items.find(s => s.relativePath === '资料/one.md');
  assert.equal(source.state, 'ready'); assert.equal(source.version, before);
  assert.equal(source.readableRepresentation.hash, before); assert.equal(source.readableRepresentation.kind, 'original_text');
  const url = `/api/v1/sources/${source.id}/content?view=text&expectedVersion=${source.version}`;
  const text = await request(url); assert.equal(text.status, 200); assert.equal(text.text, '# Public\nOriginal fact.\n');
  assert.match(text.headers.get('content-type'), /^text\/plain/); assert.equal(text.headers.get('x-content-type-options'), 'nosniff');
  const download = await request(url.replace('view=text', 'view=original'));
  assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /^attachment;/);
  assert.equal((await request(url, { authenticated: false })).status, 401);
  assert.equal((await request(url, { headers: { origin: 'https://untrusted.invalid' } })).status, 403);
  for (const query of ['', '?view=text', `?view=text&view=original&expectedVersion=${before}`,
    `?view=text&expectedVersion=${before}&path=/outside`, `?view=text&expectedVersion=${'a'.repeat(64)}`]) {
    const response = await request(`/api/v1/sources/${source.id}/content${query}`);
    assert([400, 409].includes(response.status)); assert(!response.text.includes('Original fact'));
  }
  assert.equal(hash(fs.readFileSync(one)), before);
  assert.deepEqual(fs.readdirSync(f.vault).sort(), ['.obsidian', 'private', 'second.md', '助手资料', '资料']);
});

test('source pages validate filters and cursors and never return more than the requested bound', async t => {
  const f = fixture(t); for (let i = 0; i < 26; i++) f.write(`note-${i}.md`);
  f.write('unsupported.doc', 'public legacy'); const vault = await f.service.connect(input(f));
  const first = f.service.sources(vault.id, { limit: '20', state: 'ready' });
  const second = f.service.sources(vault.id, { cursor: first.nextCursor, limit: '20', state: 'ready' });
  assert.equal(first.items.length, 20); assert.equal(second.items.length, 6); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map(s => s.id)).size, 26);
  for (const query of [{ limit: '0' }, { limit: '51' }, { limit: 5 }, { limit: ['1', '2'] }, { state: 'unknown' },
    { cursor: 'path/to/file' }, { cursor: `s_${randomUUID()}` }, { absolutePath: f.vault }]) {
    assert.throws(() => f.service.sources(vault.id, query), fails('BAD_REQUEST'));
  }
  assert.equal(f.service.sources(vault.id, { state: 'unsupported' }).items.length, 1);
});

test('state survives reopening without copying or rearranging the original vault', async t => {
  const f = fixture(t); f.write('note.md'); const vault = await f.service.connect(input(f));
  const before = f.service.sources(vault.id, {}).items;
  const beforeVault = f.service.get(vault.id);
  await f.service.close(); f.storage.close();
  const second = openStorage(f.storage.directory);
  try {
    const service = new VaultService(second.db, new VaultFiles(python, [second.directory, root]));
    assert.deepEqual(service.get(vault.id), beforeVault);
    assert.deepEqual(service.sources(vault.id, {}).items, before);
    assert.equal((await service.content(before[0].id, 'text', before[0].version)).bytes.toString(), '# Public fixture\nPUBLIC_BODY\n');
    await service.close();
  } finally { second.close(); }
  assert.deepEqual(fs.readdirSync(f.vault), ['note.md']);
});

test('changed bytes with restored timestamps invalidate the old source and internal rescan preserves its identity', async t => {
  const f = fixture(t), file = f.write('note.md', 'PUBLIC_VERSION_ONE');
  const vault = await f.service.connect(input(f)), source = f.service.sources(vault.id, {}).items[0];
  const stat = fs.statSync(file); fs.writeFileSync(file, 'PUBLIC_VERSION_TWO'); fs.utimesSync(file, stat.atime, stat.mtime);
  await assert.rejects(f.service.content(source.id, 'text', source.version), fails('SOURCE_CHANGED'));
  assert.equal(f.service.source(source.id).state, 'stale'); assert.equal(f.service.source(source.id).readableRepresentation, null);
  await f.service.scan(vault.id); const current = f.service.source(source.id);
  assert.equal(current.state, 'ready'); assert.equal(current.version, hash('PUBLIC_VERSION_TWO'));
  assert.equal((await f.service.content(source.id, 'text', current.version)).bytes.toString(), 'PUBLIC_VERSION_TWO');
});

test('deletion revokes a known source immediately when accessed, without serving cached content', async t => {
  const f = fixture(t), file = f.write('note.md'); const vault = await f.service.connect(input(f));
  const source = f.service.sources(vault.id, {}).items[0]; fs.unlinkSync(file);
  await assert.rejects(f.service.content(source.id, 'text', source.version), fails('SOURCE_MISSING'));
  const current = f.service.source(source.id);
  assert.equal(current.state, 'missing'); assert.equal(current.originalSaved, false);
  assert.equal(current.version, null); assert.equal(current.readableRepresentation, null);
});

test('symbolic links, hard links and special files are not discovered or used to replace registered originals', async t => {
  const f = fixture(t), file = f.write('safe/note.md');
  const outside = path.join(f.directory, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'note.md'), 'PUBLIC_OUTSIDE');
  fs.symlinkSync(outside, path.join(f.vault, 'alias')); fs.linkSync(path.join(outside, 'note.md'), path.join(f.vault, 'hard.md'));
  const fifo = spawnSync('/usr/bin/mkfifo', [path.join(f.vault, 'pipe.md')]); assert.equal(fifo.status, 0);
  const vault = await f.service.connect(input(f)); assert.equal(vault.discovery.scanned, 1); assert.equal(vault.discovery.skipped, 3);
  const source = f.service.sources(vault.id, {}).items[0]; fs.unlinkSync(file); fs.symlinkSync(path.join(outside, 'note.md'), file);
  await assert.rejects(f.service.content(source.id, 'text', source.version), fails('PATH_OUTSIDE_SCOPE'));
  assert.equal(f.service.source(source.id).state, 'excluded');
  assert.equal(fs.readFileSync(path.join(outside, 'note.md'), 'utf8'), 'PUBLIC_OUTSIDE');
});

test('root identity, ancestor links and overlap with application data or code are checked before scanning', async t => {
  const f = fixture(t); f.write('note.md');
  for (const forbidden of [f.directory, f.storage.directory, root]) {
    await assert.rejects(f.service.connect({ absolutePath: forbidden, exclusions: [] }), fails('PATH_OUTSIDE_SCOPE'));
  }
  const alias = path.join(f.directory, 'alias'); fs.symlinkSync(f.vault, alias);
  await assert.rejects(f.service.connect({ absolutePath: alias, exclusions: [] }), fails('PATH_OUTSIDE_SCOPE'));
  const vault = await f.service.connect(input(f)), source = f.service.sources(vault.id, {}).items[0];
  fs.renameSync(f.vault, path.join(f.directory, 'moved')); fs.mkdirSync(f.vault); f.write('note.md');
  await assert.rejects(f.service.content(source.id, 'text', source.version), fails('VAULT_ACCESS_DENIED'));
  const other = path.join(f.directory, 'second'); fs.mkdirSync(other);
  await assert.rejects(f.service.connect({ absolutePath: other, exclusions: [] }), fails('BAD_REQUEST'));
  assert.equal(f.service.list().items.length, 1);
});

test('descriptor-relative opens cannot follow an ancestor replaced between validation and leaf open', t => {
  const f = fixture(t); f.write('safe/note.md', 'PUBLIC_INSIDE');
  const outside = path.join(f.directory, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'note.md'), 'PUBLIC_OUTSIDE');
  const script = `import importlib.util, os\nspec=importlib.util.spec_from_file_location('gateway',${JSON.stringify(path.join(root, 'dist/server/vault-files.py'))})\nm=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\nroot=${JSON.stringify(f.vault)}\noutside=${JSON.stringify(outside)}\ntree=m.Directories(root); tree.push('safe')\noriginal_open,original_read=os.open,os.read\ndef swapping_open(name,*args,**kwargs):\n    if name=='note.md':\n        os.rename(root+'/safe',root+'/old-safe'); os.symlink(outside,root+'/safe')\n    return original_open(name,*args,**kwargs)\ndef checked_read(fd,*args):\n    assert os.fstat(fd).st_ino!=os.stat(outside+'/note.md').st_ino\n    return original_read(fd,*args)\nos.open=swapping_open; os.read=checked_read\ntry:\n    try: m.read_file(tree,'note.md')\n    except m.Denied as error: assert error.code=='SOURCE_CHANGED'\n    else: raise AssertionError('changed ancestor accepted')\nfinally: tree.close()\nprint('descriptor race rejected without outside read')\n`;
  const result = spawnSync(python, ['-I', '-B', '-c', script], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /without outside read/);
});

test('non-ready formats, empty or invalid Markdown and oversize input remain explicit source states', async t => {
  const f = fixture(t); f.write('pending.pdf', 'PUBLIC_NOT_CONVERTED'); f.write('legacy.doc', 'PUBLIC_LEGACY');
  f.write('empty.md', ' \n'); f.write('invalid.md', Buffer.from([0xff, 0xfe]));
  const large = f.write('large.md', ''); fs.truncateSync(large, MAX_FILE_BYTES + 1);
  const vault = await f.service.connect(input(f)); assert.equal(vault.discovery.state, 'ready');
  const records = new Map(f.service.sources(vault.id, {}).items.map(source => [source.relativePath, source]));
  assert.equal(records.get('pending.pdf').state, 'pending'); assert.equal(records.get('legacy.doc').state, 'unsupported');
  for (const name of ['empty.md', 'invalid.md', 'large.md']) assert.equal(records.get(name).state, 'failed');
  assert.equal(records.get('large.md').warnings[0].code, 'FILE_TOO_LARGE');
  const pending = records.get('pending.pdf');
  await assert.rejects(f.service.content(pending.id, 'text', pending.version), fails('SOURCE_NOT_READY'));
  assert.equal((await f.service.content(pending.id, 'original', pending.version)).bytes.toString(), 'PUBLIC_NOT_CONVERTED');
});

test('scans stream more than 50 files across batches and publish a complete catalog', async t => {
  const f = fixture(t); for (let i = 0; i < 251; i++) f.write(`note-${i}.md`);
  const vault = await f.service.connect(input(f));
  assert.equal(vault.discovery.state, 'ready'); assert.equal(vault.discovery.scanned, 251);
  assert.equal(f.service.sources(vault.id, { limit: '50' }).items.length, 50); assert.equal(fs.readdirSync(f.vault).length, 251);
});

test('an older scan cannot overwrite a newer snapshot even when its filesystem result returns late', async t => {
  const f = fixture(t), file = f.write('note.md', 'PUBLIC_OLD'); const vault = await f.service.connect(input(f));
  const snapshot = f.files.snapshot.bind(f.files); let release, reached;
  const paused = new Promise(resolve => { reached = resolve; }); let first = true;
  f.files.snapshot = async location => {
    const result = await snapshot(location);
    if (first) { first = false; reached(); await new Promise(resolve => { release = resolve; }); }
    return result;
  };
  const earlier = f.service.scan(vault.id); const rejected = assert.rejects(earlier, fails('CONTEXT_CHANGED'));
  await paused; fs.writeFileSync(file, 'PUBLIC_NEW'); await f.service.scan(vault.id); release(); await rejected;
  assert.equal(f.service.get(vault.id).discovery.state, 'ready');
  assert.equal(f.service.sources(vault.id, {}).items[0].version, hash('PUBLIC_NEW'));
});

test('v2 configuration is preserved in both the migration backup and the current database', t => {
  const f = fixture(t), directory = path.join(f.directory, 'legacy');
  const legacy = openStorage(directory, MIGRATIONS.slice(0, 2));
  legacy.db.prepare('UPDATE model_settings SET revision=4,provider=?,model=?,base_url=?')
    .run('deepseek', 'deepseek-flash', 'https://api.deepseek.com'); legacy.close();
  const current = openStorage(directory);
  try {
    assert.equal(current.db.pragma('user_version', { simple: true }), MIGRATIONS.length);
    assert.equal(current.db.prepare('SELECT revision FROM model_settings').get().revision, 4);
    const backups = fs.readdirSync(path.join(directory, 'backups')); assert.equal(backups.length, 1);
    const backup = new Database(path.join(directory, 'backups', backups[0]), { readonly: true });
    try {
      assert.equal(backup.pragma('user_version', { simple: true }), 2);
      assert.equal(backup.prepare('SELECT revision FROM model_settings').get().revision, 4);
      assert.equal(backup.prepare("SELECT name FROM sqlite_schema WHERE name='vaults'").get(), undefined);
    } finally { backup.close(); }
  } finally { current.close(); }
});

test('gateway rejects unknown fields and malformed paths before any vault access and hides native failures', async t => {
  const f = fixture(t), helper = path.join(root, 'dist/server/vault-files.py');
  for (const request of [{ op: 'read' }, { op: 'inspect', root: f.vault, exclusions: [], forbiddenRoots: [f.storage.directory], extra: true },
    { op: 'inspect', root: f.vault, exclusions: ['../outside'], forbiddenRoots: [f.storage.directory] }]) {
    const result = spawnSync(python, ['-I', '-B', helper], { input: JSON.stringify(request), encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0); assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { ok: false, error: 'BAD_REQUEST' });
  }
  const missing = new VaultFiles('/does/not/exist/python', [f.storage.directory]);
  await assert.rejects(missing.inspect(f.vault, []), fails('SERVICE_UNAVAILABLE'));
});

test('formal startup connects five public fixtures, reads an original, ingests text and stops without changing existing files', async t => {
  const f = fixture(t), inputs = ['policies/rule-v1.md', 'policies/rule-v2.md', 'policies/undated-a.md',
    'policies/undated-b.md', 'chat/handover.md'];
  const originals = inputs.map((name, index) => {
    const bytes = fs.readFileSync(path.join(root, 'tests/fixtures/public/t00/inputs', name));
    return { file: f.write(`public-${index}.md`, bytes), version: hash(bytes) };
  });
  const directory = path.join(f.directory, 'formal-data');
  const backend = launchBackend(['--data-dir', directory, '--port', '0'], { cwd: root,
    env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'en_US.UTF-8', NOTETRAIL_PYTHON: python } });
  const { child, exited } = backend;
  try {
    const { origin, cookie } = await connectBackend(backend), start = performance.now();
    const response = await fetch(`${origin}/api/v1/vaults`, { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' },
      body: JSON.stringify(input(f)) });
    assert.equal(response.status, 201); const vault = (await response.json()).data, elapsedMs = performance.now() - start;
    assert.equal(vault.discovery.state, 'ready'); assert.equal(vault.discovery.scanned, 5); assert(elapsedMs < 1000);
    const listing = await fetch(`${origin}/api/v1/vaults/${vault.id}/sources?limit=5`, { headers: { cookie } });
    assert.equal(listing.status, 200); const sources = (await listing.json()).data.items; assert.equal(sources.length, 5);
    const source = sources.find(item => item.relativePath === 'public-0.md');
    const content = await fetch(`${origin}/api/v1/sources/${source.id}/content?view=original&expectedVersion=${source.version}`, { headers: { cookie } });
    assert.equal(content.status, 200); assert.equal(hash(Buffer.from(await content.arrayBuffer())), originals[0].version);
    const refreshStart = performance.now(), key = randomUUID();
    const refresh = await fetch(`${origin}/api/v1/vaults/${vault.id}/refresh`, { method: 'POST',
      headers: { cookie, origin, 'idempotency-key': key } });
    const acceptedMs = performance.now() - refreshStart;
    assert.equal(refresh.status, 202); assert(acceptedMs < 1000);
    const ref = (await refresh.json()).data;
    const events = await fetch(`${origin}${ref.eventsUrl}`, { headers: { cookie }, signal: AbortSignal.timeout(5000) });
    assert.equal(events.status, 200); assert.match(await events.text(), /"terminalState":"succeeded"/);
    const finished = await fetch(`${origin}/api/v1/runs/${ref.runId}`, { headers: { cookie } });
    const result = (await finished.json()).data;
    assert.deepEqual(result.result, { scanned: 5, ready: 5, partial: 0, failed: 0, skipped: 0,
      pending: 0, unsupported: 0, needsReview: 0, missing: 0, excluded: 0 });
    const intake = await fetch(`${origin}/api/v1/ingestions`, { method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ vaultId: vault.id, input: { kind: 'text', title: 'Public intake', text: 'PUBLIC_INGESTED_TEXT' } }) });
    assert.equal(intake.status, 202); const intakeRef = (await intake.json()).data;
    const intakeEvents = await fetch(`${origin}${intakeRef.eventsUrl}`, { headers: { cookie }, signal: AbortSignal.timeout(5000) });
    assert.match(await intakeEvents.text(), /"terminalState":"succeeded"/);
    const intakeRun = (await (await fetch(`${origin}/api/v1/runs/${intakeRef.runId}`, { headers: { cookie } })).json()).data;
    const saved = (await (await fetch(`${origin}/api/v1/sources/${intakeRun.result.sourceId}`, { headers: { cookie } })).json()).data;
    assert.equal(saved.originalSaved, true); assert.equal(saved.state, 'ready');
    assert.equal(fs.readFileSync(path.join(f.vault, saved.relativePath), 'utf8'), 'PUBLIC_INGESTED_TEXT');
    child.kill('SIGTERM'); assert.deepEqual(await exited, [0, null]);
    for (const original of originals) assert.equal(hash(fs.readFileSync(original.file)), original.version);
    assert.deepEqual(fs.readdirSync(f.vault).sort(), ['public-0.md', 'public-1.md', 'public-2.md', 'public-3.md', 'public-4.md', '助手资料']);
    t.diagnostic(JSON.stringify({ scenario: 'five_public_markdown_formal_startup', receivedAndReadyMs: Math.round(elapsedMs),
      refreshAcceptedMs: Math.round(acceptedMs), sourceCount: 5, formalTextIntake: 'ready' }));
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
});

async function until(check, timeout = 5000) {
  const start = performance.now();
  while (!check()) {
    assert(performance.now() - start < timeout, 'Expected source update before the deadline');
    await delay(30);
  }
  return Math.round(performance.now() - start);
}

test('unique renames keep source IDs; identical copies, reused paths and symlink remnants are not merged', async t => {
  const f = fixture(t);
  f.write('unique.md', 'UNIQUE'); f.write('a.md', 'COPY'); f.write('b.md', 'COPY');
  f.write('linked.md', 'LINKED');
  const vault = await f.service.connect(input(f));
  const old = new Map(f.service.sources(vault.id, {}).items.map(s => [s.relativePath, s]));
  fs.renameSync(path.join(f.vault, 'unique.md'), path.join(f.vault, 'renamed.md'));
  fs.renameSync(path.join(f.vault, 'a.md'), path.join(f.vault, 'copy-renamed.md'));
  fs.renameSync(path.join(f.vault, 'linked.md'), path.join(f.vault, 'new-linked.md'));
  fs.symlinkSync(path.join(f.vault, 'new-linked.md'), path.join(f.vault, 'linked.md'));
  await f.service.scan(vault.id);
  const current = new Map(f.service.sources(vault.id, {}).items.map(s => [s.relativePath, s]));
  assert.equal(current.get('renamed.md').id, old.get('unique.md').id);
  assert.equal(current.get('renamed.md').readableRepresentation.relativePath, 'renamed.md');
  assert.equal(current.get('a.md').state, 'missing');
  assert.notEqual(current.get('copy-renamed.md').id, old.get('a.md').id);
  assert.notEqual(current.get('new-linked.md').id, old.get('linked.md').id);
  assert.equal((await f.service.content(old.get('unique.md').id, 'text', hash('UNIQUE'))).bytes.toString(), 'UNIQUE');
  f.write('renamed.md', 'REPLACEMENT'); await f.service.scan(vault.id);
  assert.equal(f.service.source(old.get('unique.md').id).version, hash('REPLACEMENT'));
  await assert.rejects(f.service.content(old.get('unique.md').id, 'text', hash('UNIQUE')), fails('SOURCE_CHANGED'));
});

test('exclusion changes revoke content immediately, reject stale revisions and require rescanning before restoration', async t => {
  const f = fixture(t); f.write('public.md'); f.write('private/note.md');
  const vault = await f.service.connect(input(f)), request = await http(t, f);
  const source = f.service.sources(vault.id, {}).items.find(s => s.relativePath === 'private/note.md');
  const update = { expectedRevision: 1, exclusions: ['private/'] };
  const response = await request(`/api/v1/vaults/${vault.id}`, { method: 'PATCH', body: update });
  assert.equal(response.status, 200); assert.equal(response.json.data.revision, 2);
  assert.equal(f.service.source(source.id).state, 'excluded');
  assert.equal(f.service.source(source.id).readableRepresentation, null);
  await assert.rejects(f.service.content(source.id, 'text', source.version), fails('SOURCE_EXCLUDED'));
  const stale = await request(`/api/v1/vaults/${vault.id}`, { method: 'PATCH', body: update });
  assert.equal(stale.status, 409); assert.equal(stale.json.error.details.currentRevision, 2);
  for (const body of [{ ...update, extra: true }, { ...update, expectedRevision: '2' }, { ...update, exclusions: ['../outside'] }]) {
    assert.equal((await request(`/api/v1/vaults/${vault.id}`, { method: 'PATCH', body })).status, 400);
  }
  assert.equal((await request(`/api/v1/vaults/${vault.id}`, { method: 'PATCH', body: update, authenticated: false })).status, 401);
  const restored = f.service.update(vault.id, { expectedRevision: 2, exclusions: [] });
  assert.equal(restored.revision, 3); assert.equal(f.service.source(source.id).state, 'excluded');
  await f.service.scan(vault.id); assert.equal(f.service.source(source.id).state, 'ready');
  assert.equal((await f.service.content(source.id, 'text', source.version)).bytes.toString(), '# Public fixture\nPUBLIC_BODY\n');
});

test('a scan started before an exclusion revision cannot republish newly excluded content or overwrite pending status', async t => {
  const f = fixture(t); f.write('note.md'); const vault = await f.service.connect(input(f));
  const snapshot = f.files.snapshot.bind(f.files); let release, reached;
  const paused = new Promise(resolve => { reached = resolve; });
  f.files.snapshot = async (...args) => { const result = await snapshot(...args); reached(); await new Promise(resolve => { release = resolve; }); return result; };
  const running = f.service.scan(vault.id), rejected = assert.rejects(running, fails('CONTEXT_CHANGED'));
  await paused;
  f.service.update(vault.id, { expectedRevision: 1, exclusions: ['note.md'] });
  release(); await rejected;
  assert.equal(f.service.get(vault.id).discovery.state, 'pending');
  assert.equal(f.service.sources(vault.id, {}).items[0].state, 'excluded');
  f.files.snapshot = snapshot;
});

test('exclusions changed during an in-flight read revoke the returned bytes', async t => {
  const f = fixture(t); f.write('note.md'); const vault = await f.service.connect(input(f));
  const source = f.service.sources(vault.id, {}).items[0], read = f.files.read.bind(f.files);
  f.files.read = async (...args) => {
    const bytes = await read(...args); f.service.update(vault.id, { expectedRevision: 1, exclusions: ['note.md'] }); return bytes;
  };
  await assert.rejects(f.service.content(source.id, 'text', source.version), fails('CONTEXT_CHANGED'));
  assert.equal(f.service.source(source.id).state, 'excluded');
});

test('automatic reconciliation discovers edits, additions, deletion and unique renames within the small-vault target', async t => {
  const f = fixture(t); f.write('note.md', 'VERSION_ONE'); const vault = await f.service.connect(input(f));
  const source = f.service.sources(vault.id, {}).items[0]; f.service.startMonitoring();
  f.write('note.md', 'VERSION_TWO');
  const updateMs = await until(() => f.service.source(source.id).version === hash('VERSION_TWO'));
  f.write('added.md', 'ADDED'); await until(() => f.service.sources(vault.id, {}).items.some(s => s.relativePath === 'added.md'));
  fs.renameSync(path.join(f.vault, 'note.md'), path.join(f.vault, 'renamed.md'));
  await until(() => f.service.source(source.id).relativePath === 'renamed.md');
  fs.unlinkSync(path.join(f.vault, 'renamed.md'));
  await until(() => f.service.source(source.id).state === 'missing');
  t.diagnostic(JSON.stringify({ scenario: 'automatic_markdown_update', discoveredAndReadableMs: updateMs, targetMs: 5000 }));
});

test('startup reconciliation notices offline changes and periodic scanning works when watcher events are absent', async t => {
  const f = fixture(t); f.write('note.md', 'BEFORE'); const vault = await f.service.connect(input(f));
  const source = f.service.sources(vault.id, {}).items[0];
  f.write('note.md', 'OFFLINE_EDIT');
  const service = new VaultService(f.storage.db, new VaultFiles(python, [f.storage.directory, root]));
  try {
    service.startMonitoring(); await until(() => service.source(source.id).version === hash('OFFLINE_EDIT'));
    service.watcher?.close(); // Fault injection: the timer must not depend on notification delivery.
    f.write('note.md', 'NO_WATCH_EVENT');
    const detectedMs = await until(() => service.source(source.id).version === hash('NO_WATCH_EVENT'));
    t.diagnostic(JSON.stringify({ scenario: 'periodic_without_watch_events', discoveredAndReadableMs: detectedMs }));
  } finally { await service.close(); }
});

test('cancelling a delayed scan prevents publication and stopping closes active scans before storage', async t => {
  const f = fixture(t); f.write('note.md', 'BEFORE'); const vault = await f.service.connect(input(f));
  const source = f.service.sources(vault.id, {}).items[0], snapshot = f.files.snapshot.bind(f.files);
  for (const closing of [false, true]) {
    let release, reached; const paused = new Promise(resolve => { reached = resolve; });
    f.write('note.md', 'AFTER');
    f.files.snapshot = async (...args) => { const result = await snapshot(...args); reached(); await new Promise(resolve => { release = resolve; }); return result; };
    const controller = new AbortController();
    const scan = f.service.scan(vault.id, controller.signal), rejected = assert.rejects(scan, fails('RUN_INTERRUPTED'));
    await paused;
    const stopped = closing ? f.service.close() : (controller.abort(), Promise.resolve());
    release(); await rejected; await stopped;
    assert.equal(f.service.source(source.id).version, hash('BEFORE'));
  }
});

test('aggregate vault size above 100 MiB and literal bracket filenames remain readable', async t => {
  const f = fixture(t);
  for (let i = 0; i < 6; i++) { const file = f.write(`large-${i}.bin`); fs.truncateSync(file, 18 * 1024 * 1024); }
  f.write('资料[1].md', 'LITERAL_BRACKET_CONTENT');
  const vault = await f.service.connect(input(f));
  assert.equal(vault.discovery.state, 'ready'); assert.equal(vault.discovery.scanned, 7);
  const source = f.service.sources(vault.id, {}).items.find(s => s.relativePath === '资料[1].md');
  assert.equal((await f.service.content(source.id, 'text', source.version)).bytes.toString(), 'LITERAL_BRACKET_CONTENT');
});
