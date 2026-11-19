#!/usr/bin/env node
// T01-E only: synthetic storage and platform compatibility checks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { ROOT, FIXTURE, MANIFEST, createRunDir, hash, readFixture, readJson, writeJson, workerEnvironment } from './verify_pi.mjs';

const PYTHON = path.join(os.homedir(), '.local/share/uv/tools/markitdown/bin/python');

export function sqliteSandbox(runDir) {
  assert(path.resolve(runDir) === runDir && !/[\n\r]/.test(runDir), 'invalid sandbox output path');
  return `(version 1)(allow default)(deny network*)(deny file-write*)` +
    `(allow file-write* (subpath ${JSON.stringify(runDir)}) (literal "/dev/null"))`;
}

export function nativeInventory() {
  const requireFromSqlite = createRequire(path.join(fs.realpathSync(path.join(ROOT, 'node_modules/better-sqlite3')), 'package.json'));
  return ['better-sqlite3', 'node-addon-api'].map((name) => {
    const directory = path.dirname(requireFromSqlite.resolve(`${name}/package.json`));
    const pkg = readJson(path.join(directory, 'package.json'));
    let bytes = 0;
    let files = 0;
    const binaries = [];
    function walk(folder) {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) walk(file);
        if (!entry.isFile()) continue;
        const size = fs.statSync(file).size;
        bytes += size; files++;
        if (entry.name.endsWith('.node')) binaries.push({ path: path.relative(ROOT, file), bytes: size, sha256: hash(fs.readFileSync(file)) });
      }
    }
    walk(directory);
    return { name: pkg.name, version: pkg.version, license: pkg.license, engines: pkg.engines, regularBytes: bytes, files, binaries };
  });
}

export function runVerification(runId) {
  assert(process.version === 'v24.22.1' && process.platform === 'darwin' && process.arch === 'arm64', 'this slice verifies locked Node on macOS arm64 only');
  assert(readJson(path.join(ROOT, 'node_modules/better-sqlite3/package.json')).version === '13.1.1', 'SQLite dependency changed');
  const fixture = readJson(path.join(ROOT, MANIFEST)).files.find((item) => item.id === 'F06');
  assert(fixture?.path === 'inputs/chat/handover.md');
  readFixture(path.join(ROOT, FIXTURE), fixture);
  const runDir = createRunDir(ROOT, runId, 'storage');
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), node: process.version,
    platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules, napi: process.versions.napi,
    phases: [], dependencies: nativeInventory(), fingerprints: {}, paidModelCalls: 0, fixture };
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'scripts/verify_storage.mjs', 'scripts/sqlite_probe.mjs',
    'scripts/keychain_probe.py', 'scripts/verify_pi.mjs', MANIFEST, FIXTURE]) report.fingerprints[file] = hash(fs.readFileSync(path.join(ROOT, file)));
  const reads = ['node_modules', 'scripts', 'package.json', MANIFEST, FIXTURE].map((p) => path.join(ROOT, p));
  for (const phase of ['prepare', 'crash', 'recover', 'restore', 'keychain']) {
    if (phase !== 'keychain' && report.phases.some((p) => !p.passed)) continue;
    const keychain = phase === 'keychain';
    const command = keychain ? PYTHON : '/usr/bin/sandbox-exec';
    const args = keychain ? ['-I', '-B', path.join(ROOT, 'scripts/keychain_probe.py'), runDir] :
      ['-p', sqliteSandbox(runDir), process.execPath, '--permission', '--allow-addons',
        ...[...reads, runDir].map((p) => `--allow-fs-read=${p}`), `--allow-fs-write=${runDir}`,
        path.join(ROOT, 'scripts/sqlite_probe.mjs'), phase, runDir];
    const child = spawnSync(command, args, { cwd: runDir, env: workerEnvironment(runDir), encoding: 'utf8',
      timeout: 30_000, maxBuffer: 256 * 1024 });
    fs.writeFileSync(path.join(runDir, `${phase}.log`), `${child.stdout ?? ''}${child.stderr ?? ''}`, { flag: 'wx' });
    let result;
    try { result = readJson(path.join(runDir, `${phase}.json`)); }
    catch { result = { passed: false, checks: [], error: child.error?.code ?? 'missing worker result' }; }
    const expectedExit = phase === 'crash' ? child.signal === 'SIGKILL' : child.status === 0;
    report.phases.push({ ...result, phase, passed: result.passed === true && expectedExit,
      exitCode: child.status, signal: child.signal });
  }
  report.fixtureUnchanged = hash(fs.readFileSync(path.join(ROOT, FIXTURE))) === fixture.sha256;
  report.passed = report.phases.length === 5 && report.phases.every((p) => p.passed) && report.fixtureUnchanged;
  report.finishedAt = new Date().toISOString();
  writeJson(path.join(runDir, 'report.json'), report);
  fs.writeFileSync(path.join(runDir, 'REPORT.md'), [
    '# NoteTrail T01-E SQLite与Keychain验证', '', `结果：${report.passed ? '通过' : '未通过'}。Node ${report.node} / macOS ${report.arch} / better-sqlite3 13.1.1。`, '',
    '| 阶段 | 已通过检查数 | 结果 |', '| --- | --- | --- |',
    ...report.phases.map((p) => `| ${p.phase} | ${p.checks.length} | ${p.passed ? '通过' : '未通过，见同名JSON/log'} |`), '',
    'SQLite为真实原生组件，crash阶段只对测试子进程发送SIGKILL；Keychain为系统框架操作的新建测试钥匙串，凭据为公开假值。', '',
    '数据库、备份和记录只写本目录；不创建产品库，不操作真实DeepSeek密钥、默认钥匙串或私有资料，不发起模型调用。', '',
    'keychain.json记录锁定、删除、不可用的状态码以及清理/默认配置未变检查。测试钥匙串在finally中删除，数据库证据按T00保留30天，未解决失败继续保留。', '',
    '仅验证当前Mac；不等同Intel/最低系统版本、断电、正式迁移、产品设置页面或跨文件/数据库一致性已通过。', '',
  ].join('\n'), { flag: 'wx' });
  return { runDir, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    assert(args.length === 0 || (args.length === 2 && args[0] === '--run-id'), 'usage: node scripts/verify_storage.mjs [--run-id NAME]');
    const id = args[1] ?? `${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`;
    const { runDir, report } = runVerification(id);
    console.log(`${report.passed ? 'PASS' : 'FAIL'}: ${report.phases.filter((p) => p.passed).length}/5 phases; ${path.join(runDir, 'REPORT.md')}`);
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    console.error(`Preflight failed: ${error.message}`);
    process.exitCode = 2;
  }
}
