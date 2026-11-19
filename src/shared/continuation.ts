import { hasFields, isId, type Id } from './contracts.js';
import type { AnswerBlock } from './answer.js';

export const resumeSections = { goal:'当时的目标', decisions:'已确认的决定', progress:'已报告的进展', stopping_point:'上次停点', open_questions:'尚未决定或验证', next_step:'现在可以怎么继续' };
export const resumeBases = { user_confirmed:'用户原话确认', user_reported:'用户报告，未独立验收', source_recorded:'资料记载', historical_answer:'历史模型判断', model_suggested:'模型建议', model_inferred:'模型推断，未证实', unknown:'尚未确认' };
export type MessageReference = { messageId:Id<'message'>; answerId?:never; role:'user'|'assistant'; quote:string } | {answerId:Id<'answer'>; messageId?:never; role:'assistant'; quote:string};
export type ResumeItem = { blockId:string; basis:keyof typeof resumeBases; messages:MessageReference[] };
export type ResumeDraft = { sections:Array<{kind:keyof typeof resumeSections; items:ResumeItem[]}> };
export type ResumeCoverage = { firstOrdinal:number|null; lastOrdinal:number|null; totalMessages:number; includedMessages:number; omittedMessages:number; omittedForAccess:number; omittedAnswers:number; through:string|null; generatedAt:string };
export const resumeRequestText=(progress='')=>'请根据这段对话生成续接说明。'+(progress.trim()?'\n我补充的当前进展：'+progress.trim():'');
export type ResumeContext = { messages:Array<{id:Id<'message'>; ordinal:number; createdAt:string; text:string;
  answer?:{id:Id<'answer'>; blocks:Array<Pick<AnswerBlock,'id'|'kind'|'markdown'>>}}>;
  purpose?:'resume'|'retrospective';
  selectedAnswer?:{id:Id<'answer'>;createdAt:string;blocks:Array<Pick<AnswerBlock,'id'|'kind'|'markdown'>>};
  requestedAnswer?:{id:Id<'answer'>;createdAt:string};
  selectedAnswerUnavailable?:true;
  coverage:ResumeCoverage };
export function isResumeDraft(value:unknown):value is ResumeDraft {
  return isConversationOutline(value,Object.keys(resumeSections));
}
export function isConversationOutline(value:unknown,sections:string[],versions=false):boolean {
  return hasFields(value,['sections']) && Array.isArray(value.sections) && value.sections.length===sections.length &&
    value.sections.every((section,index)=>hasFields(section,['kind','items']) && section.kind===sections[index] &&
      Array.isArray(section.items) && section.items.length>0 && section.items.length<=32 && section.items.every(item=>
        hasFields(item,['blockId','basis','messages']) && typeof item.blockId==='string' && /^[A-Za-z0-9_-]{1,64}$/.test(item.blockId) &&
        typeof item.basis==='string' && Object.hasOwn(resumeBases,item.basis) && Array.isArray(item.messages) && item.messages.length<=8 && item.messages.every(ref=>
          ((hasFields(ref,['messageId','role','quote']) && isId(ref.messageId,'message') && typeof ref.role==='string' && ['user','assistant'].includes(ref.role)) ||
            (versions && hasFields(ref,['answerId','role','quote']) && isId(ref.answerId,'answer') && ref.role==='assistant')) &&
          typeof ref.quote==='string' && !!ref.quote.trim() && ref.quote.length<=1200 && !/[\x00\ud800-\udfff]/u.test(ref.quote))));
}
export const plainMarkdown = (s:string) => s.replace(/[\\`*_{}\[\]()#<>!|]/g,'\\$&');
export function resumeLabel(resume:ResumeDraft|undefined,blockId:string):string {
  const section=resume?.sections.find(s=>s.items.some(i=>i.blockId===blockId)),item=section?.items.find(i=>i.blockId===blockId);
  return section && item ? `${resumeSections[section.kind]} · ${resumeBases[item.basis]}` : '';
}


export function resumeValidationErrors(blocks:AnswerBlock[],resume:{sections:Array<{kind:string;items:ResumeItem[]}>}|undefined,context:ResumeContext|undefined,workflow:'resume'|'retrospective'='resume'):string[] {
  const errors:string[]=[];
  if(!!resume!==!!context)return [workflow==='resume'?'仅本轮明确生成续接说明时输出 resume，且必须包含六栏。':'仅本轮明确复盘时输出 retrospective，且必须包含七栏。'];
  if(!resume || !context)return errors;
  const items=resume.sections.flatMap(s=>s.items),ids=items.map(i=>i.blockId);
  if(new Set(ids).size!==ids.length)errors.push('同一块只能归属一个栏位。');
  const ordered=blocks.filter(b=>ids.includes(b.id));
  if(items.length!==ordered.length || items.some((item,i)=>item.blockId!==ordered[i]?.id))errors.push('items 必须按 blocks 顺序列出真实块编号。');
  for(const block of blocks)if(block.kind!=='notice'&&!ids.includes(block.id))errors.push(`块 ${block.id} 缺少栏位及性质；只有独立 notice 运行说明可放在六栏之外。`);
  for(const item of items){
    const block=blocks.find(b=>b.id===item.blockId);if(!block)continue;
    if(['user_confirmed','user_reported'].includes(item.basis)&&!item.messages.some(r=>r.role==='user'))errors.push(`块 ${item.blockId} 必须引用用户原话。`);
    if(item.basis==='historical_answer'&&!item.messages.some(r=>r.role==='assistant'))errors.push(`块 ${item.blockId} 必须引用历史模型原话。`);
    if(item.basis==='source_recorded'&&!['grounded','web'].includes(block.kind))errors.push(`块 ${item.blockId} 的资料记载必须使用 grounded 或 web 及本轮证据。`);
    if(item.basis==='model_inferred' && !['general','inference','notice'].includes(block.kind))errors.push(`块 ${item.blockId} 的模型推断不能标作资料事实。`);
    for(const ref of item.messages){const entry=ref.messageId?context.messages.find(m=>m.id===ref.messageId):undefined;
      const valid=ref.answerId ? workflow==='retrospective' && context.selectedAnswer?.id===ref.answerId && context.selectedAnswer.blocks.some(b=>b.markdown.includes(ref.quote)) :
        entry && (ref.role==='user'?entry.text.includes(ref.quote):entry.answer?.blocks.some(b=>b.markdown.includes(ref.quote)));
      if(!valid)errors.push(`块 ${item.blockId} 的 ${ref.messageId??ref.answerId}/${ref.role} quote 不是原文连续子串；保留 Markdown 符号（如 **），或选更短逐字片段。`);
    }
  }
  return errors;
}
