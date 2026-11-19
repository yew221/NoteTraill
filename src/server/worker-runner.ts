import { experienceErrors, experienceSections } from '../shared/experiences.js';
import { retrospectiveValidationErrors } from '../shared/retrospective.js';
import { resumeValidationErrors } from '../shared/continuation.js';
import { MEMORY_LIMITS, isMemoryText } from '../shared/memory.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork, type ChildProcess } from 'node:child_process';
import { hasFields, isId, isRevision, type Id } from '../shared/contracts.js';
import { isErrorCode, type ErrorCode } from '../shared/api.js';
import { ANSWER_LIMITS, isAnswerDraft, parseAnswerDraft } from '../shared/answer.js';
import { AnswerService } from './answers.js';
import type { ModelLimits } from '../shared/model-run.js';
import { TOOL_LIMITS } from '../shared/tools.js';
import { PROJECT_PROTOCOL_VERSION, WORKER_REQUEST_BYTES, type WorkerCandidate, type WorkerStart, type WorkerRpc } from '../shared/worker.js';
import { ApiError } from './contracts.js';
import type { SqliteDatabase } from './storage.js';
import { ModelSettings } from './model-settings.js';
import { ModelLedger } from './model-ledger.js';
import { ModelTransport, type ModelResponse } from './model-transport.js';
import { WebSearch } from './web-search.js';
import { SearchPrivacy } from './search-privacy.js';
import { VaultToolSession, type ToolRunContext } from './vault-tools.js';
import { VaultService } from './vaults.js';
import { Ripgrep } from './ripgrep.js';
import { readSessionFile } from './session-files.js';

export type WorkerInput = ToolRunContext & { generation: number; sessionId: Id<'session'>; segmentId: Id<'segment'>;
  question: string; preferences: string[]; thinking: 'off' | 'low'; batchId: string; modelRevision: number;
  modelLimits?: Partial<ModelLimits>;
  beforeSend?: () => Promise<void>;
  context?: Omit<WorkerStart['context'], 'resumeFile'> & { resume: { file: string; hash: string } | null } };
export type WorkerProgress = { stage: 'preparing' | 'generating' | 'searching' | 'reading' | 'validating'; tool?: string; preview?: string };
function protocol(): never { throw new ApiError('MODEL_PROTOCOL_ERROR'); }
function privateDirectory(directory: string, create = false): void {
  if (create && !fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700 || fs.realpathSync(directory) !== directory) throw new ApiError('SERVICE_UNAVAILABLE');
}

