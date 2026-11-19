// T01-E component verification with synthetic data, not the product database schema.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { ROOT, FIXTURE, MANIFEST, hash, readFixture, readJson, writeJson } from './verify_pi.mjs';

const [phase, runDir] = process.argv.slice(2);
assert(['prepare', 'crash', 'recover', 'restore'].includes(phase));
assert(process.permission?.has('fs.write', runDir), 'use the restricted launcher');
const result = { phase, passed: false, checks: [] };
const check = (name, condition) => { assert(condition, name); result.checks.push(name); };
const file = path.join(runDir, 'state.sqlite');
const backup = path.join(runDir, 'backup.sqlite');
const fixture = readJson(path.join(ROOT, MANIFEST)).files.find((item) => item.id === 'F06');
const text = readFixture(path.join(ROOT, FIXTURE), fixture);
let db;

try {
  if (phase === 'prepare') assert(!fs.existsSync(file), 'never replace an existing database');
  db = new Database(file, { fileMustExist: phase !== 'prepare', timeout: 100 });
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = FULL');
  const native = Object.keys(createRequire(import.meta.url).cache).find((p) => p.endsWith('/darwin-arm64.node'));
  check('加载当前Mac的预编译原生模块', Boolean(native));
  result.runtime = { sqlite: db.prepare('SELECT sqlite_version() AS version').get().version,
    nativePath: path.relative(ROOT, native), nativeSha256: hash(fs.readFileSync(native)),
    compileOptions: db.pragma('compile_options').map((r) => r.compile_options) };
  if (phase === 'prepare') {
    check('WAL日志模式可用', db.pragma('journal_mode = WAL', { simple: true }) === 'wal');
    db.exec(`CREATE TABLE probe_sources(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE probe_refs(id INTEGER PRIMARY KEY, source_id TEXT NOT NULL REFERENCES probe_sources(id));`);
    const insert = db.prepare('INSERT INTO probe_sources VALUES (?, ?)');
    db.transaction(() => {
      insert.run('F06', text);
      db.prepare('INSERT INTO probe_refs VALUES (?, ?)').run(1, 'F06');
    })();
    assert.throws(db.transaction(() => {
      insert.run('ROLLBACK', 'must not persist');
      insert.run('F06', 'duplicate');
    }), { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' });
    check('事务中途失败不留下前半段写入', !db.prepare('SELECT id FROM probe_sources WHERE id = ?').get('ROLLBACK'));
    assert.throws(() => db.prepare('INSERT INTO probe_refs VALUES (?, ?)').run(2, 'missing'), { code: 'SQLITE_CONSTRAINT_FOREIGNKEY' });
    check('外键拒绝不存在的来源', db.prepare('SELECT count(*) AS n FROM probe_refs').get().n === 1);
    const tricky = "公开文本'); DROP TABLE probe_sources; --";
    insert.run('QUOTED', tricky);
    check('参数化写入保留文本原样', db.prepare('SELECT body FROM probe_sources WHERE id = ?').get('QUOTED').body === tricky);
    const other = new Database(file, { timeout: 100 });
    try {
      other.exec('BEGIN IMMEDIATE');
      assert.throws(() => insert.run('LOCKED', 'blocked'), { code: 'SQLITE_BUSY' });
      check('写入冲突明确返回SQLITE_BUSY', !db.prepare('SELECT id FROM probe_sources WHERE id = ?').get('LOCKED'));
      other.exec('ROLLBACK');
      insert.run('AFTER_LOCK', 'write resumed');
      check('锁释放后可继续写入', Boolean(db.prepare('SELECT id FROM probe_sources WHERE id = ?').get('AFTER_LOCK')));
    } finally { other.close(); }
    check('完整性与外键检查通过', db.pragma('integrity_check', { simple: true }) === 'ok' && db.pragma('foreign_key_check').length === 0);
  } else if (phase === 'crash') {
    check('新进程读到已提交资料', db.prepare('SELECT body FROM probe_sources WHERE id = ?').get('F06').body === text);
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO probe_sources VALUES (?, ?)').run('UNCOMMITTED', 'must disappear after SIGKILL');
    check('退出前确实存在未提交事务', db.inTransaction);
    result.passed = true;
    writeJson(path.join(runDir, `${phase}.json`), result);
    process.kill(process.pid, 'SIGKILL'); // Only this synthetic verification process is killed.
  } else if (phase === 'recover') {
    check('强制退出后保留已提交资料', db.prepare('SELECT body FROM probe_sources WHERE id = ?').get('F06').body === text);
    check('强制退出后丢弃未提交写入', !db.prepare('SELECT id FROM probe_sources WHERE id = ?').get('UNCOMMITTED'));
    check('重新打开后数据库完整', db.pragma('integrity_check', { simple: true }) === 'ok');
    assert(!fs.existsSync(backup), 'backup destination already exists');
    const progress = await db.backup(backup);
    check('通过SQLite备份接口完成快照', progress.remainingPages === 0 && progress.totalPages > 0);
    // Mutate only after backup completes, so the later restore has an independent expected value.
    db.prepare('UPDATE probe_sources SET body = ? WHERE id = ?').run('PUBLIC_CHANGE_AFTER_BACKUP', 'F06');
    check('备份完成后主库可继续写入', db.prepare('SELECT body FROM probe_sources WHERE id = ?').get('F06').body === 'PUBLIC_CHANGE_AFTER_BACKUP');
  } else {
    check('新进程主库保留备份后的修改', db.prepare('SELECT body FROM probe_sources WHERE id = ?').get('F06').body === 'PUBLIC_CHANGE_AFTER_BACKUP');
    const restoredFile = path.join(runDir, 'restored.sqlite');
    fs.copyFileSync(backup, restoredFile, fs.constants.COPYFILE_EXCL);
    const restored = new Database(restoredFile, { readonly: true, fileMustExist: true });
    try {
      check('备份恢复到新路径后读回原依据', restored.prepare('SELECT body FROM probe_sources WHERE id = ?').get('F06').body === text);
      check('恢复后来源与引用关系完整', restored.pragma('integrity_check', { simple: true }) === 'ok'
        && restored.pragma('foreign_key_check').length === 0 && restored.prepare('SELECT source_id FROM probe_refs').get().source_id === 'F06');
      assert.throws(() => restored.prepare('DELETE FROM probe_sources').run(), { code: 'SQLITE_READONLY' });
      check('只读恢复检查拒绝写入', true);
    } finally { restored.close(); }
    const absent = path.join(runDir, 'missing.sqlite');
    assert.throws(() => new Database(absent, { fileMustExist: true }));
    check('指定必须存在时不静默创建空库', !fs.existsSync(absent));
    const corruptFile = path.join(runDir, 'corrupt.sqlite');
    fs.writeFileSync(corruptFile, 'PUBLIC_SYNTHETIC_INVALID_SQLITE', { flag: 'wx' });
    const corrupt = new Database(corruptFile, { readonly: true });
    try { assert.throws(() => corrupt.pragma('integrity_check'), { code: 'SQLITE_NOTADB' }); }
    finally { corrupt.close(); }
    check('损坏文件明确失败', true);
  }
  result.passed = true;
} catch (error) {
  result.error = { code: error.code, message: error.message };
} finally {
  db?.close();
}
writeJson(path.join(runDir, `${phase}.json`), result);
process.exitCode = result.passed ? 0 : 1;
