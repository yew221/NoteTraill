import { retrospectiveLabel } from '../../shared/retrospective.js';
import { experienceLabel } from '../../shared/experiences.js';
import { useEffect, useRef, useState } from 'react';
import type { AnswerView } from '../../shared/answer.js';
import type { Source } from '../../shared/vault.js';
import { Markdown } from './markdown.js';
import { data, type CitationView } from './api.js';
import { resumeLabel, type MessageReference } from '../../shared/continuation.js';

export type CitationTarget = { answerId: string; evidenceId: string };
const labels = { grounded: '', inference: '推断', general: '模型回答', notice: '说明', web: '网页补充' };
const statuses = { current: '已核对版本', changed: '资料已修改，请重新提问核对新版。', missing: '原资料已找不到，无法核对引用。',
  excluded: '这份资料已被排除，不能继续读取。', unavailable: '暂时无法核对这份资料，请稍后重试。' };

export type MessageTarget=MessageReference & {sessionId:string};
export function Answer({ view, sources, onCitation, onChecks, onMessage, excerpt = false }: { view: AnswerView; sources: Source[]; onCitation: (target: CitationTarget) => void; onChecks?: () => void; onMessage?:(target:MessageTarget)=>void; excerpt?: boolean }) {
  const answer = view.answer;
  return <div className="answer-body">
    {answer.retrospectiveBase&&!excerpt&&<p className="notice">本次选定判断版本：{new Date(answer.retrospectiveBase.createdAt).toLocaleString('zh-CN')}。{answer.retrospectiveBase.available?'按此版本还原当时判断。':'该版本当前不可核对，未带入旧正文。'}</p>}
    {answer.resumeCoverage && !excerpt && <p className="notice">{answer.resumeCoverage.through?'记录截至 '+new Date(answer.resumeCoverage.through).toLocaleString('zh-CN'):'尚无可用的业务记录'}，纳入 {answer.resumeCoverage.includedMessages}/{answer.resumeCoverage.totalMessages} 条用户消息。生成于 {new Date(answer.resumeCoverage.generatedAt).toLocaleString('zh-CN')}。{answer.resumeCoverage.omittedMessages || answer.resumeCoverage.omittedAnswers ? '部分记录未纳入，详见限制。' : '这不代表离开期间没有新进展。'}</p>}
    {answer.blocks.map(block => <div className="answer-block" key={block.id}>
      {(retrospectiveLabel(answer.retrospective,block.id)||resumeLabel(answer.resume,block.id)||experienceLabel(answer.experiences,block.id,block.kind)||labels[block.kind]) && <strong className="answer-label">{retrospectiveLabel(answer.retrospective,block.id)||resumeLabel(answer.resume,block.id)||experienceLabel(answer.experiences,block.id,block.kind)||labels[block.kind]}</strong>}
      <Markdown text={block.markdown} trailing={block.evidenceIds.length ? block.evidenceIds.map(id => {
        if (block.kind === 'web') {
          const i = (answer.webCitations ?? []).findIndex(e => e.id === id), e = answer.webCitations?.[i];
          return e ? <a className="citation-button" key={id} href={e.url} title={e.title} aria-label={`打开网页来源 ${i + 1}：${e.title}`}>[网页 {i + 1}]</a> : null;
        }
        const index = answer.citations.findIndex(item => item.id === id), evidence = answer.citations[index];
        if (!evidence) return null;
        const status = view.citationStatus.find(item => item.evidenceId === id)?.status;
        const name = sources.find(source => source.id === evidence.sourceId)?.title;
        const title = `${name ?? `资料 ${index + 1}`} · ${evidence.location.refersTo === 'extracted' ? '提取文本' : '原文'} ${evidence.location.startLine}–${evidence.location.endLine} 行${evidence.location.startOffset !== undefined || evidence.location.endOffset !== undefined ? ' · 行内片段' : ''}${status !== 'current' ? ' · 需核对' : ''}`;
        return <button className={`citation-button${status !== 'current' ? ' citation-button--unchecked' : ''}`} key={id}
          title={title} aria-label={`查看引用 ${index + 1}：${title}`} onClick={() => onCitation({ answerId: answer.id, evidenceId: id })}>
          [资料 {index + 1}{status !== 'current' && ' · 需核对'}]
          {name && <span className="citation-origin" aria-hidden="true"> · {name}</span>}
        </button>;
      }) : null} />
      {(answer.resume??answer.retrospective)?.sections.flatMap(s=>s.items).find(item=>item.blockId===block.id)?.messages.map((ref,i)=><div className="message-proof" key={i}>
        <blockquote>{ref.quote}</blockquote>{onMessage ? <button className="text-button" onClick={()=>onMessage({...ref,sessionId:answer.sessionId})}>{ref.role==='user'?'查看用户原话':'查看历史模型表述'}</button> : <small>{ref.role==='user'?'用户原话':'历史模型表述，非现实结果证据'}</small>}
      </div>)}
      {!!answer.checks?.some(issue => issue.blockIds.includes(block.id)) && <button className="text-button evidence-notice" onClick={onChecks}>此结论有待核对事项</button>}
    </div>)}
    {!!answer.webCitations?.length && <div className="citation-note" aria-label="网页来源"><strong>网页来源</strong><ol>
      {answer.webCitations.map(e => <li key={e.id}><a href={e.url}>{e.title}</a>
        <p className="muted">{new URL(e.url).hostname} · {e.contentKind === 'summary' ? '搜索摘要' : '网页摘录'} · 获取于 {new Date(e.retrievedAt).toLocaleString('zh-CN')}</p>
        <details><summary>查看本次依据摘录</summary><p>{e.excerpt}</p></details>
      </li>)}</ol><p className="muted">保留的是本次搜索返回内容；网页之后可能变化，未核查全文。</p></div>}
    {!excerpt && <div className="evidence-summary">{answer.checks?.length ? <button className="text-button evidence-notice" onClick={onChecks}>{answer.checks.length} 项待核对</button> :
      <small className="muted">{!answer.checkStatus || answer.checkStatus === 'not_checked' ? '此版本尚未生成待核对事项' : answer.checkStatus === 'not_applicable' ? '本轮未进行资料论证检查' : '本轮未列出待核对事项，不代表已核查全部资料'}</small>}</div>}
    {!!answer.limitations.length && <div className="citation-note"><strong>资料与检索限制</strong><ul>{answer.limitations.map((item, i) => <li key={i}>{item}</li>)}</ul></div>}
  </div>;
}

