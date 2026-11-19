import { createHash } from 'node:crypto';
import { hasFields, isId, type Id, type IdempotencyIdentity } from '../shared/contracts.js';
import { isConversationInput, isHistoryTerm, isQuestionInput, questionTooLong, parseSessionCursor, type HistoryHit, type HistoryPosition, type Conversation, type DeletionImpact, type Message, type QuestionInput } from '../shared/chat.js';
import { isExcluded } from '../shared/vault.js';
import { ApiError, newId, requireId, requireIdempotencyKey, checkIdempotency } from './contracts.js';
import type { SqliteDatabase } from './storage.js';
import type { VaultService } from './vaults.js';
import type { ModelSettings } from './model-settings.js';
import { answerDependencyRuns, checkSources, inScope, normalizeScope } from './context-sources.js';
import { isMemoryAction, type MemoryAction } from '../shared/memory.js';
import type { Scope } from '../shared/tools.js';
import { deleteRunSessionFiles } from './session-files.js';

export type AcceptedQuestion = { text: string; scope: Scope; basedOnAnswerId?: Id<'answer'>; workflow?:'resume'|'retrospective'; workflowNote?:string; experienceComparison?:true } & ({ action: 'auto' | 'ask' } | MemoryAction);
export type ConversationRow = { id: Id<'session'>; vault_id: Id<'vault'>; title: string; created_at: string;
  updated_at: string; active_segment_id: Id<'segment'> | null; context_generation: number; deletion_state: 'deleting' | 'deleted' | null };
export type MessageRow = { id: Id<'message'>; session_id: Id<'session'>; run_id: Id<'run'>; ordinal: number;
  text: string; input_json: string; scope_revision: number; model_revision: number; context_generation: number; created_at: string;
  memory_generation: number; segment_id: Id<'segment'> | null; pi_entry_id: string | null; answer_id?: Id<'answer'> | null;
  resolved_action?: string | null; result_json?: string | null };
