import { createHash } from 'node:crypto';
import { isTerminalRunState, type Id, type RunRef } from '../shared/contracts.js';
import { isWatchInput, isWatchPatch, type AnswerWatch, type WatchDetail, type AnswerReview, type ReviewContext } from '../shared/watch.js';
import type { Scope } from '../shared/tools.js';
import { ApiError, checkRevision, newId, requireId } from './contracts.js';
import type { SqliteDatabase } from './storage.js';
import type { VaultService } from './vaults.js';
import type { QuestionService, PreparedAnswer } from './questions.js';
import type { WorkerProgress } from './worker-runner.js';
import { scopedSources, sourceSnapshot, answerDependencyRuns, recordSource } from './context-sources.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Row = { id: Id<'watch'>; root_answer_id: Id<'answer'>; session_id: Id<'session'>; vault_id: Id<'vault'>;
  question: string; scope_json: string; revision: number; enabled: number; latest_answer_id: Id<'answer'>;
  checked_at: string | null; observed_hash: string | null; observed_at: number | null; observation: number; attempted_hash: string | null; checked_hash: string | null };
type Snapshot = { question: string; modelRevision: number; scopeRevision: number; memoryGeneration: number;
  sources: Array<{ sourceId: string; hash: string; relativePath: string; state: string }> };
type Job = { run_id: Id<'run'>; watch_id: Id<'watch'>; watch_revision: number; catalog_hash: string;
  snapshot_json: string; previous_answer_id: Id<'answer'>; state: string; error_json: string | null };
type Hooks = { enqueue: (row: Row, snapshot: Snapshot, fingerprint: string) => RunRef; cancel: (id: string) => unknown };

