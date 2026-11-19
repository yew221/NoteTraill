import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { ENDPOINT, MODEL, LIMITS, guardedFetch, checkPayload, checkResponse, usageCost } from '../scripts/deepseek_checks.mjs';
import { keychainKey, previousBudget } from '../scripts/verify_deepseek.mjs';
import { syntheticFetch } from './deepseek_transport.mjs';
import { createHash } from 'node:crypto';

function payload(mode = 'off') {
  return { model: MODEL, stream: true, max_tokens: 4096, stream_options: { include_usage: true },
    thinking: { type: mode === 'off' ? 'disabled' : 'enabled' }, ...(mode === 'low' ? { reasoning_effort: 'low' } : {}),
    tools: [{ type: 'function', function: { name: 'read_fixture' } }], messages: [{ role: 'user', content: '公开测试' }] };
}

test('payload checks reject wrong model/mode/tools, missing reasoning and excessive input', () => {
  checkPayload(payload(), 'off');
  checkPayload({ ...payload(), max_tokens: 192 }, 'off', undefined, { maxOutput: 192 });
  const body = payload('low');
  body.messages.push({ role: 'assistant', reasoning_content: 'synthetic', tool_calls: [{ id: 'c1' }] }, { role: 'tool', tool_call_id: 'c1' });
  checkPayload(body, 'low', 'synthetic');
  for (const change of [p => p.model = 'other', p => p.max_tokens = 5000, p => p.max_tokens = 0, p => p.max_tokens = 1.5, p => p.thinking.type = 'enabled',
    p => p.tools.push(p.tools[0]), p => p.messages[0].content = 'x'.repeat(8192)]) {
    const bad = payload(); change(bad); assert.throws(() => checkPayload(bad, 'off'));
  }
  body.messages[1].reasoning_content = '';
  assert.throws(() => checkPayload(body, 'low', 'synthetic'), /reasoning replay/);
});

test('usage includes reasoning output, uses conservative CNY rates and rejects missing/inconsistent counts', () => {
  assert.equal(usageCost({ prompt_tokens: 32_000, completion_tokens: 4096, total_tokens: 36_096 }), LIMITS.batchReserveMicroYuan / 4);
  for (const usage of [null, {}, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 99 },
    { prompt_tokens: 32_001, completion_tokens: 1, total_tokens: 32_002 }]) assert.throws(() => usageCost(usage));
});

test('transport enforces endpoint, no redirect/retry, split SSE usage and response size', async () => {
  const record = {};
  const fetch = guardedFetch((input, init) => {
    assert.equal(init.redirect, 'error');
    return syntheticFetch(input, init);
  }, record, AbortSignal.timeout(1000));
  await assert.rejects(fetch('https://other.invalid/chat/completions', { method: 'POST' }), /endpoint/);
  const response = await fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(payload()) });
  await response.text();
  assert.equal(record.returnedModel, 'deepseek-flash-SYNTHETIC');
  assert.equal(record.costUpperMicroYuan, 800);
  await assert.rejects(fetch(ENDPOINT, { method: 'POST' }), /retry/);
  const oversized = guardedFetch(async () => new Response('x'.repeat(LIMITS.responseBytes + 1)), {}, AbortSignal.timeout(1000));
  await assert.rejects((await oversized(ENDPOINT, { method: 'POST' })).text(), /response byte/);
});

