import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import Database from 'better-sqlite3';
import { openStorage, openMaintenanceStorage, MIGRATIONS } from '../dist/server/storage.js';
import { backupData, restoreData, diagnoseData } from '../dist/server/maintenance.js';
import { RunService } from '../dist/server/runs.js';
import { ModelLedger } from '../dist/server/model-ledger.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-maintenance-')));
  const data = path.join(directory, 'data'), backup = path.join(directory, 'backup'), restored = path.join(directory, 'restored');
  const store = openStorage(data), db = store.db, vault = `v_${randomUUID()}`, run = `r_${randomUUID()}`, session = `c_${randomUUID()}`;
  const now = new Date().toISOString(), vaultPath = path.join(directory, 'vault'); fs.mkdirSync(vaultPath);
  fs.writeFileSync(path.join(vaultPath, 'untouched.md'), 'PUBLIC_VAULT_ONLY');
  db.prepare('INSERT INTO vaults(id,singleton,root_path,root_device,root_inode,exclusions_json) VALUES (?,1,?,?,?,?)').run(vault, vaultPath, '1', '1', '[]');
  db.prepare('INSERT INTO conversations(id,vault_id,title,created_at,updated_at) VALUES (?,?,?,?,?)').run(session, vault, 'PRIVATE_TITLE_SENTINEL', now, now);
  db.prepare("INSERT INTO runs(id,kind,vault_id,state,created_at,started_at,session_id) VALUES (?,'message',?,'running',?,?,?)").run(run, vault, now, now, session);
  db.exec("UPDATE model_settings SET revision=3,provider='deepseek',model='deepseek-flash',base_url='https://private-config.example',credential_id='PRIVATE_CREDENTIAL_REFERENCE'; INSERT INTO retired_credentials VALUES ('OLD_KEY_REFERENCE','PRIVATE_SERVICE');");
  db.exec(`INSERT INTO model_profiles(id,name,provider,model,base_url,credential_id,connection) VALUES
    ('mp_default','Saved DeepSeek','deepseek','deepseek-flash','https://api.deepseek.com','PRIVATE_CREDENTIAL_REFERENCE','passed'),
    ('mp_00000000-0000-4000-8000-000000000001','Saved compatible','openai-compatible','public-chat','https://public.example/v1','OTHER_CREDENTIAL_REFERENCE','passed');
    UPDATE model_settings SET active_profile_id='mp_default';`);
  const segment = `seg_${randomUUID()}`, relative = `workers/${run}-1/sessions/test.jsonl`;
  const bytes = Buffer.from('{"type":"session","id":"PUBLIC_SESSION"}\n{"type":"message","message":{"role":"user","content":"PRIVATE_CHAT_SENTINEL"}}\n');
  fs.mkdirSync(path.dirname(path.join(data, relative)), { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(data, relative), bytes, { mode: 0o600 });
  db.prepare('INSERT INTO session_segments(id,session_id,generation,settings_json,catalog_hash,session_file,session_hash,created_at) VALUES (?,?,1,?,?,?,?,?)').run(segment, session, '{}', 'public-catalog', relative, sha(bytes), now);
  db.prepare('UPDATE conversations SET active_segment_id=?').run(segment);
  const source = `s_${randomUUID()}`, operation = `op_${randomUUID()}`, staged = Buffer.from('PUBLIC_UNPUBLISHED_ORIGINAL');
  db.prepare("INSERT INTO sources(id,vault_id,relative_path,media_type,state,original_saved,warnings_json,updated_at) VALUES (?,?,'pending.md','text/markdown','pending',0,'[]',?)").run(source, vault, now);
  db.prepare("INSERT INTO ingest_operations(id,source_id,vault_id,vault_revision,filename,version,bytes,phase) VALUES (?,?,?,1,'pending.md',?,?,'prepared')").run(operation, source, vault, sha(staged), staged.length);
  fs.mkdirSync(path.join(data, 'staging'), { mode: 0o700 });
  fs.writeFileSync(path.join(data, 'staging/.notetrail-staging'), 'NoteTrail staging v1\n', { mode: 0o600 });
  fs.writeFileSync(path.join(data, `staging/${operation}.bin`), staged, { mode: 0o600 });
  fs.writeFileSync(path.join(data, 'private-config.json'), 'PRIVATE_KEY_SENTINEL', { mode: 0o600 });
  const ledger = new ModelLedger(db); ledger.batch('synthetic'); ledger.start(run, 'synthetic');
  const attempt = ledger.reserve(run); ledger.sent(attempt.id, 500, 'a'.repeat(64));
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, data, backup, restored, store, vaultPath, relative, bytes, operation, staged, run };
}
function makeBackup(f) { f.store.close(); return backupData(f.data, f.backup); }