export class AnswerWatches {
  private timer?: NodeJS.Timeout;
  constructor(private readonly db: SqliteDatabase, private readonly vaults: VaultService, private readonly questions: QuestionService,
    private readonly hooks: Hooks, readonly debounceMs = 30_000) {}
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.reconcile(); } catch { /* Preserve pending work; the next local scan can retry scheduling. */ } }, 2000);
    this.timer.unref();
  }
  close(): void { clearInterval(this.timer); this.timer = undefined; }
  private row(id: string): Row {
    requireId(id, 'watch');
    const row = this.db.prepare(`SELECT w.* FROM answer_watches w JOIN conversations c ON c.id=w.session_id
      WHERE w.id=? AND c.deletion_state IS NULL`).get(id) as Row | undefined;
    if (!row) throw new ApiError('NOT_FOUND'); return row;
  }
  private job(id: string): Job | undefined {
    return this.db.prepare(`SELECT j.*,r.state,r.error_json FROM answer_watch_runs j JOIN runs r ON r.id=j.run_id
      WHERE j.watch_id=? ORDER BY j.created_at DESC,j.run_id DESC LIMIT 1`).get(id) as Job | undefined;
  }
  get(id: string): AnswerWatch {
    const row = this.row(id), job = this.job(id);
    const latest = this.db.prepare('SELECT review_json FROM answer_watch_runs WHERE answer_id=?').get(row.latest_answer_id) as { review_json: string } | undefined;
    const active = job && !isTerminalRunState(job.state);
    const unavailable=this.vaults.get(row.vault_id).discovery.state==='failed';
    const failed = job && job.state !== 'succeeded' && !active && job.catalog_hash === row.observed_hash && job.watch_revision === row.revision;
    return { id: row.id, rootAnswerId: row.root_answer_id, latestAnswerId: row.latest_answer_id, sessionId: row.session_id,
      question: row.question, scope: JSON.parse(row.scope_json), revision: row.revision, enabled: !!row.enabled, checkedAt: row.checked_at,
      state: !row.enabled ? 'paused' : unavailable ? 'failed' : active ? 'updating' : failed ? 'failed' : row.checked_hash && row.checked_hash === row.observed_hash ? 'checked' : 'pending',
      runId: job?.run_id ?? null, error: unavailable ? '知识库暂时无法扫描，当前保留的是上次版本；恢复连接后才能继续核查。' : failed ? (job.error_json ? JSON.parse(job.error_json).message : '本轮更新已停止，可重新启用关注后重试。') : null,
      latestReview: latest ? JSON.parse(latest.review_json) : null };
  }
  list(vaultId: string, cursor?: string): { items: AnswerWatch[]; nextCursor: string | null } {
    this.vaults.get(vaultId); if (cursor) requireId(cursor, 'watch');
    const rows = this.db.prepare(`SELECT w.id FROM answer_watches w JOIN conversations c ON c.id=w.session_id
      WHERE w.vault_id=? AND c.deletion_state IS NULL AND w.id>? ORDER BY w.id LIMIT 51`).all(vaultId, cursor ?? '') as { id: string }[];
    return { items: rows.slice(0, 50).map(r => this.get(r.id)), nextCursor: rows.length > 50 ? rows[49].id : null };
  }
  detail(id: string, cursor?: string): WatchDetail {
    const row = this.row(id); if (cursor) requireId(cursor, 'answer');
    const versions = `SELECT j.answer_id AS answerId,j.previous_answer_id AS previousAnswerId,j.created_at AS createdAt,j.review_json AS review,j.run_id AS runId
      FROM answer_watch_runs j WHERE j.watch_id=? AND j.answer_id IS NOT NULL
      UNION ALL SELECT a.id,NULL,json_extract(a.body_json,'$.createdAt'),NULL,a.run_id FROM answers a WHERE a.id=?`;
    const boundary = cursor ? this.db.prepare(`SELECT * FROM (${versions}) WHERE answerId=?`).get(id, row.root_answer_id, cursor) as { createdAt: string } | undefined : undefined;
    if (cursor && !boundary) throw new ApiError('BAD_REQUEST');
    const rows = this.db.prepare(`SELECT * FROM (${versions}) WHERE createdAt<? OR (createdAt=? AND answerId<?)
      ORDER BY createdAt DESC,answerId DESC LIMIT 51`).all(id, row.root_answer_id, boundary?.createdAt ?? '\uffff', boundary?.createdAt ?? '\uffff', cursor ?? '') as
      Array<{ answerId: Id<'answer'>; previousAnswerId: Id<'answer'> | null; createdAt: string; review: string | null; runId: Id<'run'> }>;
    return { watch: this.get(id), versions: rows.slice(0,50).map(r => ({ ...r, review: r.review ? JSON.parse(r.review) : null })),
      nextCursor: rows.length > 50 ? rows[49].answerId : null };
  }
  create(answerId: string, input: unknown): AnswerWatch {
    if (!isWatchInput(input)) throw new ApiError('BAD_REQUEST');
    const answer = this.questions.answers.stored(answerId); checkRevision(input.expectedAnswerRevision, answer.revision);
    if(answer.resume||answer.retrospective)throw new ApiError('BAD_REQUEST');
    const existing = this.db.prepare('SELECT id,question FROM answer_watches WHERE root_answer_id=?').get(answerId) as { id: string; question: string } | undefined;
    if (existing) { if (existing.question !== input.question.trim()) throw new ApiError('REVISION_CONFLICT'); return this.get(existing.id); }
    const message = this.db.prepare('SELECT input_json FROM messages WHERE run_id=?').get(answer.runId) as { input_json: string } | undefined;
    if (!message) throw new ApiError('BAD_REQUEST');
    const session = this.questions.conversations.row(answer.sessionId), scope: Scope = JSON.parse(message.input_json).scope;
    const id = newId('watch');
    this.db.prepare(`INSERT INTO answer_watches(id,root_answer_id,session_id,vault_id,question,scope_json,latest_answer_id,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(id, answer.id, session.id, session.vault_id, input.question.trim(), JSON.stringify(scope), answer.id, new Date().toISOString());
    this.reconcile(); return this.get(id);
  }
  patch(id: string, input: unknown): AnswerWatch {
    if (!isWatchPatch(input)) throw new ApiError('BAD_REQUEST');
    const row = this.row(id); checkRevision(input.expectedRevision, row.revision);
    this.db.prepare(`UPDATE answer_watches SET enabled=?,question=?,revision=revision+1,attempted_hash=NULL,
      checked_hash=CASE WHEN ?=question AND ?=0 THEN checked_hash ELSE NULL END,observed_hash=NULL,observed_at=NULL WHERE id=?`)
      .run(Number(input.enabled), input.question?.trim() ?? row.question, input.question?.trim() ?? row.question, Number(!!input.retry), id);
    this.cancelPending(id); this.reconcile(); return this.get(id);
  }
  cancelPending(id: string): void {
    const rows = this.db.prepare(`SELECT j.run_id FROM answer_watch_runs j JOIN runs r ON r.id=j.run_id
      WHERE j.watch_id=? AND r.state IN ('queued','running','cancelling')`).all(id) as { run_id: string }[];
    for (const row of rows) this.hooks.cancel(row.run_id);
  }
  stopSession(sessionId: string): void {
    this.db.prepare('UPDATE answer_watches SET enabled=0,revision=revision+1 WHERE session_id=?').run(sessionId);
    for (const row of this.db.prepare('SELECT id FROM answer_watches WHERE session_id=?').all(sessionId) as { id: string }[]) this.cancelPending(row.id);
  }
  ignoredSources(id: string): string[] {
    // A saved descendant is not independent evidence for its own answer lineage.
    const rows = this.db.prepare(`SELECT json_extract(r.result_json,'$.sourceId') AS id FROM idempotency_records i
      JOIN runs r ON r.id=json_extract(i.result_json,'$.runId') WHERE i.operation='answer.save' AND r.state='succeeded'
      AND i.scope_id IN (SELECT root_answer_id FROM answer_watches WHERE id=? UNION SELECT answer_id FROM answer_watch_runs WHERE watch_id=?)`)
      .all(id,id) as { id: string | null }[];
    return rows.flatMap(r => r.id ? [r.id] : []);
  }
  private snapshot(row: Row): Snapshot {
    const ignored = new Set(this.ignoredSources(row.id));
    return { question: row.question, modelRevision: this.questions.modelRevision(), scopeRevision: this.vaults.get(row.vault_id).revision,
      memoryGeneration: this.questions.memories.generation(row.vault_id), sources: scopedSources(this.vaults, row.vault_id, JSON.parse(row.scope_json))
        .filter(s => !ignored.has(s.id)).map(s => ({ sourceId: s.id, hash: hash(sourceSnapshot(s)), relativePath: s.relativePath, state: s.state })) };
  }
  reconcile(now = Date.now()): void {
    const rows = this.db.prepare(`SELECT w.* FROM answer_watches w JOIN conversations c ON c.id=w.session_id
      WHERE w.enabled=1 AND c.deletion_state IS NULL`).all() as Row[];
    for (const row of rows) {
      if (this.vaults.get(row.vault_id).discovery.state !== 'ready') continue;
      const snapshot = this.snapshot(row), fingerprint = hash(snapshot);
      if (fingerprint !== row.observed_hash) {
        this.db.prepare('UPDATE answer_watches SET observed_hash=?,observed_at=?,observation=observation+1,attempted_hash=NULL WHERE id=?').run(fingerprint,now,row.id);
        this.cancelPending(row.id); continue;
      }
      const job = this.job(row.id);
      if (job && !isTerminalRunState(job.state)) continue;
      if (row.checked_hash === fingerprint || row.attempted_hash === fingerprint || now - (row.observed_at ?? now) < this.debounceMs) continue;
      // Foreground questions get first use of the single model worker.
      if (this.db.prepare("SELECT id FROM runs WHERE state IN ('queued','running','cancelling') LIMIT 1").get()) continue;
      this.hooks.enqueue(row, snapshot, fingerprint);
    }
  }
  register(runId: Id<'run'>, row: Row, snapshot: Snapshot, fingerprint: string): void {
    if (!this.db.inTransaction) throw new ApiError('SERVICE_UNAVAILABLE');
    this.db.prepare("UPDATE runs SET session_id=?,resolved_action='ask' WHERE id=?").run(row.session_id,runId);
    this.db.prepare(`INSERT INTO answer_watch_runs(run_id,watch_id,watch_revision,catalog_hash,snapshot_json,previous_answer_id,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(runId,row.id,row.revision,fingerprint,JSON.stringify(snapshot),row.latest_answer_id,new Date().toISOString());
    this.db.prepare('UPDATE answer_watches SET attempted_hash=? WHERE id=?').run(fingerprint,row.id);
  }
  async execute(runId: Id<'run'>, signal: AbortSignal, progress: (event: WorkerProgress) => void): Promise<PreparedAnswer> {
    const job = this.db.prepare('SELECT * FROM answer_watch_runs WHERE run_id=?').get(runId) as Job;
    if (!job) throw new ApiError('NOT_FOUND');
    const row = this.row(job.watch_id), snapshot: Snapshot = JSON.parse(job.snapshot_json), ignoredSourceIds = this.ignoredSources(row.id);
    const check = () => {
      const current = this.row(row.id);
      if (!current.enabled || current.revision !== job.watch_revision || hash(this.snapshot(current)) !== job.catalog_hash) throw new ApiError('CONTEXT_CHANGED');
    };
    check();
    const previous = this.questions.answers.stored(job.previous_answer_id);
    const priorJob = this.db.prepare('SELECT snapshot_json FROM answer_watch_runs WHERE answer_id=?').get(previous.id) as { snapshot_json: string } | undefined;
    const original = this.db.prepare('SELECT scope_revision,memory_generation FROM messages WHERE run_id=?').get(previous.runId) as { scope_revision: number; memory_generation: number } | undefined;
    const prior: Snapshot | undefined = priorJob ? JSON.parse(priorJob.snapshot_json) : undefined;
    const available = new Set(snapshot.sources.filter(s => ['ready','partial'].includes(s.state)).map(s => s.sourceId));
    const dependencies = answerDependencyRuns(this.db,previous.runId).flatMap(id =>
      this.db.prepare('SELECT source_id FROM context_sources WHERE run_id=?').all(id) as { source_id: string }[]);
    let comparisonAvailable = (prior?.question ?? row.question) === row.question &&
      (prior?.scopeRevision ?? original?.scope_revision) === snapshot.scopeRevision &&
      (prior?.memoryGeneration ?? original?.memory_generation) === snapshot.memoryGeneration &&
      dependencies.every(s => available.has(s.source_id)) && previous.citations.every(e => available.has(e.sourceId));
    let blocks = comparisonAvailable ? previous.blocks.map(({ id,kind,markdown }) => ({ id,kind,markdown })) : [];
    let previousChecks = comparisonAvailable ? (previous.checks ?? []).map(({id,kind,blockIds,summary,impact,nextStep}) => ({id,kind,blockIds,summary,impact,nextStep})) : [];
    let previousExperiences=comparisonAvailable?previous.experiences:undefined;
    if (Buffer.byteLength(JSON.stringify({blocks,previousChecks,previousExperiences})) > 48000) { comparisonAvailable = false; blocks = []; previousChecks = []; previousExperiences=undefined; }
    if(comparisonAvailable) for(const source of dependencies) recordSource(this.db,runId,this.vaults.source(source.source_id));
    const oldHashes = new Map(prior?.sources.map(s => [s.sourceId,s.hash]) ?? []);
    const review: ReviewContext = { previous: blocks, comparisonAvailable, previousChecks,previousExperiences,
      ...(previous.experiences?{experienceComparison:true as const}:{}),
      changedSources: snapshot.sources.filter(s => oldHashes.get(s.sourceId) !== s.hash).slice(0,48)
        .map(({ sourceId,relativePath,state }) => ({ sourceId,relativePath,state })) };
    const prepared = await this.questions.executeReview(runId, { sessionId: row.session_id, question: row.question,
      scope: JSON.parse(row.scope_json), modelRevision: snapshot.modelRevision, scopeRevision: snapshot.scopeRevision,
      memoryGeneration: snapshot.memoryGeneration, ignoredSourceIds, review, check }, signal, progress);
    const answer = prepared.answer!;
    const comparison: AnswerReview = structuredClone(answer.review!);
    if (answer.outcome === 'insufficient_evidence' || snapshot.sources.some(s => !['ready','excluded'].includes(s.state))) comparison.kind = 'uncertain';
    const evidenceSignature = (a: typeof answer) => hash(a.citations.map(e => [e.sourceId,e.sourceVersion,e.representationHash]).sort());
    if (comparison.kind === 'unchanged' && evidenceSignature(answer) !== evidenceSignature(previous)) comparison.kind = 'evidence_updated';
    answer.review = comparison;
    return { answer, commit: () => {
      check(); const result = prepared.commit();
      this.db.prepare('UPDATE answer_watch_runs SET answer_id=?,review_json=? WHERE run_id=?').run(answer.id,JSON.stringify(comparison),runId);
      this.db.prepare('UPDATE answer_watches SET latest_answer_id=?,checked_at=?,checked_hash=? WHERE id=?')
        .run(answer.id,answer.checkedAt,job.catalog_hash,row.id);
      return result;
    } };
  }
}
