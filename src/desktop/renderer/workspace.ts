import { emptyDraft, pruneEmptyDrafts, type DesktopWorkspace, type DesktopDraft } from '../../shared/desktop.js';
import { questionTooLong } from '../../shared/chat.js';
import { isRunRef, type RunRef } from '../../shared/contracts.js';
import type { Conversation } from '../../shared/chat.js';
import { intakeKind } from '../../shared/presentation.js';
import { isIngestInstruction } from '../../shared/ingest.js';
import { inScope } from '../../shared/tools.js';
import type { Run } from '../../shared/run.js';
import { data } from './api.js';

export async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function unwrap<T>(reply: { data: T } | { error: { code: string; message: string } }): T {
  if ('error' in reply) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
  return reply.data;
}
export function uploadSourceId(run?: Run) {
  return run?.attachmentSourceId ?? (run?.result && 'sourceId' in run.result ? run.result.sourceId : run?.error?.details?.sourceId);
}
function rejectedAttachmentRequest(error: unknown): boolean {
  const {code} = error as {code?: string};
  return !!code && ['SOURCE_EXCLUDED','PATH_OUTSIDE_SCOPE','BAD_REQUEST','CONTEXT_CHANGED','VAULT_ACCESS_DENIED','UNSUPPORTED_FORMAT','FILE_TOO_LARGE','SESSION_BUSY','SOURCE_MISSING','SOURCE_NOT_READY','NOT_FOUND'].includes(code);
}
export class Workspace {
  current: DesktopWorkspace;
  private listeners = new Set<() => void>();
  constructor() {
    this.current = unwrap(window.notetrail.loadWorkspace());
    // Pending submissions keep their original fingerprint and request key until acknowledged.
    const drafts = Object.fromEntries(Object.entries(this.current.drafts).map(([key, draft]) => {
      if (draft.pending) return [key, draft];
      const { policyVersion: _legacy, ...current } = draft;
      return [key, { ...current, options: { scope: draft.options.scope } }];
    }));
    if (JSON.stringify(drafts) !== JSON.stringify(this.current.drafts)) this.update(state => ({ ...state, drafts }));
  }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = (): DesktopWorkspace => this.current;
  update(change: (state: DesktopWorkspace) => DesktopWorkspace): void {
    const next = pruneEmptyDrafts(change(this.current));
    // A synchronous, bounded write makes text and request identities durable before closing or sending.
    unwrap(window.notetrail.saveWorkspace(next)); this.current = next; this.listeners.forEach(listener => listener());
  }
  draft(key: string): DesktopDraft { return this.current.drafts[key] ?? emptyDraft(); }
  edit(key: string, patch: Partial<DesktopDraft>): void {
    const previous = this.draft(key);
    if (patch.basedOnAnswerId || patch.experienceComparison) patch = { ...patch, questionFileRun: undefined };
    // An unacknowledged file question must replay exactly the same scope and request key.
    if (previous.pending && patch.options && (previous.pending.questionPath || JSON.stringify(previous.options.scope) === JSON.stringify(patch.options.scope))) {
      patch = { ...patch, options: previous.options };
    }
    this.update(state => ({ ...state, drafts: { ...state.drafts, [key]: { ...previous, ...patch } } }));
  }
  location(patch: Partial<Pick<DesktopWorkspace, 'page' | 'vaultId' | 'sessionId' | 'sidebarWidth'>>): void {
    this.update(state => ({ ...state, ...patch }));
  }
  capacity(): void { if (this.current.tasks.filter(task => !task.finished).length >= 50) throw new Error('请先等待或停止已有任务，再提交新任务。'); }
  task(ref: RunRef, sessionId: string | null): void {
    this.update(state => ({ ...state, tasks: [...state.tasks.filter(task => task.runId !== ref.runId), { runId: ref.runId, sessionId, finished: false }] }));
  }
  terminal(id: string): void {
    const tasks = this.current.tasks.map(task => task.runId === id ? { ...task, finished: true } : task);
    const recent = new Set(tasks.filter(task => task.finished).slice(-40).map(task => task.runId));
    this.update(state => ({ ...state, tasks: tasks.filter(task => !task.finished || recent.has(task.runId)) }));
  }
  async auxiliary(signature: string, invoke: (key: string) => Promise<unknown>): Promise<unknown> {
    this.capacity();
    const key = this.current.pending[signature] ?? crypto.randomUUID();
    this.update(state => ({ ...state, pending: { ...state.pending, [signature]: key } }));
    const result = await invoke(key);
    this.update(state => { const pending = { ...state.pending }; delete pending[signature];
      return { ...state, pending, tasks: isRunRef(result) ? [...state.tasks.filter(task => task.runId !== result.runId), { runId: result.runId, sessionId: null, finished: false }] : state.tasks };
    });
    return result;
  }
  async submit(key: string, vaultId: string, conversation: Conversation | null, storeFile = false): Promise<{ ref: RunRef; session: Conversation | null }> {
    this.capacity();
    const draft = this.draft(key), file = draft.attachment, collection = key.startsWith('collect:');
    if (collection && file && draft.text.trim()) throw new Error('文件与文字请分两次存入，草稿已保留。');
    const fileOnly = storeFile || !!draft.pending?.fileOnly;
    if (fileOnly && (!file || collection || (draft.pending && !draft.pending.fileOnly))) throw new Error('请先处理当前待确认的提交。');
    const text = fileOnly ? '帮我入库' : draft.text.trim() || (file && !collection && draft.mode === 'store' ? '帮我入库' : '');
    // A version follow-up sends text only; an unsent attachment remains a local draft.
    const retainAttachment=!!file && !collection && draft.mode==='ask' && (!!draft.basedOnAnswerId || !!draft.experienceComparison) && !isIngestInstruction(text);
    const chatUpload = !!file && !collection && !retainAttachment;
    if (!collection && draft.mode === 'ask' && questionTooLong(text)) throw new Error('问题最多 16,000 UTF-8 字节，请缩短后发送；草稿已保留。');
    if (chatUpload && !isIngestInstruction(text)) throw new Error('附件已保留。点击附件旁的“存入知识库”，刚写的问题会留在这里。');
    const signature = await fingerprint(fileOnly ? { storeFile: file, vaultId } :
      { text, mode: draft.mode, title: draft.title.trim(), options: draft.options, attachment: draft.attachment ?? null, ...(draft.basedOnAnswerId ? { basedOnAnswerId:draft.basedOnAnswerId } : {}),...(draft.experienceComparison?{experienceComparison:true as const}:{}),...(draft.questionFileRun ? { questionFileRun: draft.questionFileRun } : {}) });
    const pending: NonNullable<DesktopDraft['pending']> = draft.pending?.signature === signature ? draft.pending :
      { signature, key: crypto.randomUUID(), sessionKey: crypto.randomUUID(), ...(fileOnly ? { fileOnly: true } : {}) };
    if (draft.questionFileRun && !chatUpload && draft.mode === 'ask' && !pending.questionPath) {
      const run = await data(window.notetrail.run(draft.questionFileRun)), id = uploadSourceId(run);
      if (!id || run.sessionId !== conversation?.id) throw new Error('这份附件还不能提问。可查看处理状态或取消附件关联。');
      const source = await data(window.notetrail.source(id));
      if (source.vaultId !== vaultId || !source.readableRepresentation || !['ready','partial'].includes(source.state)) throw new Error('这份资料暂不可问。可查看处理状态或取消附件关联。');
      if (!inScope(draft.options.scope, source.relativePath)) throw new Error('这份附件不在当前资料范围内。请调整范围，或取消附件关联。');
      pending.questionPath = source.relativePath;
    }
    this.edit(key, { pending });
    let session = conversation, currentKey = key, ref: RunRef;
    if (!collection && (draft.mode === 'ask' || chatUpload)) {
      if (!session) {
        session = await data(window.notetrail.createSession({ vaultId, title: chatUpload ? `入库 · ${file!.name}`.slice(0, 80) : text.slice(0, 80) }, pending.sessionKey));
        currentKey = session.id;
        this.update(state => { const drafts = { ...state.drafts, [currentKey]: state.drafts[key] }; delete drafts[key];
          return { ...state, sessionId: currentKey, drafts };
        });
      }
    }
    if (chatUpload) {
      try {
        ref = await data(window.notetrail.ingest({ vaultId, input: { kind: 'upload', filePart: 'file' }, conversation: { sessionId: session!.id, text } },
          pending.key, { name: file!.name, bytes: await data(window.notetrail.getDraftFile(file!)) }));
      } catch (e) {
        if (fileOnly && rejectedAttachmentRequest(e)) {
          this.edit(currentKey,{pending:undefined});
        }
        throw e;
      }
    } else if (!collection && draft.mode === 'ask') {
      try {
        ref = await data(window.notetrail.ask(session!.id, { text, ...draft.options, ...(pending.questionPath ? { scope: { mode:'selected' as const, paths:[pending.questionPath] } } : {}), action: pending.questionPath || draft.basedOnAnswerId || draft.experienceComparison ? 'ask' : 'auto', ...(draft.basedOnAnswerId ? { basedOnAnswerId:draft.basedOnAnswerId } : {}),...(draft.experienceComparison?{experienceComparison:true as const}:{}) }, pending.key));
      } catch (e) {
        if (pending.questionPath && rejectedAttachmentRequest(e)) this.edit(currentKey, {pending:undefined});
        throw e;
      }
    } else {
      const input = file ? { kind: 'upload', filePart: 'file' } : intakeKind(text) === 'url' ? { kind: 'url', url: text } :
        { kind: 'text', text, ...(draft.title.trim() ? { title: draft.title.trim() } : {}) };
      ref = await data(window.notetrail.ingest({ vaultId, input }, pending.key, file ? { name: file.name, bytes: await data(window.notetrail.getDraftFile(file)) } : undefined));
    }
    if (!isRunRef(ref)) throw new Error('提交结果无法确认，草稿与提交标识已保留。');
    // Clearing a submitted draft and remembering its run are a single durable write.
    this.update(state => ({ ...state,
      drafts: { ...state.drafts, [currentKey]: fileOnly ? { ...state.drafts[currentKey], mode:'ask', attachment:undefined, pending:undefined,
        text: isIngestInstruction(state.drafts[currentKey].text) ? '' : state.drafts[currentKey].text,
        questionFileRun: draft.basedOnAnswerId || draft.experienceComparison ? undefined : ref.runId
      } : { ...emptyDraft(), mode: draft.mode, options: { scope: draft.options.scope }, ...(retainAttachment?{attachment:file,title:draft.title}:{}) } },
      tasks: [...state.tasks.filter(task => task.runId !== ref.runId), { runId: ref.runId, sessionId: chatUpload || !collection && draft.mode === 'ask' ? session!.id : null, finished: false }],
    }));
    return { ref, session };
  }
}