test('installed provider does not retry 401, 429 or 503 with maxRetries zero', async () => {
  for (const status of [401, 429, 503]) {
    let calls = 0;
    const model = { id: MODEL, provider: 'deepseek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com',
      reasoning: true, input: ['text'], contextWindow: 32_000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const stream = streamSimple(model, { messages: [{ role: 'user', content: 'synthetic error test', timestamp: 1 }] }, {
      apiKey: 'PUBLIC_TEST_CREDENTIAL', maxRetries: 0, timeoutMs: 1000,
      fetch: async () => { calls++; return new Response(JSON.stringify({ error: { message: 'synthetic rejection' } }),
        { status, headers: { 'content-type': 'application/json' } }); },
    });
    const result = await stream.result();
    assert.equal(result.stopReason, 'error');
    assert.equal(calls, 1);
  }
});

test('a completed stream without usage cannot pass settlement or permit continuation', async () => {
  const record = {};
  const body = 'data: ' + JSON.stringify({ model: 'deepseek-flash-SYNTHETIC', choices: [
    { index: 0, delta: { content: 'synthetic answer' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n';
  const model = { id: MODEL, provider: 'deepseek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com',
    reasoning: true, input: ['text'], contextWindow: 32_000, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const result = await streamSimple(model, { messages: [{ role: 'user', content: 'test', timestamp: 1 }] }, {
    apiKey: 'PUBLIC_TEST_CREDENTIAL', maxRetries: 0,
    fetch: guardedFetch(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      record, AbortSignal.timeout(1000)),
  }).result();
  assert.equal(result.stopReason, 'stop');
  assert.throws(() => checkResponse(record, result), /usage missing/);
});

test('keychain read captures only the exact item and never relays secret-bearing failures', () => {
  const secret = 'PUBLIC_SECRET_SENTINEL';
  assert.equal(keychainKey((command, args, options) => {
    assert.equal(command, '/usr/bin/security');
    assert.deepEqual(args, ['find-generic-password', '-s', 'com.notetrail.t01.deepseek', '-a', 'api.deepseek.com', '-w']);
    assert(!JSON.stringify({ args, options }).includes(secret));
    return { status: 0, stdout: `${secret}\n` };
  }), secret);
  assert.throws(() => keychainKey(() => ({ status: 44, stdout: secret, stderr: secret })),
    (error) => !error.message.includes(secret) && /Keychain/.test(error.message));
});

test('budget refuses failed, pending, corrupt or over-threshold previous live runs', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-deepseek-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(previousBudget(root), 0);
  const run = path.join(root, 'first'); fs.mkdirSync(run);
  fs.writeFileSync(path.join(run, 'live-reservation.json'), JSON.stringify({ microYuan: LIMITS.batchReserveMicroYuan }));
  assert.throws(() => previousBudget(root), /unresolved/);
  const report = { mode: 'live', passed: true, usageComplete: true, costUpperMicroYuan: 800 };
  const save = (value) => fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(value));
  save(report); assert.equal(previousBudget(root), 800);
  save({ ...report, usageComplete: false }); assert.throws(() => previousBudget(root), /unknown/);
  save({ ...report, costUpperMicroYuan: -1 }); assert.throws(() => previousBudget(root), /invalid settled/);
  save({ ...report, costUpperMicroYuan: LIMITS.batchReserveMicroYuan });
  for (let i = 0; i < 20; i++) fs.cpSync(run, path.join(root, `copy-${i}`), { recursive: true });
  assert.throws(() => previousBudget(root), /pause threshold/);
});

test('budget accepts only an explicitly reviewed quality failure with matching settled attempts and unchanged report', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-budget-review-')), run = path.join(root, 'failed'); fs.mkdirSync(run);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(run, 'live-reservation.json'), JSON.stringify({ microYuan: LIMITS.batchReserveMicroYuan }));
  const report = { mode: 'live', passed: false, usageComplete: true, failure: 'ACCEPTANCE_CHECK_FAILED',
    reservedUnsettledMicroYuan: 0, costUpperMicroYuan: 800, attempts: [{ state: 'settled', cost_micro_yuan: 800 }] };
  const write = value => fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(value));
  const review = () => fs.writeFileSync(path.join(run, 'budget-review.json'), JSON.stringify({ schemaVersion: 1,
    reportSha256: createHash('sha256').update(fs.readFileSync(path.join(run, 'report.json'))).digest('hex'),
    settledMicroYuan: 800, reason: 'Inspected public answer; output classification failed, charges all settled.' }));
  write(report); assert.throws(() => previousBudget(root), /review/); review(); assert.equal(previousBudget(root), 800);
  write({ ...report, changed: true }); assert.throws(() => previousBudget(root), /review/);
  for (const change of [{ usageComplete: false }, { reservedUnsettledMicroYuan: 1 }, { attempts: [{ state: 'unknown', cost_micro_yuan: 800 }] },
    { attempts: [{ state: 'settled', cost_micro_yuan: 799 }] }, { failure: 'VERIFICATION_FAILED' }]) {
    write({ ...report, ...change }); review(); assert.throws(() => previousBudget(root));
  }
  write(report); review(); fs.renameSync(path.join(run, 'budget-review.json'), path.join(root, 'review.json'));
  fs.symlinkSync(path.join(root, 'review.json'), path.join(run, 'budget-review.json')); assert.throws(() => previousBudget(root));
});

for (const held of [96768, 16640]) test(`explicit user approval retains the full ${held} unknown reservation without relabeling it as settled`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-budget-hold-')), run = path.join(root, 'unknown'); fs.mkdirSync(run);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(run, 'live-reservation.json'), JSON.stringify({ microYuan: LIMITS.batchReserveMicroYuan }));
  const report = { mode: 'live', passed: false, usageComplete: false, failure: 'ACCEPTANCE_CHECK_FAILED', costUpperMicroYuan: 800,
    reservedUnsettledMicroYuan: held, attempts: [{ state: 'settled', cost_micro_yuan: 800 }, { state: 'unknown', cost_micro_yuan: null,
      reserved_micro_yuan: held, ...(held === 16640 ? { kind: 'model_probe', input_reserved: 8192, output_limit: 32 } : {}) }] };
  const file = path.join(run, 'report.json'), approval = path.join(run, 'reserved-charge-approval.json');
  fs.writeFileSync(file, JSON.stringify(report)); const before = fs.readFileSync(file);
  assert.throws(() => previousBudget(root), /unknown/);
  const valid = { schemaVersion: 1, approvedByUser: true, reportSha256: createHash('sha256').update(before).digest('hex'), retainedMicroYuan: held, userDecision: 'Keep the full reservation and continue within the same total ceiling.' };
  fs.writeFileSync(approval, JSON.stringify(valid)); assert.equal(previousBudget(root), 800 + held); assert.deepEqual(fs.readFileSync(file), before);
  for (const change of [{ approvedByUser: false }, { retainedMicroYuan: 0 }, { retainedMicroYuan: held - 1 }, { reportSha256: '0'.repeat(64) }]) {
    fs.writeFileSync(approval, JSON.stringify({ ...valid, ...change })); assert.throws(() => previousBudget(root));
  }
  fs.writeFileSync(approval, JSON.stringify(valid)); fs.writeFileSync(file, JSON.stringify({ ...report, changed: true })); assert.throws(() => previousBudget(root));
  if (held === 16640) for (const change of [{ kind: 'message' }, { input_reserved: 32000 }, { output_limit: 4096 }, { reserved_micro_yuan: 16639 }]) {
    const forged = JSON.stringify({ ...report, attempts: [report.attempts[0], { ...report.attempts[1], ...change }] });
    fs.writeFileSync(file, forged); fs.writeFileSync(approval, JSON.stringify({ ...valid, reportSha256: createHash('sha256').update(forged).digest('hex') }));
    assert.throws(() => previousBudget(root));
  }
});
