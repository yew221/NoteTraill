import { isModelPricing, type ModelPricing } from '../shared/model-profiles.js';
import { WEB_SEARCH_LIMITS } from '../shared/tools.js';
import type { ModelConfig } from '../shared/model.js';
import { randomUUID } from 'node:crypto';
import { isId, type Id } from '../shared/contracts.js';
import { isRawUsage, MODEL_LIMITS, type ModelLimits, type ModelReservation, type ModelTotals } from '../shared/model-run.js';
import { ApiError } from './contracts.js';
import type { ErrorCode } from '../shared/api.js';
import type { SqliteDatabase } from './storage.js';

// Peak, uncached CNY rates checked against DeepSeek's official price page on 2026-11-13.
export const costMicroYuan = (input: number, output: number): number => input * 2 + output * 8;
type RunRow = { run_id: string; batch_id: string; deadline: number; limits_json: string; retries: number };
type Attempt = { id: string; run_id: string; ordinal: number; state: string; input_reserved: number; output_limit: number;
  reserved_micro_yuan: number; input_tokens: number | null; output_tokens: number | null; cost_micro_yuan: number | null; input_rate: number; output_rate: number };
const held = "state IN ('reserved','sent','unknown')";
type SearchAttempt = { id: string; run_id: string; state: string; reserved_micro_yuan: number; cost_micro_yuan: number | null };
// DeepSeek Search: CNY 5 / 1,000 successful requests, checked 2026-11-16.
export const SEARCH_COST_MICRO_YUAN = 5000;

