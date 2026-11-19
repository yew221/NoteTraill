import type { ModelProfilesView } from '../../shared/model-profiles.js';
import type { VaultDiscovery } from '../../shared/vault-discovery.js';
import type { Vault, Page, Source } from '../../shared/vault.js';
import type { Conversation, DeletionImpact, HistoryHit, Message, QuestionInput } from '../../shared/chat.js';
import type { AnswerView, CitationStatus } from '../../shared/answer.js';
import type { Evidence } from '../../shared/tools.js';
import type { Run } from '../../shared/run.js';
import { isRunRef, isTerminalRunState, type RunRef } from '../../shared/contracts.js';
import type { ModelSettingsView, CredentialSaved } from '../../shared/model.js';
import type { Memory } from '../../shared/memory.js';
import type { DesktopWorkspace, DraftFile } from '../../shared/desktop.js';
import type { AnswerWatch, WatchInput, WatchPatch, WatchDetail } from '../../shared/watch.js';

export type CitationView = { status: CitationStatus['status']; checkedAt: string; source?: Source; evidence?: Evidence; text?: string };

export type Status = { phase: 'starting' | 'ready' | 'failed' | 'stopping' | 'stopped'; code?: string };
export type VaultWorkspacesView = { active: string; items: { id: string; name: string; key: string }[] };
type Reply<T> = { data: T } | { error: { code: string; message: string } };
declare global {
  interface Window {
    notetrail: {
      status(): Promise<Reply<Status>>;
      loadWorkspace(): Reply<DesktopWorkspace>;
      saveWorkspace(state: DesktopWorkspace): Reply<{ saved: boolean }>;
      putDraftFile(input: { name: string; bytes: Uint8Array; lastModified: number }): Promise<Reply<DraftFile>>;
      getDraftFile(file: DraftFile): Promise<Reply<Uint8Array>>;
      retry(): Promise<Reply<Status>>;
      vaults(): Promise<Reply<Page<Vault>>>;
      vaultWorkspaces(): Promise<Reply<VaultWorkspacesView>>;
      selectWorkspace(id: string): Promise<Reply<{ changed: boolean }>>;
      addWorkspace(directory: string): Promise<Reply<{ changed: boolean }>>;
      sessions(vaultId: string, cursor?: string): Promise<Reply<Page<Conversation>>>;
      searchHistory(vaultId: string, q: string, cursor?: string, sessionId?: string): Promise<Reply<Page<HistoryHit>>>;
      messages(sessionId: string, cursor?: string): Promise<Reply<Page<Message>>>;
      messageReference(sessionId:string,messageId:string):Promise<Reply<{message:Message;ordinal:number}>>;
      answer(answerId: string): Promise<Reply<AnswerView>>;
      watches(vaultId: string, cursor?: string): Promise<Reply<Page<AnswerWatch>>>;
      watch(watchId: string, cursor?: string): Promise<Reply<WatchDetail>>;
      watchAnswer(answerId: string, input: WatchInput): Promise<Reply<AnswerWatch>>;
      updateWatch(watchId: string, input: WatchPatch): Promise<Reply<AnswerWatch>>;
      session(sessionId: string): Promise<Reply<Conversation>>;
      createSession(input: { vaultId: string; title: string }, key?: string): Promise<Reply<Conversation>>;
      ask(sessionId: string, input: QuestionInput, key: string): Promise<Reply<RunRef>>;
      run(runId: string): Promise<Reply<Run>>;
      cancel(runId: string): Promise<Reply<Run>>;
      catalogRevision(vaultId: string): Promise<Reply<number>>;
      sources(vaultId: string, cursor?: string): Promise<Reply<Page<Source>>>;
      source(sourceId: string): Promise<Reply<Source>>;
      citation(answerId: string, evidenceId: string): Promise<Reply<CitationView>>;
      modelProfiles(): Promise<Reply<ModelProfilesView>>;
      saveModelProfile(input: unknown): Promise<Reply<ModelProfilesView>>;
      modelCatalog(input: unknown): Promise<Reply<{ models: string[] }>>;
      activateModelProfile(id: string, input: unknown): Promise<Reply<ModelProfilesView>>;
      deleteModelProfile(id: string, input: unknown): Promise<Reply<ModelProfilesView>>;
      settings(): Promise<Reply<ModelSettingsView>>;
      connectVault(input: unknown): Promise<Reply<Vault>>;
      updateVault(vaultId: string, input: unknown): Promise<Reply<Vault>>;
      setModel(input: unknown): Promise<Reply<ModelSettingsView>>;
      setCredential(input: unknown): Promise<Reply<CredentialSaved>>;
      probe(key: string): Promise<Reply<RunRef>>;
      ingest(input: unknown, key: string, upload?: { name: string; bytes: Uint8Array }): Promise<Reply<RunRef>>;
      refreshVault(vaultId: string, key: string): Promise<Reply<RunRef>>;
      retrySource(sourceId: string, key: string): Promise<Reply<RunRef>>;
      previewAnswerSelection(answerId:string,input:unknown):Promise<Reply<{text:string}>>;
      saveAnswer(answerId: string, input: unknown, key: string): Promise<Reply<RunRef>>;
      memories(vaultId: string, cursor?: string): Promise<Reply<Page<Memory>>>;
      createMemory(input: unknown, key: string): Promise<Reply<Memory>>;
      updateMemory(memoryId: string, input: unknown): Promise<Reply<Memory>>;
      deleteMemory(memoryId: string, input: unknown): Promise<Reply<{ deleted: true }>>;
      deletionImpact(sessionId: string): Promise<Reply<DeletionImpact>>;
      deleteSession(sessionId: string, expected: DeletionImpact): Promise<Reply<{ deleted: true }>>;
      sourceText(sourceId: string, version: string): Promise<Reply<string>>;
      exportOriginal(sourceId: string, version: string): Promise<Reply<{ saved: boolean }>>;
      discoverVaults(): Promise<Reply<VaultDiscovery>>;
      scanVaults(): Promise<Reply<VaultDiscovery | null>>;
      pickVault(): Promise<Reply<string | null>>;
      openExternal(url: string): Promise<Reply<{ opened: true }>>;
      onStatus(callback: (status: Status) => void): () => void;
    };
  }
}
export async function data<T>(request: Promise<Reply<T>>): Promise<T> {
  const reply = await request;
  if ('error' in reply) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
  return reply.data;
}

