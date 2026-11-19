import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { makeError, type AppError } from '../shared/api.js';
import { canTransitionRun, type Id, type RunRef, type RunState,
  isIdempotencyIdentity, type IdempotencyIdentity } from '../shared/contracts.js';
import type { RunResult, Run, RunEvent } from '../shared/run.js';
import { isIngestInput, type IngestInput } from '../shared/ingest.js';
import type { Source } from '../shared/vault.js';
import type { IngestService, Upload } from './ingestions.js';
import { ApiError, checkIdempotency, newId, requireId, requireIdempotencyKey } from './contracts.js';
import type { SqliteDatabase } from './storage.js';
import type { VaultService } from './vaults.js';
import type { QuestionService, PreparedAnswer } from './questions.js';
import type { WorkerProgress } from './worker-runner.js';
import { isAnswerSelection } from '../shared/answer.js';
import type { ModelProbeService } from './model-probes.js';
import type { DeletionImpact } from '../shared/chat.js';
import { AnswerWatches } from './answer-watches.js';

type Row = { id: Id<'run'>; kind: Run['kind']; vault_id: Id<'vault'>; session_id: Id<'session'> | null; operation_id: string | null; state: RunState; stage: Run['stage'];
  resolved_action: Run['resolvedAction']; preview_text: string | null;
  source_id: string | null; expected_source_version: string | null; scope_revision: number | null;
  created_at: string; started_at: string | null; ended_at: string | null; result_json: string | null; error_json: string | null };
const EMPTY_PAYLOAD = createHash('sha256').update('{}').digest('hex');
const EVENT_TTL = 24 * 60 * 60 * 1000;

