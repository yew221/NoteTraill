import { useEffect, useState } from 'react';
import type { Answer, AnswerView } from '../../shared/answer.js';
import type { Scope } from '../../shared/tools.js';
import { issueLabels, type AnswerIssue } from '../../shared/evidence-check.js';
import { data } from './api.js';
import type { CitationTarget } from './answers.js';

export type ChecksTarget = { answerId: string; sessionId: Answer['sessionId']; question: string; scope: Scope };
export function ChecksPanel({ target, onCitation, onContinue, onCollect }: { target: ChecksTarget;
  onCitation: (target: CitationTarget) => void; onContinue: (answer: Answer, issue: AnswerIssue) => void; onCollect: () => void }) {
  const [view,setView] = useState<AnswerView|null>(null), [error,setError] = useState(''), [reload,setReload] = useState(0);
  useEffect(() => { let active = true; setView(null); setError('');
    void data(window.notetrail.answer(target.answerId)).then(value => { if(active)setView(value); }).catch(e=>{if(active)setError(e.message);});
    return ()=>{active=false;};
  }, [target.answerId,reload]);
  useEffect(()=>{ const refresh=()=>setReload(n=>n+1); window.addEventListener('focus',refresh); return()=>window.removeEventListener('focus',refresh); },[]);
  return <section className="checks-panel" aria-label="待核对事项"><h2>待核对事项</h2>
    <p className="muted">这是该答案生成时的核查记录。原文摘录经过对应检查，语义判断仍需核对。</p>
    {error && <p role="alert">{error}</p>}{!view && !error && <p role="status">正在核对来源…</p>}
    {view && (view.answer.checks ?? []).map(issue => <article className="check-item" key={issue.id}>
      <strong>{issueLabels[issue.kind]}</strong><h3>{issue.summary}</h3><p>影响：{issue.impact}</p><p>建议核对：{issue.nextStep}</p>
      {issue.evidence.map((ref,i)=>{const local=view.answer.citations.find(e=>e.id===ref.evidenceId), web=view.answer.webCitations?.find(e=>e.id===ref.evidenceId);
        const status=view.citationStatus.find(s=>s.evidenceId===ref.evidenceId)?.status;
        return <div key={i}>{ref.kind==='local' && status!=='current' ? <p className="notice">来源已变化或暂不可读，旧摘录暂不展示；不能据此认为问题已解决。</p> : <blockquote>{ref.quote}</blockquote>}
          {local && <button className="text-button" onClick={()=>onCitation({answerId:view.answer.id,evidenceId:ref.evidenceId})}>查看原文 · 第 {local.location.startLine}–{local.location.endLine} 行</button>}
          {web && <a href={web.url}>{web.title}（{web.contentKind==='summary'?'搜索摘要':'网页摘录'}）</a>}</div>;
      })}
      <div className="watch-actions"><button className="text-button" onClick={()=>onContinue(view.answer,issue)}>继续核对</button><button className="text-button" onClick={onCollect}>补充资料</button></div>
    </article>)}
  </section>;
}