test('offline snapshot restores WAL data, session hashes, staging, unknown charges and a single interrupted task', async t => {
  const f = fixture(t);
  assert.throws(() => backupData(f.data, f.backup), { code: 'DATABASE_BUSY' }); assert(!fs.existsSync(f.backup));
  const started = performance.now(), result = makeBackup(f); assert.equal(result.files, 5);
  assert(!fs.existsSync(path.join(f.backup, 'data/private-config.json')));
  assert.equal(restoreData(f.backup, f.restored).credentialReentryRequired, true);
  const storage = openStorage(f.restored), db = storage.db;
  try {
    assert.deepEqual(fs.readFileSync(path.join(f.restored, f.relative)), f.bytes);
    assert.deepEqual(fs.readFileSync(path.join(f.restored, `staging/${f.operation}.bin`)), f.staged);
    assert.equal(db.prepare('SELECT credential_id FROM model_settings').get().credential_id, null);
    assert.deepEqual(db.prepare('SELECT name,credential_id,connection FROM model_profiles ORDER BY name').all(), [
      { name: 'Saved DeepSeek', credential_id: null, connection: 'untested' },
      { name: 'Saved compatible', credential_id: null, connection: 'untested' },
    ]);
    assert.equal(db.prepare('SELECT active_profile_id FROM model_settings').get().active_profile_id, 'mp_default');
    assert.equal(db.prepare('SELECT count(*) AS n FROM retired_credentials').get().n, 0);
    const ledger = new ModelLedger(db); ledger.recover();
    assert(ledger.batchTotals('synthetic').reservedMicroYuan > 0);
    assert.equal(ledger.totals(f.run).modelRequests, 1);
    const runs = new RunService(db, {}); assert.equal(runs.get(f.run).state, 'interrupted');
    assert.equal(runs.events(f.run, 0).items.filter(e => e.type === 'run.completed').length, 1); await runs.close();
    assert.deepEqual(fs.readdirSync(f.vaultPath), ['untouched.md']);
    for (const file of JSON.parse(fs.readFileSync(path.join(f.backup, 'manifest.json'))).files) {
      assert.equal(fs.statSync(path.join(f.restored, file.path)).mode & 0o777, 0o600);
    }
  } finally { storage.close(); }
  t.diagnostic(`Synthetic backup + restore + recovery: ${Math.round(performance.now() - started)} ms`);
});

test('maintenance refuses missing/old/live data without initializing or migrating it', t => {
  const f = fixture(t);
  assert.throws(() => diagnoseData(f.data), { code: 'DATABASE_BUSY' });
  assert.throws(() => openMaintenanceStorage(path.join(f.directory, 'missing')), { code: 'DATA_DIRECTORY_UNRECOGNIZED' });
  assert(!fs.existsSync(path.join(f.directory, 'missing')));
  const old = path.join(f.directory, 'old'); openStorage(old, MIGRATIONS.slice(0, 1)).close();
  const before = sha(fs.readFileSync(path.join(old, 'state.sqlite')));
  assert.throws(() => backupData(old, f.backup), { code: 'DATABASE_INVALID' });
  assert.equal(sha(fs.readFileSync(path.join(old, 'state.sqlite'))), before); assert(!fs.existsSync(f.backup));
});

test('corrupt or missing committed sessions cannot become a valid backup, and originals are retained', t => {
  for (const kind of ['changed', 'missing', 'invalid-json']) {
    const f = fixture(t); f.store.close(); const file = path.join(f.data, f.relative);
    if (kind === 'missing') fs.unlinkSync(file);
    else {
      const content = Buffer.from('PUBLIC_CORRUPT_SESSION'); fs.writeFileSync(file, content);
      if (kind === 'invalid-json') { const db = new Database(path.join(f.data, 'state.sqlite')); db.prepare('UPDATE session_segments SET session_hash=?').run(sha(content)); db.close(); }
    }
    assert.throws(() => backupData(f.data, f.backup));
    assert(!fs.existsSync(path.join(f.backup, 'manifest.json')));
    if (kind !== 'missing') assert.equal(fs.readFileSync(file, 'utf8'), 'PUBLIC_CORRUPT_SESSION');
    assert.throws(() => restoreData(f.backup, f.restored)); assert(!fs.existsSync(f.restored));
  }
});

