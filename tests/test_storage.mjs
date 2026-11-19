import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { launchBackend, startupMessage } from './fixtures/backend-process.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import Database from 'better-sqlite3';
import { APPLICATION_ID, MIGRATIONS, openStorage, migrateDatabase, defaultDataDirectory } from '../dist/server/storage.js';
import { parseStartOptions } from '../dist/server/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const SCHEMA_VERSION = MIGRATIONS.length;
const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'en_US.UTF-8' };
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function area(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-storage-')));
  const stores = [];
  t.after(() => { for (const store of stores.reverse()) store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, open(name = 'data') {
    const store = openStorage(path.join(directory, name)); stores.push(store); return store;
  } };
}

test('data directory defaults and startup arguments are explicit and bounded', () => {
  assert.equal(defaultDataDirectory('/synthetic-user'), '/synthetic-user/Library/Application Support/NoteTrail');
  assert.equal(parseStartOptions([]).dataDirectory, defaultDataDirectory());
  assert.deepEqual(parseStartOptions(['--data-dir', '/synthetic-user/app data', '--port', '0']), {
    port: 0, dataDirectory: '/synthetic-user/app data',
  });
  for (const args of [['--data-dir'], ['--data-dir', 'relative'], ['--data-dir', '/a', '--data-dir', '/b'],
    ['--port', '0', '--port', '1'], ['--data-dir', '/a\0b']]) assert.throws(() => parseStartOptions(args));
});

test('empty initialization and reopening preserve schema and committed data with private permissions', t => {
  const f = area(t), first = f.open();
  assert.equal(first.db.pragma('application_id', { simple: true }), APPLICATION_ID);
  assert.equal(first.db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  assert.equal(first.db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(first.db.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(first.db.pragma('synchronous', { simple: true }), 2);
  const ledger = first.db.prepare('SELECT * FROM schema_migrations').all();
  assert.equal(ledger.length, SCHEMA_VERSION);
  first.db.exec('CREATE TABLE public_probe (body TEXT NOT NULL) STRICT');
  first.db.prepare('INSERT INTO public_probe VALUES (?)').run('PUBLIC_RESTART_SENTINEL');
  for (const name of fs.readdirSync(first.directory)) {
    assert.equal(fs.statSync(path.join(first.directory, name)).mode & 0o777, 0o600);
  }
  assert.equal(fs.statSync(first.directory).mode & 0o777, 0o700);
  first.close(); first.close();
  const second = f.open();
  assert.deepEqual(second.db.prepare('SELECT * FROM schema_migrations').all(), ledger);
  assert.equal(second.db.prepare('SELECT body FROM public_probe').get().body, 'PUBLIC_RESTART_SENTINEL');
  second.close();
  assert.deepEqual(fs.readdirSync(second.directory).sort(), ['.notetrail-data', '.notetrail-lock', 'state.sqlite']);
});

test('a failed migration rolls back its schema, data, version and ledger together', t => {
  const { db } = area(t).open();
  const broken = { version: SCHEMA_VERSION + 1, name: 'synthetic_failure', sql: `
    CREATE TABLE partial_change (id INTEGER PRIMARY KEY);
    INSERT INTO partial_change VALUES (1);
    INSERT INTO partial_change VALUES (1);` };
  assert.throws(() => migrateDatabase(db, [...MIGRATIONS, broken]), { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' });
  assert.equal(db.inTransaction, false);
  assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n, SCHEMA_VERSION);
  assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name='partial_change'").get(), undefined);
  migrateDatabase(db);
});

test('completed migration is not replayed and newer schemas are refused without overwriting data', t => {
  const f = area(t), store = f.open();
  const migrations = [...MIGRATIONS, { version: SCHEMA_VERSION + 1, name: 'synthetic_upgrade',
    sql: 'CREATE TABLE upgraded (body TEXT); INSERT INTO upgraded VALUES (\'PUBLIC_UPGRADE\');' }];
  migrateDatabase(store.db, migrations);
  migrateDatabase(store.db, migrations);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM upgraded').get().n, 1);
  store.close();
  const file = path.join(store.directory, 'state.sqlite'), before = hash(file);
  assert.throws(() => f.open(), { code: 'DATABASE_TOO_NEW' });
  assert.equal(hash(file), before);
});

test('changed migration history and invalid version sequences fail without resetting the database', t => {
  const f = area(t), store = f.open();
  assert.throws(() => migrateDatabase(store.db, [{ ...MIGRATIONS[0], version: 2 }]), { code: 'DATABASE_INVALID' });
  store.db.prepare('UPDATE schema_migrations SET checksum = ?').run('PUBLIC_TAMPERED_HASH');
  store.close();
  const file = path.join(store.directory, 'state.sqlite'), before = hash(file);
  assert.throws(() => f.open(), { code: 'DATABASE_INVALID' });
  assert.equal(hash(file), before);
});

test('unknown directories, repository paths and vault paths are not claimed or modified', t => {
  const f = area(t), unknown = path.join(f.directory, 'unknown');
  fs.mkdirSync(unknown);
  const sentinel = path.join(unknown, 'keep.txt'); fs.writeFileSync(sentinel, 'PUBLIC_KEEP');
  const mode = fs.statSync(unknown).mode;
  assert.throws(() => openStorage(unknown), { code: 'DATA_DIRECTORY_UNRECOGNIZED' });
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'PUBLIC_KEEP');
  assert.equal(fs.statSync(unknown).mode, mode);
  assert.deepEqual(fs.readdirSync(unknown), ['keep.txt']);
  for (const marker of ['.git', '.obsidian']) {
    const parent = path.join(f.directory, marker.slice(1)); fs.mkdirSync(parent);
    fs.mkdirSync(path.join(parent, marker));
    assert.throws(() => openStorage(path.join(parent, 'nested/state')), { code: 'DATA_DIRECTORY_INVALID' });
    assert.deepEqual(fs.readdirSync(parent), [marker]);
  }
  // A source archive has no checkout metadata. Its temporary Git fixture tests the same restriction.
  const checkout = fs.existsSync(path.join(root, '.git')) ? root : path.join(f.directory, 'git');
  const target = path.join(checkout, 'outputs/do-not-create-state');
  assert.throws(() => openStorage(target), { code: 'DATA_DIRECTORY_INVALID' });
  assert(!fs.existsSync(target));
});

test('data directory aliases and symlink ancestors cannot redirect initialization', t => {
  const f = area(t), destination = path.join(f.directory, 'destination'), alias = path.join(f.directory, 'alias');
  fs.mkdirSync(destination, { mode: 0o700 }); fs.symlinkSync(destination, alias);
  for (const target of [alias, path.join(alias, 'new-state')]) {
    assert.throws(() => openStorage(target), { code: 'DATA_DIRECTORY_INVALID' });
  }
  assert.deepEqual(fs.readdirSync(destination), []);
});

test('database, marker and SQLite sidecars reject symlinks and hardlinks before opening', t => {
  const f = area(t), outside = path.join(f.directory, 'outside');
  fs.writeFileSync(outside, 'PUBLIC_OUTSIDE_SENTINEL', { mode: 0o600 });
  let i = 0;
  for (const name of ['.notetrail-data', '.notetrail-lock', '.notetrail-lock-journal', 'state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm', 'state.sqlite-journal']) {
    for (const link of ['symbolic', 'hard']) {
      const store = f.open(`data-${i++}`); store.close();
      const target = path.join(store.directory, name);
      if (fs.existsSync(target)) fs.unlinkSync(target);
      if (link === 'symbolic') fs.symlinkSync(outside, target); else fs.linkSync(outside, target);
      assert.throws(() => openStorage(store.directory), { code: 'DATA_DIRECTORY_INVALID' });
      assert.equal(fs.readFileSync(outside, 'utf8'), 'PUBLIC_OUTSIDE_SENTINEL');
      fs.unlinkSync(target);
    }
  }
});

test('owned directories and files with public access fail without silently changing permissions', t => {
  const f = area(t);
  for (const name of ['', '.notetrail-data', 'state.sqlite']) {
    const store = f.open(`permissions-${name || 'root'}`); store.close();
    const target = path.join(store.directory, name), mode = name ? 0o644 : 0o755;
    fs.chmodSync(target, mode);
    assert.throws(() => openStorage(store.directory), { code: 'DATA_DIRECTORY_INVALID' });
    assert.equal(fs.statSync(target).mode & 0o777, mode);
  }
});

test('missing, corrupt, and unrelated databases are preserved and never silently replaced', t => {
  const f = area(t);
  for (const scenario of ['missing', 'empty', 'corrupt', 'unrelated']) {
    const store = f.open(scenario); store.close();
    const file = path.join(store.directory, 'state.sqlite'); fs.unlinkSync(file);
    if (scenario === 'empty') fs.writeFileSync(file, '', { mode: 0o600 });
    if (scenario === 'corrupt') fs.writeFileSync(file, 'PUBLIC_CORRUPT_DATABASE', { mode: 0o600 });
    if (scenario === 'unrelated') {
      fs.closeSync(fs.openSync(file, 'wx', 0o600));
      const other = new Database(file); other.exec('CREATE TABLE unrelated (value TEXT)'); other.close();
    }
    const before = fs.existsSync(file) ? hash(file) : null;
    assert.throws(() => openStorage(store.directory), { code: 'DATABASE_INVALID' });
    assert.equal(fs.existsSync(file) ? hash(file) : null, before);
  }
});

test('a concurrent write lock fails clearly and initialization resumes after the lock is released', t => {
  const f = area(t), store = f.open();
  store.db.exec('BEGIN IMMEDIATE');
  try { assert.throws(() => openStorage(store.directory), { code: 'DATABASE_BUSY' }); }
  finally { store.db.exec('ROLLBACK'); }
  store.close();
  const reopened = f.open();
  assert.equal(reopened.db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
});

test('one owner holds the data directory even between writes; a second owner cannot run recovery', t => {
  const f = area(t), first = f.open();
  let unexpected;
  try { assert.throws(() => { unexpected = openStorage(first.directory); }, { code: 'DATABASE_BUSY' }); }
  finally { unexpected?.close(); }
  first.db.prepare('UPDATE model_settings SET revision=2').run();
  first.close();
  assert.equal(f.open().db.prepare('SELECT revision FROM model_settings').get().revision, 2);
});

test('a process killed during migration leaves the old committed schema readable on restart', t => {
  const f = area(t), store = f.open(); store.close();
  const module = pathToFileURL(path.join(root, 'dist/server/storage.js')).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { openStorage, migrateDatabase, MIGRATIONS } from ${JSON.stringify(module)};
    const store = openStorage(process.argv[1]);
    store.db.function('interrupt_test_process', () => process.kill(process.pid, 'SIGKILL'));
    migrateDatabase(store.db, [...MIGRATIONS, { version: ${SCHEMA_VERSION + 1}, name: 'interrupted_synthetic',
      sql: 'CREATE TABLE interrupted (value TEXT); SELECT interrupt_test_process();' }]);
  `, store.directory], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(child.signal, 'SIGKILL');
  const reopened = f.open();
  assert.equal(reopened.db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  assert.equal(reopened.db.prepare("SELECT name FROM sqlite_schema WHERE name='interrupted'").get(), undefined);
  assert.equal(reopened.db.pragma('quick_check', { simple: true }), 'ok');
});

test('real application startup initializes state, restarts with it, and hides local paths in failures', async t => {
  const f = area(t), directory = path.join(f.directory, 'application-state');
  const launch = () => launchBackend(['--data-dir', directory, '--port', '0'], { env });
  for (let round = 0; round < 2; round++) {
    const backend = launch(), { child, exited } = backend;
    try {
      const { type, origin, bootstrapToken } = await startupMessage(backend);
      assert.equal(type, 'ready');
      const response = await fetch(origin + '/api/v1/health');
      assert.equal(response.status, 200); await response.text();
      child.kill('SIGTERM'); assert.deepEqual(await exited, [0, null]);
      assert(!backend.logs().includes(directory) && !backend.logs().includes(bootstrapToken));
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    }
    const db = new Database(path.join(directory, 'state.sqlite'));
    try {
      if (round === 0) db.exec("CREATE TABLE restart_probe (value TEXT); INSERT INTO restart_probe VALUES ('PUBLIC_PERSISTED');");
      else assert.equal(db.prepare('SELECT value FROM restart_probe').get().value, 'PUBLIC_PERSISTED');
    } finally { db.close(); }
  }
  const state = path.join(directory, 'state.sqlite'); fs.writeFileSync(state, 'PUBLIC_BROKEN');
  const before = hash(state);
  const failed = launch();
  t.after(() => { if (failed.child.exitCode === null) failed.child.kill('SIGKILL'); });
  assert.deepEqual(await startupMessage(failed), { type: 'failed', code: 'DATABASE_INVALID' });
  assert.deepEqual(await failed.exited, [1, null]);
  assert(!failed.logs().includes(directory) && !failed.logs().includes('PUBLIC_BROKEN'));
  assert.equal(hash(state), before);
});
