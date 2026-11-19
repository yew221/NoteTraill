import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { openMaintenanceStorage, migrationVersion, MIGRATIONS, type SqliteDatabase } from './storage.js';
import { readSessionFile } from './session-files.js';

const Database = createRequire(import.meta.url)('better-sqlite3') as {
  new(file: string, options: { readonly: boolean; fileMustExist: boolean }): SqliteDatabase;
};
const MARKER = 'NoteTrail application data v1\n';
const SESSION = /^workers\/r_[a-f0-9-]{36}-[1-9][0-9]*\/sessions\/[A-Za-z0-9._-]{1,200}\.jsonl$/;
const STAGED = /^staging\/op_[a-f0-9-]{36}\.bin$/;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
interface FileRecord { path: string; bytes: number; sha256: string }
interface Manifest { format: 'notetrail-backup-v1'; schema: number; files: FileRecord[] }
export class MaintenanceError extends Error {
  constructor(readonly code: 'BACKUP_INVALID' | 'BACKUP_CONTENT_INVALID' | 'DESTINATION_INVALID') { super(code); }
}

function privateDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700 || fs.realpathSync(directory) !== directory) {
    throw new MaintenanceError('BACKUP_INVALID');
  }
}
function openPrivate(root: string, relative: string): number {
  const file = path.join(root, relative);
  for (let parent = path.dirname(file); parent !== path.dirname(root); parent = path.dirname(parent)) privateDirectory(parent);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) {
    fs.closeSync(fd); throw new MaintenanceError('BACKUP_INVALID');
  }
  return fd;
}
function sync(directory: string): void {
  const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function syncDirectories(directory: string): void {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if (item.isDirectory()) syncDirectories(path.join(directory, item.name));
  }
  sync(directory);
}
function write(file: string, bytes: Buffer | string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  sync(path.dirname(file));
}
function inspect(root: string, relative: string, destination?: string): FileRecord {
  const fd = openPrivate(root, relative), before = fs.fstatSync(fd), digest = createHash('sha256');
  let output: number | undefined, size = 0;
  try {
    if (destination) {
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      output = fs.openSync(destination, 'wx', 0o600);
    }
    const chunk = Buffer.alloc(64 * 1024);
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null); if (!n) break;
      digest.update(chunk.subarray(0, n)); size += n;
      if (output !== undefined) fs.writeFileSync(output, chunk.subarray(0, n));
    }
    const after = fs.fstatSync(fd);
    if (size !== before.size || size !== after.size || before.mtimeMs !== after.mtimeMs) throw new MaintenanceError('BACKUP_CONTENT_INVALID');
    if (output !== undefined) fs.fsyncSync(output);
    return { path: relative, bytes: size, sha256: digest.digest('hex') };
  } finally { fs.closeSync(fd); if (output !== undefined) { fs.closeSync(output); sync(path.dirname(destination!)); } }
}
function createDestination(input: string, forbidden: string[]): string {
  if (!path.isAbsolute(input) || input.includes('\0') || path.normalize(input) !== input || input === '/') throw new MaintenanceError('DESTINATION_INVALID');
  if (forbidden.some(root => input === root || input.startsWith(root + '/'))) throw new MaintenanceError('DESTINATION_INVALID');
  for (let parent = path.dirname(input); ; parent = path.dirname(parent)) {
    if (!fs.lstatSync(parent).isDirectory() || fs.realpathSync(parent) !== parent ||
        fs.existsSync(path.join(parent, '.git')) || fs.existsSync(path.join(parent, '.obsidian'))) throw new MaintenanceError('DESTINATION_INVALID');
    if (path.dirname(parent) === parent) break;
  }
  try { fs.mkdirSync(input, { mode: 0o700 }); }
  catch { throw new MaintenanceError('DESTINATION_INVALID'); }
  sync(path.dirname(input));
  return input;
}
function checkDatabase(db: SqliteDatabase): void {
  const foreignKeys = db.pragma('foreign_key_check') as unknown[];
  if (db.pragma('quick_check', { simple: true }) !== 'ok' ||
      migrationVersion(db, MIGRATIONS, false) !== MIGRATIONS.length || foreignKeys.length !== 0) throw new MaintenanceError('BACKUP_INVALID');
}
function checkContents(db: SqliteDatabase, root: string, files: FileRecord[]): void {
  const records = new Map(files.map(file => [file.path, file]));
  const sessions = db.prepare('SELECT session_file,session_hash FROM session_segments').all() as { session_file: string; session_hash: string }[];
  for (const row of sessions) {
    const saved = readSessionFile(root, row.session_file, row.session_hash);
    if (records.get(row.session_file)?.sha256 !== saved.hash) throw new MaintenanceError('BACKUP_CONTENT_INVALID');
    try { for (const line of saved.bytes.toString('utf8').trim().split('\n')) JSON.parse(line); }
    catch { throw new MaintenanceError('BACKUP_CONTENT_INVALID'); }
  }
  const operations = db.prepare('SELECT id,version,bytes FROM ingest_operations WHERE staged=1').all() as { id: string; version: string; bytes: number }[];
  for (const row of operations) {
    const record = records.get(`staging/${row.id}.bin`);
    if (record?.sha256 !== row.version || record.bytes !== row.bytes) throw new MaintenanceError('BACKUP_CONTENT_INVALID');
  }
  if (files.some(file => STAGED.test(file.path)) && records.get('staging/.notetrail-staging')?.sha256 !== hash(Buffer.from('NoteTrail staging v1\n'))) {
    throw new MaintenanceError('BACKUP_CONTENT_INVALID');
  }
  if (records.get('.notetrail-data')?.sha256 !== hash(Buffer.from(MARKER))) throw new MaintenanceError('BACKUP_INVALID');
}
function validatedBackup(input: string): { root: string; manifest: Manifest; db: SqliteDatabase } {
  if (!path.isAbsolute(input) || path.normalize(input) !== input) throw new MaintenanceError('BACKUP_INVALID');
  privateDirectory(input);
  const fd = openPrivate(input, 'manifest.json'); let manifest: Manifest;
  try {
    if (fs.fstatSync(fd).size > 16 * 1024 * 1024) throw new MaintenanceError('BACKUP_INVALID');
    manifest = JSON.parse(fs.readFileSync(fd, 'utf8')) as Manifest;
  } finally { fs.closeSync(fd); }
  if (!manifest || manifest.format !== 'notetrail-backup-v1' || manifest.schema !== MIGRATIONS.length ||
      !Array.isArray(manifest.files) || manifest.files.length < 2 || manifest.files.length > 100000) throw new MaintenanceError('BACKUP_INVALID');
  const root = path.join(input, 'data'), seen = new Set<string>();
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || seen.has(file.path) ||
        !(file.path === 'state.sqlite' || file.path === '.notetrail-data' || file.path === 'staging/.notetrail-staging' || SESSION.test(file.path) || STAGED.test(file.path)) ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0 || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new MaintenanceError('BACKUP_INVALID');
    seen.add(file.path);
    const actual = inspect(root, file.path);
    if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw new MaintenanceError('BACKUP_CONTENT_INVALID');
  }
  if (!seen.has('state.sqlite') || !seen.has('.notetrail-data')) throw new MaintenanceError('BACKUP_INVALID');
  // Snapshots have no WAL; never allow an unlisted sidecar to change the checked database.
  for (const suffix of ['-wal', '-shm', '-journal']) if (fs.existsSync(path.join(root, `state.sqlite${suffix}`))) throw new MaintenanceError('BACKUP_INVALID');
  const db = new Database(path.join(root, 'state.sqlite'), { readonly: true, fileMustExist: true });
  try { checkDatabase(db); checkContents(db, root, manifest.files); return { root, manifest, db }; }
  catch (error) { db.close(); throw error; }
}