export class WorkerRunner {
  private active = false;
  constructor(private readonly db: SqliteDatabase, private readonly vaults: VaultService, private readonly ripgrep: Ripgrep,
    private readonly settings: ModelSettings, private readonly ledger: ModelLedger, private readonly dataDirectory: string,
    private readonly fetcher: typeof fetch = fetch) {}
  async run(input: WorkerInput, onProgress: (event: WorkerProgress) => void = () => {}): Promise<WorkerCandidate> {
    if (this.active) throw new ApiError('SESSION_BUSY');
    if (process.platform !== 'darwin') throw new ApiError('CONFIG_REQUIRED');
    if (!isRevision(input.generation) || !isId(input.sessionId, 'session') || !isId(input.segmentId, 'segment') ||
      typeof input.question !== 'string' || !input.question.trim() || Buffer.byteLength(input.question) > 16000 ||
      !['off','low'].includes(input.thinking) || !isRevision(input.modelRevision) ||
      !Array.isArray(input.preferences) || input.preferences.length > MEMORY_LIMITS.count || input.preferences.some(item => !isMemoryText(item)) ||
      input.preferences.join('').length > MEMORY_LIMITS.totalLength) throw new ApiError('BAD_REQUEST');
    if (this.settings.view().revision !== input.modelRevision) throw new ApiError('CONTEXT_CHANGED');
    if (input.signal.aborted) throw new ApiError('RUN_INTERRUPTED');
    const abort = new AbortController(), signal = AbortSignal.any([input.signal, abort.signal]);
    // Refresh only when a local tool is actually used. Evidence still revalidates source hashes.
    const privacy = new SearchPrivacy();
    privacy.question(input.question);
    privacy.local(input.preferences);
    if (input.scope.mode === 'selected') for (const relativePath of input.scope.paths) privacy.local({ relativePath });
    privacy.local(input.context?.priorQuestions);
    privacy.local(input.context?.priorTools);
    privacy.local(input.context?.attachments);
    privacy.local(input.context?.review);
    privacy.local(input.context?.answerReference);
    privacy.local(input.context?.conversation);
    const search = new WebSearch(this.settings, this.ledger, privacy, this.fetcher, input.beforeSend);
    const gateway = new VaultToolSession(this.db, this.vaults, this.ripgrep, { ...input, signal,
      prepareVault: () => this.vaults.scan(input.vaultId, signal),
      observeLocal: result => privacy.local(result),
      webSearch: (args, toolSignal) => search.execute(input.runId, input.modelRevision, args, toolSignal),
      limits: input.limits });
    this.active = true;
    let transport: ModelTransport | undefined;
    try {
      this.ledger.start(input.runId, input.batchId, input.modelLimits);
      transport = new ModelTransport(this.ledger, this.settings, input.runId, input.modelRevision, signal, this.fetcher, input.beforeSend);
      privateDirectory(this.dataDirectory);
      const workers = path.join(this.dataDirectory, 'workers'); privateDirectory(workers, true);
      const directory = path.join(workers, `${input.runId}-${input.generation}`);
      fs.mkdirSync(directory, { mode: 0o700 });
      for (const name of ['cwd','agent','sessions']) fs.mkdirSync(path.join(directory, name), { mode: 0o700 });
      let resumeFile: string | null = null;
      if (input.context?.resume) {
        const saved = readSessionFile(this.dataDirectory, input.context.resume.file, input.context.resume.hash);
        privacy.history(saved.bytes);
        resumeFile = 'resume.jsonl';
        fs.writeFileSync(path.join(directory, 'sessions', resumeFile), saved.bytes, { mode: 0o600, flag: 'wx' });
      }
      const root = fileURLToPath(new URL('../../', import.meta.url));
      const permissions = ['--permission', ...[path.join(root, 'node_modules'), path.join(root, 'dist'), directory]
        .map(file => `--allow-fs-read=${file}`), `--allow-fs-write=${directory}`];
      const child = fork(fileURLToPath(new URL('./pi-worker.mjs', import.meta.url)), [], {
        execPath: '/usr/bin/sandbox-exec', execArgv: ['-p', '(version 1)(allow default)(deny network*)', process.execPath, ...permissions],
        cwd: path.join(directory, 'cwd'), serialization: 'json', stdio: ['ignore','ignore','ignore','ipc'],
        env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', PI_OFFLINE: '1', PI_CODING_AGENT_DIR: path.join(directory, 'agent') },
      });
      const start: WorkerStart = { projectProtocolVersion: PROJECT_PROTOCOL_VERSION, type: 'RunStart', runId: input.runId, generation: input.generation,
        sessionId: input.sessionId, segmentId: input.segmentId, deadline: Math.min(input.deadline, this.ledger.deadline(input.runId)), question: input.question,
        modelConfig: this.settings.view().model!, preferences: [...input.preferences], thinking: input.thinking, scope: input.scope, sourceHints: gateway.selectedSourceHints(),
        context: { resumeFile, priorQuestions: input.context?.priorQuestions ?? [], priorTools: input.context?.priorTools ?? [],
          ...(input.context?.experienceComparison?{experienceComparison:true as const}:{}),notice: input.context?.notice ?? null, attachments: input.context?.attachments ?? [], ...(input.context?.review ? { review: input.context.review } : {}), ...(input.context?.answerReference ? { answerReference: input.context.answerReference } : {}), ...(input.context?.conversation ? {conversation:input.context.conversation} : {}) } };
      privacy.local(start.sourceHints);
      const result = await this.drive(child, start, input.modelRevision, transport, gateway, abort, signal, onProgress);
      const file = path.join(directory, 'sessions', result.sessionFile), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 ||
        stat.size > 8 * 1024 * 1024 || fs.realpathSync(file) !== file) throw new ApiError('SESSION_UNREADABLE');
      return { ...result, sessionFile: path.relative(this.dataDirectory, file), usage: { ...this.ledger.totals(input.runId), ...gateway.usage() }, workerPid: child.pid! };
    } finally {
      abort.abort(); transport?.close(); gateway.close(); this.ledger.abandon(input.runId); this.active = false;
    }
  }
  private async drive(child: ChildProcess, start: WorkerStart, modelRevision: number, transport: ModelTransport, gateway: VaultToolSession,
    abort: AbortController, signal: AbortSignal, progress: (event: WorkerProgress) => void): Promise<Omit<WorkerCandidate, 'usage' | 'workerPid'>> {
    let ready = false, settled = false, sequence = 0, failure: ErrorCode | undefined, pending: ModelResponse | undefined, lastModel: string | undefined;
    let candidate: Omit<WorkerCandidate, 'usage' | 'workerPid'> | undefined, tail = Promise.resolve(), killTimer: NodeJS.Timeout | undefined;
    const calls = new Map<string, string>();
    const send = (message: unknown) => new Promise<void>((resolve, reject) => {
      if (!child.connected) { reject(new ApiError('WORKER_EXITED')); return; }
      child.send(message as object, error => error ? reject(new ApiError('WORKER_EXITED')) : resolve());
    });
    const stop = (code: ErrorCode) => {
      if (failure) return;
      failure = code; abort.abort();
      void send({ projectProtocolVersion: PROJECT_PROTOCOL_VERSION, type: 'Abort', runId: start.runId, generation: start.generation, errorCode: code }).catch(() => {});
      killTimer = setTimeout(() => child.kill('SIGKILL'), 500); killTimer.unref();
    };
    const onAbort = () => stop(Date.now() >= start.deadline ? 'DEADLINE_EXCEEDED' :
      this.settings.view().revision !== modelRevision || signal.reason === 'CONTEXT_CHANGED' ? 'CONTEXT_CHANGED' : 'RUN_INTERRUPTED');
    const scopeChange = this.vaults.onScopeChange(() => stop('CONTEXT_CHANGED'));
    const modelChange = this.settings.onChange(() => stop('CONTEXT_CHANGED'));
    signal.addEventListener('abort', onAbort, { once: true });
    const deadline = setTimeout(() => stop('DEADLINE_EXCEEDED'), Math.max(0, start.deadline - Date.now()));
    const startup = setTimeout(() => { if (!ready) stop('WORKER_EXITED'); }, Math.min(10000, Math.max(1, start.deadline - Date.now())));
    const execute = async (request: WorkerRpc): Promise<unknown> => {
      if (failure || signal.aborted || settled) throw new ApiError(failure ?? 'RUN_INTERRUPTED');
      const data = request.data;
      if (request.operation === 'model') {
        if (pending || candidate) protocol(); gateway.assertToolsSettled(); progress({ stage: 'generating' });
        const used = gateway.usage();
        pending = await transport.request(data, preview => progress({ stage: 'generating', preview }),
          used.toolCalls >= TOOL_LIMITS.maxToolCalls - 20 || used.readBytes >= TOOL_LIMITS.maxReadBytes - TOOL_LIMITS.maxReadBytesPerCall * 2);
        gateway.reserveCalls(pending.calls);
        for (const call of pending.calls) calls.set(call.id, call.name);
        const { calls: _calls, ...response } = pending; return response;
      }
      if (request.operation === 'verify') {
        if (!pending || !hasFields(data, ['attemptId','inputTokens','outputTokens','totalTokens','stopReason','calls']) ||
          data.attemptId !== pending.attemptId || data.inputTokens !== pending.usage.prompt_tokens || data.outputTokens !== pending.usage.completion_tokens ||
          data.totalTokens !== pending.usage.total_tokens || !['stop','toolUse','length'].includes(String(data.stopReason)) || !Array.isArray(data.calls) ||
          data.calls.some(call => !hasFields(call, ['id','name','arguments']) || typeof call.id !== 'string' || typeof call.name !== 'string') ||
          (data.stopReason === 'toolUse') !== (data.calls.length > 0) || JSON.stringify(data.calls) !== JSON.stringify(pending.calls)) protocol();
        lastModel = pending.returnedModel; pending = undefined; return {};
      }
      if (pending || candidate) protocol();
      if (request.operation === 'validate') {
        gateway.assertToolsSettled(); progress({ stage: 'validating' });
        if (typeof data !== 'string' || data.length > ANSWER_LIMITS.serializedChars) protocol();
        const draft = parseAnswerDraft(data);
        if (!draft) {
          let syntax='字段结构不正确';
          try {
            const raw:unknown=JSON.parse(data.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1'));
            if(hasFields(raw,['outcome','blocks','limitations'],['checks','resume','experiences','review','retrospective']) && Array.isArray(raw.blocks)){
              const groups=new Map<string,Set<string>>();
              for(const block of raw.blocks)if(hasFields(block,['id','kind','markdown','evidenceIds','experience'])&&hasFields(block.experience,['caseTitle','section'])&&typeof block.experience.caseTitle==='string'&&typeof block.experience.section==='string'){
                const set=groups.get(block.experience.caseTitle)??new Set<string>();set.add(block.experience.section);groups.set(block.experience.caseTitle,set);
              }
              for(const [title,sections] of [...groups].slice(0,4)){const missing=Object.keys(experienceSections).filter(k=>!sections.has(k));if(missing.length)syntax+=`；案例 ${title.slice(0,160)} 缺少 ${missing.join('、')} 栏，未知也须独立 notice 块`;
              }
            }
          }
          catch { syntax='JSON 语法不完整或不合法；检查引号及所有对象/数组的闭合，必须闭合每个 block、blocks 数组和顶层对象'; }
          return { ok: false, code: 'MODEL_PROTOCOL_ERROR', hint: syntax+'。请输出完整 AnswerDraft JSON；每块包含 id/kind/markdown/evidenceIds，引用必须是完整 e_ 编号。grounded 可有 sourceQuote:{evidenceId,quote}，用于绑定关键原句。checks 每项包括 evidence 数组。不要增加解释或字段。' };
        }
        try {
          if (start.context.review) {
            const context = start.context.review, review = draft.review;
            const results = (this.db.prepare('SELECT result_json FROM tool_results WHERE run_id=?').all(start.runId) as { result_json: string }[]).map(r => JSON.parse(r.result_json));
            if (!review || review.changes.some(c => c.before.some(id => !context.previous.some(b => b.id === id)) || c.after.some(id => !draft.blocks.some(b => b.id === id))) ||
              (!context.comparisonAvailable && (review.kind !== 'uncertain' || review.changes.some(c => c.before.length))) ||
              !results.some(r => r.ok && (r.data?.evidence || Array.isArray(r.data?.matches)))) throw new ApiError('CITATION_INVALID');
          }
          await new AnswerService(this.db, this.vaults).prepare(draft, { runId: start.runId, sessionId: start.sessionId,
            vaultId: gateway.vaultId, scope: start.scope, signal, conversation:start.context.conversation,experienceComparison:start.context.experienceComparison, check: () => { gateway.assertToolsSettled(); } });
          return { ok: true };
        } catch (error) {
          if (!(error instanceof ApiError) || !['CITATION_INVALID','MODEL_PROTOCOL_ERROR'].includes(error.publicError.code)) throw error;
          const local = this.db.prepare('SELECT id FROM evidence WHERE run_id=?').all(start.runId) as { id: string }[];
          const messageReferenceErrors=[...resumeValidationErrors(draft.blocks,draft.resume,start.context.conversation?.purpose==='retrospective'?undefined:start.context.conversation),...retrospectiveValidationErrors(draft.blocks,draft.retrospective,start.context.conversation?.purpose==='retrospective'?start.context.conversation:undefined)];
          if(draft.outcome==='answered'&&draft.blocks.every(b=>b.kind==='notice'))messageReferenceErrors.push('outcome=answered 不能只有 notice。根据用户报告、对话内容或模型知识作答的正文应使用 general 并保留事实性质；只有说明无法回答时才用 notice 和 insufficient_evidence。不要通过伪造资料引用修复。');
          return { ok: false, code: error.publicError.code, messageReferenceErrors, experienceErrors:[...experienceErrors(draft.blocks,draft.experiences),...(start.context.experienceComparison&&!draft.experiences?['本轮需要案例对照：找到案例时每个相关块添加experience元信息并填齐七栏；没有匹配案例才用顶层experiences:{cases:[]}，不要把失败或仅有计划的案例省成普通回答。']:[])], hint: '引用核对失败。grounded/inference 必须引用本轮 vault_read 的 e_ 编号。每条 grounded 只挂同一份资料，对不同资料分块转述原文，比较用独立 inference。sourceQuote 必须逐字来自这一块对应的 e_ 片段，不能沿用另一块的引文。计划、建议、尚待核对不能表述为已完成。web 只能引用本轮网页结果。general/notice 不得挂引用。未读取的资料不能当作依据；可继续读取或如实说明缺口。不要伪造应用内部链接。' + (start.context.review ? ' 自动复核须调用 vault_search 或 vault_read，并输出 review；before/after 只引用提供的历史/本轮块编号，历史不可比较时 kind=uncertain 且 before 为空。' : '') + (start.context.conversation?.purpose==='retrospective'?' 复盘 blocks 至少7块，每块添加 retrospective:{section,basis,messages}，按 judgment/expected/action/outcome/comparison/explanations/lesson 排列，缺失也要单独 unknown 块。必须区分实际结果、历史预期和未证实解释。':start.context.conversation ? ' 续接 blocks 至少6块，每块的 resume 元信息写 section/basis/messages；按 goal、decisions、progress、stopping_point、open_questions、next_step 排列，不复用块编号，不在顶层另写 resume；user_confirmed/user_reported 必须有同一消息的用户原话，historical_answer 必须有历史 assistant 原话。messages 的 quote 必须逐字来自提供的相应消息，不能把回答文本当成用户原话。' : ''), localEvidenceIds: local.map(e => e.id) };
        }
      }
      if (request.operation === 'tool') {
        if (!hasFields(data, ['id']) || typeof data.id !== 'string' || !calls.has(data.id)) protocol();
        const name = calls.get(data.id)!; progress({ stage: name === 'vault_read' ? 'reading' : 'searching', tool: name });
        return gateway.executeReserved(data.id);
      }
      if (request.operation === 'results') {
        if (!Array.isArray(data) || data.length < 1 || data.length > 20 || data.some(item => !hasFields(item, ['id','text','isError']) ||
          typeof item.id !== 'string' || typeof item.text !== 'string' || Buffer.byteLength(item.text) > 65536 || typeof item.isError !== 'boolean')) protocol();
        return data.map(item => gateway.reconcileResult(item.id, item.text, item.isError));
      }
      if (request.operation === 'candidate') {
        gateway.assertToolsSettled(); progress({ stage: 'validating' });
        if (!hasFields(data, ['draft','model','sessionFile','entryId','userEntryId']) || !isAnswerDraft(data.draft) || typeof data.model !== 'string' || data.model !== lastModel ||
          typeof data.sessionFile !== 'string' || !/^[A-Za-z0-9._-]{1,200}\.jsonl$/.test(data.sessionFile) || path.basename(data.sessionFile) !== data.sessionFile ||
          typeof data.entryId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.entryId) ||
          typeof data.userEntryId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.userEntryId)) protocol();
        candidate = data as Omit<WorkerCandidate, 'usage' | 'workerPid'>; return {};
      }
      return protocol();
    };
    try {
      const closed = new Promise<void>((resolve, reject) => {
        child.once('error', () => { stop('WORKER_EXITED'); });
        child.once('close', (code, exitSignal) => {
          if (code !== 0 || exitSignal || !settled || !candidate || failure) { failure ??= 'WORKER_EXITED'; abort.abort(); }
          tail.then(() => failure ? reject(new ApiError(failure)) : resolve(), () => reject(new ApiError(failure ?? 'WORKER_EXITED')));
        });
      });
      child.on('message', message => {
        if (!ready) {
          if (!hasFields(message, ['projectProtocolVersion','type']) || message.projectProtocolVersion !== PROJECT_PROTOCOL_VERSION || message.type !== 'Ready') { stop('MODEL_PROTOCOL_ERROR'); return; }
          ready = true; clearTimeout(startup);
          try { progress({ stage: 'preparing' }); } catch { stop('SERVICE_UNAVAILABLE'); return; }
          void send(start).catch(() => stop('WORKER_EXITED')); return;
        }
        if (hasFields(message, ['projectProtocolVersion','type','runId','generation','state'], ['errorCode']) && message.type === 'Settled' &&
          message.projectProtocolVersion === PROJECT_PROTOCOL_VERSION && message.runId === start.runId && message.generation === start.generation && !settled) {
          settled = true;
          if (message.state !== 'prepared' || !candidate || message.errorCode !== undefined) stop(isErrorCode(message.errorCode) ? message.errorCode : 'MODEL_PROTOCOL_ERROR');
          return;
        }
        if (!hasFields(message, ['projectProtocolVersion','type','runId','generation','id','operation','data']) ||
          message.projectProtocolVersion !== PROJECT_PROTOCOL_VERSION || message.type !== 'Request' || message.runId !== start.runId || message.generation !== start.generation ||
          message.id !== sequence + 1 || sequence >= 200 || Buffer.byteLength(JSON.stringify(message)) > WORKER_REQUEST_BYTES) { stop('MODEL_PROTOCOL_ERROR'); return; }
        sequence++; const request = message as WorkerRpc;
        tail = tail.then(async () => {
          try {
            const data = await execute(request);
            if (failure || signal.aborted) throw new ApiError(failure ?? 'RUN_INTERRUPTED');
            await send({ projectProtocolVersion: PROJECT_PROTOCOL_VERSION, type: 'Reply', runId: start.runId, generation: start.generation, id: request.id, ok: true, data });
          } catch (error) {
            const code = error instanceof ApiError ? error.publicError.code : 'MODEL_PROTOCOL_ERROR';
            await send({ projectProtocolVersion: PROJECT_PROTOCOL_VERSION, type: 'Reply', runId: start.runId, generation: start.generation, id: request.id, ok: false, errorCode: code }).catch(() => {});
            stop(code);
          }
        });
      });
      if (signal.aborted) onAbort();
      await closed; return candidate!;
    } finally {
      clearTimeout(deadline); clearTimeout(startup); if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener('abort', onAbort); scopeChange(); modelChange();
    }
  }
}
