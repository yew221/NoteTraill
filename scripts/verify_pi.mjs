#!/usr/bin/env node
// T01-B verification only. This is not the product worker or its IPC protocol.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE = 'tests/fixtures/public/t00/inputs/chat/handover.md';
export const MANIFEST = 'tests/fixtures/public/t00/versions.json';
export const hash = (data) => createHash('sha256').update(data).digest('hex');
export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });

export function readFixture(file, record) {
  assert.equal(fs.realpathSync(file), path.resolve(file), 'fixture symlinks are forbidden');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    assert(stat.isFile() && stat.size <= 16 * 1024, 'fixture must be a regular file of at most 16 KiB');
    const buffer = Buffer.alloc(16 * 1024 + 1);
    const data = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0));
    assert(data.length <= 16 * 1024, 'fixture grew beyond the read limit');
    assert.equal(data.length, record.bytes, 'fixture size changed');
    assert.equal(hash(data), record.sha256, 'fixture hash changed');
    const text = data.toString('utf8');
    assert(text.split('\n').length <= 200, 'fixture exceeds 200 lines');
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

export function createRunDir(root, runId, category = 'pi-sdk') {
  assert(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(runId), 'invalid run ID');
  assert(['pi-sdk', 'pi-context', 'deepseek', 'storage', 'model-limits', 'web'].includes(category), 'invalid verification category');
  let directory = fs.realpathSync(root);
  for (const part of ['outputs', 't01', category]) {
    directory = path.join(directory, part);
    if (!fs.existsSync(directory)) fs.mkdirSync(directory);
    assert(!fs.lstatSync(directory).isSymbolicLink(), 'output symlinks are forbidden');
    assert(fs.statSync(directory).isDirectory(), 'output path is not a directory');
  }
  directory = path.join(directory, runId);
  fs.mkdirSync(directory); // Never reuse or overwrite an earlier run.
  return directory;
}

export function workerEnvironment(runDir) {
  // An allowlist prevents credentials, NODE_OPTIONS and proxy settings crossing the boundary.
  return {
    PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', PI_OFFLINE: '1',
    PI_CODING_AGENT_DIR: path.join(runDir, 'agent'),
  };
}

function inventory() {
  const packages = [];
  let logicalBytes = 0;
  let files = 0;
  const inodes = new Set();
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      if (!entry.isFile()) continue; // Do not follow dependency symlinks or count them twice.
      const stat = fs.statSync(file);
      const inode = `${stat.dev}:${stat.ino}`;
      if (!inodes.has(inode)) { inodes.add(inode); logicalBytes += stat.size; files++; }
      if (entry.name !== 'package.json') continue;
      const parent = path.dirname(directory);
      if (path.basename(parent) !== 'node_modules' &&
          !(path.basename(parent).startsWith('@') && path.basename(path.dirname(parent)) === 'node_modules')) continue;
      const p = readJson(file);
      packages.push({ name: p.name, version: p.version, license: p.license ?? 'not declared',
        engines: p.engines, repository: p.repository, relativePath: path.relative(ROOT, file) });
    }
  }
  walk(path.join(ROOT, 'node_modules'));
  packages.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  return { packages, packageCount: packages.length, logicalBytes, files,
    sizeMeaning: 'Installed regular-file bytes, deduplicated by inode; not download size or allocated disk space.',
    licenseMeaning: 'Package metadata only; not a complete distribution license audit.' };
}