export function CitationPanel({ target, onClose, embedded = false }: { target: CitationTarget; onClose: () => void; embedded?: boolean }) {
  const [view, setView] = useState<CitationView | null>(null), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  const [lineStart, setLineStart] = useState(0);
  const firstLine = useRef<HTMLElement>(null), close = useRef<HTMLButtonElement>(null);
  useEffect(() => { close.current?.focus(); }, []);
  useEffect(() => {
    let active = true;
    setView(null); setError('');
    void data(window.notetrail.citation(target.answerId, target.evidenceId)).then(result => {
      if (active) { setView(result); setLineStart(Math.max(0, (result.evidence?.location.startLine ?? 1) - 31)); }
    })
      .catch(reason => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [target.answerId, target.evidenceId, revision]);
  useEffect(() => {
    const check = () => { setView(null); setRevision(value => value + 1); };
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, []);
  useEffect(() => { firstLine.current?.scrollIntoView({ block: 'center' }); }, [view]);
  const evidence = view?.evidence;
  const lines = view?.text?.split('\n') ?? [];
  return <aside className="citation-panel" aria-label="引用原文" onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
    {!embedded && <header><strong>引用原文</strong><button ref={close} onClick={onClose} aria-label="关闭引用">×</button></header>}
    <div className="citation-panel__body">
      {!view && !error && <p role="status">正在核对来源版本…</p>}
      {error && <p role="alert" className="notice">{error}</p>}
      {view && <><p className={view.status === 'current' ? 'muted' : 'notice'} role="status">{statuses[view.status]}</p>
        <p className="muted">核对时间：{new Date(view.checkedAt).toLocaleTimeString('zh-CN')}</p></>}
      {view?.status === 'current' && evidence && view.source && view.text !== undefined && <>
        <h2>{view.source.title}</h2><p className="source-path">{view.source.relativePath}</p>
        <p className="muted">{evidence.location.refersTo === 'extracted' ? '以下为提取文本，行号不代表原文件页码。' : '以下为原文。'}引用位于第 {evidence.location.startLine}–{evidence.location.endLine} 行。{(evidence.location.startOffset !== undefined || evidence.location.endOffset !== undefined) && '本次引用为行内片段，仅高亮部分已作为回答依据。'}</p>
        {view.source.originalSaved && <button className="text-button" onClick={() => {
          void data(window.notetrail.exportOriginal(evidence.sourceId, evidence.sourceVersion)).catch(reason => setError(reason.message));
        }}>保存原件副本</button>}
        {evidence.origin === 'ai_saved' && <p className="notice">来源包含保存的 AI 整理，属于派生内容。</p>}
        {evidence.warnings.map((warning, i) => <p className="notice" key={i}>{warning.message}</p>)}
        <div className="line-navigation"><button className="text-button" disabled={lineStart === 0} onClick={() => setLineStart(value => Math.max(0, value - 200))}>前 200 行</button>
          <button className="text-button" disabled={lineStart + 200 >= lines.length} onClick={() => setLineStart(value => value + 200)}>后 200 行</button></div>
        <p className="muted">显示 {lineStart + 1}–{Math.min(lineStart + 200, lines.length)} 行，共 {lines.length} 行</p>
        <pre className="source-lines">{lines.slice(lineStart, lineStart + 200).map((line, offset) => {
          const index = lineStart + offset, number = index + 1;
          const quoted = number >= evidence.location.startLine && number <= evidence.location.endLine;
          const start = number === evidence.location.startLine ? evidence.location.startOffset ?? 0 : 0;
          const end = number === evidence.location.endLine ? Math.min(line.length, evidence.location.endOffset ?? line.length) : line.length;
          const partial = quoted && (start > 0 || end < line.length);
          return <span key={index}
          ref={number === evidence.location.startLine && !partial ? element => { firstLine.current = element; } : undefined}
          className={quoted && !partial ? 'source-line source-line--quoted' : 'source-line'}>
          <span className="line-number" aria-hidden="true">{index + 1}</span><span>{partial ? <>{line.slice(0, start)}<mark className="source-fragment" ref={number === evidence.location.startLine ? element => { firstLine.current = element; } : undefined}>{line.slice(start, end)}</mark>{line.slice(end)}</> : line || '\u200b'}</span>
        </span>; })}</pre>
      </>}
      <button className="text-button" onClick={() => { setView(null); setRevision(value => value + 1); }}>重新核对来源</button>
    </div>
  </aside>;
}