export class Questions {
  private readonly pending = new Map<string, { signature: string; key: string }>();
  async send(sessionId: string, input: QuestionInput): Promise<RunRef> {
    const signature = JSON.stringify(input), previous = this.pending.get(sessionId);
    const current = previous?.signature === signature ? previous : { signature, key: crypto.randomUUID() };
    this.pending.set(sessionId, current);
    const ref = await data(window.notetrail.ask(sessionId, input, current.key));
    if (!isRunRef(ref)) throw new Error('未能确认提交结果，请查看历史后重试同一内容。');
    this.pending.delete(sessionId);
    return ref;
  }
}

// Snapshots carry the same authoritative states as SSE; reconnecting never submits another question.
export function watchRun(id: string, changed: (run: Run) => void, disconnected: (message: string) => void): () => void {
  let stopped = false, timer: ReturnType<typeof setTimeout>;
  const poll = async () => {
    try {
      const run = await data(window.notetrail.run(id));
      if (stopped) return;
      disconnected(''); changed(run);
      if (isTerminalRunState(run.state)) { stopped = true; return; }
    } catch (reason) {
      if (!stopped) disconnected((reason as Error).message);
      if (['UNAUTHORIZED', 'NOT_FOUND'].includes((reason as { code?: string }).code ?? '')) stopped = true;
    }
    if (!stopped) timer = setTimeout(() => void poll(), 200);
  };
  void poll();
  return () => { stopped = true; clearTimeout(timer); };
}