export class RunService {
  readonly watches?: AnswerWatches;
  private readonly changes = new EventEmitter();
  private processing?: Promise<void>;
  private scheduled?: NodeJS.Immediate;
  private active?: { id: string; abort: AbortController };
  private closed = false;
  constructor(private readonly db: SqliteDatabase, private readonly vaults: VaultService, private readonly ingestions?: IngestService,
    private readonly questions?: QuestionService, private readonly probes?: ModelProbeService) {
    // A restart never reruns persisted work, including queued work.
    const unfinished = db.prepare("SELECT id,kind,state FROM runs WHERE state NOT IN ('succeeded','failed','cancelled','interrupted')").all() as { id: string;kind:string;state:string }[];
    for (const row of unfinished) this.finish(row.id, 'interrupted', null, makeError('RUN_INTERRUPTED'));
    // Only work that never started can be automatically replaced on restart. Sent/unknown calls retain their ledger and require a visible retry.
    for(const row of unfinished) if(row.kind==='answer_update' && row.state==='queued') db.prepare(`UPDATE answer_watches SET attempted_hash=NULL,revision=revision+1
      WHERE enabled=1 AND id IN (SELECT watch_id FROM answer_watch_runs WHERE run_id=?)`).run(row.id);
    // A normal shutdown already marked queued jobs interrupted; started_at distinguishes them from paid/uncertain work.
    db.prepare(`UPDATE answer_watches SET attempted_hash=NULL,revision=revision+1 WHERE enabled=1 AND attempted_hash IS NOT NULL
      AND EXISTS (SELECT 1 FROM answer_watch_runs j JOIN runs r ON r.id=j.run_id WHERE j.watch_id=answer_watches.id
        AND j.watch_revision=answer_watches.revision AND j.catalog_hash=answer_watches.attempted_hash AND r.state='interrupted' AND r.started_at IS NULL)`).run();
    if (questions) this.watches = new AnswerWatches(db, vaults, questions, {
      enqueue: (row, snapshot, fingerprint) => this.enqueue({
        key: createHash('sha256').update(`answer-watch:${row.id}:${row.revision}:${row.observation}:${fingerprint}`).digest('hex'),
        operation: 'answer.update', scopeId: row.id, payloadHash: fingerprint,
      }, 'answer_update', row.vault_id, id => this.watches!.register(id,row,snapshot,fingerprint)).ref,
      cancel: id => this.cancel(id),
    });
    this.pruneEvents();
  }
  private row(id: string): Row {
    requireId(id, 'run');
    const row = this.db.prepare(`SELECT r.* FROM runs r LEFT JOIN conversations c ON c.id=r.session_id
      WHERE r.id=? AND c.deletion_state IS NULL`).get(id) as Row | undefined;
    if (!row) throw new ApiError('NOT_FOUND');
    return row;
  }
  get(id: string): Run {
    const row = this.row(id);
    const attachment = row.kind === 'ingest' && row.session_id ? this.db.prepare(
      "SELECT json_extract(input_json,'$.attachment.sourceId') AS id FROM messages WHERE session_id=? AND run_id=?").get(row.session_id, id) as {id:Id<'source'> | null} | undefined : undefined;
    const ledger = this.questions?.ledger ?? this.probes?.ledger;
    const model = ledger && this.db.prepare('SELECT run_id FROM model_runs WHERE run_id=?').get(id) ? ledger.totals(id) : null;
    const tools = this.db.prepare('SELECT tool_calls,read_bytes FROM tool_usage WHERE run_id=?').get(id) as { tool_calls: number; read_bytes: number } | undefined;
    return { ...(attachment?.id ? { attachmentSourceId: attachment.id } : {}), ...(row.state !== 'succeeded' && row.preview_text ? { preview: row.preview_text } : {}), id: row.id, kind: row.kind, state: row.state, sessionId: row.session_id, vaultId: row.vault_id,
      resolvedAction: row.resolved_action ?? (row.kind === 'ingest' ? 'ingest' : null), stage: row.stage, createdAt: row.created_at, startedAt: row.started_at, endedAt: row.ended_at,
      result: row.result_json ? JSON.parse(row.result_json) as RunResult : null,
      error: row.error_json ? JSON.parse(row.error_json) as AppError : null,
      usage: { inputTokens: model ? model.inputTokens : 0, outputTokens: model ? model.outputTokens : 0, modelRequests: model?.modelRequests ?? 0,
        ...(model?.searchRequests ? { searchRequests: model.searchRequests } : {}),
        toolCalls: tools?.tool_calls ?? 0, readBytes: tools?.read_bytes ?? 0,
        cost: { value: model?.costMicroYuan === null ? null : (model?.costMicroYuan ?? 0) / 1000000,
          currency: 'CNY', basis: model?.costMicroYuan === null ? 'unknown' : 'estimate' } }, warnings: [] };
  }
  private ref(id: string): RunRef {
    const run = this.get(id);
    return { runId: run.id, state: run.state, eventsUrl: `/api/v1/runs/${run.id}/events` };
  }
  private event(id: string, type: RunEvent['type'], payload: object): void {
    this.db.prepare(`INSERT INTO run_events(run_id,event_id,type,at,payload_json)
      SELECT ?,COALESCE(MAX(event_id),0)+1,?,?,? FROM run_events WHERE run_id=?`)
      .run(id, type, new Date().toISOString(), JSON.stringify(payload), id);
  }
  message(sessionId: string, input: unknown, key: unknown): RunRef {
    if (this.closed || !this.questions) throw new ApiError('SERVICE_UNAVAILABLE');
    const normalized = this.questions.conversations.normalize(input), session = this.questions.conversations.get(sessionId);
    const identity: IdempotencyIdentity = { key: requireIdempotencyKey(key), operation: 'message.create', scopeId: session.id,
      payloadHash: createHash('sha256').update(JSON.stringify(normalized)).digest('hex') };
    // Pre-unified requests hashed a now-obsolete policy. Recover their original run, never resubmit it.
    const previous = this.db.prepare(`SELECT m.run_id,m.input_json FROM idempotency_records i JOIN messages m
      ON m.run_id=json_extract(i.result_json,'$.runId') WHERE i.key=? AND i.operation='message.create' AND i.scope_id=?
      AND m.session_id=?`).get(identity.key, session.id, session.id) as { run_id: string; input_json: string } | undefined;
    if (previous && JSON.stringify(this.questions.conversations.normalize(JSON.parse(previous.input_json))) === JSON.stringify(normalized)) {
      return this.ref(previous.run_id);
    }
    return this.enqueue(identity, 'message', session.vaultId, id => this.questions!.conversations.register(id, sessionId, normalized)).ref;
  }
  probe(key: unknown): RunRef {
    if (this.closed || !this.probes) throw new ApiError('SERVICE_UNAVAILABLE');
    const vault = this.vaults.list().items[0];
    if (!vault) throw new ApiError('CONFIG_REQUIRED');
    return this.enqueue({ key: requireIdempotencyKey(key), operation: 'model.probe', scopeId: vault.id, payloadHash: EMPTY_PAYLOAD },
      'model_probe', vault.id, id => this.probes!.register(id)).ref;
  }
  async saveAnswer(answerId: string, input: unknown, key: unknown): Promise<RunRef> {
    if (this.closed || !this.questions || !this.ingestions) throw new ApiError('SERVICE_UNAVAILABLE');
    const answer = requireId(answerId, 'answer');
    if (!isAnswerSelection(input)) throw new ApiError('BAD_REQUEST');
    const identity: IdempotencyIdentity = { key: requireIdempotencyKey(key), operation: 'answer.save', scopeId: answer,
      payloadHash: createHash('sha256').update(JSON.stringify({ expectedAnswerRevision: input.expectedAnswerRevision,
        selection: { start: input.selection.start, end: input.selection.end, expectedText: input.selection.expectedText }, title: input.title?.trim() ?? 'AI 整理选段' })).digest('hex') };
    const old = this.replay(identity); if (old) return old;
    const selected = await this.questions.answers.selection(answerId, input);
    const intake = { ...this.ingestions.normalize({ vaultId: selected.vaultId, input: { kind: 'text', text: selected.text, title: selected.title } }), origin: 'ai_saved' as const };
    const staged = await this.ingestions.stage(intake);
    let created = false;
    try {
      const accepted = this.enqueue(identity, 'ingest', intake.vaultId, id => {
        this.questions!.conversations.get(selected.sessionId);
        this.ingestions!.register(id, intake, staged);
        this.db.prepare("UPDATE runs SET session_id=?,resolved_action='save_answer' WHERE id=?").run(selected.sessionId, id);
      });
      created = accepted.created; return accepted.ref;
    } finally {
      if (!created) await this.ingestions.discard(staged, intake.version).catch(() => { /* Keep uncertain staged data. */ });
    }
  }
  refresh(vaultId: string, key: unknown): RunRef {
    if (this.closed) throw new ApiError('SERVICE_UNAVAILABLE');
    const vault = this.vaults.get(vaultId);
    const identity: IdempotencyIdentity = { key: requireIdempotencyKey(key), operation: 'vault.refresh',
      scopeId: vault.id, payloadHash: EMPTY_PAYLOAD };
    return this.enqueue(identity, 'refresh', vault.id).ref;
  }
  private replay(identity: IdempotencyIdentity): RunRef | undefined {
    const old = this.db.prepare('SELECT * FROM idempotency_records WHERE key=?').get(identity.key) as
      { key: string; operation: string; scope_id: string; payload_hash: string; result_json: string } | undefined;
    const recorded = old ? { key: old.key, operation: old.operation, scopeId: old.scope_id, payloadHash: old.payload_hash } : null;
    if (recorded && !isIdempotencyIdentity(recorded)) throw new ApiError('SERVICE_UNAVAILABLE');
    checkIdempotency(recorded, identity);
    return old ? this.ref(requireId((JSON.parse(old.result_json) as RunRef).runId, 'run')) : undefined;
  }
  retry(sourceId: string, key: unknown): RunRef {
    if (this.closed || !this.ingestions) throw new ApiError('SERVICE_UNAVAILABLE');
    const source = this.vaults.source(sourceId);
    const identity: IdempotencyIdentity = { key: requireIdempotencyKey(key), operation: 'source.retry', scopeId: source.id, payloadHash: EMPTY_PAYLOAD };
    const old = this.replay(identity); if (old) return old;
    if (source.state === 'missing') throw new ApiError('SOURCE_MISSING', { sourceId: source.id });
    if (source.state === 'excluded') throw new ApiError('SOURCE_EXCLUDED', { sourceId: source.id });
    const revision = this.vaults.get(source.vaultId).revision;
    return this.enqueue(identity, 'ingest', source.vaultId, id => {
      this.db.prepare('UPDATE runs SET source_id=?,expected_source_version=?,scope_revision=? WHERE id=?')
        .run(source.id, source.version, revision, id);
    }).ref;
  }
  async ingest(input: IngestInput, key: unknown, upload?: Upload): Promise<RunRef> {
    if (this.closed || !this.ingestions) throw new ApiError('SERVICE_UNAVAILABLE');
    if (!isIngestInput(input)) throw new ApiError('BAD_REQUEST');
    if (input.input.kind === 'url') {
      if (upload) throw new ApiError('BAD_REQUEST');
      const web = this.ingestions.normalizeWeb(input);
      const identity: IdempotencyIdentity = { key: requireIdempotencyKey(key), operation: 'ingest.create', scopeId: web.vaultId, payloadHash: web.payloadHash };
      return this.enqueue(identity, 'ingest', web.vaultId, id => this.ingestions!.registerWeb(id, web)).ref;
    }
    const intake = this.ingestions.normalize(input, upload);
    const identity: IdempotencyIdentity = { key: requireIdempotencyKey(key), operation: 'ingest.create',
      scopeId: intake.vaultId, payloadHash: input.conversation ? createHash('sha256').update(JSON.stringify({
        file: intake.payloadHash, sessionId: input.conversation.sessionId, text: input.conversation.text.trim(),
      })).digest('hex') : intake.payloadHash };
    const old = this.replay(identity); if (old) return old;
    if (input.conversation && (!this.questions || this.questions.conversations.get(input.conversation.sessionId).vaultId !== input.vaultId)) throw new ApiError('BAD_REQUEST');
    const staged = await this.ingestions.stage(intake);
    let created = false;
    try {
      const accepted = this.enqueue(identity, 'ingest', intake.vaultId, id => {
        this.ingestions!.register(id, intake, staged);
        if (input.conversation) {
          const message = { text: input.conversation.text.trim(), scope: { mode: 'vault' as const }, action: 'ask' as const,
            attachment: { name: intake.filename, sourceId: staged.sourceId } };
          this.questions!.conversations.register(id, input.conversation.sessionId, message);
          this.db.prepare("UPDATE runs SET resolved_action='ingest' WHERE id=?").run(id);
        }
      });
      created = accepted.created;
      return accepted.ref;
    } finally {
      if (!created) await this.ingestions.discard(staged, intake.version).catch(() => { /* Preserve uncertain staged data. */ });
    }
  }
  private enqueue(identity: IdempotencyIdentity, kind: Run['kind'], vaultId: Id<'vault'>,
    register?: (id: Id<'run'>) => void): { ref: RunRef; created: boolean } {
    if (this.closed) throw new ApiError('SERVICE_UNAVAILABLE');
    this.db.exec('BEGIN IMMEDIATE');
    let runId: Id<'run'>, created = false;
    try {
      const old = this.replay(identity);
      if (old) {
        runId = old.runId;
      } else {
        runId = newId('run');
        this.db.prepare("INSERT INTO runs(id,kind,vault_id,state,created_at) VALUES (?,?,?,'queued',?)")
          .run(runId, kind, vaultId, new Date().toISOString());
        register?.(runId); created = true;
        this.event(runId, 'run.state', { state: 'queued', stage: null });
        this.db.prepare('INSERT INTO idempotency_records(key,operation,scope_id,payload_hash,result_json) VALUES (?,?,?,?,?)')
          .run(identity.key, identity.operation, identity.scopeId, identity.payloadHash, JSON.stringify(this.ref(runId)));
      }
      this.db.exec('COMMIT');
    } catch (error) { if (this.db.inTransaction) this.db.exec('ROLLBACK'); throw error; }
    const result = this.ref(runId);
    if (!this.scheduled && !this.processing) this.scheduled = setImmediate(() => {
      this.scheduled = undefined;
      if (!this.closed) this.processing = this.drain().catch(() => {
        // Storage failure must not become an unhandled process rejection. Restart recovers unfinished runs.
        console.error('任务未能完成状态记录，请检查本机存储并重启服务。');
      }).finally(() => { this.processing = undefined; });
    });
    return { ref: result, created };
  }
  private async drain(): Promise<void> {
    while (!this.closed) {
      const next = this.db.prepare("SELECT id,kind FROM runs WHERE state='queued' ORDER BY (kind='answer_update'),created_at,id LIMIT 1").get() as { id: string; kind: Run['kind'] } | undefined;
      if (!next) return;
      const stage = next.kind === 'ingest' ? 'saving' : ['message','model_probe','answer_update'].includes(next.kind) ? 'preparing' : 'scanning';
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare("UPDATE runs SET state='running',stage=?,started_at=? WHERE id=? AND state='queued'")
          .run(stage, new Date().toISOString(), next.id);
        this.event(next.id, 'run.state', { state: 'running', stage });
        this.db.exec('COMMIT');
      } catch (error) { if (this.db.inTransaction) this.db.exec('ROLLBACK'); throw error; }
      const abort = new AbortController(); this.active = { id: next.id, abort };
      this.changes.emit(next.id);
      try {
        const run = this.get(next.id);
        let result: RunResult | null = null, prepared: PreparedAnswer | undefined;
        if (run.kind === 'message') {
          if (!this.questions) throw new ApiError('SERVICE_UNAVAILABLE');
          prepared = await this.questions.execute(run.id, abort.signal, event => this.progress(run.id, event));
        } else if (run.kind === 'answer_update') {
          if (!this.watches) throw new ApiError('SERVICE_UNAVAILABLE');
          prepared = await this.watches.execute(run.id, abort.signal, event => this.progress(run.id,event));
        } else if (run.kind === 'model_probe') {
          if (!this.probes) throw new ApiError('SERVICE_UNAVAILABLE');
          this.progress(run.id, { stage: 'generating' });
          result = await this.probes.execute(run.id, abort.signal);
        } else if (run.kind === 'ingest') {
          const row = this.row(next.id);
          if (!this.ingestions) throw new ApiError('SERVICE_UNAVAILABLE');
          if (row.source_id && row.scope_revision !== null) result = await this.ingestions.retry(row.source_id,
            row.expected_source_version, row.scope_revision, abort.signal, source => this.sourceUpdated(next.id, source));
          else if (row.operation_id) result = await this.ingestions.execute(row.operation_id, abort.signal, source => this.sourceUpdated(next.id, source));
          else throw new ApiError('SERVICE_UNAVAILABLE');
        } else {
          result = await this.vaults.refresh(run.vaultId, abort.signal, source => this.sourceUpdated(next.id, source));
        }
        if (abort.signal.aborted) {
          const cancelled = this.get(next.id).state === 'cancelling';
          this.finish(next.id, cancelled ? 'cancelled' : 'interrupted', null, cancelled ? null : makeError('RUN_INTERRUPTED'));
          continue;
        }
        this.finish(next.id, 'succeeded', result, null, prepared);
      } catch (error) {
        const run = this.get(next.id);
        if (run.state === 'cancelling') this.finish(next.id, 'cancelled', null, null);
        else if (this.closed) this.finish(next.id, 'interrupted', null, makeError('RUN_INTERRUPTED'));
        else this.finish(next.id, 'failed', null, error instanceof ApiError ? error.publicError : makeError('SERVICE_UNAVAILABLE'));
      } finally { this.active = undefined; }
    }
  }
  private progress(id: string, event: WorkerProgress): void {
    if (this.row(id).state !== 'running') return;
    if (event.preview !== undefined) {
      if (typeof event.preview !== 'string' || event.preview.length > 48000) throw new ApiError('MODEL_PROTOCOL_ERROR');
      this.db.prepare('UPDATE runs SET preview_text=? WHERE id=?').run(event.preview, id);
      this.event(id, 'answer.preview', { text: event.preview });
      // Keep one bounded snapshot for reconnect/history, not a copy for every token.
      this.db.prepare("DELETE FROM run_events WHERE run_id=? AND type='answer.preview' AND event_id < (SELECT MAX(event_id) FROM run_events WHERE run_id=? AND type='answer.preview')").run(id, id);
      this.changes.emit(id);
    }
    if (this.row(id).stage === event.stage) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE runs SET stage=? WHERE id=?').run(event.stage, id);
      this.event(id, 'run.state', { state: 'running', stage: event.stage });
      this.db.exec('COMMIT');
    } catch (error) { if (this.db.inTransaction) this.db.exec('ROLLBACK'); throw error; }
    this.changes.emit(id);
  }
  private sourceUpdated(id: string, source: Source): void {
    if (this.row(id).state !== 'running') return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const stage = source.origin === 'web_snapshot' && !source.originalSaved && !source.capturedAt ? 'fetching' :
        source.state === 'pending' ? 'checking' : source.state === 'processing' ? 'converting' : 'publishing';
      this.db.prepare('UPDATE runs SET stage=? WHERE id=?').run(stage, id);
      this.event(id, 'run.state', { state: 'running', stage });
      this.event(id, 'source.updated', { sourceId: source.id, sourceState: source.state });
      this.db.exec('COMMIT');
    } catch (error) { if (this.db.inTransaction) this.db.exec('ROLLBACK'); throw error; }
    this.changes.emit(id);
  }
  private finish(id: string, state: 'succeeded' | 'failed' | 'cancelled' | 'interrupted', result: RunResult | null, error: AppError | null,
    prepared?: PreparedAnswer): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.row(id);
      if (!canTransitionRun(row.state, state)) { this.db.exec('COMMIT'); return; }
      if (row.kind === 'ingest' && row.state === 'queued' && (state === 'cancelled' || state === 'interrupted')) {
        this.db.prepare(`UPDATE sources SET state='failed', warnings_json=?, updated_at=?
          WHERE id=COALESCE((SELECT source_id FROM ingest_operations WHERE id=?), ?) AND original_saved=0 AND state='pending'`)
          .run(JSON.stringify(['RUN_INTERRUPTED']), new Date().toISOString(), row.operation_id, row.source_id);
      }
      if (state === 'succeeded' && row.kind === 'model_probe') this.probes!.check(id);
      if (prepared) {
        if (state !== 'succeeded' || !['message','answer_update'].includes(row.kind)) throw new ApiError('SERVICE_UNAVAILABLE');
        result = prepared.commit();
        if (prepared.answer) this.event(id, 'answer.final', { answerId: prepared.answer.id });
      }
      this.db.prepare("UPDATE runs SET state=?,ended_at=?,result_json=?,error_json=?,preview_text=CASE WHEN ?='succeeded' THEN NULL ELSE preview_text END WHERE id=?")
        .run(state, new Date().toISOString(), result ? JSON.stringify(result) : null, error ? JSON.stringify(error) : null, state, id);
      this.event(id, 'run.state', { state, stage: row.stage });
      if (error) this.event(id, 'run.error', error);
      this.event(id, 'run.completed', { terminalState: state, result });
      this.db.exec('COMMIT');
    } catch (failure) { if (this.db.inTransaction) this.db.exec('ROLLBACK'); throw failure; }
    prepared?.afterCommit?.();
    this.changes.emit(id);
  }
  cancel(id: string): Run {
    const row = this.row(id);
    if (row.state === 'queued') this.finish(id, 'cancelled', null, null);
    else if (row.state === 'running') {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare("UPDATE runs SET state='cancelling' WHERE id=? AND state='running'").run(id);
        this.event(id, 'run.state', { state: 'cancelling', stage: row.stage });
        this.db.exec('COMMIT');
      } catch (error) { if (this.db.inTransaction) this.db.exec('ROLLBACK'); throw error; }
      if (this.active?.id === id) this.active.abort.abort();
      this.changes.emit(id);
    }
    return this.get(id);
  }
  private pruneEvents(): void {
    this.db.prepare('DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE ended_at IS NOT NULL AND ended_at<?)')
      .run(new Date(Date.now() - EVENT_TTL).toISOString());
  }
  events(id: string, after: number): { reset: boolean; lastEventId: number; items: RunEvent[] } {
    const run = this.get(id);
    this.pruneEvents();
    const last = this.db.prepare('SELECT MAX(event_id) AS n FROM run_events WHERE run_id=?').get(id) as { n: number | null };
    const lastEventId = last.n ?? 0;
    if ((run.endedAt && Date.now() - Date.parse(run.endedAt) > EVENT_TTL) || after > lastEventId) {
      return { reset: true, lastEventId, items: [] };
    }
    const rows = this.db.prepare('SELECT * FROM run_events WHERE run_id=? AND event_id>? ORDER BY event_id').all(id, after) as
      { event_id: number; run_id: Id<'run'>; type: RunEvent['type']; at: string; payload_json: string }[];
    return { reset: false, lastEventId, items: rows.map(row => ({ eventId: row.event_id, runId: row.run_id,
      type: row.type, at: row.at, payload: JSON.parse(row.payload_json) as object })) };
  }
  subscribe(id: string, listener: () => void): () => void {
    this.row(id);
    this.changes.on(id, listener);
    return () => { this.changes.off(id, listener); };
  }
  async deleteSession(id: string, expected: DeletionImpact = { watches: 0, versions: 0 }): Promise<{ deleted: true }> {
    if (!this.questions) throw new ApiError('SERVICE_UNAVAILABLE');
    // An active review can still publish another version. Leave it untouched; the dialog can retry after it finishes.
    return this.questions.deleteSession(id, expected);
  }
  pauseForSwitch(): boolean {
    if (this.closed || this.processing || this.db.prepare("SELECT 1 FROM runs WHERE state IN ('queued','running','cancelling') LIMIT 1").get()) return false;
    this.closed = true;
    this.watches?.close();
    return true;
  }
  async close(): Promise<void> {
    this.watches?.close();
    this.closed = true; clearImmediate(this.scheduled); this.active?.abort.abort();
    await this.processing;
    const pending = this.db.prepare("SELECT id FROM runs WHERE state NOT IN ('succeeded','failed','cancelled','interrupted')").all() as { id: string }[];
    for (const row of pending) this.finish(row.id, 'interrupted', null, makeError('RUN_INTERRUPTED'));
    this.changes.removeAllListeners();
  }
}
