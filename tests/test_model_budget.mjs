import assert from 'node:assert/strict';
import test from 'node:test';
import { CAPS, QuestionBudget, newBatch, definitelyUnsentDns } from '../scripts/model_budget.mjs';

const usage = (input = 240, output = 40) => ({ prompt_tokens: input, completion_tokens: output, total_tokens: input + output });
const stopped = (fn, code) => assert.throws(fn, (error) => error.code === code);

test('reserve before sending, settle real usage, release unused funds and refuse duplicate settlement', () => {
  const events = [];
  const batch = newBatch(4710);
  const budget = new QuestionBudget(batch, { record: event => events.push(event) });
  const attempt = budget.begin();
  assert.equal(events[0].event, 'reserved');
  assert.equal(batch.reservedMicroYuan, 96_768);
  assert.equal(batch.spentMicroYuan, 4710);
  budget.settle(attempt, usage());
  assert.equal(batch.spentMicroYuan, 5510);
  assert.equal(batch.reservedMicroYuan, 0);
  assert.deepEqual([budget.input, budget.output, budget.costMicroYuan], [240, 40, 800]);
  assert.throws(() => budget.settle(attempt, usage()), /duplicate/);
});

test('unknown or invalid usage holds funds and stops another question sharing the batch', () => {
  for (const value of [null, usage(32_001, 40), usage(240, 4097)]) {
    const batch = newBatch();
    const budget = new QuestionBudget(batch);
    stopped(() => budget.settle(budget.begin(), value), 'usage_invalid');
    assert.equal(batch.reservedMicroYuan, 96_768);
    assert.equal(batch.paused, true);
    stopped(() => new QuestionBudget(batch).begin(), 'unresolved_usage');
  }
});

test('one retry is shared by the whole question and every attempt counts toward six', () => {
  const budget = new QuestionBudget(newBatch());
  budget.notSent(budget.begin());
  budget.planRetry(250);
  for (let i = 0; i < 5; i++) budget.settle(budget.begin(), usage());
  stopped(() => budget.begin(), 'request_limit');
  assert.equal(budget.attempts.length, 6);
  const other = new QuestionBudget(newBatch());
  other.notSent(other.begin()); other.planRetry(0);
  other.settle(other.begin(), usage());
  other.notSent(other.begin());
  stopped(() => other.planRetry(0), 'retry_limit');
});

test('input reservations stay below 120k and output allowance shrinks to the remaining tokens', () => {
  const input = new QuestionBudget(newBatch());
  for (let i = 0; i < 3; i++) input.settle(input.begin(), usage(32_000, 40));
  stopped(() => input.begin(), 'input_limit');
  assert.equal(input.input, 96_000);
  const output = new QuestionBudget(newBatch());
  output.settle(output.begin(), usage(240, 4000));
  output.settle(output.begin(), usage(240, 4000));
  const last = output.begin();
  assert.equal(last.outputLimit, 192);
  assert.equal(last.reservedMicroYuan, 65_536);
  output.settle(last, usage(240, 192));
  stopped(() => output.begin(), 'output_limit');
  assert.equal(output.output, CAPS.output);
});

test('question, batch pause and total money guards act before a request, using integer micro-yuan', () => {
  const budget = new QuestionBudget(newBatch(), { questionMicroYuan: 96_768 });
  budget.settle(budget.begin(), usage());
  stopped(() => budget.begin(), 'question_budget');
  stopped(() => new QuestionBudget(newBatch(7_950_000)).begin(), 'batch_pause');
  stopped(() => new QuestionBudget(newBatch(9_950_000)).begin(), 'total_budget');
  const between = new QuestionBudget(newBatch(7_902_800));
  between.settle(between.begin(), usage());
  stopped(() => between.begin(), 'batch_pause');
});

test('request timeout uses the remaining question time; retry waits cannot exceed it', () => {
  let now = 0;
  const budget = new QuestionBudget(newBatch(), { now: () => now });
  assert.equal(budget.begin().timeoutMs, 60_000);
  budget.notSent(budget.pending);
  now = 119_900;
  assert.equal(budget.begin().timeoutMs, 100);
  budget.notSent(budget.pending);
  stopped(() => budget.planRetry(250), 'question_timeout');
  const expired = new QuestionBudget(newBatch(), { now: () => now });
  now += 120_000;
  stopped(() => expired.begin(), 'question_timeout');
  for (const settings of [{ requestMs: 60_001 }, { questionMs: 120_001 }, { questionMicroYuan: 500_001 }]) {
    assert.throws(() => new QuestionBudget(newBatch(), settings), /lower/);
  }
});

test('only an exact transient DNS failure for the fixed origin proves no request was sent', () => {
  const cause = { code: 'EAI_AGAIN', syscall: 'getaddrinfo', hostname: 'api.deepseek.com' };
  assert(definitelyUnsentDns({ cause }));
  for (const error of [{}, { code: 'EAI_AGAIN' }, { cause: { ...cause, code: 'ECONNRESET' } },
    { cause: { ...cause, syscall: 'connect' } }, { cause: { ...cause, hostname: 'other.invalid' } }]) {
    assert.equal(definitelyUnsentDns(error), false);
  }
});