export function backupData(source: string, destination: string): { files: number; bytes: number } {
  const storage = openMaintenanceStorage(source);
  try {
    const vault = storage.db.prepare('SELECT root_path FROM vaults').get() as { root_path: string } | undefined;
    const output = createDestination(destination, [storage.directory, ...(vault ? [vault.root_path] : [])]), payload = path.join(output, 'data');
    fs.mkdirSync(payload, { mode: 0o700 });
    const database = path.join(payload, 'state.sqlite');
    fs.closeSync(fs.openSync(database, 'wx', 0o600));
    storage.db.prepare('VACUUM INTO ?').run(database);
    const databaseFd = fs.openSync(database, 'r'); try { fs.fsyncSync(databaseFd); } finally { fs.closeSync(databaseFd); }
    write(path.join(payload, '.notetrail-data'), MARKER);
    const files: FileRecord[] = [inspect(payload, 'state.sqlite'), inspect(payload, '.notetrail-data')];
    const sessions = storage.db.prepare('SELECT DISTINCT session_file,session_hash FROM session_segments').all() as { session_file: string; session_hash: string }[];
    for (const row of sessions) {
      const saved = readSessionFile(storage.directory, row.session_file, row.session_hash);
      write(path.join(payload, row.session_file), saved.bytes);
      files.push({ path: row.session_file, bytes: saved.bytes.length, sha256: saved.hash });
    }
    const staging = path.join(storage.directory, 'staging');
    if (fs.existsSync(staging)) {
      privateDirectory(staging);
      for (const name of fs.readdirSync(staging).sort()) {
        const relative = `staging/${name}`;
        if (relative !== 'staging/.notetrail-staging' && !STAGED.test(relative)) throw new MaintenanceError('BACKUP_CONTENT_INVALID');
        files.push(inspect(storage.directory, relative, path.join(payload, relative)));
      }
    }
    checkContents(storage.db, payload, files);
    const snapshot = new Database(database, { readonly: true, fileMustExist: true });
    try { checkDatabase(snapshot); } finally { snapshot.close(); }
    syncDirectories(payload);
    // Completion marker is last. Incomplete output is retained and can never be restored as a valid backup.
    write(path.join(output, 'manifest.json'), JSON.stringify({ format: 'notetrail-backup-v1', schema: MIGRATIONS.length, files } satisfies Manifest) + '\n');
    const checked = validatedBackup(output); checked.db.close();
    return { files: files.length, bytes: files.reduce((total, file) => total + file.bytes, 0) };
  } finally { storage.close(); }
}

