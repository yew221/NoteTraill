import type { Id } from '../shared/contracts.js';
import { ApiError } from './contracts.js';
import type { ModelSettings } from './model-settings.js';
import type { ModelLedger } from './model-ledger.js';
import { ModelTransport } from './model-transport.js';
import type { SqliteDatabase } from './storage.js';

export class ModelProbeService {
  constructor(private readonly db: SqliteDatabase, private readonly settings: ModelSettings,
    readonly ledger: ModelLedger, private readonly batchId: string, private readonly fetcher: typeof fetch = fetch) {}
  register(runId: Id<'run'>): void {
    if (!this.db.inTransaction) throw new ApiError('SERVICE_UNAVAILABLE');
    const model = this.settings.view();
    if (!model.model || !model.credentialConfigured) throw new ApiError('CONFIG_REQUIRED');
    this.db.prepare('INSERT INTO model_probes(run_id,model_revision) VALUES (?,?)').run(runId, model.revision);
  }
  check(runId: string): number {
    const row = this.db.prepare('SELECT model_revision FROM model_probes WHERE run_id=?').get(runId) as { model_revision: number } | undefined;
    if (!row) throw new ApiError('SERVICE_UNAVAILABLE');
    if (this.settings.view().revision !== row.model_revision) throw new ApiError('CONTEXT_CHANGED');
    return row.model_revision;
  }
  async execute(runId: Id<'run'>, signal: AbortSignal): Promise<{ modelAvailable: true; modelRevision: number }> {
    const revision = this.check(runId);
    this.ledger.start(runId, this.batchId, { maxRequests: 2, maxInputTokens: 16384, requestInputTokens: 8192,
      maxOutputTokens: 32, requestOutputTokens: 32, requestMs: 15000, questionMs: 20000 });
    const transport = new ModelTransport(this.ledger, this.settings, runId, revision, signal, this.fetcher);
    try { await transport.probe(); this.check(runId); this.settings.recordProbe(revision, true); return { modelAvailable: true, modelRevision: revision }; }
    catch (error) { this.settings.recordProbe(revision, false); throw error; }
    finally { transport.close(); this.ledger.abandon(runId); }
  }
}