export function runVerification(runId) {
  assert.equal(process.version, 'v24.22.1', 'use the T01 locked Node patch');
  assert.equal(process.platform, 'darwin', 'this offline verification currently requires macOS sandbox-exec');
  for (const name of ['pi-coding-agent', 'pi-ai']) {
    assert.equal(readJson(path.join(ROOT, 'node_modules/@earendil-works', name, 'package.json')).version, '1.5.2');
  }
  const manifest = readJson(path.join(ROOT, MANIFEST));
  const record = manifest.files.find((item) => item.id === 'F06');
  assert.equal(record?.path, 'inputs/chat/handover.md');
  readFixture(path.join(ROOT, FIXTURE), record);
  const runDir = createRunDir(ROOT, runId);
  for (const folder of ['agent', 'cwd/.pi/extensions', 'sessions']) fs.mkdirSync(path.join(runDir, folder), { recursive: true });
  // Synthetic traps: default discovery would either inject this marker or load a throwing extension.
  fs.writeFileSync(path.join(runDir, 'cwd/AGENTS.md'), 'NOTETRAIL_UNEXPECTED_RESOURCE');
  fs.writeFileSync(path.join(runDir, 'agent/AGENTS.md'), 'NOTETRAIL_UNEXPECTED_RESOURCE');
  fs.writeFileSync(path.join(runDir, 'cwd/.pi/extensions/unexpected.mjs'), "throw new Error('NOTETRAIL_UNEXPECTED_RESOURCE');\n");
  writeJson(path.join(runDir, 'cwd/.pi/settings.json'), { defaultTools: ['bash', 'write'] });
  writeJson(path.join(runDir, 'agent/auth.json'), { fake: { type: 'api_key', key: 'PUBLIC_TEST_SENTINEL' } });
  writeJson(path.join(runDir, 'agent/models.json'), { NOTETRAIL_UNEXPECTED_RESOURCE: true });
  const protectedFiles = ['cwd/AGENTS.md', 'agent/AGENTS.md', 'cwd/.pi/extensions/unexpected.mjs',
    'cwd/.pi/settings.json', 'agent/auth.json', 'agent/models.json'];
  const before = Object.fromEntries(protectedFiles.map((f) => [f, hash(fs.readFileSync(path.join(runDir, f)))]));
  const report = {
    schemaVersion: 1, scope: 'T01-B, real Pi SDK with a deterministic offline model; not DeepSeek validation',
    startedAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
    pi: '1.5.2', model: 'notetrail-offline/fixture', modelCallsPaid: 0,
    fixture: record, fingerprints: {}, phases: [], dependencies: inventory(),
  };
  for (const file of ['package.json', 'pnpm-lock.yaml', 'scripts/verify_pi.mjs', 'scripts/pi_sdk_probe.mjs', MANIFEST, FIXTURE]) {
    report.fingerprints[file] = hash(fs.readFileSync(path.join(ROOT, file)));
  }
  const allowedReads = ['node_modules', 'scripts', 'package.json', MANIFEST, FIXTURE].map((f) => path.join(ROOT, f));
  for (const phase of ['create', 'resume', 'boundaries']) {
    const args = ['-p', '(version 1)(allow default)(deny network*)', process.execPath,
      '--permission', ...[...allowedReads, runDir].map((p) => `--allow-fs-read=${p}`),
      `--allow-fs-write=${runDir}`, path.join(ROOT, 'scripts/pi_sdk_probe.mjs'), phase, runDir];
    const child = spawnSync('/usr/bin/sandbox-exec', args, {
      cwd: path.join(runDir, 'cwd'), env: workerEnvironment(runDir), encoding: 'utf8',
      timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
    });
    fs.writeFileSync(path.join(runDir, `${phase}.log`), `${child.stdout ?? ''}${child.stderr ?? ''}`, { flag: 'wx' });
    const resultFile = path.join(runDir, `${phase}.json`);
    let result;
    try {
      result = readJson(resultFile);
      assert(Array.isArray(result.checks) && result.checks.every((c) => typeof c === 'string'));
      assert.equal(typeof result.passed, 'boolean');
    } catch {
      result = { passed: false, checks: [], error: child.error?.code ?? 'missing or invalid worker result' };
    }
    const passed = child.status === 0 && result.passed === true;
    report.phases.push({ ...result, phase, passed, exitCode: child.status, signal: child.signal });
    if (!passed) break;
  }
  report.inputsUnchanged = Object.entries(before).every(([f, digest]) => hash(fs.readFileSync(path.join(runDir, f))) === digest)
    && hash(fs.readFileSync(path.join(ROOT, FIXTURE))) === record.sha256;
  report.passed = report.phases.length === 3 && report.phases.every((p) => p.passed) && report.inputsUnchanged;
  report.finishedAt = new Date().toISOString();
  writeJson(path.join(runDir, 'report.json'), report);
  const rows = report.phases.flatMap((p) => p.checks.map((check) => `| ${p.phase} | ${check} | 通过 |`));
  for (const p of report.phases.filter((p) => !p.passed)) rows.push(`| ${p.phase} | 未完成，见 ${p.phase}.json / .log | 失败 |`);
  fs.writeFileSync(path.join(runDir, 'REPORT.md'), [
    '# NoteTrail T01-B Pi SDK 验证', '', `整体结果：${report.passed ? '通过' : '失败'}。Node ${report.node} / Pi ${report.pi}。`, '',
    '真实 Pi SDK；模型为本地固定测试流。没有云端模型调用，不证明真实回答质量、DeepSeek 协议或摘要失效处理。', '',
    '| 阶段 | 检查 | 结果 |', '| --- | --- | --- |', ...rows, '',
    `公开输入与配置诱饵未改变：${report.inputsUnchanged}。私有资料未读入。`, '',
    '会话保存在 sessions/；各阶段的请求、事件和断言结果在同名 JSON 文件。report.json 含代码/锁文件/样本指纹和依赖清单。', '',
    '本目录按 T00 运行结果规则保留30天；未解决的失败记录保留至问题关闭。', '',
  ].join('\n'), { flag: 'wx' });
  return { runDir, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    assert(args.length === 0 || (args.length === 2 && args[0] === '--run-id'), 'usage: node scripts/verify_pi.mjs [--run-id NAME]');
    const runId = args[1] ?? `${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`;
    const { runDir, report } = runVerification(runId);
    console.log(`${report.passed ? 'PASS' : 'FAIL'}: ${report.phases.filter((p) => p.passed).length}/3 phases; ${path.join(runDir, 'REPORT.md')}`);
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    console.error(`Preflight failed: ${error.message}`);
    process.exitCode = 2;
  }
}
