import { retrospectiveRequestText } from '../../shared/retrospective.js';
import { experiencePrompt } from '../../shared/experiences.js';
import { MAX_FILE_BYTES } from '../../shared/vault.js';
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { historyWindow, type Conversation, type HistoryPosition, type Message } from '../../shared/chat.js';
import type { Source, Vault } from '../../shared/vault.js';
import type { Answer as AnswerRecord, AnswerView } from '../../shared/answer.js';
import { data, watchRun, type Status, type VaultWorkspacesView } from './api.js';
import type { Run } from '../../shared/run.js';
import { isTerminalRunState, type RunRef } from '../../shared/contracts.js';
import { runLabel, sourceLabel, Usage } from './common.js';
import { Answer, CitationPanel, type CitationTarget, type MessageTarget } from './answers.js';
import { ChecksPanel, type ChecksTarget } from './evidence-checks.js';
import { ResumePanel, MessagePanel } from './continuation.js';
import { ScopeDialog, defaultOptions, type QuestionOptions } from './scope.js';
import { Composer } from './composer.js';
import { PaneResizeHandle } from './upstream/pane-resize-handle.js';
import { DeleteConversationDialog, SourcesPanel, SettingsPanel, useLiveSources } from './panels.js';
import { allPages, RunCommands } from './client.js';
import { focusHistoryPosition, HistorySearch, historyPositionId } from './history-search.js';
import { isIngestInstruction } from '../../shared/ingest.js';
import { inScope } from '../../shared/tools.js';
import { safeContentPath } from '../../shared/presentation.js';
import type { DesktopDraft } from '../../shared/desktop.js';
import { Workspace, fingerprint, uploadSourceId } from './workspace.js';
import type { ModelSettingsView } from '../../shared/model.js';
import type { Memory } from '../../shared/memory.js';
import { installDesktopTransport } from './transport.js';
import { Markdown } from './markdown.js';
import { SaveAnswer } from './save-answer.js';
import { VaultDiscoveryPanel } from './vault-discovery.js';
import { Collection, SourceReading } from './inspector.js';
import { WatchSetup, WatchList, WatchPanel, reviewLabel } from './watches.js';
import type { AnswerWatch } from '../../shared/watch.js';
import { resumeRequestText } from '../../shared/continuation.js';

type Turn = { message: Message; answer?: AnswerView };
const statusText = (status: Status) => status.phase === 'ready' ? '本机服务已连接' :
  status.phase === 'starting' ? '正在连接本机服务…' : status.phase === 'failed' ? '本机服务未连接' : '本机服务已停止';
const failureText = (code?: string) => code === 'DATABASE_BUSY' ? '这份数据正在被另一个 NoteTrail 使用。请先正常退出那个应用，再重试。' :
  code === 'UNAUTHORIZED' ? '本机会话已到期，请重新连接。草稿会保留，任务不会自动重发。' :
  code === 'DATABASE_TOO_NEW' ? '这份数据来自更新版本，请使用兼容的 NoteTrail。' :
  code === 'DATABASE_INVALID' || code === 'DATA_DIRECTORY_UNRECOGNIZED' ? '数据无法读取，原文件已保留。请检查数据目录。' :
  '本机服务未能连接，请重试。';

