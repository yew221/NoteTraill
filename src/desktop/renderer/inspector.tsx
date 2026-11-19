import { MAX_FILE_BYTES } from '../../shared/vault.js';
import { useEffect, useState } from 'react';
import type { Source } from '../../shared/vault.js';
import type { DesktopDraft } from '../../shared/desktop.js';
import { sourceLabel } from './common.js';
import { data } from './api.js';

export function Collection({ draft, vaultName, disabled, sending, sources, onDraft, onFile, onSend, onRead, onError }: {
  draft: DesktopDraft; vaultName: string; disabled: boolean; sending: boolean; sources: Source[];
  onDraft: (patch: Partial<DesktopDraft>) => void; onFile: (file: File | null) => void;
  onSend: () => void; onRead: (id: string) => void; onError: (message: string) => void;
}) {
  const [dragging, setDragging] = useState(false);
  function choose(files: FileList) {
    setDragging(false);
    if (disabled) return;
    if (files.length !== 1) { onError('每次存入一个文件，请分次提交。'); return; }
    if (files[0].size > MAX_FILE_BYTES) { onError('单个文件最多 100 MiB。'); return; }
    onFile(files[0]);
  }
  const recent = sources.filter(source => source.origin !== 'existing_file').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);
  return <div className="collection">
    {!vaultName && <p className="muted">尚未连接知识库</p>}
    <label className={`collection__drop ${dragging ? 'collection__drop--active' : ''}`} data-disabled={disabled}
      title="每次一个文件，最多 100 MiB"
      onDragOver={event => { event.preventDefault(); if (!disabled) setDragging(true); }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={event => { event.preventDefault(); choose(event.dataTransfer.files); }}>
      <span className="collection__symbol" aria-hidden="true">＋</span>
      <strong>选择或拖入文件</strong>
      <input aria-label="收集区选择文件" type="file" disabled={disabled}
        onChange={event => { if (event.target.files?.length) choose(event.target.files); event.target.value = ''; }} />
    </label>
    {draft.attachment && <div className="attachment"><span>{draft.attachment.name}</span><button disabled={disabled} aria-label="移除收集区附件" onClick={() => onFile(null)}>×</button></div>}
    {!draft.attachment && <><label className="field"><span>粘贴文字或链接</span><textarea aria-label="收集资料内容" rows={4} maxLength={1000000} value={draft.text}
      disabled={disabled} onChange={event => onDraft({ text: event.target.value })} /></label>
      <label className="field"><span>标题 <span className="muted">（可选）</span></span><input aria-label="收集资料标题" value={draft.title} maxLength={200} disabled={disabled} onChange={event => onDraft({ title: event.target.value })} /></label></>}
    {draft.attachment && draft.text.trim() && <p className="notice">这里还留有文字草稿。请先移除文件并存入文字，或清空文字后再存入文件。<button disabled={disabled} onClick={() => onDraft({ text: '', title: '' })}>清空文字草稿</button></p>}
    <button className="primary-button collection__submit" title={vaultName ? `存入「${vaultName}」` : undefined} disabled={disabled || (!draft.text.trim() && !draft.attachment) || !!(draft.attachment && draft.text.trim())} onClick={onSend}>{sending ? '正在提交…' : '存入知识库'}</button>
    {draft.pending && <p className="muted" role="status">上次提交尚未确认，可重试同一内容；不会重复存入。</p>}
    {!!recent.length && <section className="collection__recent"><h3>最近收集</h3>{recent.map(source => <button key={source.id} className="collected-source" onClick={() => onRead(source.id)}>
      <span>{source.title}</span><small>{sourceLabel[source.state]}</small></button>)}</section>}
  </div>;
}

export function SourceReading({ sourceId, revision, catalogStamp }: { sourceId: string; revision: number; catalogStamp?: string }) {
  const [source, setSource] = useState<Source | null>(null), [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState(''), [reload, setReload] = useState(0), [lineStart, setLineStart] = useState(0);
  useEffect(() => {
    let active = true;
    setSource(null); setBody(null); setError(''); setLineStart(0);
    void data(window.notetrail.source(sourceId)).then(async value => {
      if (!active) return;
      setSource(value);
      if (value.version && ['ready', 'partial'].includes(value.state)) {
        const text = await data(window.notetrail.sourceText(value.id, value.version));
        if (active) setBody(text);
      }
    }).catch(reason => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [sourceId, revision, catalogStamp, reload]);
  useEffect(() => { const check = () => { setSource(null); setBody(null); setReload(value => value + 1); };
    window.addEventListener('focus', check); return () => window.removeEventListener('focus', check);
  }, []);
  const lines = body?.split('\n') ?? [];
  return <section className="source-reading" aria-label="资料正文">
    {!source && !error && <p className="muted" role="status">正在核对资料…</p>}
    {error && <p className="notice" role="alert">{error}</p>}
    {source && <><h2>{source.title}</h2>
      {source.origin === 'existing_file' && source.relativePath !== source.title && <p className="source-path">{source.relativePath}</p>}
      <p className="muted" role="status">{sourceLabel[source.state]}</p>
      {source.originalSaved && source.version && !['excluded', 'missing', 'stale'].includes(source.state) && <button className="text-button" onClick={() => {
        void data(window.notetrail.exportOriginal(source.id, source.version!)).catch(reason => setError(reason.message));
      }}>保存原件副本</button>}
      {source.warnings.map((warning, index) => <p className="notice" key={index}>{warning.message}</p>)}
      {body !== null ? <>
        {source.readableRepresentation?.kind === 'extracted_markdown' && <p className="muted">提取正文，行号不代表原文件页码。</p>}
        {lines.length > 200 && <>
          <div className="line-navigation"><button className="text-button" disabled={lineStart === 0} onClick={() => setLineStart(value => Math.max(0, value - 200))}>前 200 行</button>
            <button className="text-button" disabled={lineStart + 200 >= lines.length} onClick={() => setLineStart(value => value + 200)}>后 200 行</button></div>
          <p className="muted">显示 {lineStart + 1}–{Math.min(lineStart + 200, lines.length)} 行，共 {lines.length} 行</p>
        </>}
        <pre className="source-lines">{lines.slice(lineStart, lineStart + 200).map((line, index) => <span className="source-line" key={index}><span className="line-number" aria-hidden="true">{lineStart + index + 1}</span><span>{line || '\u200b'}</span></span>)}</pre></> :
        !error && <p className="muted">{['pending', 'processing'].includes(source.state) ? '资料正在处理中，完成后会显示正文。' : ['ready', 'partial'].includes(source.state) ? '正在读取正文…' : '这份资料暂时没有可阅读的正文。可到“资料”页面查看状态并处理。'}</p>}</>}
    <button className="text-button" onClick={() => { setSource(null); setBody(null); setReload(value => value + 1); }}>重新读取资料</button>
  </section>;
}
