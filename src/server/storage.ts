import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';

type SqlValue = string | number | bigint | Buffer | null;
interface Statement {
  get(...parameters: SqlValue[]): unknown;
  all(...parameters: SqlValue[]): unknown[];
  run(...parameters: SqlValue[]): { changes: number; lastInsertRowid: number | bigint };
}
// The pinned package has no bundled TypeScript types; describe only the API used here.
export interface SqliteDatabase {
  prepare(sql: string): Statement;
  exec(sql: string): this;
  pragma(sql: string, options?: { simple: boolean }): unknown;
  readonly inTransaction: boolean;
  close(): void;
}
const Database = createRequire(import.meta.url)('better-sqlite3') as {
  new(file: string, options: { fileMustExist: boolean; timeout: number; readonly?: boolean }): SqliteDatabase;
};

export const APPLICATION_ID = 0x4e54524c;
const MARKER = '.notetrail-data';
const MARKER_CONTENT = 'NoteTrail application data v1\n';
type StorageFailure = 'DATA_DIRECTORY_INVALID' | 'DATA_DIRECTORY_UNRECOGNIZED' |
  'DATABASE_INVALID' | 'DATABASE_TOO_NEW' | 'DATABASE_BUSY';
export class StorageError extends Error {
  constructor(readonly code: StorageFailure) { super(code); }
}

export function defaultDataDirectory(home = os.homedir()): string {
  return path.join(home, 'Library', 'Application Support', 'NoteTrail');
}