export function restoreData(source: string, destination: string): { files: number; credentialReentryRequired: true } {
  const backup = validatedBackup(source);
  try {
    const vault = backup.db.prepare('SELECT root_path FROM vaults').get() as { root_path: string } | undefined;
    const output = createDestination(destination, [source, ...(vault ? [vault.root_path] : [])]);
    for (const file of backup.manifest.files.filter(file => file.path !== '.notetrail-data')) {
      const copied = inspect(backup.root, file.path, path.join(output, file.path));
      if (copied.bytes !== file.bytes || copied.sha256 !== file.sha256) throw new MaintenanceError('BACKUP_CONTENT_INVALID');
    }
    const restored = new Database(path.join(output, 'state.sqlite'), { readonly: false, fileMustExist: true });
    try {
      checkDatabase(restored); checkContents(restored, output, backup.manifest.files);
      // An old credential reference must not reconnect to or remove a newer Keychain entry after rollback.
      restored.pragma('synchronous = FULL');
      restored.exec(`BEGIN IMMEDIATE;
        UPDATE model_settings SET credential_id=NULL, revision=revision+1;
        UPDATE model_profiles SET credential_id=NULL, connection='untested';
        DELETE FROM retired_credentials;
        COMMIT;`);
    } finally { restored.close(); }
    syncDirectories(output);
    write(path.join(output, '.notetrail-data'), MARKER);
    return { files: backup.manifest.files.length, credentialReentryRequired: true };
  } finally { backup.db.close(); }
}

export function diagnoseData(source: string) {
  const storage = openMaintenanceStorage(source);
  try {
    const count = (sql: string) => (storage.db.prepare(sql).get() as { n: number }).n;
    return { format: 'notetrail-diagnostics-v1', schema: MIGRATIONS.length, database: 'ok',
      runs: Object.fromEntries(['queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted']
        .map(state => [state, count(`SELECT count(*) AS n FROM runs WHERE state='${state}'`)])),
      sources: count('SELECT count(*) AS n FROM sources'), conversations: count('SELECT count(*) AS n FROM conversations'),
      unresolvedModelAttempts: count("SELECT count(*) AS n FROM model_attempts WHERE state IN ('sent','unknown')") +
        count("SELECT count(*) AS n FROM search_attempts WHERE state IN ('sent','unknown')"),
      pendingStaging: count('SELECT count(*) AS n FROM ingest_operations WHERE staged=1'),
    };
  } finally { storage.close(); }
}

export function verifyBackup(source: string): void {
  const backup = validatedBackup(source); backup.db.close();
}

export function verifyData(source: string): void {
  const storage = openMaintenanceStorage(source);
  try {
    checkDatabase(storage.db);
    const files = [inspect(source, '.notetrail-data')];
    const sessions = storage.db.prepare('SELECT DISTINCT session_file FROM session_segments').all() as { session_file: string }[];
    for (const row of sessions) {
      if (!SESSION.test(row.session_file)) throw new MaintenanceError('BACKUP_CONTENT_INVALID');
      files.push(inspect(source, row.session_file));
      const entries = readSessionFile(source, row.session_file).bytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
      // The pinned Pi 1.5.2 writes v3; an incompatible future format must not activate silently.
      if (entries[0]?.type !== 'session' || entries[0].version !== 3 || typeof entries[0].id !== 'string' ||
          entries.some(entry => !entry || typeof entry !== 'object' || typeof entry.type !== 'string')) throw new MaintenanceError('BACKUP_CONTENT_INVALID');
    }
    const staging = path.join(source, 'staging');
    if (fs.existsSync(staging)) {
      privateDirectory(staging);
      for (const name of fs.readdirSync(staging)) {
        const relative = `staging/${name}`;
        if (relative !== 'staging/.notetrail-staging' && !STAGED.test(relative)) throw new MaintenanceError('BACKUP_CONTENT_INVALID');
        files.push(inspect(source, relative));
      }
    }
    checkContents(storage.db, source, files);
  } finally { storage.close(); }
}
