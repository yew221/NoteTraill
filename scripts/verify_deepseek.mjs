#!/usr/bin/env node
// Run the Pi adapter against a synthetic transport and the public handover fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, FIXTURE, MANIFEST, createRunDir, hash, readFixture, readJson, writeJson, workerEnvironment } from './verify_pi.mjs';
import { KEYCHAIN, LIMITS } from './deepseek_checks.mjs';

export function keychainKey(run) {
  assert.equal(typeof run, 'function', 'The Keychain contract test requires a supplied adapter.');
  const result = run('/usr/bin/security', ['find-generic-password', ...KEYCHAIN, '-w'], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
  });
  // Never relay security stdout/stderr or include a credential in process arguments.
  assert(result.status === 0 && !result.error, 'NoteTrail Keychain item missing, locked or access denied; see scripts/README.md');
  const key = result.stdout.trim();
  assert(key.length >= 16 && key.length <= 512 && !/\s/.test(key), 'invalid NoteTrail credential');
  return key;
}

export function previousBudget(directory) {
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), 'budget directory symlinks are forbidden');
    if (!entry.isDirectory() || entry.name === '.live-lock') continue;
    const reservation = path.join(directory, entry.name, 'live-reservation.json');
    if (!fs.existsSync(reservation)) continue;
    assert(!fs.lstatSync(reservation).isSymbolicLink(), 'reservation symlinks are forbidden');
    const reserved = readJson(reservation);
    assert(reserved.microYuan === LIMITS.batchReserveMicroYuan, 'unknown reservation');
    const reportFile = path.join(directory, entry.name, 'report.json');
    assert(fs.existsSync(reportFile), 'previous live run is unresolved; review before further billing');
    assert(!fs.lstatSync(reportFile).isSymbolicLink(), 'report symlinks are forbidden');
    const report = readJson(reportFile);
    assert(report.mode === 'live', 'previous live run failed or usage is unknown; review before further billing');
    if (!report.usageComplete) {
      const approvalFile = path.join(directory, entry.name, 'reserved-charge-approval.json');
      assert(fs.existsSync(approvalFile) && !fs.lstatSync(approvalFile).isSymbolicLink(), 'previous usage is unknown; explicit user approval is required');
      const approval = readJson(approvalFile), attempts = report.attempts;
      // Only an explicit user decision can carry this exact report's full hold into the next batch.
      // The original unknown attempt stays unknown, and its reservation is never released here.
      assert(!report.passed && ['ACCEPTANCE_CHECK_FAILED', 'USAGE_INCOMPLETE'].includes(report.failure) && Array.isArray(attempts) && attempts.length > 0 &&
        attempts.every(a => ['settled', 'unknown'].includes(a.state) && (a.state === 'settled' ?
          Number.isSafeInteger(a.cost_micro_yuan) && a.cost_micro_yuan >= 0 : a.cost_micro_yuan === null &&
            (a.reserved_micro_yuan === 96768 || a.reserved_micro_yuan === 16640 &&
              a.kind === 'model_probe' && a.input_reserved === 8192 && a.output_limit === 32))) &&
        attempts.filter(a => a.state === 'settled').reduce((sum, a) => sum + a.cost_micro_yuan, 0) === report.costUpperMicroYuan &&
        attempts.filter(a => a.state === 'unknown').reduce((sum, a) => sum + a.reserved_micro_yuan, 0) === report.reservedUnsettledMicroYuan &&
        report.reservedUnsettledMicroYuan > 0 && approval.schemaVersion === 1 && approval.approvedByUser === true &&
        approval.reportSha256 === hash(fs.readFileSync(reportFile)) && approval.retainedMicroYuan === report.reservedUnsettledMicroYuan &&
        typeof approval.userDecision === 'string' && approval.userDecision.trim().length > 0 &&
        Number.isSafeInteger(report.costUpperMicroYuan) && report.costUpperMicroYuan + approval.retainedMicroYuan <= reserved.microYuan,
      'approval must retain all unknown reservations and match the unchanged report');
      total += report.costUpperMicroYuan + approval.retainedMicroYuan;
      continue;
    }
    if (!report.passed) {
      const reviewFile = path.join(directory, entry.name, 'budget-review.json');
      assert(fs.existsSync(reviewFile) && !fs.lstatSync(reviewFile).isSymbolicLink(), 'previous live run failed; review before further billing');
      const review = readJson(reviewFile), attempts = report.attempts;
      // An explicit review settles a known quality failure, never an unknown charge or an unreviewed retry.
      assert(report.failure === 'ACCEPTANCE_CHECK_FAILED' && report.reservedUnsettledMicroYuan === 0 &&
        review.schemaVersion === 1 && review.reportSha256 === hash(fs.readFileSync(reportFile)) &&
        review.settledMicroYuan === report.costUpperMicroYuan && typeof review.reason === 'string' && review.reason.trim().length > 0 &&
        Array.isArray(attempts) && attempts.length > 0 && attempts.every(a => a.state === 'settled' &&
          Number.isSafeInteger(a.cost_micro_yuan) && a.cost_micro_yuan >= 0) &&
        attempts.reduce((sum, a) => sum + a.cost_micro_yuan, 0) === report.costUpperMicroYuan,
      'failed run review does not prove settled usage');
    }
    assert(Number.isSafeInteger(report.costUpperMicroYuan) && report.costUpperMicroYuan >= 0
      && report.costUpperMicroYuan <= reserved.microYuan, 'invalid settled cost');
    total += report.costUpperMicroYuan;
  }
  assert(total + LIMITS.batchReserveMicroYuan < LIMITS.pauseMicroYuan, '8 yuan pause threshold reached');
  return total;
}