function statIfPresent(file: string) {
  try { return fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function privateFile(file: string): void {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 || (stat.mode & 0o600) !== 0o600) {
    throw new StorageError('DATA_DIRECTORY_INVALID');
  }
}

function prepareDirectory(input: string): { directory: string; created: boolean } {
  if (!path.isAbsolute(input) || input.includes('\0')) throw new StorageError('DATA_DIRECTORY_INVALID');
  const directory = path.normalize(input).replace(/\/$/, '');
  if (!directory) throw new StorageError('DATA_DIRECTORY_INVALID');
  // Do not put state in any Git checkout or Obsidian vault, including via aliases.
  for (let current = directory; ; current = path.dirname(current)) {
    const stat = statIfPresent(current);
    if (stat && (!stat.isDirectory() || fs.realpathSync(current) !== current)) {
      throw new StorageError('DATA_DIRECTORY_INVALID');
    }
    if (statIfPresent(path.join(current, '.git')) || statIfPresent(path.join(current, '.obsidian'))) {
      throw new StorageError('DATA_DIRECTORY_INVALID');
    }
    if (path.dirname(current) === current) break;
  }
  const marker = path.join(directory, MARKER);
  const existing = statIfPresent(directory);
  if (existing && existing.uid !== process.getuid?.()) throw new StorageError('DATA_DIRECTORY_INVALID');
  if (statIfPresent(marker)) {
    if (!existing || (existing.mode & 0o777) !== 0o700) throw new StorageError('DATA_DIRECTORY_INVALID');
    privateFile(marker);
    const fd = fs.openSync(marker, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (fs.fstatSync(fd).size !== Buffer.byteLength(MARKER_CONTENT) || fs.readFileSync(fd, 'utf8') !== MARKER_CONTENT) {
        throw new StorageError('DATA_DIRECTORY_UNRECOGNIZED');
      }
    } finally { fs.closeSync(fd); }
    return { directory, created: false };
  }
  if (existing && fs.readdirSync(directory).length !== 0) throw new StorageError('DATA_DIRECTORY_UNRECOGNIZED');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  fs.writeFileSync(marker, MARKER_CONTENT, { flag: 'wx', mode: 0o600 });
  return { directory, created: true };
}

export interface Migration { version: number; name: string; sql: string }
export const MIGRATIONS: readonly Migration[] = Object.freeze([
  Object.freeze({ version: 1, name: 'initial_storage', sql: `
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  ` }),
  Object.freeze({ version: 2, name: 'model_configuration', sql: `
    CREATE TABLE model_settings (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
      provider TEXT, model TEXT, base_url TEXT, credential_id TEXT,
      CHECK ((provider IS NULL AND model IS NULL AND base_url IS NULL AND credential_id IS NULL)
        OR (provider IS NOT NULL AND model IS NOT NULL AND base_url IS NOT NULL))
    ) STRICT;
    INSERT INTO model_settings(singleton, revision) VALUES (1, 1);
    CREATE TABLE retired_credentials (
      account TEXT PRIMARY KEY, service TEXT NOT NULL
    ) STRICT;
  ` }),
  Object.freeze({ version: 3, name: 'vault_sources', sql: `
    CREATE TABLE vaults (
      id TEXT PRIMARY KEY, singleton INTEGER NOT NULL UNIQUE CHECK (singleton=1),
      root_path TEXT NOT NULL, root_device TEXT NOT NULL, root_inode TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision>0), exclusions_json TEXT NOT NULL,
      scan_generation INTEGER NOT NULL DEFAULT 0, scan_state TEXT NOT NULL DEFAULT 'pending'
        CHECK (scan_state IN ('pending','scanning','ready','failed')),
      scanned_at TEXT, scan_error_code TEXT, skipped_count INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE sources (
      id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id),
      relative_path TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'existing_file',
      media_type TEXT NOT NULL, version TEXT, state TEXT NOT NULL
        CHECK (state IN ('pending','processing','ready','partial','failed','unsupported','stale','missing','excluded','needs_review')),
      original_saved INTEGER NOT NULL CHECK (original_saved IN (0,1)),
      source_url TEXT, captured_at TEXT, warnings_json TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(vault_id, relative_path)
    ) STRICT;
    CREATE TABLE representations (
      source_id TEXT PRIMARY KEY REFERENCES sources(id), source_version TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('original_text','extracted_markdown')),
      hash TEXT NOT NULL, relative_path TEXT NOT NULL, extractor_version TEXT
    ) STRICT;
  ` }),
  Object.freeze({ version: 4, name: 'refresh_runs', sql: `
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, vault_id TEXT NOT NULL REFERENCES vaults(id),
      state TEXT NOT NULL CHECK (state IN ('queued','running','cancelling','succeeded','failed','cancelled','interrupted')),
      stage TEXT, created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT,
      result_json TEXT, error_json TEXT
    ) STRICT;
    CREATE TABLE idempotency_records (
      key TEXT PRIMARY KEY, operation TEXT NOT NULL, scope_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL, result_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE run_events (
      run_id TEXT NOT NULL REFERENCES runs(id), event_id INTEGER NOT NULL CHECK (event_id > 0),
      type TEXT NOT NULL, at TEXT NOT NULL, payload_json TEXT NOT NULL,
      PRIMARY KEY(run_id,event_id)
    ) STRICT;
  ` }),
  Object.freeze({ version: 5, name: 'ingest_originals', sql: `
    CREATE TABLE ingest_operations (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL UNIQUE REFERENCES sources(id),
      vault_id TEXT NOT NULL REFERENCES vaults(id), vault_revision INTEGER NOT NULL,
      filename TEXT NOT NULL, version TEXT NOT NULL, bytes INTEGER NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('prepared','published','registered')),
      staged INTEGER NOT NULL DEFAULT 1 CHECK (staged IN (0,1))
    ) STRICT;
    ALTER TABLE runs ADD COLUMN operation_id TEXT REFERENCES ingest_operations(id);
  ` }),
  Object.freeze({ version: 6, name: 'source_retry_context', sql: `
    ALTER TABLE runs ADD COLUMN source_id TEXT REFERENCES sources(id);
    ALTER TABLE runs ADD COLUMN expected_source_version TEXT;
    ALTER TABLE runs ADD COLUMN scope_revision INTEGER;
  ` }),
  Object.freeze({ version: 7, name: 'web_intake_requests', sql: `
    CREATE TABLE web_inputs (
      source_id TEXT PRIMARY KEY REFERENCES sources(id), requested_url TEXT NOT NULL
    ) STRICT;
  ` }),
  Object.freeze({ version: 8, name: 'read_evidence', sql: `
    CREATE TABLE evidence (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
      source_id TEXT NOT NULL REFERENCES sources(id), source_version TEXT NOT NULL,
      representation_hash TEXT NOT NULL, body_json TEXT NOT NULL CHECK (json_valid(body_json))
    ) STRICT;
    CREATE INDEX evidence_run ON evidence(run_id);
  ` }),
  Object.freeze({ version: 9, name: 'model_accounting', sql: `
    CREATE TABLE tool_usage (
      run_id TEXT PRIMARY KEY REFERENCES runs(id), tool_calls INTEGER NOT NULL DEFAULT 0 CHECK (tool_calls>=0),
      read_bytes INTEGER NOT NULL DEFAULT 0 CHECK (read_bytes>=0)
    ) STRICT;
    CREATE TABLE model_batches (
      id TEXT PRIMARY KEY, baseline_micro_yuan INTEGER NOT NULL CHECK (baseline_micro_yuan>=0),
      spent_micro_yuan INTEGER NOT NULL CHECK (spent_micro_yuan>=0),
      paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0,1))
    ) STRICT;
    CREATE TABLE model_runs (
      run_id TEXT PRIMARY KEY REFERENCES runs(id), batch_id TEXT NOT NULL REFERENCES model_batches(id),
      deadline INTEGER NOT NULL, limits_json TEXT NOT NULL CHECK (json_valid(limits_json)),
      retries INTEGER NOT NULL DEFAULT 0 CHECK (retries>=0)
    ) STRICT;
    CREATE TABLE model_attempts (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES model_runs(run_id), ordinal INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('reserved','sent','settled','not_sent','unknown')),
      input_reserved INTEGER NOT NULL, output_limit INTEGER NOT NULL, reserved_micro_yuan INTEGER NOT NULL,
      input_tokens INTEGER, output_tokens INTEGER, cost_micro_yuan INTEGER,
      payload_bytes INTEGER, payload_hash TEXT, returned_model TEXT, failure_code TEXT,
      created_at TEXT NOT NULL, ended_at TEXT, UNIQUE(run_id,ordinal)
    ) STRICT;
    CREATE INDEX model_attempts_run ON model_attempts(run_id);
  ` }),
  Object.freeze({ version: 10, name: 'conversations_and_answers', sql: `
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id), title TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, active_segment_id TEXT,
      context_generation INTEGER NOT NULL DEFAULT 1 CHECK (context_generation>0)
    ) STRICT;
    ALTER TABLE runs ADD COLUMN session_id TEXT REFERENCES conversations(id);
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES conversations(id),
      run_id TEXT NOT NULL UNIQUE REFERENCES runs(id), ordinal INTEGER NOT NULL, text TEXT NOT NULL,
      input_json TEXT NOT NULL CHECK (json_valid(input_json)), scope_revision INTEGER NOT NULL,
      model_revision INTEGER NOT NULL, context_generation INTEGER NOT NULL, created_at TEXT NOT NULL,
      segment_id TEXT, pi_entry_id TEXT, UNIQUE(session_id,ordinal)
    ) STRICT;
    CREATE TABLE session_segments (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES conversations(id), generation INTEGER NOT NULL,
      settings_json TEXT NOT NULL CHECK (json_valid(settings_json)), catalog_hash TEXT NOT NULL,
      session_file TEXT NOT NULL, session_hash TEXT NOT NULL, created_at TEXT NOT NULL, rebuild_reason TEXT
    ) STRICT;
    CREATE TABLE answers (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
      session_id TEXT NOT NULL REFERENCES conversations(id), body_json TEXT NOT NULL CHECK (json_valid(body_json))
    ) STRICT;
    CREATE TABLE context_sources (
      run_id TEXT NOT NULL REFERENCES runs(id), source_id TEXT NOT NULL REFERENCES sources(id),
      snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)), PRIMARY KEY(run_id,source_id)
    ) STRICT;
    CREATE TABLE tool_results (
      run_id TEXT NOT NULL REFERENCES runs(id), call_id TEXT NOT NULL,
      result_json TEXT NOT NULL CHECK (json_valid(result_json)), PRIMARY KEY(run_id,call_id)
    ) STRICT;
  ` }),
  Object.freeze({ version: 11, name: 'explicit_memories', sql: `
    CREATE TABLE memory_state (
      vault_id TEXT PRIMARY KEY REFERENCES vaults(id), generation INTEGER NOT NULL DEFAULT 1 CHECK (generation>0)
    ) STRICT;
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id), text TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('preference','focus','user_note')),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      source_user_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL, deleted_at TEXT,
      CHECK ((deleted_at IS NULL AND length(text)>0) OR (deleted_at IS NOT NULL AND text=''))
    ) STRICT;
    ALTER TABLE messages ADD COLUMN memory_generation INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE runs ADD COLUMN resolved_action TEXT;
  ` }),
  Object.freeze({ version: 12, name: 'recoverable_history_deletion', sql: `
    ALTER TABLE conversations ADD COLUMN deletion_state TEXT CHECK (deletion_state IN ('deleting','deleted'));
  ` }),
  Object.freeze({ version: 13, name: 'explicit_model_probes', sql: `
    CREATE TABLE model_probes (
      run_id TEXT PRIMARY KEY REFERENCES runs(id), model_revision INTEGER NOT NULL CHECK (model_revision>0)
    ) STRICT;
  ` }),
  Object.freeze({ version: 14, name: 'saved_model_profiles', sql: `
    CREATE TABLE model_profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
      base_url TEXT NOT NULL, credential_id TEXT, pricing_json TEXT, model_ids_json TEXT NOT NULL DEFAULT '[]',
      connection TEXT NOT NULL DEFAULT 'untested' CHECK (connection IN ('untested','passed','failed'))
    ) STRICT;
    ALTER TABLE model_settings ADD COLUMN active_profile_id TEXT REFERENCES model_profiles(id);
    INSERT INTO model_profiles(id,name,provider,model,base_url,credential_id,pricing_json,model_ids_json)
      SELECT 'mp_default','现有模型',provider,model,base_url,credential_id,
        CASE WHEN provider='deepseek' AND model='deepseek-flash' AND base_url='https://api.deepseek.com'
          THEN '{"input":2,"output":8}' ELSE NULL END, json_array(model)
      FROM model_settings WHERE provider IS NOT NULL;
    UPDATE model_settings SET active_profile_id='mp_default' WHERE provider IS NOT NULL;
    ALTER TABLE model_attempts ADD COLUMN input_rate REAL NOT NULL DEFAULT 2;
    ALTER TABLE model_attempts ADD COLUMN output_rate REAL NOT NULL DEFAULT 8;
    ALTER TABLE model_attempts ADD COLUMN model_config_json TEXT;
    ALTER TABLE runs ADD COLUMN preview_text TEXT;
  ` }),
  Object.freeze({ version: 15, name: 'web_search_charges', sql: `
    CREATE TABLE search_attempts (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES model_runs(run_id),
      state TEXT NOT NULL CHECK (state IN ('reserved','sent','settled','not_sent','unknown')),
      reserved_micro_yuan INTEGER NOT NULL CHECK (reserved_micro_yuan>=0),
      cost_micro_yuan INTEGER, created_at TEXT NOT NULL, ended_at TEXT
    ) STRICT;
    CREATE INDEX search_attempts_run ON search_attempts(run_id);
  ` }),
  Object.freeze({ version: 16, name: 'reviewable_usage_budget', sql: `
    CREATE TABLE budget_settings (
      batch_id TEXT PRIMARY KEY REFERENCES model_batches(id), revision INTEGER NOT NULL DEFAULT 1,
      question_micro_yuan INTEGER NOT NULL DEFAULT 500000,
      pause_micro_yuan INTEGER NOT NULL DEFAULT 8000000,
      total_micro_yuan INTEGER NOT NULL DEFAULT 10000000
    ) STRICT;
    ALTER TABLE model_attempts ADD COLUMN reservation_reviewed INTEGER NOT NULL DEFAULT 0;
  ` }),
  Object.freeze({ version: 17, name: 'watched_answer_versions', sql: `
    CREATE TABLE answer_watches (
      id TEXT PRIMARY KEY, root_answer_id TEXT NOT NULL UNIQUE REFERENCES answers(id),
      session_id TEXT NOT NULL REFERENCES conversations(id), vault_id TEXT NOT NULL REFERENCES vaults(id),
      question TEXT NOT NULL, scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
      revision INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      latest_answer_id TEXT NOT NULL REFERENCES answers(id), checked_at TEXT,
      observed_hash TEXT, observed_at INTEGER, observation INTEGER NOT NULL DEFAULT 0, attempted_hash TEXT, checked_hash TEXT,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE answer_watch_runs (
      run_id TEXT PRIMARY KEY REFERENCES runs(id), watch_id TEXT NOT NULL REFERENCES answer_watches(id),
      watch_revision INTEGER NOT NULL, catalog_hash TEXT NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
      previous_answer_id TEXT NOT NULL REFERENCES answers(id), answer_id TEXT REFERENCES answers(id),
      review_json TEXT CHECK(review_json IS NULL OR json_valid(review_json)), created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX answer_watch_runs_watch ON answer_watch_runs(watch_id,created_at);
  ` }),
  Object.freeze({ version: 18, name: 'answer_evidence_checks', sql: `
    -- New answer JSON stores evidence checks; older applications must not silently omit them when saving selections.
    SELECT 1;
  ` }),
  Object.freeze({version:19,name:'conversation_continuations',sql:`
    -- Continuations persist message references and coverage in answer JSON; old clients must not omit provenance.
    SELECT 1;
  `}),
  Object.freeze({version:20,name:'experience_comparisons',sql:`
    -- Older clients cannot safely save experience excerpts without their case conditions.
    SELECT 1;
  `}),
  Object.freeze({version:21,name:'outcome_retrospectives',sql:`
    -- Retrospectives preserve historical version references and the conditions behind saved lessons.
    SELECT 1;
  `}),
]);

function checksum(migration: Migration): string {
  return createHash('sha256').update(JSON.stringify(migration)).digest('hex');
}

export function migrationVersion(db: SqliteDatabase, migrations: readonly Migration[], initialize: boolean): number {
  if (migrations.length === 0 || migrations.some((m, i) => m.version !== i + 1)) {
    throw new StorageError('DATABASE_INVALID');
  }
  const application = db.pragma('application_id', { simple: true });
  const version = db.pragma('user_version', { simple: true });
  if (!Number.isSafeInteger(version) || (version as number) < 0) throw new StorageError('DATABASE_INVALID');
  if (application === APPLICATION_ID && (version as number) > migrations.length) throw new StorageError('DATABASE_TOO_NEW');
  if (version === 0) {
    if (!initialize || application !== 0 || db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all().length) {
      throw new StorageError('DATABASE_INVALID');
    }
  } else {
    if (application !== APPLICATION_ID) throw new StorageError('DATABASE_INVALID');
    const applied = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all() as
      { version: number; name: string; checksum: string }[];
    if (applied.length !== version || applied.some((row, i) => row.version !== i + 1 ||
        row.name !== migrations[i]?.name || row.checksum !== checksum(migrations[i]))) throw new StorageError('DATABASE_INVALID');
  }
  return version as number;
}

export function migrateDatabase(db: SqliteDatabase, migrations: readonly Migration[] = MIGRATIONS, initialize = false): void {
  if (db.inTransaction) throw new StorageError('DATABASE_INVALID');
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = migrationVersion(db, migrations, initialize);
    if (version === 0) db.pragma(`application_id = ${APPLICATION_ID}`);
    for (const migration of migrations.slice(version)) {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
        .run(migration.version, migration.name, checksum(migration), new Date().toISOString());
      db.pragma(`user_version = ${migration.version}`);
    }
    db.exec('COMMIT');
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function backupBeforeMigration(db: SqliteDatabase, directory: string, version: number): void {
  const folder = path.join(directory, 'backups');
  const stat = statIfPresent(folder);
  if (stat && (!stat.isDirectory() || stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o700 || fs.realpathSync(folder) !== folder)) throw new StorageError('DATA_DIRECTORY_INVALID');
  if (!stat) fs.mkdirSync(folder, { mode: 0o700 });
  const destination = path.join(folder, `schema-${version}-${randomUUID()}.sqlite`);
  const pending = `${destination}.pending`;
  fs.closeSync(fs.openSync(pending, 'wx', 0o600));
  // VACUUM INTO includes committed WAL content; never copy the live database file directly.
  db.prepare('VACUUM INTO ?').run(pending);
  const snapshot = new Database(pending, { readonly: true, fileMustExist: true, timeout: 1000 });
  try {
    if (snapshot.pragma('quick_check', { simple: true }) !== 'ok' ||
        snapshot.pragma('application_id', { simple: true }) !== APPLICATION_ID ||
        snapshot.pragma('user_version', { simple: true }) !== version) throw new StorageError('DATABASE_INVALID');
  } finally { snapshot.close(); }
  fs.linkSync(pending, destination); // Refuses an existing destination; publish only a verified snapshot.
  fs.unlinkSync(pending);
  const fd = fs.openSync(folder, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function openStorage(input: string, migrations: readonly Migration[] = MIGRATIONS) {
  return openState(input, migrations, true);
}

// Maintenance must never initialize or upgrade the source it is about to preserve.
export function openMaintenanceStorage(input: string) {
  return openState(input, MIGRATIONS, false);
}

function openState(input: string, migrations: readonly Migration[], upgrade: boolean) {
  let db: SqliteDatabase | undefined;
  let lock: SqliteDatabase | undefined;
  try {
    if (!upgrade && !statIfPresent(path.join(input, MARKER))) throw new StorageError('DATA_DIRECTORY_UNRECOGNIZED');
    const { directory, created } = prepareDirectory(input);
    const lockFile = path.join(directory, '.notetrail-lock');
    try { fs.closeSync(fs.openSync(lockFile, 'wx', 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    privateFile(lockFile);
    for (const suffix of ['-wal', '-shm', '-journal']) if (statIfPresent(`${lockFile}${suffix}`)) privateFile(`${lockFile}${suffix}`);
    lock = new Database(lockFile, { fileMustExist: true, timeout: 100 });
    // A separate SQLite transaction holds an OS lock for our lifetime, including across idle periods.
    // Do not unlink this file: replacing its inode would let another process bypass the lock.
    lock.exec('BEGIN EXCLUSIVE');
    const file = path.join(directory, 'state.sqlite');
    if (created) fs.closeSync(fs.openSync(file, 'wx', 0o600));
    // Missing state in an already-owned directory must not silently become an empty database.
    privateFile(file);
    for (const suffix of ['-wal', '-shm', '-journal']) if (statIfPresent(`${file}${suffix}`)) privateFile(`${file}${suffix}`);
    db = new Database(file, { fileMustExist: true, timeout: 1000 });
    if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new StorageError('DATABASE_INVALID');
    db.pragma('foreign_keys = ON');
    db.pragma('trusted_schema = OFF');
    db.pragma('synchronous = FULL');
    const version = migrationVersion(db, migrations, created);
    if (!upgrade && version !== migrations.length) throw new StorageError('DATABASE_INVALID');
    if (upgrade && version > 0 && version < migrations.length) backupBeforeMigration(db, directory, version);
    // Only a directory claimed by this call may initialize a blank file. A truncated old DB is a failure.
    if (upgrade) migrateDatabase(db, migrations, created);
    if (db.pragma('journal_mode = WAL', { simple: true }) !== 'wal') throw new StorageError('DATABASE_INVALID');
    const database = db;
    const owner = lock;
    let closed = false;
    return { directory, db: database, close() { if (!closed) { try { database.close(); } finally { owner.close(); closed = true; } } } };
  } catch (error) {
    db?.close();
    lock?.close();
    if (error instanceof StorageError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new StorageError(code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' ? 'DATABASE_BUSY' : 'DATABASE_INVALID');
  }
}
