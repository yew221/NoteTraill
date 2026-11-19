// T01-F verification policy. This is not a durable product billing service.
import assert from 'node:assert/strict';
import { usageCost } from './deepseek_checks.mjs';

export const CAPS = Object.freeze({ attempts: 6, retries: 1, input: 120_000, output: 8192,
  requestInput: 32_000, requestOutput: 4096, questionMicroYuan: 500_000,
  pauseMicroYuan: 8_000_000, totalMicroYuan: 10_000_000, requestMs: 60_000, questionMs: 120_000 });

export class BudgetStop extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function newBatch(spentMicroYuan = 0) {
  assert(Number.isSafeInteger(spentMicroYuan) && spentMicroYuan >= 0 && spentMicroYuan <= CAPS.totalMicroYuan);
  return { spentMicroYuan, reservedMicroYuan: 0, paused: false };
}

export class QuestionBudget {
  constructor(batch, { now = () => performance.now(), record = () => {}, requestMs = CAPS.requestMs,
    questionMs = CAPS.questionMs, questionMicroYuan = CAPS.questionMicroYuan } = {}) {
    for (const [value, cap] of [[requestMs, CAPS.requestMs], [questionMs, CAPS.questionMs], [questionMicroYuan, CAPS.questionMicroYuan]]) {
      assert(Number.isInteger(value) && value > 0 && value <= cap, 'test overrides may only lower confirmed caps');
    }
    this.batch = batch;
    this.now = now;
    this.record = record;
    this.deadline = now() + questionMs;
    this.requestMs = requestMs;
    this.questionMicroYuan = questionMicroYuan;
    this.input = 0; this.output = 0; this.costMicroYuan = 0; this.retries = 0;
    this.attempts = []; this.pending = null; this.stopped = null;
  }

  snapshot() {
    return structuredClone({ input: this.input, output: this.output, costMicroYuan: this.costMicroYuan,
      retries: this.retries, stopped: this.stopped, attempts: this.attempts, batch: this.batch });
  }

  note(event) { this.record({ event, ...this.snapshot() }); }

  stop(code) { this.stopped ??= code; this.note('stopped'); throw new BudgetStop(this.stopped); }

  begin() {
    if (this.stopped) throw new BudgetStop(this.stopped);
    if (this.batch.paused || this.batch.reservedMicroYuan > 0) this.stop('unresolved_usage');
    if (this.now() >= this.deadline) this.stop('question_timeout');
    if (this.attempts.length >= CAPS.attempts) this.stop('request_limit');
    if (this.input + CAPS.requestInput > CAPS.input) this.stop('input_limit');
    const output = Math.min(CAPS.requestOutput, CAPS.output - this.output);
    if (output <= 0) this.stop('output_limit');
    const reserve = CAPS.requestInput * 2 + output * 8;
    if (this.costMicroYuan + reserve > this.questionMicroYuan) this.stop('question_budget');
    if (this.batch.spentMicroYuan + reserve > CAPS.totalMicroYuan) this.stop('total_budget');
    if (this.batch.spentMicroYuan + reserve >= CAPS.pauseMicroYuan) this.stop('batch_pause');
    const attempt = { number: this.attempts.length + 1, state: 'reserved', inputUpper: CAPS.requestInput,
      outputLimit: output, reservedMicroYuan: reserve, timeoutMs: Math.min(this.requestMs, this.deadline - this.now()) };
    this.attempts.push(attempt); this.pending = attempt;
    this.batch.reservedMicroYuan = reserve;
    // The caller writes this snapshot before invoking the transport.
    this.note('reserved');
    return attempt;
  }

  requirePending(attempt) { assert(this.pending === attempt && attempt.state === 'reserved', 'duplicate or foreign settlement'); }

  notSent(attempt) {
    this.requirePending(attempt);
    attempt.state = 'not_sent'; attempt.costMicroYuan = 0;
    this.batch.reservedMicroYuan = 0; this.pending = null;
    this.note('not_sent');
  }

  settle(attempt, usage) {
    this.requirePending(attempt);
    let cost;
    try {
      cost = usageCost(usage);
      assert(usage.prompt_tokens <= attempt.inputUpper && usage.completion_tokens <= attempt.outputLimit);
    } catch { this.unknown(attempt, 'usage_invalid'); }
    this.input += usage.prompt_tokens; this.output += usage.completion_tokens;
    this.costMicroYuan += cost; this.batch.spentMicroYuan += cost;
    this.batch.reservedMicroYuan = 0; this.pending = null;
    Object.assign(attempt, { state: 'settled', input: usage.prompt_tokens, output: usage.completion_tokens, costMicroYuan: cost });
    this.note('settled');
  }

  unknown(attempt, code = 'usage_unknown') {
    this.requirePending(attempt);
    attempt.state = 'unknown'; this.batch.paused = true; this.pending = null;
    // Keep the whole reservation; a later question sharing this batch must stop too.
    this.stop(code);
  }

  planRetry(delayMs) {
    assert(!this.pending && Number.isInteger(delayMs) && delayMs >= 0);
    if (this.stopped || this.batch.paused) this.stop(this.stopped ?? 'unresolved_usage');
    if (this.retries >= CAPS.retries) this.stop('retry_limit');
    if (this.now() + delayMs >= this.deadline) this.stop('question_timeout');
    this.retries++;
    this.note('retry_wait');
  }
}

export function definitelyUnsentDns(error) {
  // Narrow evidence: DNS resolution failed before a connection to the fixed origin.
  const cause = error?.cause;
  return cause?.code === 'EAI_AGAIN' && cause.syscall === 'getaddrinfo' && cause.hostname === 'api.deepseek.com';
}
