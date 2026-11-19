import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Source, Vault } from '../../shared/vault.js';
import { MEMORY_LIMITS, type Memory, type MemoryCategory } from '../../shared/memory.js';
import { ModelProfilesPanel } from './model-profiles.js';
import { type ModelSettingsView } from '../../shared/model.js';
import type { RunRef } from '../../shared/contracts.js';
import { contentPath } from '../../shared/presentation.js';
import { allPages, api, ClientError, errorText, RunCommands } from './client.js';
import { Dialog, Icon, sourceLabel, timeLabel } from './common.js';
import { SourceReader } from './source-reader.js';
import { isDeletionImpact, type Conversation, type DeletionImpact } from '../../shared/chat.js';

export function DeleteConversationDialog({ session, onClose, onDeleted }: { session: Conversation; onClose: () => void; onDeleted: () => void }) {
  const [impact, setImpact] = useState<DeletionImpact | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const path = `/api/v1/sessions/${session.id}`;
  useEffect(() => {
    if (busy) return;
    const abort = new AbortController(); let reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const next = await api<DeletionImpact>(path + '/deletion-impact', { signal: abort.signal });
        if (!isDeletionImpact(next)) throw new ClientError('无法确认本次删除的影响。');
        if (!abort.signal.aborted) setImpact(next);
      } catch (e) { if (!abort.signal.aborted) { setImpact(null); setError(errorText(e)); } }
      finally { reading = false; }
    };
    void read();
    const timer = window.setInterval(() => { if (!document.hidden) void read(); }, 1500);
    return () => { abort.abort(); window.clearInterval(timer); };
  }, [path, busy, reload]);
  async function remove() {
    if (!impact || busy) return;
    setError(''); setBusy(true);
    try { await api(path, { method: 'DELETE', body: impact }); onDeleted(); }
    catch (e) {
      setImpact(null); setError(e instanceof ClientError && e.code === 'REVISION_CONFLICT'
        ? '关注或答案版本数已经变化。请核对最新数量后再确认删除。' : e instanceof ClientError && e.code === 'SESSION_BUSY' ? '这段对话还有任务正在处理。请等本轮结束后核对数量，再确认删除。' : errorText(e));
    } finally { setBusy(false); }
  }
  return <Dialog title="删除这段对话？" onClose={() => { if (!busy) onClose(); }}>
    <p>将删除“{session.title}”及其聊天历史。</p>
    <div role="status">{impact ? impact.watches > 0 && <p>还会删除 {impact.watches} 条持续关注，共 {impact.versions} 个答案版本（含原回答）。</p> :
      !error && <p>正在核对删除范围…</p>}</div>
    <p>已存入知识库的文件、笔记和长期记忆会保留。</p>
    {error && <p role="alert">{error} {!impact && <button className="text-button" onClick={() => { setError(''); setReload(n => n+1); }}>重新核对</button>}</p>}
    <div className="row end"><button className="button secondary" disabled={busy} onClick={onClose}>保留对话</button>
      <button className="button danger" disabled={busy || !impact} onClick={() => void remove()}>确认删除对话</button></div>
  </Dialog>;
}

export type PanelActions = { disabled: boolean; commands: RunCommands; track: (ref: RunRef) => void; refresh: () => Promise<void>; report: (message: string) => void };

