#!/usr/bin/env node
// T01-C: compact an actual Pi session, then invalidate its source or preference.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ROOT, MANIFEST, hash, readJson, writeJson, readFixture, createRunDir, workerEnvironment } from './verify_pi.mjs';

try {
  assert.equal(process.version, 'v24.22.1');
  assert.equal(process.platform, 'darwin');
  for (const name of ['pi-ai', 'pi-coding-agent']) {
    assert.equal(readJson(path.join(ROOT, 'node_modules/@earendil-works', name, 'package.json')).version, '1.5.2');
  }
  const args = process.argv.slice(2);
  assert(args.length === 0 || (args.length === 2 && args[0] === '--run-id'), 'usage: node scripts/verify_pi_context.mjs [--run-id NAME]');
  const casesPath = 'tests/pi_context_cases.json';
  const config = readJson(path.join(ROOT, casesPath));
  const manifest = readJson(path.join(ROOT, MANIFEST));
  const records = [config.oldFixture, config.newFixture].map((id) => manifest.files.find((f) => f.id === id));
  assert.deepEqual(records.map((r) => r.path), ['inputs/lifecycle/v1/inspection.md', 'inputs/lifecycle/v2/inspection.md']);
  const inputs = records.map((r) => `tests/fixtures/public/t00/${r.path}`);
  inputs.forEach((file, i) => readFixture(path.join(ROOT, file), records[i]));
  const runId = args[1] ?? `${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`;
  const runDir = createRunDir(ROOT, runId, 'pi-context');
  const phases = ['seed', ...config.cases.map((c) => c.id), 'summary-failure'];
  assert.deepEqual(phases, ['seed', 'changed', 'excluded', 'missing', 'memory-removed', 'summary-failure']);
  const fingerprints = {};
  for (const file of ['package.json', 'pnpm-lock.yaml', 'scripts/verify_pi.mjs', 'scripts/verify_pi_context.mjs',
    'scripts/pi_context_probe.mjs', 'scripts/context_checks.mjs', casesPath, MANIFEST, ...inputs]) {
    fingerprints[file] = hash(fs.readFileSync(path.join(ROOT, file)));
  }
  const report = { schemaVersion: 1, scope: 'T01-C: actual Pi compaction with a deterministic offline model',
    startedAt: new Date().toISOString(), asOf: config.asOf, node: process.version, pi: '1.5.2',
    platform: process.platform, arch: process.arch, paidModelCalls: 0, fingerprints, phases: [] };
  const reads = ['node_modules', 'scripts', 'package.json', MANIFEST, casesPath, ...inputs].map((f) => path.join(ROOT, f));
  for (const phase of phases) {
    fs.mkdirSync(path.join(runDir, phase));
    const child = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)(deny network*)', process.execPath,
      '--permission', ...[...reads, runDir].map((f) => `--allow-fs-read=${f}`), `--allow-fs-write=${runDir}`,
      path.join(ROOT, 'scripts/pi_context_probe.mjs'), phase, runDir], {
      cwd: path.join(runDir, phase), env: workerEnvironment(runDir), encoding: 'utf8', timeout: 30_000,
      killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
    });
    fs.writeFileSync(path.join(runDir, `${phase}.log`), `${child.stdout ?? ''}${child.stderr ?? ''}`, { flag: 'wx' });
    let result;
    try {
      result = readJson(path.join(runDir, `${phase}.json`));
      assert.equal(typeof result.passed, 'boolean');
      assert(Array.isArray(result.checks) && result.checks.every((c) => typeof c === 'string'));
    } catch {
      result = { passed: false, checks: [], error: child.error?.code ?? 'missing or invalid worker result' };
    }
    report.phases.push({ ...result, phase, passed: result.passed === true && child.status === 0, exitCode: child.status, signal: child.signal });
    if (!report.phases.at(-1).passed) break;
  }
  report.inputsUnchanged = inputs.every((f, i) => hash(fs.readFileSync(path.join(ROOT, f))) === records[i].sha256);
  report.passed = report.inputsUnchanged && report.phases.length === phases.length && report.phases.every((p) => p.passed);
  report.finishedAt = new Date().toISOString();
  writeJson(path.join(runDir, 'report.json'), report);
  const rows = report.phases.flatMap((p) => [
    ...p.checks.map((name) => `| ${p.phase} | ${name} | 通过 |`),
    ...(!p.passed ? [`| ${p.phase} | 失败，见同名JSON或日志 | 未通过 |`] : []),
  ]);
  fs.writeFileSync(path.join(runDir, 'REPORT.md'), [
    '# NoteTrail T01-C 摘要与上下文重建验证', '', `整体结果：${report.passed ? '通过' : '失败'}。Node ${process.version} / Pi 1.5.2。`, '',
    `模拟场景日期：${config.asOf}。真实Pi SDK负责压缩和保存；模型回答及摘要文本来自固定本地测试流。`, '',
    '| 阶段 | 检查 | 结果 |', '| --- | --- | --- |', ...rows, '',
    `原始公开样本未改变：${report.inputsUnchanged}。私有资料未读取，云端模型调用为0。`, '',
    'seed/保存已污染的原生摘要会话；各案例分别保存直接续用对照与重建后的会话。请求、事件、状态变化与检查位于同名JSON。', '',
    '本验证没有实现产品文件监听、SQLite依赖账本、UI会话映射或真实DeepSeek调用。结果按T00规则留存30天，未解决失败保留至关闭。', '',
  ].join('\n'), { flag: 'wx' });
  console.log(`${report.passed ? 'PASS' : 'FAIL'}: ${report.phases.filter((p) => p.passed).length}/${phases.length} phases; ${path.join(runDir, 'REPORT.md')}`);
  process.exitCode = report.passed ? 0 : 1;
} catch (error) {
  console.error(`Verification setup failed: ${error.message}`);
  process.exitCode = 2;
}
