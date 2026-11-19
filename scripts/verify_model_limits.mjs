#!/usr/bin/env node
// T01-F launcher. No live mode: model faults and charges are synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ROOT, FIXTURE, MANIFEST, createRunDir, hash, readFixture, readJson, writeJson, workerEnvironment } from './verify_pi.mjs';

try {
  const args = process.argv.slice(2);
  assert(args.length === 0 || (args.length === 2 && args[0] === '--run-id'), 'usage: node scripts/verify_model_limits.mjs [--run-id NAME]');
  assert(process.version === 'v24.22.1' && process.platform === 'darwin', 'use locked Node on macOS');
  for (const name of ['pi-ai', 'pi-coding-agent']) assert.equal(readJson(path.join(ROOT, 'node_modules/@earendil-works', name, 'package.json')).version, '1.5.2');
  const fixture = readJson(path.join(ROOT, MANIFEST)).files.find(item => item.id === 'F06');
  readFixture(path.join(ROOT, FIXTURE), fixture);
  const runDir = createRunDir(ROOT, args[1] ?? `${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`, 'model-limits');
  fs.mkdirSync(path.join(runDir, 'agent'));
  const fingerprints = Object.fromEntries(['package.json', 'pnpm-lock.yaml', 'scripts/model_budget.mjs', 'scripts/budgeted_stream.mjs',
    'scripts/verify_model_limits.mjs', 'scripts/model_limits_probe.mjs', 'scripts/deepseek_checks.mjs',
    'scripts/verify_pi.mjs', 'scripts/context_checks.mjs', 'tests/deepseek_transport.mjs', 'tests/test_model_budget.mjs', MANIFEST, FIXTURE]
    .map(file => [file, hash(fs.readFileSync(path.join(ROOT, file)))]));
  const reads = ['node_modules', 'scripts', 'tests/deepseek_transport.mjs', 'package.json', MANIFEST, FIXTURE].map(file => path.join(ROOT, file));
  const child = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)(deny network*)', process.execPath,
    '--permission', ...[...reads, runDir].map(file => `--allow-fs-read=${file}`), `--allow-fs-write=${runDir}`,
    path.join(ROOT, 'scripts/model_limits_probe.mjs'), runDir], {
    cwd: runDir, env: workerEnvironment(runDir), encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024,
  });
  fs.writeFileSync(path.join(runDir, 'probe.log'), `${child.stdout ?? ''}${child.stderr ?? ''}`, { flag: 'wx' });
  let result;
  try { result = readJson(path.join(runDir, 'result.json')); }
  catch { result = { passed: false, cases: [], checks: [], failure: 'worker did not return a report' }; }
  const fixtureUnchanged = hash(fs.readFileSync(path.join(ROOT, FIXTURE))) === fixture.sha256;
  const report = { ...result, passed: result.passed && child.status === 0 && fixtureUnchanged,
    node: process.version, pi: '1.5.2', finishedAt: new Date().toISOString(), paidModelCalls: 0,
    fixtureUnchanged, fingerprints, exitCode: child.status, signal: child.signal };
  writeJson(path.join(runDir, 'report.json'), report);
  fs.writeFileSync(path.join(runDir, 'REPORT.md'), [
    '# NoteTrail T01-F 模型失败与联合上限验证', '', `结果：${report.passed ? '通过' : '未通过'}；${report.cases.filter(c => c.passed).length}/${report.cases.length}场景。`, '',
    '真实Pi 1.5.2和DeepSeek适配器；HTTP/SSE及故障均在本地合成，网络被系统沙箱禁用。没有付费请求、真实密钥或私有资料。', '',
    '| 场景 | 请求尝试 | 工具读取 | 停止原因 | 结果 |', '| --- | --- | --- | --- | --- |',
    ...report.cases.map(c => `| ${c.id} | ${c.transports} | ${c.toolReads} | ${c.budget?.stopped ?? '无'} | ${c.passed ? '通过' : '未通过'} |`), '',
    'report.json保存实际断言、模拟用量及保留额度；各场景ledger.ndjson记录发请求前的预留与事后结算，sessions/为原生会话。模拟费用不计入T00真实花费。', '',
    '范围：只有固定域名的临时DNS解析失败可确认未发送并自动重试一次；HTTP错误、断流、取消和用量缺失保留预留额并暂停。', '',
    '输入仍受8KiB固定公开载荷限制，并按每请求32k输入预留；尚无通用token预估。正式持久化账本、真实异常服务计费和产品页面未验证。', '',
    '按T00保留30天；未解决的失败保留至关闭。', '',
  ].join('\n'), { flag: 'wx' });
  console.log(`${report.passed ? 'PASS' : 'FAIL'}: ${report.cases.filter(c => c.passed).length}/${report.cases.length} cases; ${path.join(runDir, 'REPORT.md')}`);
  process.exitCode = report.passed ? 0 : 1;
} catch (error) {
  console.error(`Preflight failed: ${error.message}`);
  process.exitCode = 2;
}
