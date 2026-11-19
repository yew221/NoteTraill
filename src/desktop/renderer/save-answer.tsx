import { useState } from 'react';
import type { Answer, AnswerSelection } from '../../shared/answer.js';
import type { RunRef } from '../../shared/contracts.js';
import { selectableMarkdown } from '../../shared/presentation.js';
import { data } from './api.js';
import { Dialog } from './common.js';
import { errorText, type RunCommands } from './client.js';

export function SaveAnswer({ answer, commands, onRun, onClose }: { answer: Answer; commands: RunCommands; onRun: (ref: RunRef) => void; onClose: () => void }) {
  const mapped = selectableMarkdown(answer.markdown);
  const [selection, setSelection] = useState<AnswerSelection['selection'] | null>(null);
  const [preview,setPreview]=useState<{selection:AnswerSelection['selection'];text:string}|null>(null);
  const [title, setTitle] = useState('AI 整理选段'), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function prepare(){
    if(!selection||busy)return;setBusy(true);setError('');
    const submitted={...selection};
    try{const result=await data(window.notetrail.previewAnswerSelection(answer.id,{expectedAnswerRevision:answer.revision,selection:submitted,title}));setPreview({selection:submitted,text:result.text});}
    catch(reason){setError(errorText(reason));}finally{setBusy(false);}
  }
  const capture = (element: HTMLTextAreaElement) => {
    if(busy)return;
    const offsets = mapped.offsets.slice(element.selectionStart, element.selectionEnd).filter((item): item is number => item !== null);
    const start = offsets[0], end = offsets.length ? offsets.at(-1)! + 1 : 0;
    setSelection(start !== undefined && end > start ? { start, end, expectedText: answer.markdown.slice(start, end) } : null);
  };
  async function save() {
    if (!preview || busy) return; setBusy(true); setError('');
    try { onRun(await commands.send(`/api/v1/answers/${answer.id}/save`, { expectedAnswerRevision: answer.revision, selection:preview.selection, title })); onClose(); }
    catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  }
  return <Dialog title={preview ? '保存选中内容' : '选择要保存的文字'} onClose={() => { if (!busy) onClose(); }} wide>
    {preview && selection ? <><p>以下是将存入资料的完整内容，已附上相关依据、不确定性和适用条件。</p>
      <pre className="source-text">{preview.text}</pre>
      <label className="field">资料标题<input value={title} maxLength={200} onChange={event => setTitle(event.target.value)} /></label></> :
      <><p>在下方选中文字；也可用 Shift + 方向键选择。</p><label className="field">回答原文<textarea readOnly disabled={busy} rows={10} value={mapped.text}
        onSelect={event => capture(event.currentTarget)} onKeyUp={event => capture(event.currentTarget)}
        onPointerUp={event => capture(event.currentTarget)} onBlur={event => capture(event.currentTarget)} /></label></>}
    {error && <p role="alert" className="error-text">{error}</p>}
    <div className="row end"><button className="button secondary" disabled={busy} onClick={onClose}>取消</button>
      <button className="button primary" disabled={!selection || busy || !title.trim()} onClick={() => { if (preview) void save(); else void prepare(); }}>{busy ? '正在处理…' : preview ? '存入资料' : '预览选段'}</button></div>
  </Dialog>;
}
