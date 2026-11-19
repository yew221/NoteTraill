import { useEffect, useRef, useState } from 'react';
import type { Scope } from '../../shared/tools.js';
import type { Source } from '../../shared/vault.js';
import { data } from './api.js';

export type QuestionOptions = { scope: Scope };
export const defaultOptions: QuestionOptions = { scope: { mode: 'vault' } };
export function ScopeDialog({ vaultId, value, onSave, onClose }: { vaultId: string; value: QuestionOptions;
  onSave: (value: QuestionOptions) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState(value.scope.mode), [paths, setPaths] = useState(value.scope.mode === 'selected' ? value.scope.paths : []);
  const [sources, setSources] = useState<Source[]>([]);
  const [cursor, setCursor] = useState<string | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const active = useRef(true);
  async function load(next?: string) {
    setLoading(true); setError('');
    try {
      const page = await data(window.notetrail.sources(vaultId, next));
      if (active.current) { setSources(old => next ? [...old, ...page.items] : page.items); setCursor(page.nextCursor); }
    } catch (reason) { if (active.current) setError((reason as Error).message); }
    finally { if (active.current) setLoading(false); }
  }
  useEffect(() => { active.current = true; dialog.current?.showModal(); void load(); return () => { active.current = false; }; }, []);
  const files = sources.filter(source => !['excluded', 'missing'].includes(source.state)).map(source => source.relativePath);
  const folders = files.flatMap(file => file.split('/').slice(0, -1).map((_, index) => file.split('/').slice(0, index + 1).join('/') + '/'));
  const choices = [...new Set([...paths, ...folders, ...files])].sort();
  return <dialog className="scope-dialog" ref={dialog} aria-labelledby="scope-title" onCancel={onClose}>
    <h2 id="scope-title">这次可以检索哪些资料</h2>
    <label><input type="radio" name="scope" checked={mode === 'vault'} onChange={() => setMode('vault')} />整个知识库</label>
    <label><input type="radio" name="scope" checked={mode === 'selected'} onChange={() => setMode('selected')} />选定资料或文件夹</label>
    {mode === 'selected' && <div className="scope-choices">{choices.map(file => <label key={file}>
      <input type="checkbox" checked={paths.includes(file)} disabled={!paths.includes(file) && paths.length >= 50}
        onChange={event => setPaths(old => event.target.checked ? [...old, file] : old.filter(item => item !== file))} />{file}
    </label>)}{!choices.length && !loading && <p>还没有可选资料。</p>}</div>}
    {loading && <p role="status">正在读取资料目录…</p>}
    {error && <p role="alert">{error}<button onClick={() => void load(cursor ?? undefined)}>重试</button></p>}
    {cursor && <button className="text-button" disabled={loading} onClick={() => void load(cursor)}>加载更多资料</button>}
    <p className="muted">通用问题直接回答；涉及你的资料时优先查知识库；需要最新信息、存在不确定性或你要求核实时联网。上方范围仅约束知识库检索。</p>
    <p className="muted">已排除的资料不会参与检索。最多选择 50 项；未就绪的资料可能无法用于回答。</p>
    <footer><button onClick={onClose}>取消</button><button className="primary-button" disabled={mode === 'selected' && !paths.length}
      onClick={() => onSave({ scope: mode === 'vault' ? { mode: 'vault' } : { mode: 'selected', paths } })}>使用此范围</button></footer>
  </dialog>;
}