function pagination(query: unknown, required: string[] = [], optional: string[] = []): { limit: number; cursor?: string } {
  if (!hasFields(query, required, ['cursor','limit', ...optional]) || (query.cursor !== undefined && typeof query.cursor !== 'string') ||
    (query.limit !== undefined && (typeof query.limit !== 'string' || !/^[1-9]\d?$/.test(query.limit) || Number(query.limit) > 50))) throw new ApiError('BAD_REQUEST');
  return { limit: Number(query.limit ?? 20), ...(query.cursor ? { cursor: query.cursor as string } : {}) };
}
type SearchMessage = { id: Id<'message'>; run_id: string; input_json: string; role: HistoryPosition['role']; text: string; position: number };
function matchSnippet(text: string, start: number, length: number): HistoryHit['snippet'] {
  const points = [...text], from = Math.max(0, start - 40), end = start + length, to = Math.min(points.length, end + 72);
  return { before: (from ? '…' : '') + points.slice(from, start).join(''), match: points.slice(start, end).join(''),
    after: points.slice(end, to).join('') + (to < points.length ? '…' : '') };
}
export class ConversationService {
  constructor(private readonly db: SqliteDatabase, private readonly vaults: VaultService, private readonly models: ModelSettings) {}
  deletionImpact(id: string): DeletionImpact {
    requireId(id, 'session');
    const counts = this.db.prepare(`SELECT (SELECT count(*) FROM answer_watches WHERE session_id=c.id) AS watches,
      (SELECT count(j.answer_id) FROM answer_watch_runs j JOIN answer_watches w ON w.id=j.watch_id WHERE w.session_id=c.id) AS updates
      FROM conversations c WHERE c.id=?`).get(id) as { watches: number; updates: number } | undefined;
    if (!counts) throw new ApiError('NOT_FOUND');
    return { watches: counts.watches, versions: counts.watches + counts.updates };
  }
  checkDeletionImpact(id: string, expected: DeletionImpact): void {
    const actual = this.deletionImpact(id);
    if (actual.watches !== expected.watches || actual.versions !== expected.versions) throw new ApiError('REVISION_CONFLICT');
  }
  recoverDeletions(directory: string): void {
    const pending = this.db.prepare("SELECT id FROM conversations WHERE deletion_state='deleting'").all() as { id: string }[];
    for (const row of pending) {
      try { this.delete(row.id, directory); }
      catch { console.error('聊天记录清理尚未完成，将在再次删除或下次启动时重试。'); }
    }
  }
  delete(id: string, directory: string, expected?: DeletionImpact): { deleted: true } {
    requireId(id, 'session');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT deletion_state FROM conversations WHERE id=?').get(id) as ConversationRow | undefined;
      if (!row) throw new ApiError('NOT_FOUND');
      if (row.deletion_state === 'deleted') { this.db.exec('COMMIT'); return { deleted: true }; }
      if (expected && !row.deletion_state) this.checkDeletionImpact(id, expected);
      if (this.db.prepare("SELECT id FROM runs WHERE session_id=? AND state NOT IN ('succeeded','failed','cancelled','interrupted') LIMIT 1").get(id)) throw new ApiError('SESSION_BUSY');
      this.db.prepare("UPDATE conversations SET deletion_state='deleting' WHERE id=?").run(id);
      this.db.exec('COMMIT');
    } catch (error) { if (this.db.inTransaction) this.db.exec('ROLLBACK'); throw error; }
    const runIds = (this.db.prepare('SELECT id FROM runs WHERE session_id=?').all(id) as { id: string }[]).map(row => row.id);
    deleteRunSessionFiles(directory, runIds);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Keep accounting and idempotency identities so deleting history cannot reset spending or replay paid work.
      for (const table of ['tool_results','context_sources','evidence','run_events']) {
        this.db.prepare(`DELETE FROM ${table} WHERE run_id IN (SELECT id FROM runs WHERE session_id=?)`).run(id);
      }
      this.db.prepare('UPDATE runs SET result_json=NULL,error_json=NULL,preview_text=NULL WHERE session_id=?').run(id);
      this.db.prepare('DELETE FROM answer_watch_runs WHERE watch_id IN (SELECT id FROM answer_watches WHERE session_id=?)').run(id);
      this.db.prepare('DELETE FROM answer_watches WHERE session_id=?').run(id);
      for (const table of ['answers','messages','session_segments']) this.db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(id);
      this.db.prepare("UPDATE conversations SET deletion_state='deleted',title='',active_segment_id=NULL WHERE id=?").run(id);
      this.db.exec('COMMIT');
    } catch (error) { if (this.db.inTransaction) this.db.exec('ROLLBACK'); throw error; }
    return { deleted: true };
  }
  row(id: string): ConversationRow {
    requireId(id, 'session');
    const row = this.db.prepare('SELECT * FROM conversations WHERE id=? AND deletion_state IS NULL').get(id) as ConversationRow | undefined;
    if (!row) throw new ApiError('NOT_FOUND');
    return row;
  }
  get(id: string): Conversation {
    const row = this.row(id);
    return { id: row.id, vaultId: row.vault_id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at,
      activeSegmentId: row.active_segment_id, contextGeneration: row.context_generation };
  }
  create(input: unknown, key?: unknown): Conversation {
    if (!isConversationInput(input)) throw new ApiError('BAD_REQUEST');
    this.vaults.get(input.vaultId);
    const title = input.title?.trim() ?? '新对话';
    const identity: IdempotencyIdentity | undefined = key === undefined ? undefined : {
      key: requireIdempotencyKey(key), operation: 'session.create', scopeId: input.vaultId,
      payloadHash: createHash('sha256').update(JSON.stringify({ title })).digest('hex'),
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (identity) {
        const old = this.db.prepare('SELECT * FROM idempotency_records WHERE key=?').get(identity.key) as
          { key: string; operation: string; scope_id: string; payload_hash: string; result_json: string } | undefined;
        checkIdempotency(old ? { key: old.key, operation: old.operation, scopeId: old.scope_id, payloadHash: old.payload_hash } as IdempotencyIdentity : null, identity);
        if (old) { const result = this.get(requireId(JSON.parse(old.result_json).sessionId, 'session')); this.db.exec('COMMIT'); return result; }
      }
      const id = newId('session'), now = new Date().toISOString();
      this.db.prepare('INSERT INTO conversations(id,vault_id,title,created_at,updated_at) VALUES (?,?,?,?,?)')
        .run(id, input.vaultId, title, now, now);
      if (identity) this.db.prepare('INSERT INTO idempotency_records(key,operation,scope_id,payload_hash,result_json) VALUES (?,?,?,?,?)')
        .run(identity.key, identity.operation, identity.scopeId, identity.payloadHash, JSON.stringify({ sessionId: id }));
      const result = this.get(id); this.db.exec('COMMIT'); return result;
    } catch (error) { if (this.db.inTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  list(query: unknown): { items: Conversation[]; nextCursor: string | null } {
    const { limit, cursor } = pagination(query, ['vaultId']);
    const vaultId = requireId((query as { vaultId: unknown }).vaultId, 'vault'); this.vaults.get(vaultId);
    let boundary = cursor ? parseSessionCursor(cursor) : null;
    if (cursor && isId(cursor, 'session')) {
      const row = this.row(cursor); boundary = { vaultId: row.vault_id, updatedAt: row.updated_at, id: row.id };
    }
    if (cursor && (!boundary || boundary.vaultId !== vaultId)) throw new ApiError('BAD_REQUEST');
    const rows = this.db.prepare(`SELECT id,updated_at FROM conversations WHERE vault_id=? AND deletion_state IS NULL
      AND (updated_at<? OR (updated_at=? AND id<?)) ORDER BY updated_at DESC,id DESC LIMIT ?`)
      .all(vaultId, boundary?.updatedAt ?? '\uffff', boundary?.updatedAt ?? '\uffff', boundary?.id ?? '', limit + 1) as { id: string; updated_at: string }[];
    const last = rows[limit - 1];
    return { items: rows.slice(0, limit).map(row => this.get(row.id)),
      nextCursor: rows.length > limit ? `v1~${vaultId}~${last.updated_at}~${last.id}` : null };
  }
  async search(query: unknown): Promise<{ items: HistoryHit[]; nextCursor: string | null }> {
    const { limit, cursor } = pagination(query, ['vaultId', 'q'], ['sessionId']);
    if (!hasFields(query, ['vaultId','q'], ['limit','cursor','sessionId']) || !isHistoryTerm(query.q) ||
        (query.sessionId !== undefined && (!isId(query.sessionId, 'session') || cursor))) throw new ApiError('BAD_REQUEST');
    const vaultId = requireId(query.vaultId, 'vault'), vault = this.vaults.get(vaultId);
    const boundary = cursor ? parseSessionCursor(cursor) : null;
    if (cursor && (!boundary || boundary.vaultId !== vaultId)) throw new ApiError('BAD_REQUEST');
    const term = query.q.trim(), length = [...term].length;
    const memory = this.db.prepare('SELECT generation FROM memory_state WHERE vault_id=?');
    const memoryGeneration = () => (memory.get(vaultId) as { generation: number } | undefined)?.generation ?? 1;
    const generation = memoryGeneration(), catalog = this.vaults.catalogRevision(vaultId);
    const verified = new Map<string, string>(), checked = new Map<string, boolean>();
    // Work from live rows. Only the current vault contributes results, and deleting rows are invisible immediately.
    const sessions = this.db.prepare(`
      SELECT c.id,c.title,c.updated_at,json_extract(m.input_json,'$.attachment.sourceId') AS attachment_id,
        s.state AS attachment_state,s.relative_path AS attachment_path,s.vault_id AS attachment_vault,
        instr(lower(c.title),lower(?)) AS title_match
      FROM conversations c LEFT JOIN messages m ON m.session_id=c.id AND m.ordinal=1
      LEFT JOIN sources s ON s.id=json_extract(m.input_json,'$.attachment.sourceId')
      WHERE c.vault_id=? AND c.deletion_state IS NULL AND (c.updated_at<? OR (c.updated_at=? AND c.id<?))
        ${query.sessionId ? 'AND c.id=?' : ''}
      ORDER BY c.updated_at DESC,c.id DESC`);
    const message = this.db.prepare(`
      WITH input(term,session,revision,generation) AS (VALUES (?,?,?,?))
      SELECT id,run_id,input_json,role,text,position FROM (
        SELECT m.id,m.run_id,m.input_json,m.ordinal,'user' AS role,m.text,0 AS block,
          instr(lower(m.text),lower(input.term)) AS position FROM input JOIN messages m ON m.session_id=input.session
        WHERE (
          (json_extract(m.input_json,'$.workflow') IS NULL AND json_extract(m.input_json,'$.basedOnAnswerId') IS NULL)
          OR (m.scope_revision=input.revision AND m.memory_generation=input.generation))
        UNION ALL
        SELECT m.id,m.run_id,m.input_json,m.ordinal,'assistant',json_extract(b.value,'$.markdown'),b.key,
          instr(lower(json_extract(b.value,'$.markdown')),lower(input.term))
        FROM input JOIN messages m ON m.session_id=input.session JOIN answers a ON a.run_id=m.run_id AND a.session_id=m.session_id
        JOIN json_each(a.body_json,'$.blocks') b
        WHERE m.scope_revision=input.revision AND m.memory_generation=input.generation
      ) WHERE position>0 ORDER BY ordinal DESC,role DESC,block LIMIT 1 OFFSET ?`);
    const items: HistoryHit[] = [];
    let nextCursor: string | null = null, lastUpdated = '';
    const cutoff = boundary?.updatedAt ?? '\uffff';
    const rows = sessions.all(term, vaultId, cutoff, cutoff, boundary?.id ?? '', ...(query.sessionId ? [query.sessionId] : [])) as {
      id: Id<'session'>; title: string; updated_at: string; title_match: number;
      attachment_id: string | null; attachment_state: string | null; attachment_path: string | null; attachment_vault: string | null;
    }[];
    for (const row of rows) {
      const hiddenTitle = row.attachment_id && (row.attachment_vault !== vaultId || !row.attachment_path ||
        ['excluded','missing','needs_review'].includes(row.attachment_state ?? '') || isExcluded(row.attachment_path, vault.exclusions));
      let hit: SearchMessage | undefined;
      for (let offset = 0; ; offset++) {
        hit = message.get(term, row.id, vault.revision, generation, offset) as SearchMessage | undefined;
        if (!hit || hit.role === 'user') break;
        if (!checked.has(hit.run_id)) checked.set(hit.run_id, await this.searchableAnswer(vaultId, hit, verified));
        if (checked.get(hit.run_id)) break;
      }
      if (!hit && (hiddenTitle || !row.title_match)) continue;
      if (items.length === limit) {
        nextCursor = `v1~${vaultId}~${lastUpdated}~${items[items.length - 1].sessionId}`;
        break;
      }
      const position = hit ? { messageId: hit.id, role: hit.role } : null;
      items.push({ sessionId: row.id, title: hiddenTitle ? '对话' : row.title, position,
        snippet: matchSnippet(hit?.text ?? row.title, (hit?.position ?? row.title_match) - 1, length) });
      lastUpdated = row.updated_at;
    }
    if (checked.size && (this.vaults.get(vaultId).revision !== vault.revision || memoryGeneration() !== generation ||
        this.vaults.catalogRevision(vaultId) !== catalog)) throw new ApiError('CONTEXT_CHANGED');
    const active = this.db.prepare('SELECT 1 FROM conversations WHERE id=? AND vault_id=? AND deletion_state IS NULL');
    return { items:items.filter(item => active.get(item.sessionId, vaultId)), nextCursor };
  }
  private async searchableAnswer(vaultId: string, match: SearchMessage, verified: Map<string, string>): Promise<boolean> {
    const runIds = answerDependencyRuns(this.db, match.run_id);
    const scope = (JSON.parse(match.input_json) as AcceptedQuestion).scope, signal = new AbortController().signal;
    try {
      await checkSources(this.db, this.vaults, runIds, vaultId, scope, signal, verified);
      // Older responses can have citations without a recorded context snapshot.
      const legacy = this.db.prepare(`SELECT json_extract(e.value,'$.sourceId') AS id, json_extract(e.value,'$.sourceVersion') AS version
        FROM answers a JOIN json_each(a.body_json,'$.citations') e
        LEFT JOIN context_sources s ON s.run_id=a.run_id AND s.source_id=json_extract(e.value,'$.sourceId')
        WHERE a.run_id=? AND s.source_id IS NULL`);
      for (const runId of runIds) for (const ref of legacy.all(runId) as {id: string; version: string}[]) {
        const source = this.vaults.source(ref.id);
        if (source.vaultId !== vaultId || !inScope(scope, source.relativePath)) return false;
        await this.vaults.content(source.id, 'text', ref.version, signal);
      }
      return true;
    } catch (error) {
      if (error instanceof ApiError && ['CONTEXT_CHANGED','NOT_FOUND','SOURCE_CHANGED','SOURCE_MISSING','SOURCE_EXCLUDED',
        'SOURCE_NOT_READY','DERIVED_MODIFIED','PATH_OUTSIDE_SCOPE','VAULT_ACCESS_DENIED'].includes(error.publicError.code)) return false;
      throw error;
    }
  }
  messages(sessionId: string, query: unknown): { items: Message[]; nextCursor: string | null } {
    this.row(sessionId);
    const { limit, cursor } = pagination(query);
    let ordinal = 0;
    if (cursor) {
      requireId(cursor, 'message');
      const row = this.db.prepare('SELECT ordinal FROM messages WHERE id=? AND session_id=?').get(cursor, sessionId) as { ordinal: number } | undefined;
      if (!row) throw new ApiError('BAD_REQUEST'); ordinal = row.ordinal;
    }
    const rows = this.db.prepare(`SELECT m.*,a.id AS answer_id,r.resolved_action,r.result_json FROM messages m JOIN runs r ON r.id=m.run_id LEFT JOIN answers a ON a.run_id=m.run_id
      WHERE m.session_id=? AND m.ordinal>? ORDER BY m.ordinal LIMIT ?`).all(sessionId, ordinal, limit + 1) as MessageRow[];
    return { items: rows.slice(0, limit).map(row => {
      const input = JSON.parse(row.input_json) as AcceptedQuestion & { attachment?: Message['attachment'] };
      return { id: row.id, sessionId: row.session_id, runId: row.run_id, text: row.text, scope: input.scope,
        createdAt: row.created_at, answerId: row.answer_id ?? null,
        resolvedAction: row.resolved_action ?? (row.answer_id ? 'ask' : null), result: row.result_json ? JSON.parse(row.result_json) : null,
        ...(input.basedOnAnswerId ? { basedOnAnswerId:input.basedOnAnswerId } : {}),
        ...(input.workflow ? {workflow:input.workflow} : {}),
        ...(input.attachment ? { attachment: input.attachment } : {}) };
    }), nextCursor: rows.length > limit ? rows[limit - 1].id : null };
  }
  normalize(input: unknown): AcceptedQuestion {
    if (input && typeof input === 'object' && 'text' in input && typeof input.text === 'string' && questionTooLong(input.text)) throw new ApiError('QUESTION_TOO_LONG');
    if (!isQuestionInput(input)) throw new ApiError('BAD_REQUEST');
    const base = { text: input.text,...(input.experienceComparison?{experienceComparison:true as const}:{}), scope: normalizeScope(input.scope ?? { mode: 'vault' }), ...(input.basedOnAnswerId ? { basedOnAnswerId:input.basedOnAnswerId } : {}), ...(input.workflow ? {workflow:input.workflow,...(input.workflowNote?.trim()?{workflowNote:input.workflowNote.trim()}:{})} : {}) };
    const operation = { action: input.action, actionInput: input.actionInput };
    if (isMemoryAction(operation)) return { ...base, ...operation };
    return { ...base, action: input.action === 'ask' ? 'ask' : 'auto' };
  }
  reference(sessionId:string,messageId:string):{message:Message;ordinal:number}{
    this.row(sessionId);requireId(messageId,'message');
    const row=this.db.prepare('SELECT * FROM messages WHERE id=? AND session_id=?').get(messageId,sessionId) as MessageRow|undefined;
    if(!row)throw new ApiError('NOT_FOUND');
    const answer=this.db.prepare('SELECT id FROM answers WHERE run_id=?').get(row.run_id) as {id:Id<'answer'>}|undefined;
    const input=JSON.parse(row.input_json) as AcceptedQuestion;
    return{ordinal:row.ordinal,message:{id:row.id,sessionId:row.session_id,runId:row.run_id,text:row.text,scope:input.scope,createdAt:row.created_at,
      answerId:answer?.id??null,resolvedAction:null,result:null,...(input.workflow ? {workflow:input.workflow} : {})}};
  }
  register(runId: Id<'run'>, sessionId: string, input: AcceptedQuestion): void {
    if (!this.db.inTransaction) throw new ApiError('SERVICE_UNAVAILABLE');
    const session = this.row(sessionId), vault = this.vaults.get(session.vault_id), models = this.models.view();
    if (input.scope.mode === 'selected' && input.scope.paths.some(p => isExcluded(p, vault.exclusions))) throw new ApiError('PATH_OUTSIDE_SCOPE');
    if (input.basedOnAnswerId && !this.db.prepare('SELECT id FROM answers WHERE id=? AND session_id=?').get(input.basedOnAnswerId,sessionId)) throw new ApiError('BAD_REQUEST');
    const busy = this.db.prepare("SELECT id FROM runs WHERE session_id=? AND kind!='answer_update' AND state NOT IN ('succeeded','failed','cancelled','interrupted') LIMIT 1").get(sessionId);
    if (busy) throw new ApiError('SESSION_BUSY');
    this.db.prepare('UPDATE runs SET session_id=? WHERE id=?').run(sessionId, runId);
    const now = new Date().toISOString();
    const memoryGeneration = (this.db.prepare('SELECT generation FROM memory_state WHERE vault_id=?').get(vault.id) as { generation: number } | undefined)?.generation ?? 1;
    this.db.prepare(`INSERT INTO messages(id,session_id,run_id,ordinal,text,input_json,scope_revision,model_revision,context_generation,memory_generation,created_at)
      SELECT ?,?,?,COALESCE(MAX(ordinal),0)+1,?,?,?,?,?,?,? FROM messages WHERE session_id=?`)
      .run(newId('message'), sessionId, runId, input.text, JSON.stringify(input), vault.revision, models.revision, session.context_generation, memoryGeneration, now, sessionId);
    this.db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(now, sessionId);
  }
  question(runId: string): MessageRow {
    const row = this.db.prepare('SELECT * FROM messages WHERE run_id=?').get(runId) as MessageRow | undefined;
    if (!row) throw new ApiError('NOT_FOUND'); return row;
  }
}