function App({ workspace }: { workspace: Workspace }) {
  const saved = useSyncExternalStore(workspace.subscribe, workspace.snapshot);
  const page = saved.page, sidebarWidth = saved.sidebarWidth;
  const [settingsSection, setSettingsSection] = useState<'vault' | 'model' | 'memory'>('vault');
  const [memories, setMemories] = useState<Memory[]>([]);
  const [models, setModels] = useState<ModelSettingsView>({ revision: 1, model: null, credentialConfigured: false });
  const [attaching, setAttaching] = useState(false), [savingAnswer, setSavingAnswer] = useState<AnswerRecord | null>(null);
  const [watchedAnswers,setWatchedAnswers]=useState<AnswerWatch[]>([]),[watchEpoch,setWatchEpoch]=useState(0);
  const [watchSetup,setWatchSetup]=useState<Turn|null>(null),[watchId,setWatchId]=useState<string|null>(null);
  const activeWatch=watchedAnswers.find(w=>w.id===watchId);
  const taskIds = saved.tasks.filter(task => task.sessionId === null).map(task => task.runId);
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const [searchingHistory, setSearchingHistory] = useState(false);
  const commands = useRef(new RunCommands()).current, resourcesVersion = useRef(0);
  const [status, setStatus] = useState<Status>({ phase: 'starting' });
  const [vaults, setVaults] = useState<Vault[]>([]), [vaultId, setVaultId] = useState(saved.vaultId);
  const [libraries, setLibraries] = useState<VaultWorkspacesView>({ active: '', items: [] });
  const [changingVault, setChangingVault] = useState(false);
  const changingVaultRef = useRef(false);
  const [sessions, setSessions] = useState<Conversation[]>([]), [sessionCursor, setSessionCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]), [earlier, setEarlier] = useState(0), [later, setLater] = useState(0);
  const historyPosition = useRef<HistoryPosition | null>(null), pendingJump = useRef<HistoryPosition | null>(null);
  const [runs, setRuns] = useState<Record<string, Run>>({}), [activeIds, setActiveIds] = useState<Record<string, string>>({});
  const latestTask = runs[taskIds.at(-1) ?? ''];
  const [runErrors, setRunErrors] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false), [cancelling, setCancelling] = useState('');
  const [options, setOptions] = useState<Record<string, QuestionOptions>>({}), [scopeOpen, setScopeOpen] = useState(false);
  const [citation, setCitation] = useState<CitationTarget | null>(null);
  const [checksTarget,setChecksTarget] = useState<ChecksTarget|null>(null);
  const [resumeSession,setResumeSession] = useState<string|null>(null),[messageTarget,setMessageTarget] = useState<MessageTarget|null>(null);
  const [workflowMode,setWorkflowMode]=useState<'resume'|'retrospective'>('resume');
  const [retrospectiveFrom,setRetrospectiveFrom]=useState<{answer:AnswerRecord;scope:QuestionOptions['scope']}|null>(null);
  const [workflowScope,setWorkflowScope]=useState<QuestionOptions['scope']>(defaultOptions.scope),[workflowScopeOpen,setWorkflowScopeOpen]=useState(false);
  const workflowLabel=workflowMode==='retrospective'?'结果复盘':'续接说明';
  const resumeOpen=!!selected && selected.id===resumeSession;
  const [readingSource, setReadingSource] = useState<string | null>(null), [collecting, setCollecting] = useState(false);
  const collectingRef = useRef(false);
  const [citationVersion, setCitationVersion] = useState(0);
  const watchers = useRef(new Map<string, () => void>());
  const submitting = useRef(false), selectedRef = useRef<Conversation | null>(null), shown = useRef(50);
  const mounted = useRef(true);
  const canvas = useRef<HTMLElement>(null), followTail = useRef(true), citationTrigger = useRef<HTMLElement | null>(null);
  const [loading, setLoading] = useState(false), [listLoading, setListLoading] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const {sources, error:liveSourcesError} = useLiveSources(status.phase === 'ready' ? vaultId : undefined);
  const selectionVersion = useRef(0), listVersion = useRef(0);
  const key = selected?.id ?? `new:${vaultId}`;
  const draft = saved.drafts[key], choice = draft?.options ?? options[key] ?? defaultOptions;
  const mode = draft?.mode ?? 'ask', file = draft?.attachment ?? null, intakeTitle = draft?.title ?? '';
  const questionRun = draft?.questionFileRun ? runs[draft.questionFileRun] : undefined;
  const questionSource = sources.find(s => s.vaultId === vaultId && s.id === uploadSourceId(questionRun));
  const inRange = !questionSource || inScope(choice.scope, questionSource.relativePath);
  const textOnly = mode === 'ask' && !!(draft?.basedOnAnswerId || draft?.experienceComparison);
  const blockSend = !!draft?.pending?.fileOnly ||
    (!!file && !textOnly && !isIngestInstruction(draft?.text ?? '') && !(mode === 'store' && !draft?.text.trim())) ||
    (!file && mode === 'ask' && !!draft?.questionFileRun && !draft.pending?.questionPath && (!questionSource?.readableRepresentation || !inRange));
  const inspector = saved.inspector ?? { open: false, tab: 'collect' as const, width: 380 };
  const collectionKey = `collect:${vaultId}`, collectionDraft = workspace.draft(collectionKey);
  function change(action: () => void) { try { action(); } catch (reason) { setError((reason as Error).message); } }
  const editInspector = (patch: Partial<typeof inspector>) => change(() => workspace.update(state => ({ ...state, inspector: { ...inspector, ...patch } })));
  const editCollection = (patch: Partial<DesktopDraft>) => change(() => workspace.edit(collectionKey, { mode: 'store', ...patch }));
  const setPage = (page: 'chat' | 'sources' | 'settings' | 'watches') => change(() => workspace.location({ page }));
  const editDraft = (patch: Partial<DesktopDraft>) => change(() => workspace.edit(key, { options: choice, ...patch }));
  const setMode = (mode: 'ask' | 'store') => editDraft({ mode });
  const setIntakeTitle = (title: string) => editDraft({ title });
  const setSidebarWidth = (sidebarWidth: number) => change(() => workspace.location({ sidebarWidth }));
  async function setFile(file: File | null, targetKey: string = key) {
    if (workspace.draft(targetKey).pending) { setError('请先确认上次提交，再更换附件。'); return; }
    if (!file) { change(() => workspace.edit(targetKey, { attachment: undefined })); return; }
    if (attaching) return;
    setAttaching(true); setError('');
    try { const attachment = await data(window.notetrail.putDraftFile({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), lastModified: file.lastModified }));
      workspace.edit(targetKey, { attachment });
    } catch (reason) { setError((reason as Error).message); } finally { setAttaching(false); }
  }
  const activeId = selected ? activeIds[selected.id] : undefined;
  const activeRun = activeId ? runs[activeId] : undefined;
  useEffect(() => { if (followTail.current && canvas.current) canvas.current.scrollTop = canvas.current.scrollHeight; }, [turns, runs]);
  useEffect(() => {
    if (page === 'chat' && pendingJump.current && focusHistoryPosition(pendingJump.current)) pendingJump.current = null;
  }, [page, turns]);
  useEffect(()=>{
    if(status.phase!=='ready' || !vaultId)return;
    let active=true,timer:ReturnType<typeof setTimeout>;
    const refresh=async()=>{
      try {
        const all:AnswerWatch[]=[];let cursor:string|undefined;const seen=new Set<string>();
        do { const page=await data(window.notetrail.watches(vaultId,cursor));all.push(...page.items);cursor=page.nextCursor??undefined;
          if(cursor && seen.has(cursor))throw new Error('关注列表分页异常。');if(cursor)seen.add(cursor);
        } while(cursor && active);
        if(active)setWatchedAnswers(all);
      } catch(e){if(active)setError((e as Error).message);} finally{if(active)timer=setTimeout(()=>void refresh(),2000);}
    };
    void refresh();return ()=>{active=false;clearTimeout(timer);};
  },[status.phase,vaultId,watchEpoch]);
  function openWatch(id:string){setResumeSession(null);setMessageTarget(null);setWatchId(id);setChecksTarget(null);setCitation(null);setReadingSource(null);editInspector({open:true,tab:'read'});}
  function openChecks(target:ChecksTarget, preserveContext=false){if(!preserveContext){setWatchId(null);setResumeSession(null);}setMessageTarget(null);setChecksTarget(target);setCitation(null);setReadingSource(null);editInspector({open:true,tab:'read'});}
  function openResume(){if(!selected)return;setWorkflowMode('resume');setRetrospectiveFrom(null);setResumeSession(selected.id);setWatchId(null);setChecksTarget(null);setCitation(null);setMessageTarget(null);setReadingSource(null);editInspector({open:true,tab:'read'});}
  async function openRetrospective(answer?:AnswerRecord,scope?:QuestionOptions['scope']){
    const origin=selectionVersion.current;
    try{
      const session=answer?await data(window.notetrail.session(answer.sessionId)):selectedRef.current;
      if(!session || origin!==selectionVersion.current)return;
      if(selectedRef.current?.id!==session.id){const pending=showHistory(session),navigation=selectionVersion.current;await pending;if(navigation!==selectionVersion.current)return;}
      setPage('chat');setWorkflowScope(scope??choice.scope);setWorkflowMode('retrospective');setRetrospectiveFrom(answer?{answer,scope:scope??choice.scope}:null);
      setResumeSession(session.id);setWatchId(null);setChecksTarget(null);setCitation(null);setMessageTarget(null);setReadingSource(null);editInspector({open:true,tab:'read'});
    }catch(e){setError((e as Error).message);}
  }
  function openMessage(target:MessageTarget){setMessageTarget(target);setCitation(null);setChecksTarget(null);editInspector({open:true,tab:'read'});}
  async function generateResume(progress:string){
    const session=selectedRef.current,origin=selectionVersion.current;
    if(!session || submitting.current || activeId || loading || draft?.pending || status.phase!=='ready')throw new Error('请先等待或处理当前任务，再生成对话整理。');
    submitting.current=true;setSending(true);
    try{
      const input={text:(workflowMode==='resume'?resumeRequestText:retrospectiveRequestText)(progress),action:'ask' as const,workflow:workflowMode,...(progress.trim()?{workflowNote:progress.trim()}:{}),scope:workflowMode==='retrospective'?workflowScope:choice.scope,...(workflowMode==='retrospective'&&retrospectiveFrom?{basedOnAnswerId:retrospectiveFrom.answer.id}:{})};
      const ref=await workspace.auxiliary(await fingerprint({sessionId:session.id,input}),key=>data(window.notetrail.ask(session.id,input,key))) as RunRef;
      workspace.task(ref,session.id);track(session.id,ref.runId);setRevision(n=>n+1);
      if(origin===selectionVersion.current && selectedRef.current?.id===session.id)await showHistory(session,50,true);
    }finally{submitting.current=false;setSending(false);}
  }
  async function continueVersion(watch:Pick<AnswerWatch,'sessionId'|'question'|'scope'>,answer:AnswerRecord,question?:string){
    const origin=selectionVersion.current;
    try {
      const session=await data(window.notetrail.session(watch.sessionId));
      if(origin!==selectionVersion.current)return;
      const history=showHistory(session),navigation=selectionVersion.current;
      await history;
      if(navigation!==selectionVersion.current || workspace.current.sessionId!==session.id || workspace.current.page!=='chat')return;
      // Read after navigation: the user may have typed while history was loading.
      const existing=workspace.draft(session.id);
      if(existing.pending || (existing.mode==='store' && (existing.text || existing.attachment)))throw new Error('请先处理这段对话中待确认的提交或入库草稿，再基于版本追问。');
      const prefix=`关于「${watch.question}」，基于 ${new Date(answer.createdAt).toLocaleString('zh-CN')} 的答案继续问：\n${question ? question+'\n\n' : ''}`;
      workspace.edit(session.id,{text:prefix+existing.text,mode:'ask',options:{scope:watch.scope},basedOnAnswerId:answer.id});
    } catch(e){setError((e as Error).message);}
  }
  function openCitation(target: CitationTarget) {
    setMessageTarget(null);
    citationTrigger.current = document.activeElement as HTMLElement; setCitation(target); setCitationVersion(value => value + 1);
    setReadingSource(null); editInspector({ open: true, tab: 'read' });
  }
  function openSource(id: string) {
    setWatchId(null); setChecksTarget(null);setResumeSession(null);setMessageTarget(null); citationTrigger.current = document.activeElement as HTMLElement; setCitation(null); setReadingSource(id); editInspector({ open: true, tab: 'read' });
  }
  function closeInspector() { editInspector({ open: false }); requestAnimationFrame(() => citationTrigger.current?.focus()); }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; watchers.current.forEach(stop => stop()); }; }, []);
  function track(sessionId: string, id: string) {
    if (watchers.current.has(id)) return;
    if (sessionId) setActiveIds(old => ({ ...old, [sessionId]: id }));
    watchers.current.set(id, watchRun(id, run => {
      setRuns(old => ({ ...old, [id]: run }));
      if (isTerminalRunState(run.state)) {
        change(() => workspace.terminal(id));
        watchers.current.delete(id); listVersion.current++; setRevision(value => value + 1);
        setActiveIds(old => { const next = { ...old }; if (next[sessionId] === id) delete next[sessionId]; return next; });
        if (selectedRef.current?.id === sessionId) void showHistory(selectedRef.current, shown.current, true);
      }
    }, message => setRunErrors(old => ({ ...old, [id]: message }))));
  }
  useEffect(() => {
    let observed = false;
    const unsubscribe = window.notetrail.onStatus(value => { observed = true; setStatus(value); });
    void data(window.notetrail.status()).then(value => { if (!observed) setStatus(value); })
      .catch(() => setError('桌面连接不可用，请重新打开应用。'));
    void data(window.notetrail.vaultWorkspaces()).then(setLibraries).catch(reason => setError(reason.message));
    return unsubscribe;
  }, []);
  useEffect(() => {
    watchers.current.forEach(stop => stop()); watchers.current.clear();
    if (status.phase === 'ready') for (const task of workspace.current.tasks) track(task.sessionId ?? '', task.runId);
  }, [status.phase]);
  useEffect(() => {
    const id = saved.sessionId;
    if (status.phase !== 'ready' || sending || !id || selectedRef.current?.id === id) return;
    let active = true;
    void data(window.notetrail.session(id)).then(session => { if (active) void showHistory(session, 50, true); })
      .catch(reason => { if (active) { setError(reason.message); if (reason.code === 'NOT_FOUND') change(() => workspace.location({ sessionId: null })); } });
    return () => { active = false; };
  }, [status.phase, saved.sessionId, sending]);
  async function refreshResources() {
    const version = ++resourcesVersion.current;
    const [vaultList, configuration, workspaces] = await Promise.all([
      data(window.notetrail.vaults()), data(window.notetrail.settings()), data(window.notetrail.vaultWorkspaces()),
    ]);
    const current = vaultList.items.find(vault => vault.id === vaultId) ?? vaultList.items[0];
    const memoryList = current ? await allPages<Memory>(`/api/v1/vaults/${current.id}/memories`) : [];
    if (!mounted.current || version !== resourcesVersion.current) return;
    setLibraries(workspaces);
    setVaults(vaultList.items); setVaultId(current?.id ?? ''); setModels(configuration); setMemories(memoryList);
    if (workspace.current.vaultId !== (current?.id ?? '')) workspace.location({ vaultId: current?.id ?? '' });
  }
  useEffect(() => {
    if (status.phase !== 'ready') return;
    void refreshResources().catch(reason => setError(reason.message));
    return () => { resourcesVersion.current++; };
  }, [status.phase, vaultId, revision]);
  function trackTask(ref: RunRef) { if (!workspace.current.tasks.some(task => task.runId === ref.runId)) workspace.task(ref, null); track('', ref.runId); }
  function openSettings(section: 'vault' | 'model' | 'memory') { setSettingsSection(section); setPage('settings'); setCitation(null); }
  const panelActions = { disabled: status.phase !== 'ready', commands, track: trackTask,
    refresh: async () => { await refreshResources(); setRevision(value => value + 1); }, report: setError };
  const currentVault = vaults.find(vault => vault.id === vaultId) ?? null;
  async function changeVault(target: { id: string } | { directory?: string }) {
    if (changingVaultRef.current || submitting.current || collectingRef.current || attaching) return;
    changingVaultRef.current = true;
    setChangingVault(true);
    setError('');
    let changed = false;
    try {
      if ('id' in target) changed = (await data(window.notetrail.selectWorkspace(target.id))).changed;
      else {
        const directory = target.directory ?? await data(window.notetrail.pickVault());
        if (directory) changed = (await data(window.notetrail.addWorkspace(directory))).changed;
      }
    } catch (reason) {
      const error = reason as Error & { code?: string };
      setError(error.code === 'SESSION_BUSY' ? '请等当前任务结束，再切换知识库。' : error.message);
    } finally {
      if (!changed) {
        changingVaultRef.current = false;
        setChangingVault(false);
      }
    }
  }
  async function handleLink(href: string) {
    try {
      const path = safeContentPath(href), match = path && /^\/api\/v1\/sources\/([^/]+)\/content\?view=original&expectedVersion=([a-f0-9]+)$/.exec(path);
      if (match) await data(window.notetrail.exportOriginal(match[1], match[2]));
      else if (/^https?:\/\//.test(href)) await data(window.notetrail.openExternal(href));
      else throw new Error('这个链接不能在桌面中打开。');
    } catch (reason) { setError((reason as Error).message); }
  }
  useEffect(() => {
    if (status.phase !== 'ready' || !vaultId) return;
    const version = ++listVersion.current;
    setListLoading(true); setError('');
    void data(window.notetrail.sessions(vaultId)).then(page => {
      if (version !== listVersion.current) return;
      setSessions(page.items); setSessionCursor(page.nextCursor);
    }).catch(reason => { if (version === listVersion.current) setError(reason.message); })
      .finally(() => { if (version === listVersion.current) setListLoading(false); });
    return () => { listVersion.current++; };
  }, [vaultId, status.phase, revision]);
  async function showHistory(session: Conversation, count = 50, refresh = false, position: HistoryPosition | null = null) {
    if (!refresh) {
      historyPosition.current = position;
      pendingJump.current = position;
      followTail.current = !position;
    }
    else if (count > shown.current) followTail.current = false;
    if (!refresh) setPage('chat');
    const version = ++selectionVersion.current;
    change(() => workspace.location({ sessionId: session.id }));
    selectedRef.current = session; shown.current = count;
    setSelected(session); setLoading(true); setError('');
    if (!refresh) { setTurns([]); setEarlier(0); setLater(0); setCitation(null); setChecksTarget(null);setResumeSession(null);setMessageTarget(null); }
    try {
      const messages: Message[] = []; let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await data(window.notetrail.messages(session.id, cursor));
        if (version !== selectionVersion.current || !mounted.current) return;
        messages.push(...page.items); cursor = page.nextCursor ?? undefined;
        if (cursor && seen.has(cursor)) throw new Error('历史分页异常，请重新读取。');
        if (cursor) seen.add(cursor);
      } while (cursor);
      const history = historyWindow(messages, count, historyPosition.current);
      const loaded = await Promise.all(history.items.map(async message => {
        const [run, answer] = await Promise.all([data(window.notetrail.run(message.runId)),
          message.answerId ? data(window.notetrail.answer(message.answerId)) : undefined]);
        return { message, run, answer };
      }));
      if (version !== selectionVersion.current || !mounted.current) return;
      setTurns(loaded); setEarlier(history.earlier); setLater(history.later);
      setRuns(old => ({ ...old, ...Object.fromEntries(loaded.map(turn => [turn.run.id, turn.run])) }));
      for (const { run } of loaded) if (!isTerminalRunState(run.state)) track(session.id, run.id);
      const last = messages.at(-1);
      if (last) setOptions(old => old[session.id] ? old : { ...old, [session.id]: { scope: last.scope } });
    } catch (reason) { if (version === selectionVersion.current) setError((reason as Error).message); }
    finally { if (version === selectionVersion.current) setLoading(false); }
  }
  function newDraft() {
    if (submitting.current || attaching) return;
    change(() => workspace.location({ sessionId: null, page: 'chat' }));
    selectionVersion.current++; selectedRef.current = null; setSelected(null); setTurns([]); setEarlier(0); setLater(0);
    historyPosition.current = null; pendingJump.current = null;
    setLoading(false); setError(''); setCitation(null); setScopeOpen(false);setResumeSession(null);setMessageTarget(null);setChecksTarget(null);
  }
  async function submit(storeFile = false) {
    const text = (draft?.text ?? '').trim();
    if (submitting.current || attaching || activeId || loading || (!storeFile && blockSend) || (!text && !file) || !vaultId || status.phase !== 'ready') return;
    submitting.current = true; setSending(true); setError('');
    followTail.current = true;
    try {
      const { ref, session } = await workspace.submit(key, vaultId, selected, storeFile);
      if (mode === 'store' && !file) trackTask(ref);
      else if (session) {
        historyPosition.current = null; pendingJump.current = null;
        listVersion.current++; setRevision(value => value + 1);
        setSessions(old => [session, ...old.filter(item => item.id !== session.id)]);
        track(session.id, ref.runId); await showHistory(session, 50, true);
      }
    } catch (reason) { setError((reason as Error).message); }
    finally { submitting.current = false; setSending(false); }
  }
  async function collect() {
    if (collectingRef.current || attaching || !vaultId || status.phase !== 'ready') return;
    if (collectionDraft.attachment && collectionDraft.text.trim()) { setError('文件与文字请分两次存入，草稿已保留。'); return; }
    if (!collectionDraft.attachment && !collectionDraft.text.trim()) return;
    collectingRef.current = true; setCollecting(true); setError('');
    try { const { ref } = await workspace.submit(collectionKey, vaultId, null); trackTask(ref); }
    catch (reason) { setError((reason as Error).message); }
    finally { collectingRef.current = false; setCollecting(false); }
  }
  async function stop(id = activeId) {
    if (!id || cancelling === id) return;
    setCancelling(id); setError('');
    try { const run = await data(window.notetrail.cancel(id)); setRuns(old => ({ ...old, [run.id]: run })); }
    catch (reason) { setError((reason as Error).message); }
    finally { setCancelling(''); }
  }
  async function moreSessions() {
    if (!sessionCursor) return;
    const version = listVersion.current; setListLoading(true);
    try {
      const page = await data(window.notetrail.sessions(vaultId, sessionCursor));
      if (version === listVersion.current) {
        setSessions(previous => [...previous, ...page.items.filter(item => !previous.some(old => old.id === item.id))]);
        setSessionCursor(page.nextCursor);
      }
    } catch (reason) { if (version === listVersion.current) setError((reason as Error).message); }
    finally { if (version === listVersion.current) setListLoading(false); }
  }
  return <div className={`shell ${inspector.open ? 'shell--inspector' : ''}`} inert={changingVault} aria-busy={changingVault || undefined} onClick={event => {
    const anchor = event.target instanceof Element ? event.target.closest('a') : null;
    if (anchor) { event.preventDefault(); void handleLink(anchor.getAttribute('href') ?? ''); }
  }} style={{ '--sidebar-width': `${sidebarWidth}px`, '--inspector-width': `${inspector.width}px` } as CSSProperties}>
    <aside className="sidebar" id="session-sidebar" aria-label="聊天记录">
      <div className="sidebar__top"><button className="new-chat" disabled={sending || attaching} onClick={newDraft}><span aria-hidden="true">＋</span> 新对话</button></div>
      <div className="sidebar__section">
        <nav className="desktop-nav" aria-label="主要功能"><button aria-pressed={page === 'chat'} onClick={() => setPage('chat')}>对话</button>
          <button aria-pressed={page === 'sources'} onClick={() => { setPage('sources'); setCitation(null); }}>资料</button><button aria-pressed={page==='watches'} onClick={()=>setPage('watches')}>持续关注</button></nav>
        {libraries.items.length > 0 && <select className="vault-select" aria-label="切换知识库" value={libraries.active}
          disabled={changingVault || sending || collecting || attaching} onChange={event => {
            if (event.target.value === 'add') openSettings('vault');
            else void changeVault({ id: event.target.value });
          }}>
          {libraries.items.map(library => <option key={library.id} value={library.id}>{library.name}</option>)}
          <option value="add">添加知识库</option>
        </select>}
        <div className="history-tools">
          <button className="text-button history-search-trigger" disabled={status.phase !== 'ready' || !vaultId || sending || attaching}
            onClick={() => setSearchingHistory(true)}>搜索旧对话</button>
          <button className="icon-button" title="刷新会话列表" aria-label="刷新会话列表"
            disabled={status.phase !== 'ready' || !vaultId || listLoading} onClick={() => setRevision(value => value + 1)}>↻</button>
        </div>
        <nav aria-label="会话列表">{sessions.map(session => <button key={session.id}
          className={`session-row ${selected?.id === session.id ? 'session-row--active' : ''}`}
          aria-current={selected?.id === session.id ? 'page' : undefined} disabled={status.phase !== 'ready' || sending || attaching}
          onClick={() => void showHistory(session)} title={session.title}>
          <span className="session-row__title">{activeIds[session.id] ? '◌ ' : ''}{session.title}</span>
          <time dateTime={session.updatedAt}>{new Date(session.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</time>
        </button>)}</nav>
        {listLoading && <p className="muted" role="status">正在读取会话…</p>}
        {sessionCursor && <button className="text-button" disabled={listLoading || status.phase !== 'ready'} onClick={() => void moreSessions()}>加载更多会话</button>}
      </div>
      <div className="sidebar__footer"><button className="brand-settings" aria-label="NoteTrail 设置" aria-pressed={page === 'settings'}
        title="打开设置" onClick={() => openSettings('vault')}><span className="brand-settings__mark" aria-hidden="true">N</span><strong>NoteTrail</strong>
        <span className="brand-settings__gear" aria-hidden="true">⚙</span></button></div>
      <PaneResizeHandle className="sidebar__resize-handle" label="调整历史栏宽度" controls="session-sidebar" edge="right"
        bounds={(_pane, container) => ({ min: 200, max: Math.min(380, container.clientWidth * 0.4) })}
        onResize={setSidebarWidth} onReset={() => setSidebarWidth(248)} />
    </aside>
    <main className="main" onDragOver={event => { if (page === 'chat' && event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
      onDrop={event => {
        if (page !== 'chat') return;
        event.preventDefault();
        if (status.phase !== 'ready' || !vaultId || sending || attaching) return;
        const files = event.dataTransfer.files;
        if (files.length !== 1) { setError('每次存入一个文件，请分次提交。'); return; }
        if (files[0].size > MAX_FILE_BYTES) { setError('单个文件最多 100 MiB。'); return; }
        void setFile(files[0]);
      }}>
      <header className="topbar">
        <h1 className="topbar__title">{page === 'watches' ? '持续关注' : page === 'sources' ? '资料' : page === 'settings' ? '设置' : selected?.title ?? '新对话'}</h1>
        <div className="topbar__actions">
          {page === 'chat' && selected && <>
            <button className="text-button" disabled={status.phase !== 'ready'} onClick={openResume}>续接思路</button>
            <button className="text-button" disabled={status.phase !== 'ready'} onClick={() => void openRetrospective()}>结果复盘</button>
            <button className="delete-chat" disabled={sending || !!activeId} onClick={() => setDeleting(selected)}>删除此对话</button>
          </>}
          <span className={`connection connection--${status.phase}`} role="status" title={status.phase === 'ready' ? statusText(status) : undefined}>
            {status.phase === 'ready' ? <span className="sr-only">{statusText(status)}</span> : statusText(status)}
          </span>
          <button className="inspector-toggle" aria-label={inspector.open ? '收起资料栏' : '展开资料栏'} aria-expanded={inspector.open} aria-controls="resource-inspector"
            onClick={event => { citationTrigger.current = event.currentTarget; if (inspector.open) closeInspector(); else editInspector({ open: true, tab: 'collect' }); }}><span aria-hidden="true">▥</span> 资料栏</button>
        </div>
      </header>
      <div className="work-area"><section className="canvas" aria-label={page === 'chat' ? '对话内容' : undefined} aria-busy={loading} ref={canvas}
        onScroll={event => { const node = event.currentTarget; followTail.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; }}>
        {status.phase === 'failed' && <div className="notice" role="alert"><p>{failureText(status.code)}</p>
          <button onClick={() => { setError(''); void data(window.notetrail.retry()).then(setStatus).catch(reason => setError(reason.message)); }}>重新连接</button></div>}
        {error && <div className="notice" role="alert"><p>{error}</p>{selected && <button disabled={status.phase !== 'ready'} onClick={() => void showHistory(selected)}>重新读取历史</button>}</div>}
        {liveSourcesError && <p className="notice" role="status">资料状态暂时未能更新：{liveSourcesError}</p>}
        {page === 'watches' ? <WatchList watches={watchedAnswers} onOpen={openWatch}/> : page === 'settings' ? <SettingsPanel vault={currentVault} models={models} memories={memories} actions={panelActions}
          initialSection={settingsSection} vaultDiscovery={select => <VaultDiscoveryPanel vault={currentVault}
            libraries={libraries} disabled={panelActions.disabled || changingVault}
            onSelect={directory => currentVault ? void changeVault({ directory }) : select(directory)}
            onAdd={() => void changeVault({})} />} pickFolder={() => data(window.notetrail.pickVault())} /> : page === 'sources' ?
          <SourcesPanel vault={currentVault} sources={sources} actions={panelActions} onConnect={() => { editInspector({ open: false }); openSettings('vault'); }}
            onIngest={() => editInspector({ open: true, tab: 'collect' })}
            readContent={source => data(window.notetrail.sourceText(source.id, source.version!))} /> : selected ? <div className="conversation transcript">
          {earlier > 0 && <button className="text-button" disabled={loading} onClick={() => void showHistory(selected, shown.current + 50, true)}>加载更早消息（还有 {earlier} 条）</button>}
          {turns.map(({ message, answer }) => <article className="turn" key={message.id}>
            <div className="user-message" aria-label="用户消息" id={historyPositionId(message.id, 'user')} tabIndex={-1}>{message.basedOnAnswerId && <small>基于选定答案版本的追问</small>}<p>{message.text}</p>
              {message.attachment && <button type="button" className="chat-file" onClick={() => openSource(message.attachment!.sourceId)}
                aria-label={`阅读 ${message.attachment.name}`}>
                <span className="chat-file__symbol" aria-hidden="true">▤</span><strong>{message.attachment.name}</strong><span aria-hidden="true">打开 ›</span>
              </button>}</div>
            <div className="assistant-message" id={historyPositionId(message.id, 'assistant')} tabIndex={-1}><span className="speaker">NoteTrail</span>
              {answer ? <><Answer view={answer} sources={sources} onMessage={target=>{setResumeSession(null);setWatchId(null);openMessage(target);}} onChecks={()=>openChecks({answerId:answer.answer.id,sessionId:answer.answer.sessionId,question:message.text,scope:message.scope})} onCitation={target=>{setWatchId(null);setChecksTarget(null);setResumeSession(null);openCitation(target);}} /><div className="watch-actions"><button className="text-button" disabled={status.phase !== 'ready'} onClick={() => setSavingAnswer(answer.answer)}>选择并保存片段</button>
                {!answer.answer.retrospective&&<button className="text-button" disabled={status.phase!=='ready'} onClick={()=>void openRetrospective(answer.answer,message.scope)}>根据后续结果复盘</button>}
                {!answer.answer.resume && !answer.answer.retrospective && (()=>{const w=watchedAnswers.find(w=>w.rootAnswerId===answer.answer.id);return w ? <button className="text-button" onClick={()=>openWatch(w.id)}>
                  {w.state==='paused'?'关注已暂停':w.state==='updating'?'正在复核':w.state==='pending'?'等待复核':w.state==='failed'?'更新未完成':w.latestReview ? reviewLabel[w.latestReview.kind]:'已关注'} · 查看版本</button> :
                  <button className="text-button" disabled={status.phase!=='ready'} onClick={()=>setWatchSetup({message,answer})}>持续关注</button>;})()}</div></> : runs[message.runId] ? <div className="run-status" role="status">
                {runs[message.runId].preview && <div className="answer-preview"><Markdown text={runs[message.runId].preview!} /><small>{isTerminalRunState(runs[message.runId].state) ? '未完成的回答 · 出处尚未核对' : '正在生成 · 完成后核对出处'}</small></div>}
                <p>{runLabel(runs[message.runId])}</p>
                {message.attachment && (() => { const source = sources.find(s => s.id === message.attachment!.sourceId);
                  return source && <div><p role="status">{source.originalSaved ? '原件已保存' : '原件尚未保存'} · {sourceLabel[source.state]}</p>
                    {source.warnings.map(w => <p className="warning-text" key={w.code}>{w.message}</p>)}
                    {source.state === 'failed' && <button className="text-button" onClick={() => void commands.send(`/api/v1/sources/${source.id}/retry`).then(trackTask).catch(e => setError(e.message))}>重试处理</button>}</div>; })()}
                {runs[message.runId].error && <p className="notice">{runs[message.runId].error!.message}</p>}
                {runs[message.runId].state === 'succeeded' && runs[message.runId].result && 'memoryId' in runs[message.runId].result! && <p>{(runs[message.runId].result as { deleted: boolean }).deleted ? '已删除这条记忆。' : '记忆已保存。'}<button className="text-button" onClick={() => openSettings('memory')}>查看记忆</button></p>}
                {runs[message.runId].error?.code === 'INTENT_UNCLEAR' && <button className="text-button" onClick={() => openSettings('memory')}>到记忆设置中选择具体条目</button>}
              </div> : <p className="muted">正在读取回答状态…</p>}
              {runs[message.runId] && !message.attachment && <Usage run={runs[message.runId]} />}
              {runErrors[message.runId] && <p role="alert" className="notice">{runErrors[message.runId]} 正在重新读取状态，不会重复提问。</p>}
            </div>
          </article>)}
          {later > 0 && <button className="text-button" disabled={loading} onClick={() => void showHistory(selected)}>返回最新消息</button>}
          {loading && <p className="muted" role="status">正在读取历史…</p>}
          {!loading && !turns.length && !error && <p className="muted">这段对话还没有消息。</p>}

        </div> : <div className="new-thread conversation">
          <div className="new-thread__hero"><span className="brand-mark" aria-hidden="true">N</span><h2><span>博观而约取，</span><span>厚积而薄发</span></h2></div>
          {!currentVault && <button className="button primary" onClick={() => openSettings('vault')}>连接知识库</button>}
          {currentVault && !models.credentialConfigured && <button className="button primary" onClick={() => openSettings('model')}>设置模型</button>}
        </div>}
      </section>
      </div>
      {taskIds.filter(id => runs[id] && !isTerminalRunState(runs[id].state)).map(id => <div className="task-activity" key={id}>
        <span role="status">{runLabel(runs[id])}</span><button className="text-button" disabled={runs[id].state === 'cancelling' || cancelling === id} onClick={() => void stop(id)}>停止任务</button>
      </div>)}
      {!!taskIds.length && <details className="desktop-tasks"><summary>最近任务{latestTask && isTerminalRunState(latestTask.state) && ` · ${runLabel(latestTask)}`}</summary><div>{taskIds.filter(id => !runs[id] || !isTerminalRunState(runs[id].state) || taskIds.slice(-10).includes(id)).map(id => { const run = runs[id]; return <article key={id}><strong>{!run ? '正在读取任务…' : run.kind === 'model_probe' ? '模型连接测试' : run.kind === 'refresh' ? '刷新资料' : '存入资料'}</strong>{run && <><p role="status">{runLabel(run)}</p>{run.result && 'sourceState' in run.result && <p>原件已保存 · {sourceLabel[run.result.sourceState]}</p>}{run.result && 'modelAvailable' in run.result && <p>{run.result.modelRevision === models.revision ? '本次连接测试通过。' : '配置已改变，请重新测试。'}</p>}{run.result && 'scanned' in run.result && <p>已检查 {run.result.scanned} 份资料</p>}{run.error && <p role="alert" className="error-text">{run.error.message}</p>}{run.warnings.map((warning, index) => <p className="warning-text" key={index}>{warning.message}</p>)}{!isTerminalRunState(run.state) && <button className="text-button" disabled={run.state === 'cancelling' || cancelling === id} onClick={() => void stop(id)}>停止任务</button>}<Usage run={run} /></>}</article>; })}</div></details>}
      {activeId && <div className="active-status" role="status">{activeRun ? runLabel(activeRun) : '正在读取任务状态…'}{runErrors[activeId] && ` · ${runErrors[activeId]}`}</div>}
      {page === 'chat' && draft?.pending && <p className="notice" role="status">上次提交尚未确认。内容和提交标识已保留；可先查看历史，再重试同一内容。</p>}
      {page === 'chat' && draft?.basedOnAnswerId && <p className="notice">已关联选定答案版本，发送后会重新核对资料。{draft.attachment&&draft.mode==='ask'&&'本次续问只发送文字，附件保留待入库；输入“帮我入库”可先保存文件。'}<button className="text-button" onClick={()=>editDraft({basedOnAnswerId:undefined})}>取消版本关联</button></p>}
      {page==='chat'&&draft?.experienceComparison&&<p className="notice">{mode==='ask'?'本次将生成经验对照。':'经验对照已保留，切回提问后生效。'}{draft.attachment&&mode==='ask'&&'经验提问只发送文字，附件保留待入库；输入“帮我入库”会先保存附件。'}<button className="text-button" disabled={!!draft.pending} onClick={()=>editDraft({experienceComparison:undefined})}>取消经验对照</button></p>}
      {page === 'chat' && mode === 'ask' && draft?.questionFileRun && !file && <div className="notice" role="status">
        {questionSource ? `本次提问：${questionSource.title} · ${sourceLabel[questionSource.state]}` : questionRun?.error?.message ?? (questionRun && isTerminalRunState(questionRun.state) ? '附件暂不可问，原问题已保留。' : '正在确认附件状态…')}
        {questionSource?.warnings.some(w => w.code === 'RUN_INTERRUPTED') && !questionSource.originalSaved && ' · 处理已停止，可在文件卡片重试。'}
        {!inRange && ' · 附件不在所选范围，请调整资料范围或取消关联。'}
        <button className="text-button" disabled={sending || !!draft.pending} onClick={() => editDraft({questionFileRun:undefined})}>取消附件关联</button></div>}
      {page === 'chat' && <Composer draft={draft?.text ?? ''} onDraft={text => editDraft({ text })}
        blockSend={blockSend} fileLocked={!!draft?.pending} legacyPending={!!draft?.pending && !draft.pending.fileOnly} textOnly={textOnly}
        onStoreFile={() => void submit(true)} onSend={() => void submit()} onStop={() => void stop()} onScope={draft?.pending?.questionPath ? undefined : () => setScopeOpen(true)}
        scopeLabel={choice.scope.mode === 'vault' ? '整个知识库' : `${choice.scope.paths.length} 项资料范围`}
        onExperience={vaultId && mode === 'ask' && !draft?.pending && !draft?.experienceComparison
          ? () => editDraft({ experienceComparison: true, text: [draft?.text?.trim() || '我现在的问题：', experiencePrompt].join('\n\n') })
          : undefined}
        disabled={status.phase !== 'ready' || !vaultId || sending || attaching || (loading && !activeId)} busy={!!activeId}
        stopping={cancelling === activeId || activeRun?.state === 'cancelling'} mode={mode} onMode={setMode} file={file} onFile={setFile}
        title={intakeTitle} onTitle={setIntakeTitle} onError={setError} />}
      {watchSetup?.answer && <WatchSetup answer={watchSetup.answer.answer} question={watchSetup.message.text} scope={watchSetup.message.scope} onClose={()=>setWatchSetup(null)} onDone={w=>{setWatchedAnswers(old=>[w,...old.filter(x=>x.id!==w.id)]);setWatchSetup(null);openWatch(w.id);setWatchEpoch(n=>n+1);}}/>}
      {savingAnswer && <SaveAnswer answer={savingAnswer} commands={commands} onRun={trackTask} onClose={() => setSavingAnswer(null)} />}
      {deleting && <DeleteConversationDialog key={deleting.id} session={deleting} onClose={() => setDeleting(null)} onDeleted={() => {
        change(() => workspace.update(state => { const drafts = { ...state.drafts }; delete drafts[deleting.id]; return { ...state, drafts, tasks: state.tasks.filter(task => task.sessionId !== deleting.id) }; }));
        if (selected?.id === deleting.id) newDraft(); setDeleting(null); setWatchEpoch(n=>n+1); setRevision(n=>n+1);
      }} />}
      {workflowScopeOpen && <ScopeDialog vaultId={vaultId} value={{scope:workflowScope}} onClose={()=>setWorkflowScopeOpen(false)} onSave={value=>{setWorkflowScope(value.scope);setWorkflowScopeOpen(false);}}/>}
      {searchingHistory && status.phase === 'ready' && vaultId && <HistorySearch key={vaultId} vaultId={vaultId} onClose={() => setSearchingHistory(false)}
        onOpen={(session, position) => { setSearchingHistory(false); void showHistory(session, 50, false, position); }} />}
      {scopeOpen && <ScopeDialog vaultId={vaultId} value={choice} onClose={() => setScopeOpen(false)}
        onSave={value => { editDraft({ options: value }); setScopeOpen(false); }} />}
    </main>
    {inspector.open && <aside className="inspector" id="resource-inspector" aria-label="资料侧栏" onKeyDown={event => { if (event.key === 'Escape') closeInspector(); }}>
      <PaneResizeHandle className="inspector__resize-handle" label="调整资料栏宽度" controls="resource-inspector" edge="left"
        bounds={(_pane, container) => ({ min: 300, max: Math.max(300, Math.min(640, container.clientWidth - sidebarWidth - 430)) })}
        onResize={width => editInspector({ width })} onReset={() => editInspector({ width: 380 })} />
      <header className="inspector__header">
        <div className="inspector__tabs" role="tablist" aria-label="资料栏功能">
          {(['collect', 'read'] as const).map(tab => <button key={tab} id={`inspector-tab-${tab}`} role="tab"
            aria-selected={inspector.tab === tab} aria-controls={`inspector-panel-${tab}`} onClick={() => editInspector({ tab })}>{tab === 'collect' ? '收集' : '阅读'}</button>)}
        </div>
        <button className="icon-button" aria-label="关闭资料栏" onClick={closeInspector}>×</button>
      </header>
      <div className="inspector__content" role="tabpanel" id={`inspector-panel-${inspector.tab}`} aria-labelledby={`inspector-tab-${inspector.tab}`}>
        {inspector.tab === 'collect' ? <Collection draft={collectionDraft} vaultName={currentVault?.name ?? ''} sources={sources}
          disabled={status.phase !== 'ready' || !vaultId || collecting || attaching} sending={collecting} onDraft={editCollection}
          onFile={file => void setFile(file, collectionKey)} onSend={() => void collect()} onRead={openSource} onError={setError} /> :
          <>{resumeOpen && <div hidden={!!citation||!!checksTarget||!!messageTarget}><ResumePanel key={`${selected!.id}:${workflowMode}:${retrospectiveFrom?.answer.id??''}`} purpose={workflowMode} base={retrospectiveFrom?.answer} scopeLabel={workflowScope.mode==='vault'?'整个知识库':`${workflowScope.paths.length} 项资料范围`} onScope={()=>setWorkflowScopeOpen(true)} results={turns.flatMap(t=>t.answer?.answer[workflowMode]?[t.answer]:[]).reverse()} sources={sources} busy={sending||!!activeId}
            onGenerate={generateResume} onCitation={openCitation} onMessage={openMessage} onSave={setSavingAnswer} onChecks={a=>openChecks({answerId:a.id,sessionId:a.sessionId,question:`这段对话的${workflowLabel}`,scope:turns.find(t=>t.answer?.answer.id===a.id)?.message.scope??choice.scope},true)}
            onContinue={(answer,index)=>void continueVersion({sessionId:answer.sessionId,question:`这段对话的${workflowLabel}`,scope:turns.find(t=>t.answer?.answer.id===answer.id)?.message.scope??choice.scope},answer,`请根据这份${workflowLabel}的第 ${index+1} 段建议继续讨论，先核对前提。`)}/></div>}
          {activeWatch && <div hidden={!!citation || !!checksTarget || !!messageTarget}><WatchPanel key={activeWatch.id} watch={activeWatch} sources={sources} onChanged={()=>setWatchEpoch(n=>n+1)} onCitation={openCitation} onSave={setSavingAnswer} onContinue={(w,a)=>void continueVersion(w,a)} onRetrospective={(w,a)=>void openRetrospective(a,w.scope)} onChecks={a=>openChecks({answerId:a.id,sessionId:a.sessionId,question:activeWatch.question,scope:activeWatch.scope},true)}/></div>}
          {checksTarget && <div hidden={!!citation}>{(activeWatch||resumeOpen) && <button className="text-button" onClick={()=>setChecksTarget(null)}>{resumeOpen?`返回${workflowLabel}`:'返回关注答案'}</button>}<ChecksPanel target={checksTarget} onCitation={openCitation}
            onCollect={()=>editInspector({open:true,tab:'collect'})} onContinue={(answer,issue)=>void continueVersion(checksTarget,answer,`请继续核对此版本的第 ${(answer.checks??[]).findIndex(item=>item.id===issue.id)+1} 项待核对事项，重新读取相关资料，并说明哪些仍缺证据。`)}/></div>}
          {messageTarget && <>{resumeOpen&&<button className="text-button" onClick={()=>setMessageTarget(null)}>{`返回${workflowLabel}`}</button>}<MessagePanel target={messageTarget}/></>}
          {citation ? <>{(activeWatch || checksTarget || resumeOpen) && <button className="text-button" onClick={()=>setCitation(null)}>{checksTarget?'返回待核对事项':resumeOpen?`返回${workflowLabel}`:'返回关注答案'}</button>}<CitationPanel embedded key={`${citation.answerId}:${citation.evidenceId}:${citationVersion}`} target={citation} onClose={closeInspector}/></> :
          !activeWatch && !checksTarget && !resumeOpen && !messageTarget && (readingSource ? <SourceReading key={readingSource} sourceId={readingSource} revision={revision} catalogStamp={sources.find(s => s.id === readingSource)?.updatedAt} /> :
          <div className="inspector__empty"><span aria-hidden="true">▤</span><p>点击引用或文件，在这里阅读。</p></div>)}</>}
      </div>
    </aside>}
  </div>;
}

try {
  const workspace = new Workspace(); installDesktopTransport(workspace);
  createRoot(document.getElementById('root')!).render(<App workspace={workspace} />);
} catch (reason) {
  createRoot(document.getElementById('root')!).render(<main className="notice" role="alert"><h1>未能恢复草稿</h1><p>{(reason as Error).message}</p><p>请保留现有数据目录，检查磁盘空间和文件权限后重新打开。</p></main>);
}
