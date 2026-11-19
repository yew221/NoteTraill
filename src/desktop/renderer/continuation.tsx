import { useEffect, useState } from 'react';
import type { Answer as AnswerRecord, AnswerView } from '../../shared/answer.js';
import type { Source } from '../../shared/vault.js';
import type { Message } from '../../shared/chat.js';
import { data } from './api.js';
import { Answer, type CitationTarget, type MessageTarget } from './answers.js';
import { retrospectiveNote } from '../../shared/retrospective.js';

export function MessagePanel({target}:{target:MessageTarget}){
  const [record,setRecord]=useState<{message?:Message;ordinal?:number;view?:AnswerView}|null>(null),[error,setError]=useState('');
  useEffect(()=>{let active=true;setRecord(null);setError('');
    if(target.answerId){void data(window.notetrail.answer(target.answerId)).then(view=>{if(view.answer.sessionId!==target.sessionId)throw new Error('答案不属于这段对话。');if(active)setRecord({view});}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};}
    void data(window.notetrail.messageReference(target.sessionId,target.messageId)).then(async record=>{
      const view=target.role==='assistant'&&record.message.answerId?await data(window.notetrail.answer(record.message.answerId)):undefined;
      if(active)setRecord({...record,view});
    }).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};
  },[target.sessionId,target.messageId,target.answerId,target.role]);
  return <section className="checks-panel" aria-label="对话原话"><h2>{target.role==='user'?'用户原话':'历史模型表述'}</h2>
    <p className="muted">{target.role==='user'?'用户表达的目标、决定或进展；业务执行结果仍需相应材料验证。':'当时的模型判断，不是用户确认或现实结果的证明。'}</p>
    {error&&<p role="alert">{error}</p>}{record?<><p>{target.answerId?'选定答案版本':`第 ${record.ordinal} 条消息`} · {new Date(record.view?.answer.createdAt??record.message!.createdAt).toLocaleString('zh-CN')}</p>
      <blockquote className="message-proof">{target.quote}</blockquote><details open><summary>完整原始记录</summary><pre className="source-text">{target.role==='user'?record.message?.text:record.view?.answer.blocks.map(b=>b.markdown).join('\n\n')??'原回答不可用'}</pre></details></>:!error&&<p role="status">正在读取原始记录…</p>}
  </section>;
}
export function ResumePanel({results,sources,busy,onGenerate,onCitation,onChecks,onMessage,onContinue,onSave,purpose='resume',base,scopeLabel,onScope}:{results:AnswerView[];sources:Source[];busy:boolean;purpose?:'resume'|'retrospective';base?:AnswerRecord;scopeLabel?:string;onScope?:()=>void;
  onGenerate:(progress:string)=>Promise<void>;onCitation:(target:CitationTarget)=>void;onChecks:(answer:AnswerRecord)=>void;onMessage:(target:MessageTarget)=>void;
  onContinue:(answer:AnswerRecord,index:number)=>void;onSave:(answer:AnswerRecord)=>void}){
  const [progress,setProgress]=useState(''),[selected,setSelected]=useState<string|null>(null),[error,setError]=useState('');
  const [report,setReport]=useState({problem:'',period:'',action:'',outcome:''});
  const retrospective=purpose==='retrospective',label=retrospective?'结果复盘':'续接思路';
  const view=results.find(v=>v.answer.id===(selected??results[0]?.answer.id));
  async function generate(){setError('');try{const note=retrospective?retrospectiveNote(report):progress;
    await onGenerate(note);setProgress('');setSelected(null);}catch(e){setError((e as Error).message);}}
  return <section className="checks-panel" aria-label={label}><h2>{label}</h2><p className="muted">{retrospective?'将当时判断、实际行动与后续结果放在一起核对。可以补充记录或从当前资料中查找；缺少时保留未知，不把建议当实施。':'整理这段对话的目标、明确决定、已报告进展和停点。'}只在你点击时生成；原聊天草稿和附件会保留。</p>
    {retrospective?<><p className="notice">{base?`当时判断：选定 ${new Date(base.createdAt).toLocaleString('zh-CN')} 的答案版本。`:'当时判断：从本段对话的原始记录还原。'}初始沿用原资料范围，可选择后来新增的结果记录；调整不会改动聊天草稿。</p>
      <button className="text-button" disabled={busy} onClick={onScope}>复盘资料：{scopeLabel}</button>
      {Object.entries({problem:'复盘问题',period:'时间范围',action:'实际采取的行动',outcome:'后来观察到的结果'}).map(([key,title])=><label className="field" key={key}>{title}<textarea rows={2} maxLength={600} value={report[key as keyof typeof report]} disabled={busy} placeholder="可留空；缺少的记录会列为待补充" onChange={e=>setReport(r=>({...r,[key]:e.target.value}))}/></label>)}</>:
      <label className="field">补充当前进展（可选）<textarea rows={3} value={progress} maxLength={3000} disabled={busy} onChange={e=>setProgress(e.target.value)}/></label>}
    <button className="button secondary" disabled={busy} onClick={()=>void generate()}>{busy?'正在处理…':(view?'重新生成':'生成')+label}</button>
    {error&&<p role="alert">{error}</p>}
    {results.length>0&&<label className="field">已保存的{label}版本<select value={selected??results[0].answer.id} onChange={e=>setSelected(e.target.value)}>
      {results.map(v=><option key={v.answer.id} value={v.answer.id}>{new Date(v.answer.createdAt).toLocaleString('zh-CN')}</option>)}</select></label>}
    <p className="muted">更早版本仍在原对话历史中；这里列出当前已加载的版本。</p>
    {view&&<><Answer view={view} sources={sources} onCitation={onCitation} onChecks={()=>onChecks(view.answer)} onMessage={onMessage}/>
      <div className="watch-actions">{(view.answer.resume??view.answer.retrospective)?.sections.find(s=>s.kind===(retrospective?'lesson':'next_step'))?.items.map((item,i)=><button key={item.blockId} className="text-button" onClick={()=>onContinue(view.answer,view.answer.blocks.findIndex(b=>b.id===item.blockId))}>从建议 {i+1} 继续</button>)}
        <button className="text-button" onClick={()=>onSave(view.answer)}>选择并保存片段</button></div></>}
  </section>;
}
