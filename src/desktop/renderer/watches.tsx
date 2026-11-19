import { useEffect, useState } from 'react';
import type { Answer as AnswerRecord, AnswerView } from '../../shared/answer.js';
import type { AnswerWatch, WatchDetail } from '../../shared/watch.js';
import type { Scope } from '../../shared/tools.js';
import type { Source } from '../../shared/vault.js';
import type { Run } from '../../shared/run.js';
import { Dialog, Usage, runLabel } from './common.js';
import { data, watchRun } from './api.js';
import { Answer, type CitationTarget } from './answers.js';

export const reviewLabel = { changed:'结论有变化', evidence_updated:'依据已更新', unchanged:'本轮未发现需修改', uncertain:'仍有待核查内容' };
const stateLabel = { paused:'已暂停',pending:'等待复核',updating:'正在复核',checked:'已完成本轮复核',failed:'更新未完成' };
const scopeLabel = (scope: Scope) => scope.mode === 'vault' ? '整个知识库（遵守当前排除设置）' : scope.paths.join('、');
const date = (s: string) => new Date(s).toLocaleString('zh-CN');
export function WatchSetup({ answer, question, scope, onDone, onClose }: { answer: AnswerRecord; question: string; scope: Scope;
  onDone: (watch: AnswerWatch) => void; onClose: () => void }) {
  const [text,setText]=useState(question),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function save() {
    setBusy(true); setError('');
    try { onDone(await data(window.notetrail.watchAnswer(answer.id,{question:text,expectedAnswerRevision:answer.revision}))); }
    catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <Dialog title="持续关注这条答案" onClose={() => { if(!busy) onClose(); }}>
    <label className="field">关注问题<textarea value={text} onChange={e=>setText(e.target.value)} rows={4} disabled={busy} /></label>
    <p className="muted">请把“这个”“刚才那份”等指代补充清楚，后续会独立复核这个问题。</p>
    <p>资料范围：{scopeLabel(scope)}</p>
    <p className="notice">开启后先复核一次，之后资料变化时自动调用当前云模型，必要时自动联网搜索；供应商会收到回答所需内容，搜索继续经过隐私检查。新旧答案和变化说明保留在 NoteTrail，已保存的笔记不会自动改写。</p>
    <p className="muted">程序运行时自动处理，彻底退出后暂停。你可以随时暂停关注。</p>
    {error && <p role="alert">{error}</p>}
    <div className="row end"><button className="button secondary" disabled={busy} onClick={onClose}>取消</button>
      <button className="button" disabled={busy || !text.trim()} onClick={()=>void save()}>{busy?'正在开启…':'开启自动复核'}</button></div>
  </Dialog>;
}
export function WatchList({ watches, onOpen }: { watches: AnswerWatch[]; onOpen: (id:string)=>void }) {
  return <section className="watch-list" aria-label="持续关注的答案">
    {!watches.length && <p className="muted">在回答下点击“持续关注”，资料更新后会自动复核。</p>}
    {watches.map(w=><button className="watch-card" key={w.id} onClick={()=>onOpen(w.id)}>
      <strong>{w.question}</strong><span>{stateLabel[w.state]}{w.latestReview ? ` · ${reviewLabel[w.latestReview.kind]}`:''}</span>
      <small>{w.checkedAt ? `上次复核：${date(w.checkedAt)}`:'首次复核尚未完成'}</small>
    </button>)}
  </section>;
}
export function WatchPanel({ watch, sources, onChanged, onCitation, onSave, onContinue, onChecks, onRetrospective }: { watch: AnswerWatch; sources: Source[]; onChecks:(answer:AnswerRecord)=>void;
  onChanged:()=>void; onCitation:(target:CitationTarget)=>void; onSave:(answer:AnswerRecord)=>void; onContinue:(watch:AnswerWatch,answer:AnswerRecord)=>void;onRetrospective:(watch:AnswerWatch,answer:AnswerRecord)=>void }) {
  const [detail,setDetail]=useState<WatchDetail|null>(null),[tab,setTab]=useState<'answer'|'changes'|'history'>('answer');
  const [selected,setSelected]=useState<string|null>(null),[view,setView]=useState<AnswerView|null>(null),[previous,setPrevious]=useState<AnswerView|null>(null);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[run,setRun]=useState<Run|null>(null),[reload,setReload]=useState(0);
  const answerId=selected ?? watch.latestAnswerId;
  useEffect(()=>{
    let active=true;
    void data(window.notetrail.watch(watch.id)).then(d=>{if(active) setDetail(previous=>previous ? {...d,
      versions:[...new Map([...d.versions,...previous.versions].map(v=>[v.answerId,v])).values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.answerId.localeCompare(a.answerId)),
      nextCursor:previous.versions.length>=d.versions.length ? previous.nextCursor : d.nextCursor} : d);}).catch(e=>{if(active)setError(e.message);});
    return ()=>{active=false;};
  },[watch.id,watch.revision,watch.latestAnswerId,watch.runId,watch.state,reload]);
  useEffect(()=>{setRun(null);if(watch.runId)return watchRun(watch.runId,setRun,setError);},[watch.runId]);
  const version=detail?.versions.find(v=>v.answerId===answerId);
  useEffect(()=>{
    let active=true; setView(null);setPrevious(null);
    void data(window.notetrail.answer(answerId)).then(v=>{if(active)setView(v);}).catch(e=>{if(active)setError(e.message);});
    if(version?.previousAnswerId) void data(window.notetrail.answer(version.previousAnswerId)).then(v=>{if(active)setPrevious(v);}).catch(e=>{if(active)setError(e.message);});
    return ()=>{active=false;};
  },[answerId,version?.previousAnswerId,watch.state,reload]);
  async function toggle(enabled:boolean,retry=false) {
    setBusy(true);setError('');
    try { await data(window.notetrail.updateWatch(watch.id,{expectedRevision:watch.revision,enabled,...(retry ? {retry:true} : {})})); onChanged(); }
    catch(e){setError((e as Error).message);} finally{setBusy(false);}
  }
  async function more() {
    if(!detail?.nextCursor)return;setBusy(true);
    try { const next=await data(window.notetrail.watch(watch.id,detail.nextCursor));setDetail({...next,versions:[...detail.versions,...next.versions]}); }
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  const excerpt=(v:AnswerView,ids:string[]) => <Answer excerpt view={{...v,answer:{...v.answer,blocks:v.answer.blocks.filter(b=>ids.includes(b.id)),limitations:[]}}} sources={sources} onCitation={onCitation} onChecks={()=>onChecks(v.answer)}/>;
  return <section className="watch-panel" aria-label="关注答案与版本">
    <h2>{watch.question}</h2><p className="muted">范围：{scopeLabel(watch.scope)}</p>
    <p role="status">{stateLabel[watch.state]}{watch.checkedAt ? ` · 上次复核 ${date(watch.checkedAt)}`:''}</p>
    {watch.state!=='checked' && <p className="notice">当前显示的是已保存版本，尚未完成针对最新资料的复核。</p>}
    {watch.state==='checked' && watch.latestReview?.kind==='uncertain' && <p className="notice">本轮仍有未核查内容，不能视为已经确认当前结论。</p>}
    {watch.error && <p className="notice">{watch.error}</p>}{error && <p role="alert">{error}</p>}
    <div className="watch-actions"><button className="text-button" disabled={busy} onClick={()=>void toggle(!watch.enabled)}>{watch.enabled?'暂停关注':'恢复关注'}</button>
      {watch.enabled && (watch.state==='failed' || (watch.state==='checked' && watch.latestReview?.kind==='uncertain')) && <button className="text-button" disabled={busy} onClick={()=>void toggle(true,true)}>重试复核</button>}
      {watch.state==='updating' && watch.runId && <button className="text-button" disabled={busy} onClick={()=>{
        setBusy(true);void data(window.notetrail.cancel(watch.runId!)).then(()=>onChanged()).catch(e=>setError(e.message)).finally(()=>setBusy(false));
      }}>停止本轮</button>}
      <button className="text-button" onClick={()=>setReload(n=>n+1)}>重新核对引用</button>
    </div>
    <div className="watch-tabs" role="tablist" aria-label="答案版本视图">{(['answer','changes','history'] as const).map(t=><button key={t} role="tab"
      id={`watch-tab-${t}`} aria-selected={tab===t} aria-controls="watch-content" onClick={()=>setTab(t)}>{t==='answer'?'答案':t==='changes'?'变化说明':'历史版本'}</button>)}</div>
    <div id="watch-content" role="tabpanel" aria-labelledby={`watch-tab-${tab}`}>
      {selected && selected!==watch.latestAnswerId && <p className="notice">正在查看历史版本。<button className="text-button" onClick={()=>setSelected(null)}>返回最新版</button></p>}
      {tab==='history' ? <div className="watch-history">{detail?.versions.map(v=><button key={v.answerId} onClick={()=>{setSelected(v.answerId);setTab('answer');}}>
        <strong>{v.review ? reviewLabel[v.review.kind]:'原回答'}{v.answerId===watch.latestAnswerId?' · 最新保存版':''}</strong><small>{date(v.createdAt)}</small>
        {v.review && <span>{v.review.summary}</span>}</button>)}{detail?.nextCursor && <button disabled={busy} onClick={()=>void more()}>加载更早版本</button>}</div> :
        tab==='changes' ? <div className="watch-changes">{!version?.review ? <p>这是原回答，尚无版本变化说明。</p> : <>
          <h3>{reviewLabel[version.review.kind]}</h3><p>{version.review.summary}</p>
          {version.review.changes.map((c,i)=><article key={i}><p><strong>{c.explanation}</strong></p>
            {!!c.before.length && previous && <details><summary>上次的表述</summary>{excerpt(previous,c.before)}</details>}
            {!!c.after.length && view && <div><small>本轮表述与依据</small>{excerpt(view,c.after)}</div>}</article>)}
          <p className="muted">变化判断由模型生成，请结合引用核对；未发现变化不代表穷尽了所有资料。</p>
        </>}</div> : !view ? <p role="status">正在读取版本…</p> : <>
          <p className="muted">版本生成于 {date(view.answer.createdAt)}</p><Answer view={view} sources={sources} onCitation={onCitation} onChecks={()=>onChecks(view.answer)}/>
          <div className="watch-actions"><button className="text-button" onClick={()=>onSave(view.answer)}>选择并保存片段</button>
            <button className="text-button" onClick={()=>onContinue(watch,view.answer)}>基于此版本继续问</button><button className="text-button" onClick={()=>onRetrospective(watch,view.answer)}>根据此版本复盘</button></div>
        </>}
    </div>
    {run && <details className="watch-usage"><summary>最近复核任务与用量</summary><p>{runLabel(run)}</p><Usage run={run}/></details>}
  </section>;
}
