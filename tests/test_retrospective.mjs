import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,completed,response} from './fixtures/watched-answers.mjs';
import {retrospectiveRequestText,retrospectiveSections,retrospectiveNote} from '../dist/shared/retrospective.js';
import {parseAnswerDraft} from '../dist/shared/answer.js';
import {recordSource} from '../dist/server/context-sources.js';

const options={skip:process.platform!=='darwin',timeout:30000};
const ordinary={outcome:'answered',blocks:[{id:'b1',kind:'general',markdown:'建议以同一批五名新手试用，预期五人独立完成；尚未执行。',evidenceIds:[]}],limitations:[]};
function conversation(body){const text=body.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n'),mark='覆盖范围与原始记录：',at=text.indexOf(mark);return at<0?null:JSON.parse(text.slice(at+mark.length).split('\n')[0]);}
function retrospective(c){
 const blocks=[],first=c.messages[0],report=c.messages.findLast(m=>m.text.includes('实际做了试点'));
 const sections=Object.keys(retrospectiveSections).map((kind,i)=>{
  let basis='unknown',text='记录不足，无法确认。',messages=[];
  if(['judgment','expected'].includes(kind)){
   const old=c.selectedAnswer??first?.answer;
   if(old){basis='historical_answer';text='当时模型预期五人完成；只是原预期。';messages=[c.selectedAnswer?{answerId:old.id,role:'assistant',quote:old.blocks[0].markdown}:{messageId:first.id,role:'assistant',quote:old.blocks[0].markdown}];}
  }
  if(['action','outcome'].includes(kind)&&report){basis='user_reported';text=kind==='action'?'用户报告实际开展了试点。':'用户报告五人中两人完成、三人失败；尚未独立核验。';messages=[{messageId:report.id,role:'user',quote:report.text}];}
  if(['comparison','explanations'].includes(kind)){basis='model_inferred';text=kind==='comparison'?'是否可比仍须核对周期、样本和口径；不直接外推比例。':'可能的原因没有对照支持，不能证实因果。';}
  if(kind==='lesson'){basis='model_suggested';text='下次保留原条件和逐人记录；仅适用于同类试点，不能当作普遍效果。';}
  const blockId=`r${i}`;blocks.push({id:blockId,kind:basis==='unknown'?'notice':'general',markdown:text,evidenceIds:[]});return{kind,items:[{blockId,basis,messages}]};
 });return{outcome:'answered',blocks,limitations:['本次整理不能代替实际验收。'],checks:[],retrospective:{sections}};
}
async function setup(t,override){return fixture(t,(body,n,init)=>{const c=conversation(body);return override?.(body,n,init,c)??response({answer:c?retrospective(c):ordinary});});}
async function ask(f,text,extra={}){const run=await completed(f,f.ask(text,{action:'ask',...extra}));assert.equal(run.state,'succeeded',JSON.stringify(run.error));return f.answers.stored(run.result.answerId);}
const build=(f,note='',extra={})=>ask(f,retrospectiveRequestText(note),{workflow:'retrospective',...(note?{workflowNote:note}:{}),...extra});
const context=(f,a,c)=>({runId:a.runId,sessionId:a.sessionId,vaultId:f.conversation.vaultId,scope:{mode:'selected',paths:['allowed/']},signal:new AbortController().signal,check(){},conversation:c});

test('retrospective restores an exact historical answer, separates reported results, and saves all conditions',options,async t=>{
 const f=await setup(t),old=await ask(f,'先给五名新手设计试点。');
 await ask(f,'后来改为二十人Windows方案，但不要倒写原判断。');
 const at=f.requests.length,a=await build(f,'实际做了试点，五人中两人完成，三人失败。',{basedOnAnswerId:old.id}),c=conversation(f.requests[at]);
 assert.equal(a.retrospective.sections.length,7);assert.equal(c.selectedAnswer.id,old.id);assert.equal(a.retrospectiveBase.answerId,old.id);
 assert.equal(a.retrospective.sections[0].items[0].messages[0].answerId,old.id);
 assert.equal(a.retrospective.sections[3].items[0].basis,'user_reported');
 const lesson=a.blocks.at(-1).markdown,start=a.markdown.indexOf(lesson);
 const saved=await f.answers.selection(a.id,{expectedAnswerRevision:1,selection:{start,end:start+lesson.length,expectedText:lesson}});
 assert.match(saved.text,/复盘背景、实际结果与适用条件/);assert.match(saved.text,/三人失败/);assert.match(saved.text,/可能的原因没有对照支持/);assert.match(saved.text,/答案版本 a_/);assert.match(saved.text,/用户报告，未独立验收/);
 const second=await build(f);assert.notEqual(second.id,a.id);assert.deepEqual(f.answers.stored(a.id),a);assert.equal(second.resumeCoverage.totalMessages,3);
 assert.throws(()=>f.runs.watches.create(a.id,{expectedAnswerRevision:1,question:'自动复盘'}),e=>e.publicError?.code==='BAD_REQUEST');
});

test('missing action and result stay unknown; history alone is not execution evidence',options,async t=>{
 const f=await setup(t);await ask(f,'同意这个方案，但还没执行。');const a=await build(f);
 for(const kind of ['action','outcome'])assert.equal(a.retrospective.sections.find(s=>s.kind===kind).items[0].basis,'unknown');
 const at=f.requests.length;await ask(f,'基于复盘继续讨论，不执行。',{basedOnAnswerId:a.id});assert(JSON.stringify(f.requests[at]).includes('retrospective'));
});

test('blank form generations preserve the original business cutoff and selected-version provenance',options,async t=>{
 const f=await setup(t),old=await ask(f,'先出计划。'),when='2025-01-01T00:00:00.000Z';
 f.db.prepare('UPDATE messages SET created_at=? WHERE run_id=?').run(when,old.runId);
 const note=retrospectiveNote({problem:'',period:' ',action:'',outcome:''});assert.equal(note,'');
 const a=await build(f,note),b=await build(f,note);assert.equal(a.resumeCoverage.totalMessages,1);assert.equal(b.resumeCoverage.totalMessages,1);assert.equal(b.resumeCoverage.through,when);
 const at=f.requests.length,selected=await build(f,'',{basedOnAnswerId:old.id}),c=conversation(f.requests[at]),draft=retrospective(c);
 draft.retrospective.sections[0].items[0].messages=[{messageId:c.messages[0].id,role:'assistant',quote:c.messages[0].answer.blocks[0].markdown}];
 await assert.rejects(f.answers.prepare(draft,context(f,selected,c)),e=>e.publicError?.code==='CITATION_INVALID');
});

test('retrospective refuses forged version references, false roles and result provenance',options,async t=>{
 const f=await setup(t),old=await ask(f,'先出试点计划。'),at=f.requests.length,a=await build(f,'实际做了试点，五人中两人完成，三人失败。',{basedOnAnswerId:old.id}),c=conversation(f.requests[at]);
 for(const change of [d=>d.retrospective.sections[0].items[0].messages[0].answerId=`a_${randomUUID()}`,
   d=>d.retrospective.sections[0].items[0].messages[0].quote='已证明提升百分之百',
   d=>d.retrospective.sections[2].items[0].basis='historical_answer',
   d=>d.retrospective.sections[3].items[0].basis='user_confirmed',
   d=>d.retrospective.sections[5].items[0].basis='source_recorded',
   d=>d.retrospective.sections[3].items[0].messages=[],
   d=>d.retrospective.sections[0].items[0].messages[0].role='user']){
  const draft=retrospective(c);change(draft);await assert.rejects(f.answers.prepare(draft,context(f,a,c)),e=>e.publicError?.code==='CITATION_INVALID');
 }
 await assert.rejects(f.answers.prepare(retrospective(c),{...context(f,a,c),conversation:undefined}),e=>e.publicError?.code==='CITATION_INVALID');
 assert.throws(()=>f.ask('伪装记录',{action:'ask',workflow:'retrospective',workflowNote:'真实记录'}),e=>e.publicError?.code==='BAD_REQUEST');
});

test('inline retrospective normalization preserves exact provenance and rejects mixed or incomplete forms',()=>{
 const draft=retrospective({messages:[]}),inline={...draft,blocks:draft.blocks.map((b,i)=>({...b,retrospective:{section:draft.retrospective.sections[i].kind,...draft.retrospective.sections[i].items[0]}}))};
 for(const b of inline.blocks)delete b.retrospective.blockId;delete inline.retrospective;
 assert.deepEqual(parseAnswerDraft(JSON.stringify(inline)),draft);
 const missing=structuredClone(inline);missing.blocks.pop();assert.equal(parseAnswerDraft(JSON.stringify(missing)),null);
 inline.retrospective=draft.retrospective;assert.equal(parseAnswerDraft(JSON.stringify(inline)),null);
 const bad=structuredClone(draft);bad.retrospective.sections[0].items[0].basis=['user_reported'];assert.equal(parseAnswerDraft(JSON.stringify(bad)),null);
});

test('revoked selected history is absent from model traffic and is visibly unavailable',options,async t=>{
 const f=await setup(t,(body,n,init,c)=>!c?response({answer:{...ordinary,blocks:[{...ordinary.blocks[0],markdown:'PRIVATE_RETRO_CANARY 历史判断'}]}}):undefined);
 const old=await ask(f,'旧项目，先出计划。');recordSource(f.db,old.runId,f.a);
 f.vaults.update(f.conversation.vaultId,{expectedRevision:f.vaults.get(f.conversation.vaultId).revision,exclusions:['allowed/a.md']});
 const at=f.requests.length,a=await build(f,'实际做了试点，五人中两人完成，三人失败。',{basedOnAnswerId:old.id});
 assert(!JSON.stringify(f.requests.slice(at)).includes('PRIVATE_RETRO_CANARY'));assert.equal(a.retrospectiveBase.available,false);assert.equal(a.checkStatus,'partial');
 assert.match(a.markdown,/未带入该版本正文/);assert.equal(a.resumeCoverage.omittedMessages,1);
 assert.equal(a.retrospective.sections.find(s=>s.kind==='outcome').items[0].basis,'user_reported');
 const text=a.blocks.at(-1).markdown,start=a.markdown.indexOf(text);
 const saved=await f.answers.selection(a.id,{expectedAnswerRevision:1,selection:{start,end:start+text.length,expectedText:text}});
 assert.match(saved.text,/三人失败/);assert(!saved.text.includes('PRIVATE_RETRO_CANARY'));
});

test('source withdrawal during retrospective prevents a subsequent outbound call or publication',options,async t=>{
 let f,revoked=false;
 f=await setup(t,(body,n,init,c)=>{if(!c)return;
  if(!revoked){revoked=true;fs.writeFileSync(path.join(f.vault,'allowed/a.md'),'changed before retry');return response({calls:[{id:'find',name:'vault_search',arguments:{terms:['工具箱']}}]});}
  throw Error('revoked context reached another outbound call');
 });
 const old=await ask(f,'先出计划。');recordSource(f.db,old.runId,f.a);const at=f.requests.length;
 const run=await completed(f,f.ask(retrospectiveRequestText(),{action:'ask',workflow:'retrospective',basedOnAnswerId:old.id}));
 assert.equal(run.state,'failed');assert.equal(f.requests.length-at,1);assert.equal(f.db.prepare('SELECT count(*) n FROM answers WHERE run_id=?').get(run.id).n,0);
});

test('revoked historical dependencies block saving even when selected lesson has no direct citation',options,async t=>{
 const f=await setup(t),old=await ask(f,'先出计划。');recordSource(f.db,old.runId,f.a);const a=await build(f,'实际做了试点，五人中两人完成，三人失败。',{basedOnAnswerId:old.id});
 fs.unlinkSync(path.join(f.vault,'allowed/a.md'));await f.vaults.scan(f.conversation.vaultId);
 const text=a.blocks.at(-1).markdown,start=a.markdown.indexOf(text);
 await assert.rejects(f.answers.selection(a.id,{expectedAnswerRevision:1,selection:{start,end:start+text.length,expectedText:text}}),e=>['SOURCE_MISSING','CONTEXT_CHANGED','SOURCE_CHANGED'].includes(e.publicError?.code));
});

test('cancel and idempotent retry do not publish a partial retrospective or create duplicate work',options,async t=>{
 let entered,release;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
 const f=await setup(t,async(body,n,init,c)=>{if(c){entered();await gate;}return response({answer:c?retrospective(c):ordinary});});
 await ask(f,'先出计划。');const key=randomUUID(),input={action:'ask',workflow:'retrospective'},ref=f.ask(retrospectiveRequestText(),input,key);
 assert.deepEqual(f.ask(retrospectiveRequestText(),input,key),ref);await ready;f.runs.cancel(ref.runId);release();
 const run=await completed(f,ref);assert.equal(run.state,'cancelled');assert.equal(f.db.prepare('SELECT count(*) n FROM answers WHERE run_id=?').get(run.id).n,0);
 const retried=f.ask(retrospectiveRequestText(),input,key);assert.equal(retried.runId,ref.runId);assert.equal(retried.state,'cancelled');
});

test('ordinary follow-up repairs an accidentally repeated retrospective structure',options,async t=>{
 let follow=false,attempts=0,feedback='';
 const f=await setup(t,(body,n,init,c)=>{if(!follow||c)return;
  attempts++;if(attempts===1)return response({answer:retrospective({messages:[]})});
  feedback=JSON.stringify(body);return response({answer:ordinary});
 });
 await ask(f,'先出计划。');const a=await build(f);follow=true;
 const result=await ask(f,'继续讨论其中的建议。',{basedOnAnswerId:a.id});
 assert.equal(attempts,2);assert.equal(result.retrospective,undefined);assert.match(feedback,/仅本轮明确复盘时输出 retrospective/);
});

test('an oversized selected version cannot re-enter through the larger conversation snapshot',options,async t=>{
 const canary='LARGE_OMITTED_VERSION '+ '旧'.repeat(17000);
 const f=await setup(t,(body,n,init,c)=>!c?response({answer:{...ordinary,blocks:[{...ordinary.blocks[0],markdown:canary}]}}):undefined);
 const old=await ask(f,'记录一段长历史。'),at=f.requests.length,a=await build(f,'',{basedOnAnswerId:old.id});
 assert.equal(a.retrospectiveBase.available,false);assert(a.resumeCoverage.omittedAnswers>0);
 assert(!JSON.stringify(f.requests.slice(at)).includes('LARGE_OMITTED_VERSION'));
 assert.equal(f.answers.stored(old.id).blocks[0].markdown,canary);
});
