import { HISTORY_LIMITS } from '../shared/model-context.js';
import type { DeletionImpact, Message } from '../shared/chat.js';
import { isExcluded } from '../shared/vault.js';
import { MODEL_LIMITS } from '../shared/model-run.js';
import type { Id } from '../shared/contracts.js';
import { parseAnswerDraft, type Answer } from '../shared/answer.js';
import type { ToolResult } from '../shared/tools.js';
import type { SqliteDatabase } from './storage.js';
import type { VaultService } from './vaults.js';
import type { ModelSettings } from './model-settings.js';
import type { ModelLedger } from './model-ledger.js';
import { ApiError, newId } from './contracts.js';
import { ConversationService, type AcceptedQuestion } from './conversations.js';
import { AnswerService } from './answers.js';
import type { WorkerInput, WorkerProgress, WorkerRunner } from './worker-runner.js';
import { catalogHash, checkSources, checkSourceRecords, inScope, answerDependencyRuns } from './context-sources.js';
import { readSessionFile } from './session-files.js';
import { MemoryService } from './memories.js';
import { resolveMessage } from './message-intent.js';
import type { RunResult } from '../shared/run.js';
import type { ReviewContext } from '../shared/watch.js';
import type { Scope } from '../shared/tools.js';
import { resumeContext } from './continuation.js';