// An idle window reads only a local change counter. A new file, completed conversion or revoked source changes it.
export function useLiveSources(vaultId: string | undefined) {
  const [catalog, setCatalog] = useState<{vaultId:string; sources:Source[]} | null>(null), [error,setError] = useState('');
  useEffect(() => {
    setCatalog(null); setError('');
    if (!vaultId) return;
    const abort = new AbortController(); let seen = -1, busy = false;
    const read = async () => {
      if (busy || document.hidden || abort.signal.aborted) return;
      busy = true;
      try {
        const path = `/api/v1/vaults/${vaultId}`;
        const revision = await api<number>(path + '/catalog-revision', {signal:abort.signal});
        if (revision !== seen) {
          const sources = await allPages<Source>(path + '/sources', abort.signal);
          if (!abort.signal.aborted) { setCatalog({vaultId,sources}); seen = revision; }
        }
        if (!abort.signal.aborted) setError('');
      } catch (e) {
        if (!abort.signal.aborted) { seen = -1; setCatalog(null); setError(errorText(e)); }
      } finally { busy = false; }
    };
    const focus = () => { void read(); };
    focus(); const timer = window.setInterval(focus,1000);
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => { abort.abort(); window.clearInterval(timer); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [vaultId]);
  return {sources: catalog && catalog.vaultId === vaultId ? catalog.sources : [], error};
}

export function SourcesPanel({ vault, sources, actions, onConnect, onIngest, readContent }: {
  vault: Vault | null; sources: Source[]; actions: PanelActions; onConnect: () => void; onIngest: () => void;
  readContent: (source: Source) => Promise<string>;
}) {
  const [filter, setFilter] = useState('all'), [search, setSearch] = useState(''), [readingId, setReading] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const filtered = !!search || filter !== 'all';
  const reading = sources.find(s => s.id === readingId && s.readableRepresentation && ['ready','partial'].includes(s.state));
  const shown = sources.filter(source => source.relativePath.toLocaleLowerCase().includes(search.toLocaleLowerCase()) &&
    (filter === 'all' || filter === 'readable' && ['ready','partial'].includes(source.state) || filter === 'attention' && !['ready','excluded','missing'].includes(source.state)));
  async function run(path: string) {
    if (busy) return; setBusy(true);
    try { actions.track(await actions.commands.send(path)); } catch (error) { actions.report(errorText(error)); } finally { setBusy(false); }
  }
  if (!vault) return <section className="page-panel" aria-label="资料">
    <div className="empty-panel">
      <Icon name="files" />
      <button className="button primary" onClick={onConnect}>连接知识库</button>
    </div>
  </section>;
  return <section className="page-panel" aria-label="资料">
    <div className="source-toolbar">
      <label className="field compact"><span className="sr-only">查找资料</span><input ref={searchInput} type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索文件名或路径" /></label>
      <label className="field compact"><span className="sr-only">资料状态</span><select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部状态</option><option value="readable">可用于问答</option><option value="attention">需要关注</option></select></label>
      <div className="source-tools">
        <button className="button secondary" disabled={actions.disabled || busy} title={vault.discovery.checkedAt ? `最近检查 ${timeLabel(vault.discovery.checkedAt)}` : undefined} onClick={() => void run(`/api/v1/vaults/${vault.id}/refresh`)}>刷新资料</button>
        <button className="button primary" disabled={actions.disabled} onClick={onIngest}><Icon name="plus" />存入资料</button>
      </div>
    </div>
    <span className="sr-only" role="status">{filtered && `找到 ${shown.length} 份资料`}</span>
    {vault.discovery.error && <p role="alert" className="error-text">{vault.discovery.error.message}</p>}
    <div className="source-list">{shown.length ? shown.map(source => {
      const download = source.originalSaved && source.version ? contentPath(source.id, source.version, 'original') : null;
      const original = download ? '' : source.originalSaved ? '原件已保存' : '原件尚未保存';
      const origin = source.origin === 'ai_saved' ? 'AI 整理内容' : source.origin === 'web_snapshot' ? '网页快照' : '';
      const details = [original, origin].filter(Boolean).join(' · ');
      return <article key={source.id} className="source-row">
        <div className="file-symbol" aria-hidden="true"><Icon name="note" /></div>
        <div className="source-detail">
          <div className="row"><button className="text-button source-name" disabled={!['ready','partial'].includes(source.state)} onClick={() => setReading(source.id)}>{source.title}</button><span className={`status-pill ${source.state}`}>{sourceLabel[source.state]}</span></div>
          {source.relativePath !== source.title && <p className="source-path">{source.relativePath}</p>}
          {details && <p className="subtle">{details}</p>}
          {source.warnings.map(warning => <p key={warning.code} className="warning-text">{warning.message}</p>)}
        </div>
        <div className="source-actions">
          {source.sourceUrl && <a className="button secondary small" href={source.sourceUrl} target="_blank" rel="noopener noreferrer" title={source.capturedAt ? `快照于 ${timeLabel(source.capturedAt)}` : undefined}>原网页 ↗</a>}
          {download && <a className="button secondary small" href={download}>下载原件</a>}
          {source.state === 'failed' && <button className="button secondary small" disabled={actions.disabled || busy} onClick={() => { void run(`/api/v1/sources/${source.id}/retry`); }}>重试处理</button>}
        </div>
      </article>;
    }) : <div className="empty-panel"><Icon name="files" /><h2>{filtered ? '没有匹配的资料' : '暂无资料'}</h2>
      {filtered && <button className="button secondary" onClick={() => { setSearch(''); setFilter('all'); searchInput.current?.focus(); }}>清除筛选</button>}
    </div>}</div>
    {readingId && !reading && <Dialog title="资料暂时不可读" onClose={() => setReading(null)}><p>原件已变化或暂不可读，请查看资料列表中的当前状态。</p></Dialog>}
    {reading && <SourceReader key={reading.id + ':' + reading.version + ':' + reading.readableRepresentation?.hash} source={reading} onClose={() => setReading(null)} readContent={readContent} />}
  </section>;
}

const categories: Record<MemoryCategory, string> = { preference: '回答偏好', focus: '关注事项', user_note: '我的备注' };
function Memories({ memories, vault, actions }: { memories: Memory[]; vault: Vault | null; actions: PanelActions }) {
  const [text, setText] = useState(''), [category, setCategory] = useState<MemoryCategory>('preference'), [editing, setEditing] = useState<Memory | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef<{ text: string; category: MemoryCategory; key: string } | null>(null);
  async function save(event: FormEvent) {
    event.preventDefault(); if (!vault || busy) return; setBusy(true); setError('');
    try {
      if (editing) await api(`/api/v1/memories/${editing.id}`, { method: 'PATCH', body: { text, expectedRevision: editing.revision } });
      else {
        if (pending.current?.text !== text || pending.current.category !== category) pending.current = { text, category, key: crypto.randomUUID() };
        await api('/api/v1/memories', { method: 'POST', key: pending.current.key, body: { vaultId: vault.id, text, category } }); pending.current = null;
      }
      setText(''); setEditing(null); await actions.refresh();
    } catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }
  async function remove(memory: Memory) {
    if (busy) return; setBusy(true); setError('');
    try { await api(`/api/v1/memories/${memory.id}?expectedRevision=${memory.revision}`, { method: 'DELETE' }); setConfirmDelete(null);
      if (editing?.id === memory.id) { setEditing(null); setText(''); } await actions.refresh(); }
    catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }
  return <section className="settings-section">
    <h2>长期记忆</h2>
    <form onSubmit={event => { void save(event); }} className="settings-form">
      <label className="field">{editing ? '修改记忆' : '添加记忆'}<textarea rows={3} value={text} onChange={event => setText(event.target.value)} maxLength={MEMORY_LIMITS.textLength} required /></label>
      <div className="row between"><label className="field compact"><span className="sr-only">记忆类型</span><select value={category} disabled={!!editing} onChange={event => setCategory(event.target.value as MemoryCategory)}>{Object.entries(categories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><div className="row">{editing && <button type="button" className="button secondary" onClick={() => { setEditing(null); setText(''); }}>取消修改</button>}<button className="button primary" disabled={actions.disabled || !vault || busy || !text.trim()}>{busy ? '处理中…' : editing ? '保存修改' : '保存记忆'}</button></div></div>
    </form>
    {error && <p className="error-text" role="alert">{error}</p>}
    <div className="memory-list">{memories.map(memory => <article key={memory.id} className="memory-row">
      <strong>{categories[memory.category]}</strong>
      <p>{memory.text}</p>
      <div className="row end">{confirmDelete === memory.id ? <>
        <button className="button secondary" onClick={() => setConfirmDelete(null)}>取消</button>
        <button className="button danger" disabled={busy || actions.disabled} onClick={() => { void remove(memory); }}>确认删除记忆</button>
      </> : <>
        <button className="button secondary" disabled={busy || actions.disabled} onClick={() => { setEditing(memory); setText(memory.text); setCategory(memory.category); }}>修改</button>
        <button className="text-button" disabled={busy || actions.disabled} onClick={() => setConfirmDelete(memory.id)}>删除</button>
      </>}</div>
    </article>)}</div>
  </section>;
}

export function SettingsPanel({ vault, models, memories, actions, initialSection = 'vault', pickFolder, vaultDiscovery }: { vault: Vault | null; models: ModelSettingsView; memories: Memory[]; actions: PanelActions; initialSection?: 'vault' | 'model' | 'memory'; pickFolder?: () => Promise<string | null>; vaultDiscovery?: (select: (path: string) => void) => ReactNode }) {
  const [section, setSection] = useState(initialSection), [path, setPath] = useState(''), [exclusions, setExclusions] = useState(vault?.exclusions.join('\n') ?? '');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  useEffect(() => setExclusions(vault?.exclusions.join('\n') ?? ''), [vault?.id, vault?.revision]);
  useEffect(() => setSection(initialSection), [initialSection]);
  async function saveVault(event: FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError(''); setNotice('');
    try {
      const exclude = exclusions.split('\n').map(value => value.trim()).filter(Boolean);
      if (vault) await api(`/api/v1/vaults/${vault.id}`, { method: 'PATCH', body: { exclusions: exclude, expectedRevision: vault.revision } });
      else await api('/api/v1/vaults', { method: 'POST', body: { absolutePath: path.trim(), exclusions: exclude } });
      setPath(''); await actions.refresh(); setNotice('知识库设置已保存，正在核对资料。');
    } catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }
  return <section className="page-panel settings-panel" aria-label="设置">
    <div className="settings-tabs" aria-label="设置分类">{([['vault','知识库'],['model','模型'],['memory','记忆']] as const).map(([value, label]) => <button key={value} className={section === value ? 'active' : ''} aria-pressed={section === value} onClick={() => { setSection(value); setError(''); setNotice(''); }}>{label}</button>)}</div>
    {section === 'vault' && <section className="settings-section"><h2>{vault ? vault.name : '连接你的 Obsidian 知识库'}</h2>{vaultDiscovery?.(setPath)}<form className="settings-form" onSubmit={event => { void saveVault(event); }}>
      {!vault && <><label className="field">知识库文件夹的完整路径<input value={path} onChange={event => setPath(event.target.value)} required placeholder="/Users/你的用户名/Documents/知识库" autoComplete="off" /></label>
        {pickFolder && <button type="button" className="button secondary" disabled={busy} onClick={() => { void pickFolder().then(value => { if (value) setPath(value); }).catch(error => setError(errorText(error))); }}>选择知识库文件夹</button>}</>}
      <label className="field">排除的相对路径（每行一个）<textarea rows={4} value={exclusions} onChange={event => setExclusions(event.target.value)} placeholder={'私密资料/\n日记/'} /></label>
      <div className="row end"><button className="button primary" disabled={actions.disabled || busy}>{busy ? '正在保存…' : vault ? '保存排除范围' : '连接知识库'}</button></div>
    </form></section>}
    {section === 'model' && <>
      <ModelProfilesPanel models={models} hasVault={!!vault} actions={actions} />
      <details className="privacy-note">
        <summary>数据与联网</summary>
        <p>原件与历史保存在本机，API 密钥存放在本机钥匙串。提问时，问题、检索片段、相关历史及已保存的记忆会发送给所选模型服务。</p>
        <p>模型按需自动联网。搜索关键词会发送给搜索服务，系统会拦截识别到的私密片段，仍可能遗漏敏感含义。搜索按次计费。</p>
      </details>
    </>}
    {section === 'memory' && <Memories memories={memories} vault={vault} actions={actions} />}
    {error && <p role="alert" className="error-text">{error}</p>}{notice && <p role="status" className="success-text">{notice}</p>}
  </section>;
}
