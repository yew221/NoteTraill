import { useEffect, useRef, useState } from 'react';
import { HISTORY_TERM_LIMIT, isHistoryTerm, type Conversation, type HistoryHit, type HistoryPosition } from '../../shared/chat.js';
import type { Page } from '../../shared/vault.js';
import { api, ClientError, errorText } from './client.js';
import { Dialog } from './common.js';

export function historyPositionId(messageId: string, role: HistoryPosition['role']): string {
  return `history-${role}-${messageId}`;
}

export function focusHistoryPosition(position: HistoryPosition) {
  const node = document.getElementById(historyPositionId(position.messageId, position.role));
  if (!node) return false;
  node.focus({ preventScroll: true });
  node.scrollIntoView({ block: 'center' });
  return true;
}

function searchHistory(vaultId: string, q: string, signal: AbortSignal, options: { cursor?: string; sessionId?: string } = {}) {
  const params = new URLSearchParams({ vaultId, q, ...options });
  return api<Page<HistoryHit>>('/api/v1/sessions/search?' + params, { signal });
}

export function HistorySearch({ vaultId, onClose, onOpen }: { vaultId: string; onClose: () => void;
  onOpen: (conversation: Conversation, position: HistoryPosition | null) => void }) {
  const [term, setTerm] = useState('');
  const [lookup, setLookup] = useState<{ term: string; pages: number } | null>(null);
  const [results, setResults] = useState<Page<HistoryHit> | null>(null);
  const [busy, setBusy] = useState(false), [opening, setOpening] = useState(false), [error, setError] = useState('');
  const openRequest = useRef<AbortController | null>(null), resultVersion = useRef(0);
  useEffect(() => () => openRequest.current?.abort(), []);

  useEffect(() => {
    if (!lookup) return;
    const abort = new AbortController();
    let reading = false, hasHits = false, retry = false;
    const read = async (showProgress: boolean) => {
      if (reading || openRequest.current || abort.signal.aborted) return;
      reading = true;
      const version = resultVersion.current;
      if (showProgress) { setBusy(true); setError(''); }
      try {
        let nextCursor: string | null = null;
        const items = new Map<string, HistoryHit>();
        for (let page = 0; page < lookup.pages; page++) {
          const result = await searchHistory(vaultId, lookup.term, abort.signal, nextCursor ? { cursor:nextCursor } : {});
          result.items.forEach(hit => items.set(hit.sessionId, hit));
          nextCursor = result.nextCursor;
          if (!nextCursor) break;
        }
        if (!abort.signal.aborted && version === resultVersion.current) {
          hasHits = items.size > 0; retry = false;
          setResults({ items:[...items.values()], nextCursor }); setError('');
        }
      } catch (reason) {
        if (!abort.signal.aborted && version === resultVersion.current) {
          retry = reason instanceof ClientError && reason.code === 'CONTEXT_CHANGED';
          setResults(null); setError(retry ? '资料正在更新，正在重新核对搜索结果…' : errorText(reason));
        }
      } finally {
        reading = false;
        if (!abort.signal.aborted) setBusy(false);
      }
    };
    void read(true);
    const focus = () => { if (!document.hidden) void read(false); };
    const timer = window.setInterval(() => { if (hasHits || retry) focus(); }, 2000);
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => { abort.abort(); window.clearInterval(timer); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [vaultId, lookup]);

  async function open(hit: HistoryHit) {
    if (!lookup || busy || openRequest.current) return;
    const abort = new AbortController();
    openRequest.current = abort;
    resultVersion.current++;
    setOpening(true); setError('');
    try {
      const page = await searchHistory(vaultId, lookup.term, abort.signal, { sessionId:hit.sessionId });
      const current = page.items[0];
      if (!current || current.position?.messageId !== hit.position?.messageId || current.position?.role !== hit.position?.role) {
        throw new ClientError('这条搜索结果已变化。', 'NOT_FOUND');
      }
      const conversation = await api<Conversation>(`/api/v1/sessions/${hit.sessionId}`, { signal:abort.signal });
      if (conversation.vaultId !== vaultId) throw new ClientError('这段对话已不在当前知识库。', 'NOT_FOUND');
      if (!abort.signal.aborted) onOpen({ ...conversation, title:current.title }, current.position);
    } catch (reason) {
      if (abort.signal.aborted) return;
      if (reason instanceof ClientError && reason.code === 'NOT_FOUND') {
        setResults(previous => previous && { ...previous, items:previous.items.filter(item => item.sessionId !== hit.sessionId) });
        setError('这条结果已不可用，请重新搜索。');
      } else setError(errorText(reason));
    } finally {
      if (openRequest.current === abort) {
        openRequest.current = null;
        if (!abort.signal.aborted) setOpening(false);
      }
    }
  }

  return <Dialog title="搜索旧对话" onClose={onClose} wide>
    <form className="history-search-form" onSubmit={event => {
      event.preventDefault();
      if (!busy && !opening && isHistoryTerm(term)) { setResults(null); setLookup({ term:term.trim(), pages:1 }); }
    }}>
      <label className="field">标题或关键词
        <input type="search" autoFocus value={term} maxLength={HISTORY_TERM_LIMIT} placeholder="例如：蓝色工具箱" onChange={event => {
          openRequest.current?.abort(); openRequest.current = null;
          setTerm(event.target.value); setLookup(null); setResults(null); setError(''); setBusy(false); setOpening(false);
        }} />
      </label>
      <button className="button secondary" disabled={busy || opening || !isHistoryTerm(term)}>搜索</button>
    </form>
    {error && <p role="alert" className="error-text">{error}</p>}
    {(busy || opening) && <p role="status" className="muted">正在读取对话…</p>}
    {results && (results.items.length ? <ul className="history-search-results" aria-label="搜索结果">
      {results.items.map(hit => <li key={hit.sessionId}><button type="button" disabled={busy || opening} onClick={() => void open(hit)}>
        <strong>{hit.title}</strong>
        <span className="history-search-snippet"><small>{hit.position ? hit.position.role === 'user' ? '你的消息' : 'NoteTrail' : '标题'} · </small>{hit.snippet.before}<mark>{hit.snippet.match}</mark>{hit.snippet.after}</span>
      </button></li>)}
    </ul> : !busy && <p role="status" className="muted">当前知识库中没有匹配的对话。</p>)}
    {results?.nextCursor && lookup && <button className="text-button" disabled={busy || opening}
      onClick={() => setLookup({ ...lookup, pages:lookup.pages + 1 })}>更多搜索结果</button>}
  </Dialog>;
}