type Segment = { id: Id<'segment'>; settings_json: string; catalog_hash: string; session_file: string; session_hash: string };
export type PreparedAnswer = { answer?: Answer; commit: () => RunResult; afterCommit?: () => void };
export class QuestionService {
  constructor(private readonly db: SqliteDatabase, private readonly vaults: VaultService, private readonly models: ModelSettings,
    readonly conversations: ConversationService, readonly answers: AnswerService, private readonly runner: WorkerRunner,
    readonly ledger: ModelLedger, private readonly dataDirectory: string, readonly batchId: string,
    readonly memories = new MemoryService(db, vaults)) { conversations.recoverDeletions(dataDirectory); }
  deleteSession(id: string, expected?: DeletionImpact): { deleted: true } { return this.conversations.delete(id, this.dataDirectory, expected); }
  modelRevision(): number { return this.models.view().revision; }
  async executeReview(runId: Id<'run'>, input: { sessionId: Id<'session'>; question: string; scope: Scope;
    modelRevision: number; scopeRevision: number; memoryGeneration: number; ignoredSourceIds: string[];
    review: ReviewContext; check: () => void }, parentSignal: AbortSignal, progress: (event: WorkerProgress) => void): Promise<PreparedAnswer> {
    const session = this.conversations.row(input.sessionId), snapshot = this.memories.snapshot(session.vault_id);
    const run = this.db.prepare('SELECT started_at FROM runs WHERE id=?').get(runId) as { started_at: string };
    const deadline = Date.parse(run.started_at) + MODEL_LIMITS.questionMs, segmentId = newId('segment');
    const abort=new AbortController(), signal=AbortSignal.any([parentSignal,abort.signal]);
    const unsubscribe=this.memories.onChange(vaultId=>{ if(vaultId===session.vault_id && this.memories.generation(vaultId)!==input.memoryGeneration) abort.abort('CONTEXT_CHANGED'); });
    const timer=setTimeout(()=>abort.abort(),Math.max(0,deadline-Date.now())); timer.unref();
    const check = () => {
      if(signal.reason==='CONTEXT_CHANGED') throw new ApiError('CONTEXT_CHANGED');
      if (signal.aborted || (this.db.prepare('SELECT state FROM runs WHERE id=?').get(runId) as { state: string }).state !== 'running') throw new ApiError('RUN_INTERRUPTED');
      if (Date.now() >= deadline) throw new ApiError('DEADLINE_EXCEEDED');
      this.conversations.row(session.id);
      if (this.modelRevision() !== input.modelRevision || this.vaults.get(session.vault_id).revision !== input.scopeRevision ||
        this.memories.generation(session.vault_id) !== input.memoryGeneration) throw new ApiError('CONTEXT_CHANGED');
      input.check();
    };
    try {
    check(); progress({ stage: 'preparing' });
    // A review always starts fresh. Old Pi messages, summaries and tools never re-enter its context.
    await this.vaults.scan(session.vault_id, signal); check();
    const candidate = await this.runner.run({ runId, sessionId: session.id, segmentId, generation: session.context_generation,
      vaultId: session.vault_id, scope: input.scope, scopeRevision: input.scopeRevision, deadline, signal,
      question: input.question, preferences: snapshot.items.map(item => item.text), thinking: 'off', batchId: this.batchId,
      modelRevision: input.modelRevision, ignoredSourceIds: input.ignoredSourceIds,
      beforeSend: async()=>{ await this.vaults.scan(session.vault_id,signal); check();
        await checkSources(this.db,this.vaults,[runId],session.vault_id,input.scope,signal); check(); },
      context: { resume: null, priorQuestions: [], priorTools: [], notice: null, review: input.review,...(input.review.experienceComparison?{experienceComparison:true as const}:{}) } }, progress);
    check(); progress({ stage: 'validating' });
    await this.vaults.scan(session.vault_id, signal); check();
    await checkSources(this.db, this.vaults, [runId], session.vault_id, input.scope, signal); check();
    const results = (this.db.prepare('SELECT result_json FROM tool_results WHERE run_id=?').all(runId) as { result_json: string }[])
      .map(row => JSON.parse(row.result_json));
    if (!results.some(r => r.ok && (r.data?.evidence || Array.isArray(r.data?.matches)))) throw new ApiError('CITATION_INVALID');
    const review = candidate.draft.review;
    if (!review || review.changes.some(c => c.before.some(id => !input.review.previous.some(b => b.id === id)) ||
      c.after.some(id => !candidate.draft.blocks.some(b => b.id === id))) ||
      (!input.review.comparisonAvailable && (review.kind !== 'uncertain' || review.changes.some(c => c.before.length)))) throw new ApiError('CITATION_INVALID');
    const answer = await this.answers.prepare(candidate.draft, { runId, sessionId: session.id, vaultId: session.vault_id,
      scope: input.scope, signal, check,experienceComparison:!!input.review.experienceComparison });
    if (answer.citations.some(e => input.ignoredSourceIds.includes(e.sourceId))) throw new ApiError('CITATION_INVALID');
    const file = readSessionFile(this.dataDirectory, candidate.sessionFile);
    const entries = file.bytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
    const user = entries.find(entry => entry.id === candidate.userEntryId), last = entries.find(entry => entry.id === candidate.entryId);
    const text = (entry: any) => typeof entry?.message?.content === 'string' ? entry.message.content :
      entry?.message?.content?.filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('');
    if (user?.message?.role !== 'user' || text(user) !== input.question || last?.message?.role !== 'assistant' || last.message.stopReason !== 'stop' ||
      JSON.stringify(parseAnswerDraft(text(last))) !== JSON.stringify(candidate.draft)) throw new ApiError('MODEL_PROTOCOL_ERROR');
    return { answer, commit: () => {
      check(); checkSourceRecords(this.db, this.vaults, [runId]); this.answers.commit(answer);
      // Retain the trace for backup/deletion, without replacing the conversational continuation point.
      this.db.prepare(`INSERT INTO session_segments(id,session_id,generation,settings_json,catalog_hash,session_file,session_hash,created_at,rebuild_reason)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(segmentId, session.id, session.context_generation, JSON.stringify({ scope: input.scope }),
          '', candidate.sessionFile, file.hash, answer.createdAt, '持续关注独立复核');
      return { answerId: answer.id };
    } };
    } finally { clearTimeout(timer); unsubscribe(); }
  }
  private attachmentHints(sessionId: string, ordinal: number, vaultId: string, scope: AcceptedQuestion['scope']) {
    const rows = this.db.prepare(`SELECT input_json FROM messages WHERE session_id=? AND ordinal<?
      AND json_extract(input_json, '$.attachment.sourceId') IS NOT NULL ORDER BY ordinal DESC LIMIT ?`)
      .all(sessionId, ordinal, HISTORY_LIMITS.questions) as { input_json: string }[];
    const hints: NonNullable<NonNullable<WorkerInput['context']>['attachments']> = [], exclusions = this.vaults.get(vaultId).exclusions;
    for (const row of rows) {
      const attachment = (JSON.parse(row.input_json) as { attachment: NonNullable<Message['attachment']> }).attachment;
      let hint: (typeof hints)[number] = { state: 'unavailable' };
      try {
        const source = this.vaults.source(attachment.sourceId);
        if (source.vaultId === vaultId && inScope(scope, source.relativePath) && !isExcluded(source.relativePath, exclusions)) {
          hint = { sourceId: source.id, name: attachment.name, relativePath: source.relativePath, state: source.state };
        }
      } catch (error) { if (!(error instanceof ApiError) || error.publicError.code !== 'NOT_FOUND') throw error; }
      if (Buffer.byteLength(JSON.stringify([hint, ...hints])) > 4000) break;
      hints.unshift(hint);
    }
    return hints;
  }
  async execute(runId: Id<'run'>, signal: AbortSignal, progress: (event: WorkerProgress) => void): Promise<PreparedAnswer> {
    const message = this.conversations.question(runId), session = this.conversations.row(message.session_id), input = JSON.parse(message.input_json) as AcceptedQuestion;
    const snapshot = this.memories.snapshot(session.vault_id);
    const prior = this.db.prepare(`SELECT r.result_json,r.resolved_action,r.state FROM messages m JOIN runs r ON r.id=m.run_id
      WHERE m.session_id=? AND m.ordinal<? ORDER BY m.ordinal DESC LIMIT 1`).get(session.id, message.ordinal) as
      { result_json: string | null; resolved_action: string | null; state: string } | undefined;
    const previousMemory = prior?.state === 'succeeded' && ['remember','update_memory'].includes(prior.resolved_action ?? '') && prior.result_json ?
      JSON.parse(prior.result_json) as { memoryId: string; revision: number } : null;
    const operation = resolveMessage(input, snapshot.items, previousMemory);
    this.db.prepare('UPDATE runs SET resolved_action=? WHERE id=?').run(operation.action, runId);
    if (operation.action !== 'ask') return {
      commit: () => {
        if (signal.aborted || (this.db.prepare('SELECT state FROM runs WHERE id=?').get(runId) as { state: string }).state !== 'running') throw new ApiError('RUN_INTERRUPTED');
        return this.memories.apply(session.vault_id, operation, message.id);
      },
      afterCommit: () => { if (this.memories.generation(session.vault_id) !== snapshot.generation) this.memories.notify(session.vault_id); },
    };
    const model = this.models.view();
    if (!model.model || !model.credentialConfigured) throw new ApiError('CONFIG_REQUIRED');
    const run = this.db.prepare('SELECT started_at FROM runs WHERE id=?').get(runId) as { started_at: string };
    const deadline = Date.parse(run.started_at) + MODEL_LIMITS.questionMs;
    const abort = new AbortController(), combined = AbortSignal.any([signal, abort.signal]);
    const unsubscribeMemory = this.memories.onChange(vaultId => {
      if (vaultId === session.vault_id && this.memories.generation(vaultId) !== message.memory_generation) abort.abort('CONTEXT_CHANGED');
    });
    const timer = setTimeout(() => abort.abort(), Math.max(0, deadline - Date.now())); timer.unref();
    const check = () => {
      if (Date.now() >= deadline) throw new ApiError('DEADLINE_EXCEEDED');
      if (this.models.view().revision !== message.model_revision || this.vaults.get(session.vault_id).revision !== message.scope_revision ||
        this.conversations.row(session.id).context_generation !== message.context_generation ||
        this.memories.generation(session.vault_id) !== message.memory_generation) throw new ApiError('CONTEXT_CHANGED');
      if (combined.aborted || (this.db.prepare('SELECT state FROM runs WHERE id=?').get(runId) as { state: string }).state !== 'running') throw new ApiError('RUN_INTERRUPTED');
    };
    try {
      check(); progress({ stage: 'preparing' });
      // The first local tool refreshes the catalog; model-only answers do not require a full scan.
      const settings = JSON.stringify({ scope: input.scope, scopeRevision: message.scope_revision,
        modelRevision: message.model_revision, contextGeneration: message.context_generation, memoryGeneration: message.memory_generation });
      const catalog = catalogHash(this.vaults, session.vault_id, input.scope);
      const old = !input.workflow && session.active_segment_id ? this.db.prepare('SELECT * FROM session_segments WHERE id=? AND session_id=?')
        .get(session.active_segment_id, session.id) as Segment | undefined : undefined;
      if (!input.workflow && session.active_segment_id && !old) throw new ApiError('SESSION_UNREADABLE');
      // Obsolete mode fields do not invalidate otherwise unchanged conversation context.
      const previousSettings = old ? JSON.parse(old.settings_json) : null;
      if (previousSettings) delete previousSettings.policy;
      const sameSettings = !!old && JSON.stringify(previousSettings) === settings;
      let reason: string | null = old ? '资料、范围或已保存的说明发生变化，已清除旧回答、工具片段及摘要。' : null;
      let priorRuns: string[] = [], context: NonNullable<WorkerInput['context']> = { resume: null, priorQuestions: [], priorTools: [], notice: null };
      if (old && sameSettings && old.catalog_hash === catalog) {
        priorRuns = (this.db.prepare('SELECT run_id FROM messages WHERE segment_id=? ORDER BY ordinal').all(old.id) as { run_id: string }[]).map(r => r.run_id);
        try {
          await checkSources(this.db, this.vaults, priorRuns, session.vault_id, input.scope, combined); check();
          readSessionFile(this.dataDirectory, old.session_file, old.session_hash);
          context.resume = { file: old.session_file, hash: old.session_hash }; reason = null;
          for (const priorRun of priorRuns) {
            const rows = this.db.prepare('SELECT call_id,result_json FROM tool_results WHERE run_id=?').all(priorRun) as { call_id: string; result_json: string }[];
            context.priorTools.push(...rows.map(row => ({ id: row.call_id, result: JSON.parse(row.result_json) as ToolResult })));
          }
        } catch (error) {
          check();
          if (!(error instanceof ApiError) || !['CONTEXT_CHANGED','SOURCE_CHANGED','SOURCE_MISSING','SOURCE_EXCLUDED','SOURCE_NOT_READY','DERIVED_MODIFIED'].includes(error.publicError.code)) throw error;
          priorRuns = [];
        }
      }
      if (!context.resume && old) {
        priorRuns = [];
        // Rebuild from logical user input only. A Pi role=user entry can actually be a compaction summary.
        // A changed scope/generation may revoke facts or preferences quoted in old questions; carry none then.
        if (sameSettings) {
          const rows = this.db.prepare(`SELECT m.text FROM messages m JOIN runs r ON r.id=m.run_id
            WHERE m.session_id=? AND m.ordinal<? AND (r.resolved_action='ask' OR m.segment_id IS NOT NULL) ORDER BY m.ordinal DESC LIMIT ?`)
            .all(session.id, message.ordinal, HISTORY_LIMITS.questions + 1) as { text: string }[];
          let bytes = 0;
          for (const row of rows.slice(0, HISTORY_LIMITS.questions)) {
            if (bytes + Buffer.byteLength(row.text) > HISTORY_LIMITS.bytes) break;
            context.priorQuestions.unshift(row.text); bytes += Buffer.byteLength(row.text);
          }
          if (context.priorQuestions.length < rows.length) reason += ' 只保留最近能完整容纳的问题；无法确定比较对象时请用户补充，不能猜测。';
        } else reason += ' 旧问题中的引用和偏好也不再自动带入；无法确定追问对象时请用户补充。';
        context.notice = reason;
      }
      if (input.basedOnAnswerId) {
        // An explicit version is a new continuation point, never an implicit replay of the old chat.
        context = { resume:null,priorQuestions:[],priorTools:[],notice:null }; priorRuns=[];
        const reference=this.answers.stored(input.basedOnAnswerId);
        if(reference.sessionId!==session.id) throw new ApiError('BAD_REQUEST');
        const sourceMessage=this.db.prepare('SELECT scope_revision,memory_generation FROM messages WHERE run_id=?').get(reference.runId) as
          {scope_revision:number;memory_generation:number}|undefined;
        const reviewJob=this.db.prepare('SELECT snapshot_json FROM answer_watch_runs WHERE answer_id=?').get(reference.id) as {snapshot_json:string}|undefined;
        const settings=reviewJob ? JSON.parse(reviewJob.snapshot_json) : {scopeRevision:sourceMessage?.scope_revision,memoryGeneration:sourceMessage?.memory_generation};
        try {
          if(settings.scopeRevision!==message.scope_revision || settings.memoryGeneration!==message.memory_generation) throw new ApiError('CONTEXT_CHANGED');
          const dependencies=answerDependencyRuns(this.db,reference.runId);
          await checkSources(this.db,this.vaults,dependencies,session.vault_id,input.scope,combined); check();
          const blocks=reference.blocks.map(({id,kind,markdown})=>({id,kind,markdown}));
          const checks=(reference.checks??[]).map(({id,kind,blockIds,summary,impact,nextStep})=>({id,kind,blockIds,summary,impact,nextStep}));
          const content={blocks,checks,...(reference.retrospective?{retrospective:reference.retrospective}:{}),...(reference.experiences?{experiences:reference.experiences}:{}),...(reference.resume?{resume:reference.resume,resumeCoverage:reference.resumeCoverage}:{})};
          if(Buffer.byteLength(JSON.stringify(content))>48000) throw new ApiError('CONTEXT_CHANGED');
          context.answerReference={answerId:reference.id,createdAt:reference.createdAt,...content}; priorRuns=dependencies;
          reason='本轮基于用户选择的答案版本继续，资料事实仍须重新读取核对。';
        } catch(error) {
          check();
          if(!(error instanceof ApiError) || !['CONTEXT_CHANGED','SOURCE_CHANGED','SOURCE_MISSING','SOURCE_EXCLUDED','SOURCE_NOT_READY','DERIVED_MODIFIED'].includes(error.publicError.code)) throw error;
          reason='所选答案版本的依据、范围或背景已变化，未带入旧正文；本轮重新检索，指代不清时请补充具体问题。';
        }
        context.notice=reason;
      }
      if(input.workflow){
        const snapshot=await resumeContext(this.db,this.vaults,message,session.vault_id,input.scope,combined,check);
        const reference=context.answerReference;
        snapshot.context.purpose=input.workflow;
        if(input.workflow==='retrospective' && input.basedOnAnswerId){
          const chosen=this.answers.stored(input.basedOnAnswerId);
          snapshot.context.requestedAnswer={id:chosen.id,createdAt:chosen.createdAt};
          if(reference)snapshot.context.selectedAnswer={id:input.basedOnAnswerId,createdAt:reference.createdAt,blocks:reference.blocks};
          else {
            snapshot.context.selectedAnswerUnavailable=true;
            for(const entry of snapshot.context.messages)if(entry.answer?.id===chosen.id){delete entry.answer;snapshot.context.coverage.omittedAnswers++;}
          }
        }
        context={resume:null,priorQuestions:[],priorTools:[],notice:reason,conversation:snapshot.context};
        priorRuns=[...new Set([...priorRuns,...snapshot.runs])];
      }
      if(input.experienceComparison)context.experienceComparison=true;
      const segmentId = context.resume ? old!.id : newId('segment');
      context.attachments = input.basedOnAnswerId || input.workflow ? [] : this.attachmentHints(session.id, message.ordinal, session.vault_id, input.scope);
      const workerInput: WorkerInput = { runId, sessionId: session.id, segmentId, generation: message.context_generation,
        vaultId: session.vault_id, scope: input.scope, scopeRevision: message.scope_revision, deadline, signal: combined,
        question: input.text, preferences: snapshot.items.map(item => item.text), thinking: 'off', batchId: this.batchId,
        modelRevision: message.model_revision, context,
        beforeSend: async()=>{ check();
          const dependencies = [...priorRuns,runId];
          if (dependencies.some(id => this.db.prepare('SELECT 1 FROM context_sources WHERE run_id=? LIMIT 1').get(id))) {
            await this.vaults.scan(session.vault_id,combined); check();
            await checkSources(this.db,this.vaults,dependencies,session.vault_id,input.scope,combined); check();
          }
        } };
      const candidate = await this.runner.run(workerInput, progress); check();
      progress({ stage: 'validating' });
      await checkSources(this.db, this.vaults, [...priorRuns, runId], session.vault_id, input.scope, combined); check();
      const answer = await this.answers.prepare(candidate.draft, { runId, sessionId: session.id, vaultId: session.vault_id,
        scope: input.scope, signal: combined, check, conversation:context.conversation,experienceComparison:input.experienceComparison });
      const file = readSessionFile(this.dataDirectory, candidate.sessionFile);
      const entries = file.bytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
      const user = entries.find(entry => entry.id === candidate.userEntryId), last = entries.find(entry => entry.id === candidate.entryId);
      const userText = typeof user?.message?.content === 'string' ? user.message.content : user?.message?.content?.map((b: { type: string; text?: string }) => b.type === 'text' ? b.text : '').join('');
      const answerText = Array.isArray(last?.message?.content) ? last.message.content.filter((b: { type: string }) => b.type === 'text')
        .map((b: { text: string }) => b.text).join('') : '';
      if (user?.type !== 'message' || user.message.role !== 'user' || userText !== input.text || last?.type !== 'message' ||
        last.message.role !== 'assistant' || last.message.stopReason !== 'stop' ||
        JSON.stringify(parseAnswerDraft(answerText)) !== JSON.stringify(candidate.draft)) throw new ApiError('MODEL_PROTOCOL_ERROR');
      check();
      if (reason) {
        answer.limitations.push(reason); answer.markdown += `\n\n**上下文说明：** ${reason}`;
      }
      const afterCatalog = catalogHash(this.vaults, session.vault_id, input.scope);
      // Empty when the catalog changed during generation: next question must rebuild, including negative search conclusions.
      const reusableCatalog = afterCatalog === catalog ? catalog : '';
      return { answer, commit: () => {
        check();
        if (!this.db.inTransaction) throw new ApiError('SERVICE_UNAVAILABLE');
        checkSourceRecords(this.db, this.vaults, [...priorRuns, runId]);
        for(const prior of priorRuns) this.db.prepare(`INSERT OR IGNORE INTO context_sources(run_id,source_id,snapshot_json)
          SELECT ?,source_id,snapshot_json FROM context_sources WHERE run_id=?`).run(runId,prior);
        this.answers.commit(answer);
        if (context.resume) this.db.prepare('UPDATE session_segments SET session_file=?,session_hash=?,catalog_hash=? WHERE id=?')
          .run(candidate.sessionFile, file.hash, reusableCatalog, segmentId);
        else this.db.prepare(`INSERT INTO session_segments(id,session_id,generation,settings_json,catalog_hash,session_file,session_hash,created_at,rebuild_reason)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(segmentId, session.id, message.context_generation, settings, reusableCatalog, candidate.sessionFile, file.hash, answer.createdAt, reason);
        this.db.prepare('UPDATE messages SET segment_id=?,pi_entry_id=? WHERE id=?').run(segmentId, candidate.userEntryId, message.id);
        this.db.prepare('UPDATE conversations SET active_segment_id=?,updated_at=? WHERE id=?').run(segmentId, answer.createdAt, session.id);
        return { answerId: answer.id };
      } };
    } catch (error) { check(); throw error; }
    finally { clearTimeout(timer); unsubscribeMemory(); }
  }
}
