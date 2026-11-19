import { hasFields } from './contracts.js';
import type { AnswerBlock } from './answer.js';

export const experienceSections={problem:'当时的问题',conditions:'当时的条件',action:'实际做法',outcome:'后来结果',similarities:'与现在的相同点',differences:'与现在的差异',lesson:'可借鉴与需验证的部分'};
export type ExperienceCase={title:string;sections:Array<{kind:keyof typeof experienceSections;blockIds:string[]}>};
export type Experiences={cases:ExperienceCase[]};
const blockId=(s:unknown)=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(s);
export function isExperiences(value:unknown):value is Experiences{
  return hasFields(value,['cases'])&&Array.isArray(value.cases)&&value.cases.length<=4&&value.cases.every(c=>
    hasFields(c,['title','sections'])&&typeof c.title==='string'&&!!c.title.trim()&&c.title.length<=160&&!/[\x00\ud800-\udfff]/u.test(c.title)&&
    Array.isArray(c.sections)&&c.sections.length===7&&c.sections.every((s,i)=>hasFields(s,['kind','blockIds'])&&s.kind===Object.keys(experienceSections)[i]&&
      Array.isArray(s.blockIds)&&s.blockIds.length>0&&s.blockIds.length<=32&&s.blockIds.every(blockId)))&&
    new Set(value.cases.map(c=>c.title)).size===value.cases.length;
}
export function experienceErrors(blocks:AnswerBlock[],experience:Experiences|undefined):string[]{
  if(!experience)return[];
  const errors:string[]=[],ids=experience.cases.flatMap(c=>c.sections.flatMap(s=>s.blockIds));
  if(new Set(ids).size!==ids.length)errors.push('同一段不能同时属于多个案例或栏位。');
  for(const c of experience.cases){
    for(const section of c.sections)for(const id of section.blockIds){const b=blocks.find(b=>b.id===id);
      if(!b)errors.push(`案例栏目引用不存在的段落 ${id}。`);
      else if(['problem','conditions','action','outcome'].includes(section.kind)&&!['grounded','notice'].includes(b.kind))errors.push(`案例历史事实 ${id} 必须用本轮知识库原文或明确未知的 notice。`);
      else if(['similarities','differences','lesson'].includes(section.kind)&&!['inference','general','notice'].includes(b.kind))errors.push(`案例比较和建议 ${id} 必须区分为 inference（有引用的推断）、general（模型建议）或 notice（未知），不能标为原始事实。`);
    }
    if(!c.sections.find(s=>s.kind==='problem')!.blockIds.some(id=>blocks.find(b=>b.id===id)?.kind==='grounded'))errors.push('每个历史案例至少有一段问题来自本轮读取的原资料；找不到案例请返回空 cases。');
  }
  return errors;
}
export function experienceLabel(value:Experiences|undefined,id:string,kind?:AnswerBlock['kind']):string{
  const c=value?.cases.find(c=>c.sections.some(s=>s.blockIds.includes(id))),s=c?.sections.find(s=>s.blockIds.includes(id));
  const label=kind?{grounded:'资料记载',inference:'推断',general:'模型建议',notice:'说明 / 未知',web:'网页补充'}[kind]:'';
  return c&&s?`${c.title} · ${experienceSections[s.kind]}${label?' · '+label:''}`:'';
}
export const experiencePrompt='针对上面的问题，找找当前授权资料中的过往经验。分别核对当时的问题、条件、实际做法、后来结果、与现在的相同点和差异，以及可借鉴和需验证的部分。失败或未记录结果也请如实保留；同一案例的复制和 AI 整理不算多次验证。没有匹配案例就明确说明。';