test('damaged snapshots, unlisted SQLite journals, linked files and path traversal fail before restore writes', t => {
  for (const kind of ['database', 'session', 'staging', 'sidecar', 'symlink', 'hardlink', 'traversal', 'duplicate', 'omitted']) {
    const f = fixture(t); makeBackup(f); const payload = path.join(f.backup, 'data'), manifestFile = path.join(f.backup, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile));
    if (kind === 'database') fs.appendFileSync(path.join(payload, 'state.sqlite'), 'damage');
    else if (kind === 'session') fs.appendFileSync(path.join(payload, f.relative), 'damage');
    else if (kind === 'staging') fs.unlinkSync(path.join(payload, `staging/${f.operation}.bin`));
    else if (kind === 'sidecar') fs.writeFileSync(path.join(payload, 'state.sqlite-wal'), '', { mode: 0o600 });
    else if (kind === 'symlink' || kind === 'hardlink') {
      fs.unlinkSync(path.join(payload, f.relative));
      fs[kind === 'symlink' ? 'symlinkSync' : 'linkSync'](path.join(f.data, f.relative), path.join(payload, f.relative));
    } else {
      if (kind === 'traversal') manifest.files[0].path = '../../escape';
      else if (kind === 'duplicate') manifest.files.push(manifest.files[0]);
      else manifest.files = manifest.files.filter(file => file.path !== f.relative);
      fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    }
    assert.throws(() => restoreData(f.backup, f.restored), kind); assert(!fs.existsSync(f.restored));
    assert.deepEqual(fs.readFileSync(path.join(f.data, f.relative)), f.bytes);
  }
});

test('destinations never overwrite data or write backups into a vault or data directory', t => {
  const f = fixture(t); makeBackup(f);
  for (const target of [f.data, f.restored, path.join(f.vaultPath, 'nested')]) {
    if (target === f.restored) fs.mkdirSync(target);
    assert.throws(() => restoreData(f.backup, target), { code: 'DESTINATION_INVALID' });
  }
  assert.throws(() => backupData(f.data, path.join(f.data, 'nested')), { code: 'DESTINATION_INVALID' });
  assert.throws(() => backupData(f.data, path.join(f.vaultPath, 'nested')), { code: 'DESTINATION_INVALID' });
  assert(!fs.existsSync(path.join(f.vaultPath, 'nested')));
});

test('diagnostics use a fixed whitelist, exclude private values and CLI failures never echo paths', t => {
  const f = fixture(t); f.store.close();
  const report = diagnoseData(f.data), text = JSON.stringify(report);
  assert.equal(report.runs.running, 1); assert.equal(report.unresolvedModelAttempts, 1); assert.equal(report.pendingStaging, 1);
  for (const forbidden of ['PRIVATE_', f.directory, f.run, f.relative, 'deepseek', 'private-config']) assert(!text.includes(forbidden));
  const command = (...args) => spawnSync(process.execPath, ['scripts/maintenance.mjs', ...args], { encoding: 'utf8', timeout: 5000 });
  const diagnosed = command('diagnose', '--data-dir', f.data); assert.equal(diagnosed.status, 0); assert.deepEqual(JSON.parse(diagnosed.stdout), { ok: true, command: 'diagnose', ...report });
  const backed = command('backup', '--data-dir', f.data, '--to', f.backup); assert.equal(backed.status, 0, backed.stderr);
  assert.equal(command('restore', '--from', f.backup, '--data-dir', f.restored).status, 0);
  const invalid = command('diagnose', '--data-dir', path.join(f.directory, 'PRIVATE_MISSING_PATH'));
  assert.equal(invalid.status, 1); assert(!invalid.stderr.includes(f.directory)); assert(!invalid.stderr.includes('PRIVATE_MISSING_PATH'));
  assert.equal(command('backup', '--data-dir', f.data, '--data-dir', f.backup).status, 1);
});

test('consistent backup and restore across actual filesystem devices', { skip: !process.env.NOTETRAIL_TEST_VOLUME }, t => {
  const f = fixture(t), external = fs.mkdtempSync(path.join(fs.realpathSync(process.env.NOTETRAIL_TEST_VOLUME), 'backup-'));
  t.after(() => fs.rmSync(external, { recursive: true, force: true }));
  assert.notEqual(fs.statSync(external).dev, fs.statSync(f.data).dev);
  f.backup = path.join(external, 'snapshot'); makeBackup(f); restoreData(f.backup, f.restored);
  assert.deepEqual(fs.readFileSync(path.join(f.restored, f.relative)), f.bytes);
  assert.deepEqual(fs.readFileSync(path.join(f.restored, `staging/${f.operation}.bin`)), f.staged);
});