export function runVerification(mode, runId) {
  assert.equal(mode, 'offline', 'Use offline mode for the public verification fixture.');
  assert(process.version === 'v24.22.1' && process.platform === 'darwin', 'use locked Node 24.22.1 on macOS');
  for (const name of ['pi-coding-agent', 'pi-ai']) {
    assert.equal(readJson(path.join(ROOT, 'node_modules/@earendil-works', name, 'package.json')).version, '1.5.2');
  }
  const fixture = readJson(path.join(ROOT, MANIFEST)).files.find(item => item.id === 'F06');
  assert.equal(fixture?.path, 'inputs/chat/handover.md');
  readFixture(path.join(ROOT, FIXTURE), fixture);
  const runDir = createRunDir(ROOT, runId, 'deepseek');
  for (const folder of ['cwd', 'agent', 'sessions']) fs.mkdirSync(path.join(runDir, folder));
  const reads = ['node_modules', 'scripts', 'package.json', MANIFEST, FIXTURE, 'tests/deepseek_transport.mjs']
    .map(file => path.join(ROOT, file));
  const args = ['-p', '(version 1)(allow default)(deny network*)', process.execPath, '--permission',
    ...[...reads, runDir].map(file => `--allow-fs-read=${file}`), `--allow-fs-write=${runDir}`,
    path.join(ROOT, 'scripts/deepseek_probe.mjs'), mode, runDir];
  const child = spawnSync('/usr/bin/sandbox-exec', args, { cwd: path.join(runDir, 'cwd'), env: workerEnvironment(runDir),
    stdio: 'ignore', timeout: 30_000, killSignal: 'SIGKILL' });
  const result = path.join(runDir, 'result.json');
  const report = fs.existsSync(result) ? readJson(result) : { mode, passed: false, failure: 'Worker ended before producing a result.' };
  report.fixtureUnchanged = hash(fs.readFileSync(path.join(ROOT, FIXTURE))) === fixture.sha256;
  report.passed = child.status === 0 && report.passed === true && report.fixtureUnchanged;
  writeJson(path.join(runDir, 'report.json'), report);
  return { runDir, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    assert(args.length === 0 || (args.length === 2 && args[0] === '--run-id'), 'usage: node scripts/verify_deepseek.mjs [--run-id NAME]');
    const { runDir, report } = runVerification('offline', args[1] ?? `offline-${randomUUID()}`);
    console.log(`${report.passed ? 'PASS' : 'FAIL'} ${path.join(runDir, 'report.json')}`);
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