export class ModelLedger {
  constructor(private readonly db: SqliteDatabase, private readonly now = Date.now) {}
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { if (this.db.inTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  batch(id: string, baselineMicroYuan = 0): void {
    if (!/^[a-z0-9-]{1,64}$/.test(id) || !Number.isSafeInteger(baselineMicroYuan) || baselineMicroYuan < 0) throw new ApiError('BAD_REQUEST');
    this.db.prepare('INSERT OR IGNORE INTO model_batches(id,baseline_micro_yuan,spent_micro_yuan) VALUES (?,?,?)').run(id, baselineMicroYuan, baselineMicroYuan);
    const row = this.db.prepare('SELECT baseline_micro_yuan FROM model_batches WHERE id=?').get(id) as { baseline_micro_yuan: number };
    if (row.baseline_micro_yuan !== baselineMicroYuan) throw new ApiError('CONTEXT_CHANGED');
  }
  start(runId: Id<'run'>, batchId: string, limits: Partial<ModelLimits> = {}): void {
    // Legacy budget settings and pause flags are retained as history, never enforced.
    const ceiling = MODEL_LIMITS;
    const actual = { ...ceiling, ...limits };
    if (!isId(runId, 'run') || Object.keys(limits).some(key => !Object.hasOwn(MODEL_LIMITS, key)) ||
      (Object.keys(actual) as Array<keyof ModelLimits>).some(key => !Number.isSafeInteger(actual[key]) ||
        actual[key] < (key === 'maxRetries' ? 0 : 1) || actual[key] > ceiling[key])) throw new ApiError('BAD_REQUEST');
    const run = this.db.prepare('SELECT state,kind,started_at FROM runs WHERE id=?').get(runId) as
      { state: string; kind: string; started_at: string | null } | undefined;
    if (run?.state !== 'running' || !['message','model_probe','answer_update'].includes(run.kind) || !run.started_at || !Number.isFinite(Date.parse(run.started_at))) throw new ApiError('RUN_INTERRUPTED');
    if (!this.db.prepare('SELECT id FROM model_batches WHERE id=?').get(batchId)) throw new ApiError('CONFIG_REQUIRED');
    this.db.prepare('INSERT INTO model_runs(run_id,batch_id,deadline,limits_json) VALUES (?,?,?,?)')
      .run(runId, batchId, Date.parse(run.started_at) + actual.questionMs, JSON.stringify(actual));
  }
  private run(runId: string): { row: RunRow; limits: ModelLimits } {
    const row = this.db.prepare('SELECT * FROM model_runs WHERE run_id=?').get(runId) as RunRow | undefined;
    if (!row) throw new ApiError('NOT_FOUND');
    return { row, limits: JSON.parse(row.limits_json) as ModelLimits };
  }
  private active(runId: string): { row: RunRow; limits: ModelLimits } {
    const value = this.run(runId), run = this.db.prepare('SELECT state FROM runs WHERE id=?').get(runId) as { state: string };
    if (run.state !== 'running') throw new ApiError('RUN_INTERRUPTED');
    if (this.now() >= value.row.deadline) throw new ApiError('DEADLINE_EXCEEDED');
    return value;
  }
  deadline(runId: string): number { return this.run(runId).row.deadline; }
  shouldCloseTools(runId: string): boolean {
    const { limits, row } = this.active(runId), usage = this.totals(runId);
    return usage.modelRequests >= limits.maxRequests - 2 || limits.maxOutputTokens - usage.knownOutputTokens <= limits.requestOutputTokens ||
      row.deadline - this.now() < limits.requestMs + 10000;
  }
  totals(runId: string): ModelTotals {
    const { row } = this.run(runId);
    const attempts = this.db.prepare('SELECT * FROM model_attempts WHERE run_id=? ORDER BY ordinal').all(runId) as Attempt[];
    const known = attempts.filter(a => a.state === 'settled'), pending = attempts.filter(a => ['sent','unknown','reserved'].includes(a.state));
    const input = known.reduce((n, a) => n + a.input_tokens!, 0), output = known.reduce((n, a) => n + a.output_tokens!, 0);
    const searches = this.db.prepare('SELECT * FROM search_attempts WHERE run_id=?').all(runId) as SearchAttempt[];
    const searchHeld = searches.filter(a => ['reserved','sent','unknown'].includes(a.state));
    const cost = known.reduce((n, a) => n + a.cost_micro_yuan!, 0) + searches.reduce((n, a) => n + (a.cost_micro_yuan ?? 0), 0);
    return { inputTokens: pending.length ? null : input, outputTokens: pending.length ? null : output, modelRequests: attempts.length,
      knownInputTokens: input, knownOutputTokens: output, costMicroYuan: pending.length || searchHeld.length ? null : cost, knownCostMicroYuan: cost,
      reservedMicroYuan: [...pending, ...searchHeld].reduce((n, a) => n + a.reserved_micro_yuan, 0), retries: row.retries,
      ...(searches.length ? { searchRequests: searches.length } : {}) };
  }
  batchTotals(id: string): { spentMicroYuan: number; reservedMicroYuan: number } {
    const row = this.db.prepare('SELECT spent_micro_yuan FROM model_batches WHERE id=?').get(id) as
      { spent_micro_yuan: number } | undefined;
    if (!row) throw new ApiError('NOT_FOUND');
    const heldRow = this.db.prepare(`SELECT COALESCE(SUM(a.reserved_micro_yuan),0) AS n FROM model_attempts a
      JOIN model_runs r ON r.run_id=a.run_id WHERE r.batch_id=? AND a.${held}`).get(id) as { n: number };
    const searchHeld = this.db.prepare(`SELECT COALESCE(SUM(a.reserved_micro_yuan),0) AS n FROM search_attempts a
      JOIN model_runs r ON r.run_id=a.run_id WHERE r.batch_id=? AND a.${held}`).get(id) as { n: number };
    return { spentMicroYuan: row.spent_micro_yuan, reservedMicroYuan: heldRow.n + searchHeld.n };
  }
  reserve(runId: string, pricing: ModelPricing = { input: 2, output: 8 }, config?: ModelConfig, inputReserved?: number): ModelReservation {
    if (!isModelPricing(pricing)) throw new ApiError('MODEL_PRICING_REQUIRED');
    return this.transaction(() => {
      const { row, limits } = this.active(runId), usage = this.totals(runId);
      const input = inputReserved ?? limits.requestInputTokens;
      if (!Number.isSafeInteger(input) || input < 1 || input > limits.requestInputTokens) throw new ApiError('BUDGET_EXCEEDED');
      if (this.inFlight(row.batch_id)) throw new ApiError('MODEL_REQUEST_BUSY');
      if (usage.modelRequests >= limits.maxRequests || usage.knownInputTokens + input > limits.maxInputTokens) throw new ApiError('BUDGET_EXCEEDED');
      const output = Math.min(limits.requestOutputTokens, limits.maxOutputTokens - usage.knownOutputTokens);
      if (output < 1) throw new ApiError('BUDGET_EXCEEDED');
      const cost = Math.ceil(input * pricing.input + output * pricing.output);
      const id = randomUUID(), number = usage.modelRequests + 1;
      this.db.prepare(`INSERT INTO model_attempts(id,run_id,ordinal,state,input_reserved,output_limit,reserved_micro_yuan,created_at,input_rate,output_rate,model_config_json)
        VALUES (?,?,?,'reserved',?,?,?,?,?,?,?)`).run(id, runId, number, input, output, cost, new Date(this.now()).toISOString(), pricing.input, pricing.output, config ? JSON.stringify(config) : null);
      return { id, number, inputReserved: input, outputLimit: output, timeoutMs: Math.min(limits.requestMs, row.deadline - this.now()) };
    });
  }
  private inFlight(batchId: string): boolean {
    return !!this.db.prepare(`SELECT a.id FROM model_attempts a JOIN model_runs r ON r.run_id=a.run_id
      WHERE r.batch_id=? AND a.state IN ('reserved','sent') UNION ALL SELECT a.id FROM search_attempts a JOIN model_runs r ON r.run_id=a.run_id
      WHERE r.batch_id=? AND a.state IN ('reserved','sent') LIMIT 1`).get(batchId, batchId);
  }
  reserveSearch(runId: string): string {
    return this.transaction(() => {
      const { row } = this.active(runId), usage = this.totals(runId);
      if (this.inFlight(row.batch_id) || (usage.searchRequests ?? 0) >= WEB_SEARCH_LIMITS.calls) throw new ApiError('SEARCH_LIMIT_REACHED');
      const id = randomUUID();
      this.db.prepare("INSERT INTO search_attempts(id,run_id,state,reserved_micro_yuan,created_at) VALUES (?,?,'reserved',?,?)")
        .run(id, runId, SEARCH_COST_MICRO_YUAN, new Date(this.now()).toISOString());
      return id;
    });
  }
  sentSearch(id: string): void {
    const row = this.db.prepare('SELECT * FROM search_attempts WHERE id=?').get(id) as SearchAttempt | undefined;
    if (!row || row.state !== 'reserved') throw new ApiError('MODEL_PROTOCOL_ERROR');
    this.active(row.run_id); this.db.prepare("UPDATE search_attempts SET state='sent' WHERE id=?").run(id);
  }
  endSearch(id: string, result: 'charged' | 'free' | 'unknown' | 'not_sent'): void {
    this.transaction(() => {
      const a = this.db.prepare('SELECT * FROM search_attempts WHERE id=?').get(id) as SearchAttempt | undefined;
      if (!a || !['reserved','sent'].includes(a.state) || (a.state === 'reserved' && result !== 'not_sent')) throw new ApiError('MODEL_PROTOCOL_ERROR');
      const cost = result === 'charged' ? a.reserved_micro_yuan : result === 'unknown' ? null : 0;
      this.db.prepare('UPDATE search_attempts SET state=?,cost_micro_yuan=?,ended_at=? WHERE id=?')
        .run(result === 'unknown' || result === 'not_sent' ? result : 'settled', cost, new Date(this.now()).toISOString(), id);
      if (cost) this.db.prepare('UPDATE model_batches SET spent_micro_yuan=spent_micro_yuan+? WHERE id=?').run(cost, this.run(a.run_id).row.batch_id);
      // Unknown searches retain their estimate, never as settled spend.
    });
  }
  private attempt(id: string): Attempt {
    const row = this.db.prepare('SELECT * FROM model_attempts WHERE id=?').get(id) as Attempt | undefined;
    if (!row) throw new ApiError('NOT_FOUND');
    return row;
  }
  sent(id: string, bytes: number, hash: string, outputLimit?: number): void {
    const row = this.attempt(id); this.active(row.run_id);
    const actual = outputLimit ?? row.output_limit;
    if (row.state !== 'reserved' || !Number.isSafeInteger(bytes) || bytes <= 0 || !/^[a-f0-9]{64}$/.test(hash) ||
      !Number.isSafeInteger(actual) || actual < 1 || actual > row.output_limit) throw new ApiError('MODEL_PROTOCOL_ERROR');
    this.db.prepare("UPDATE model_attempts SET state='sent',payload_bytes=?,payload_hash=?,output_limit=? WHERE id=?").run(bytes, hash, actual, id);
  }
  notSent(id: string): void {
    const row = this.attempt(id);
    if (!['reserved','sent'].includes(row.state)) throw new ApiError('MODEL_PROTOCOL_ERROR');
    this.db.prepare("UPDATE model_attempts SET state='not_sent',ended_at=? WHERE id=?").run(new Date(this.now()).toISOString(), id);
  }
  retry(runId: string): void {
    const { row, limits } = this.active(runId);
    const last = this.db.prepare('SELECT state FROM model_attempts WHERE run_id=? ORDER BY ordinal DESC LIMIT 1').get(runId) as { state: string } | undefined;
    if (last?.state !== 'not_sent' || row.retries >= limits.maxRetries) throw new ApiError('BUDGET_EXCEEDED');
    this.db.prepare('UPDATE model_runs SET retries=retries+1 WHERE run_id=?').run(runId);
  }
  unknown(id: string, code: ErrorCode): void {
    const row = this.attempt(id);
    if (!['reserved','sent'].includes(row.state)) throw new ApiError('MODEL_PROTOCOL_ERROR');
    this.transaction(() => {
      this.db.prepare("UPDATE model_attempts SET state='unknown',failure_code=?,ended_at=? WHERE id=?")
        .run(code, new Date(this.now()).toISOString(), id);
    });
  }
  settle(id: string, usage: unknown, returnedModel: string): void {
    const attempt = this.attempt(id);
    if (attempt.state !== 'sent') throw new ApiError('MODEL_PROTOCOL_ERROR');
    if (!isRawUsage(usage) || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(returnedModel)) {
      this.unknown(id, 'MODEL_PROTOCOL_ERROR'); throw new ApiError('MODEL_PROTOCOL_ERROR');
    }
    const { row, limits } = this.run(attempt.run_id), total = this.totals(attempt.run_id);
    const cost = Math.ceil(usage.prompt_tokens * attempt.input_rate + usage.completion_tokens * attempt.output_rate);
    if (!Number.isSafeInteger(cost)) { this.unknown(id, 'MODEL_PROTOCOL_ERROR'); throw new ApiError('MODEL_PROTOCOL_ERROR'); }
    const violation = usage.prompt_tokens > attempt.input_reserved || usage.completion_tokens > attempt.output_limit ||
      total.knownInputTokens + usage.prompt_tokens > limits.maxInputTokens || total.knownOutputTokens + usage.completion_tokens > limits.maxOutputTokens;
    this.transaction(() => {
      this.db.prepare(`UPDATE model_attempts SET state='settled',input_tokens=?,output_tokens=?,cost_micro_yuan=?,returned_model=?,failure_code=?,ended_at=? WHERE id=?`)
        .run(usage.prompt_tokens, usage.completion_tokens, cost, returnedModel, violation ? 'BUDGET_EXCEEDED' : null, new Date(this.now()).toISOString(), id);
      this.db.prepare('UPDATE model_batches SET spent_micro_yuan=spent_micro_yuan+? WHERE id=?').run(cost, row.batch_id);
    });
    if (violation) throw new ApiError('BUDGET_EXCEEDED');
  }
  abandon(runId: string, code: ErrorCode = 'RUN_INTERRUPTED'): void {
    const attempts = this.db.prepare(`SELECT * FROM model_attempts WHERE run_id=? AND state IN ('reserved','sent')`).all(runId) as Attempt[];
    for (const row of attempts) {
      if (row.state === 'reserved') this.notSent(row.id); else this.unknown(row.id, code);
    }
    const searches = this.db.prepare("SELECT * FROM search_attempts WHERE run_id=? AND state IN ('reserved','sent')").all(runId) as SearchAttempt[];
    for (const a of searches) this.endSearch(a.id, a.state === 'reserved' ? 'not_sent' : 'unknown');
  }
  recover(): void {
    const rows = this.db.prepare("SELECT run_id FROM model_attempts WHERE state IN ('reserved','sent') UNION SELECT run_id FROM search_attempts WHERE state IN ('reserved','sent')").all() as { run_id: string }[];
    for (const row of rows) this.abandon(row.run_id);
  }
}
