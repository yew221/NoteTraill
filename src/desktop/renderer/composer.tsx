import { MAX_FILE_BYTES } from '../../shared/vault.js';
// Adapted from pi-gui v1.0.1 ComposerSurface; see desktop/PI_GUI_LICENSE and upstream.json.
import { questionBytes, questionTooLong } from '../../shared/chat.js';
export function Composer({ draft, onDraft, onSend, onStoreFile, blockSend, fileLocked, legacyPending, textOnly, onStop, onScope, onExperience, scopeLabel, disabled, busy, stopping, mode, onMode, file, onFile, onError, title, onTitle }: {
  draft: string; onDraft: (value: string) => void; onSend: () => void; onStop: () => void; onScope?: () => void; onExperience?: () => void;
  scopeLabel: string; disabled: boolean; busy: boolean; stopping: boolean;
  onStoreFile: () => void; blockSend: boolean; fileLocked: boolean; legacyPending: boolean; textOnly: boolean;
  mode: 'ask' | 'store'; onMode: (value: 'ask' | 'store') => void; file: { name: string; size: number } | null; onFile: (file: File | null) => void;
  onError: (message: string) => void; title: string; onTitle: (value: string) => void;
}) {
  const tooLong = mode === 'ask' && questionTooLong(draft.trim());
  const hint = tooLong ? `问题 ${questionBytes(draft.trim()).toLocaleString()} / 16,000 UTF-8 字节，请缩短后发送。草稿已保留。`
    : busy ? (disabled ? '' : '可继续写草稿')
      : file && !textOnly ? '存入文件后，问题仍留在输入框。' : '';
  const choose = (files: FileList | File[]) => {
    if (disabled || fileLocked) return;
    if (files.length !== 1) { onError('每次存入一个文件，请分次提交。'); return; }
    if (files[0].size > MAX_FILE_BYTES) { onError('单个文件最多 100 MiB。'); return; }
    onFile(files[0]); onError('');
  };
  return <footer className="composer">
    <div className="conversation conversation--composer">
      <div className="composer__surface" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); event.stopPropagation(); choose(event.dataTransfer.files); }}>
        {file && <div className="attachment"><span title={file.name}>{file.name}</span>
          <button className="text-button" disabled={disabled || busy || legacyPending} onClick={onStoreFile}>{fileLocked && !legacyPending ? '重试存入' : '存入知识库'}</button>
          <button disabled={disabled || fileLocked} onClick={() => onFile(null)} aria-label="移除附件">×</button></div>}
        <textarea aria-label="共用输入框" aria-describedby={hint ? 'composer-hint' : undefined} rows={1} readOnly={disabled} placeholder={file ? '想问这份文件什么？' : mode === 'ask' ? '提问或拖入文件…' : '粘贴文字或链接…'} value={draft}
          maxLength={1000000} aria-invalid={tooLong} onChange={event => onDraft(event.target.value)} onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              event.preventDefault(); if (!event.repeat && !disabled && !busy && !blockSend && !tooLong && (draft.trim() || file)) onSend();
            }
          }} />
        <div className="composer__footer-row">
          <div className="composer__options"><select className="composer__mode" aria-label="输入模式" value={mode} disabled={disabled} onChange={event => onMode(event.target.value as 'ask' | 'store')}>
            <option value="ask">对话</option><option value="store">存入资料</option></select>
            <label className="attach-button" title="添加文件">＋<span className="attach-label"> 文件</span><input aria-label="聊天添加文件" type="file" disabled={disabled || fileLocked} onChange={event => { if (event.target.files?.length) choose(event.target.files); event.target.value = ''; }} /></label>
            {mode === 'ask' ? <button className="scope-button" title={scopeLabel} aria-haspopup="dialog" disabled={disabled || busy || !onScope} onClick={onScope}>{scopeLabel} <span aria-hidden="true">⌄</span></button> :
              !file && <input className="intake-title" aria-label="资料标题（可选）" placeholder="资料标题（可选）" value={title} maxLength={200} onChange={event => onTitle(event.target.value)} />}
            {onExperience && <button className="scope-button" disabled={disabled} onClick={onExperience}>找找过往经验</button>}
          </div>
          {busy ? <button className="stop-button" disabled={disabled || stopping} onClick={onStop}>{stopping ? '正在停止…' : '停止'}</button> :
            <button className="send-button" disabled={disabled || blockSend || tooLong || (!draft.trim() && !file)} onClick={onSend} aria-label={file && !textOnly ? '发送文件与指令' : mode === 'ask' ? '发送问题' : '存入资料'} aria-keyshortcuts="Enter" title="Enter 发送，Shift + Enter 换行">↑</button>}
        </div>
      </div>
      {hint && <p className="composer__hint" id="composer-hint" role={tooLong ? 'alert' : undefined}>{hint}</p>}
    </div>
  </footer>;
}
