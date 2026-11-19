import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fixture,completed,response} from './fixtures/watched-answers.mjs';
import {resumeRequestText,resumeSections} from '../dist/shared/continuation.js';
import {resumeContext} from '../dist/server/continuation.js';
import {readRoute} from '../src/desktop/bridge.mjs';

const options={skip:process.platform!=='darwin',timeout:30000};
function conversation(body){const text=body.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n'),mark='覆盖信息及原始记录：',at=text.indexOf(mark);return at<0?null:JSON.parse(text.slice(at+mark.length).split('\n')[0]);}
const ordinary={outcome:'answered',blocks:[{id:'b1',kind:'general',markdown:'建议先做一次试点，尚未确认执行。',evidenceIds:[]}],limitations:[]};
function resume(context){
  const first=context.messages[0],decision=context.messages.find(m=>m.text.includes('确认先做')),progress=context.messages.findLast(m=>m.text.includes('已做一次'));
  const blocks=[],sections=Object.keys(resumeSections).map((kind,i)=>{
    let text='尚无足够记录确认。',basis='unknown',messages=[];
    const quote=(entry,role,text)=>({messageId:entry.id,role,quote:text});
    if(kind==='goal'&&first){basis='user_confirmed';text='用户希望验证方案。';messages=[quote(first,'user',first.text)];}
    if(kind==='decisions'&&decision){basis='user_confirmed';text='确认先做 A 方案，但没有由确认本身证明执行。';messages=[quote(decision,'user','确认先做 A 方案，但还没开始执行。')];}
    if(kind==='progress'&&progress){basis='user_reported';text='用户报告已做一次试点，结果尚未整理，未独立验收。';messages=[quote(progress,'user','已做一次试点，结果还未整理。')];}
    if(kind==='open_questions'&&first?.answer){basis='historical_answer';text='当时模型建议试点，不能作为已完成的证明。';messages=[quote(first,'assistant',first.answer.blocks[0].markdown)];}
    if(kind==='next_step'){basis='model_suggested';text='建议补充实际试点结果记录，再决定下一步。';}
    const blockId=`b${i}`;blocks.push({id:blockId,kind:basis==='unknown'?'notice':'general',markdown:text,evidenceIds:[]});return{kind,items:[{blockId,basis,messages}]};
  });return{outcome:'answered',blocks,limitations:[],checks:[],resume:{sections}};
}
async function setup(t,override){return fixture(t,(body,n,init)=>{const c=conversation(body);return override?.(body,n,init,c)??response({answer:c?resume(c):ordinary});});}
async function ask(f,text,extra={}){const run=await completed(f,f.ask(text,{action:'ask',...extra}));assert.equal(run.state,'succeeded',JSON.stringify(run.error));return f.answers.stored(run.result.answerId);}
async function build(f,note=''){return ask(f,resumeRequestText(note),{workflow:'resume',...(note?{workflowNote:note}:{})});}

test('resume cites original users and historical model separately, keeps versions and saves provenance',options,async t=>{
  const f=await setup(t);await ask(f,'我想验证方案，先出计划。');await ask(f,'确认先做 A 方案，但还没开始执行。');
  const original=f.conversations.messages(f.conversation.id,{}).items;
  const a=await build(f,'已做一次试点，结果还未整理。');assert.equal(a.resume.sections.length,6);assert.equal(a.resumeCoverage.totalMessages,3);
  const decisions=a.resume.sections.find(s=>s.kind==='decisions').items[0],progress=a.resume.sections.find(s=>s.kind==='progress').items[0];
  assert.equal(decisions.basis,'user_confirmed');assert.equal(decisions.messages[0].messageId,original[1].id);assert.equal(progress.basis,'user_reported');
  const text='用户报告已做一次试点，结果尚未整理，未独立验收。',start=a.markdown.indexOf(text);
  const saved=await f.answers.selection(a.id,{expectedAnswerRevision:1,selection:{start,end:start+text.length,expectedText:text}});
  assert.match(saved.text,/用户报告，未独立验收/);assert.match(saved.text,/已做一次试点，结果还未整理/);assert.match(saved.text,/对话依据与性质/);
  const second=await build(f);assert.notEqual(second.id,a.id);assert.deepEqual(f.answers.stored(a.id),a);assert.equal(second.resumeCoverage.totalMessages,3,'automatic requests do not masquerade as business history');
  const beforeFollow=f.requests.length;await ask(f,'请根据这份续接说明继续讨论。',{basedOnAnswerId:a.id});
  const follow=JSON.stringify(f.requests[beforeFollow]);assert(follow.includes('user_reported'));assert(follow.includes('已做一次试点，结果还未整理。'));
  assert.throws(()=>f.runs.watches.create(a.id,{expectedAnswerRevision:1,question:'续接'}),e=>e.publicError?.code==='BAD_REQUEST');
  const ref=f.conversations.reference(f.conversation.id,original[0].id);assert.equal(ref.message.text,original[0].text);
  const other=f.conversations.create({vaultId:f.conversation.vaultId});assert.throws(()=>f.conversations.reference(other.id,original[0].id),e=>e.publicError?.code==='NOT_FOUND');
  assert.equal(readRoute({op:'messageReference',sessionId:f.conversation.id,messageId:original[0].id}),`/api/v1/sessions/${f.conversation.id}/messages/${original[0].id}`);
});

test('empty generation request does not move business cutoff or read Pi synthetic user messages',options,async t=>{
  const f=await setup(t),a=await ask(f,'我想验证方案，先出计划。');const old='2025-01-03T00:00:00.000Z';f.db.prepare('UPDATE messages SET created_at=? WHERE run_id=?').run(old,a.runId);
  const row=f.db.prepare('SELECT session_file FROM session_segments WHERE id=?').get(f.conversations.get(f.conversation.id).activeSegmentId);
  fs.appendFileSync(path.join(f.storage.directory,row.session_file),JSON.stringify({type:'message',id:'synthetic',message:{role:'user',content:'PI_FAKE_CONFIRMED_DONE'}})+'\n');
  const before=f.requests.length,result=await build(f);assert.equal(result.resumeCoverage.through,old);assert.equal(result.resumeCoverage.totalMessages,1);
  assert.notEqual(result.resumeCoverage.generatedAt,old);assert(!JSON.stringify(f.requests.slice(before)).includes('PI_FAKE_CONFIRMED_DONE'));
  const c=conversation(f.requests[before]);assert.equal(c.messages.length,1);assert(!c.messages[0].text.includes('生成续接说明'));
});

test('resume rejects forged roles, quotes, cross-message attribution and missing block classification',options,async t=>{
  const f=await setup(t);await ask(f,'我想验证方案，先出计划。');const at=f.requests.length,a=await build(f),c=conversation(f.requests[at]);
  const ctx={runId:a.runId,sessionId:a.sessionId,vaultId:f.conversation.vaultId,scope:{mode:'selected',paths:['allowed/']},signal:new AbortController().signal,check(){},conversation:c};
  for(const change of [d=>d.resume.sections[0].items[0].messages[0].role='assistant',d=>d.resume.sections[0].items[0].messages[0].quote='已经正式验收通过',
    d=>d.resume.sections[0].items[0].messages[0].messageId=`m_${randomUUID()}`,d=>d.resume.sections[1].items[0].blockId='b0',d=>d.resume.sections[0].items[0].messages=[]]){
    const d=resume(c);change(d);await assert.rejects(f.answers.prepare(d,ctx),e=>e.publicError?.code==='CITATION_INVALID');
  }
  await assert.rejects(f.answers.prepare(resume(c),{...ctx,conversation:undefined}),e=>e.publicError?.code==='CITATION_INVALID');
  assert.throws(()=>f.ask('假的原始进展',{action:'ask',workflow:'resume',workflowNote:'真进展'}),e=>e.publicError?.code==='BAD_REQUEST');
});

test('scope withdrawal omits old user text and model answer and explains incomplete coverage',options,async t=>{
  const f=await setup(t);await ask(f,'私有项目标记 PRIVATE_RESUME_CANARY，先出计划。');
  f.vaults.update(f.conversation.vaultId,{expectedRevision:f.vaults.get(f.conversation.vaultId).revision,exclusions:['allowed/a.md']});
  const at=f.requests.length,a=await build(f);assert(!JSON.stringify(f.requests.slice(at)).includes('PRIVATE_RESUME_CANARY'));
  assert.equal(a.resumeCoverage.includedMessages,0);assert.equal(a.resumeCoverage.omittedMessages,1);assert.equal(a.resumeCoverage.through,null);
  assert.equal(a.checkStatus,'partial');assert(a.checks.some(i=>i.kind==='coverage'));
});

test('snapshot validates each identical source version once across a long Pi segment',options,async t=>{
  const f=await setup(t);const a=await ask(f,'我想验证方案，先出计划。'),segment=f.conversations.get(f.conversation.id).activeSegmentId;
  const {recordSource}=await import('../dist/server/context-sources.js');recordSource(f.db,a.runId,f.a);
  for(let i=0;i<30;i++){
    const runId=`r_${randomUUID()}`,now=new Date().toISOString();f.db.exec('BEGIN');
    f.db.prepare("INSERT INTO runs(id,kind,vault_id,state,created_at,started_at,session_id) VALUES (?,'message',?,'succeeded',?,?,?)").run(runId,f.conversation.vaultId,now,now,f.conversation.id);
    f.conversations.register(runId,f.conversation.id,{text:`用户记录 ${i}`,scope:{mode:'selected',paths:['allowed/']},action:'ask'});
    f.db.prepare('UPDATE messages SET segment_id=? WHERE run_id=?').run(segment,runId);recordSource(f.db,runId,f.a);f.db.exec('COMMIT');
  }
  const current=f.db.prepare('SELECT * FROM messages ORDER BY ordinal DESC LIMIT 1').get(),read=f.vaults.content.bind(f.vaults);let reads=0;
  f.vaults.content=(...args)=>{reads++;return read(...args);};
  const result=await resumeContext(f.db,f.vaults,current,f.conversation.vaultId,{mode:'selected',paths:['allowed/']},new AbortController().signal,()=>{});
  assert.equal(result.context.messages.length,31);assert.equal(reads,1);
});

test('an interrupted resume never becomes a successful saved version',options,async t=>{
  let entered,release;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
  const f=await setup(t,async(body,n,init,c)=>{if(c){entered();await gate;}return response({answer:c?resume(c):ordinary});});
  await ask(f,'我想验证方案，先出计划。');const ref=f.ask(resumeRequestText(),{action:'ask',workflow:'resume'});await ready;f.runs.cancel(ref.runId);release();
  const run=await completed(f,ref);assert.equal(run.state,'cancelled');assert.equal(f.db.prepare('SELECT count(*) n FROM answers WHERE run_id=?').get(run.id).n,0);
});


test('resume repair identifies an inexact historical Markdown quote without weakening validation',options,async t=>{
  let attempts=0,feedback;
  const f=await setup(t,(body,n,init,c)=>{
    if(!c)return response({answer:{...ordinary,blocks:[{...ordinary.blocks[0],markdown:'先**确认范围**再执行。'}]}});
    const draft=resume(c);attempts++;
    if(attempts===1)draft.resume.sections.find(s=>s.kind==='open_questions').items[0].messages[0].quote='先确认范围再执行。';
    else feedback=JSON.stringify(body);
    return response({answer:draft});
  });
  await ask(f,'先讨论范围。');const a=await build(f);assert.equal(attempts,2);assert(feedback.includes('messageReferenceErrors'));assert(feedback.includes('Markdown'));
  assert.equal(a.resume.sections.find(s=>s.kind==='open_questions').items[0].messages[0].quote,'先**确认范围**再执行。');
});


test('standalone runtime notice is allowed but unclassified factual prose is rejected',options,async t=>{
 const f=await setup(t);await ask(f,'先讨论方案。');const at=f.requests.length,a=await build(f),c=conversation(f.requests[at]);
 const ctx={runId:a.runId,sessionId:a.sessionId,vaultId:f.conversation.vaultId,scope:{mode:'selected',paths:['allowed/']},signal:new AbortController().signal,check(){},conversation:c};
 const d=resume(c);d.blocks.push({id:'extra',kind:'notice',markdown:'本轮未读取资料。',evidenceIds:[]});await f.answers.prepare(d,ctx);
 d.blocks.at(-1).kind='general';await assert.rejects(f.answers.prepare(d,ctx),e=>e.publicError?.code==='CITATION_INVALID');
});


test('inline continuation metadata is normalized without inventing provenance or allowing missing sections',async()=>{
 const {parseAnswerDraft}=await import('../dist/shared/answer.js');
 const context={messages:[],coverage:{}},draft=resume(context);
 const flat={...draft,blocks:draft.blocks.map(block=>{const section=draft.resume.sections.find(s=>s.items.some(i=>i.blockId===block.id)),item=section.items[0];return{...block,resume:{section:section.kind,basis:item.basis,messages:item.messages}};})};delete flat.resume;
 assert.deepEqual(parseAnswerDraft(JSON.stringify(flat)),draft);
 flat.blocks.pop();assert.equal(parseAnswerDraft(JSON.stringify(flat)),null);
});

test('ordinary follow-up after resume repairs an all-notice answered response without inventing evidence',options,async t=>{
 let follow=false,attempts=0;
 const f=await setup(t,(body,n,init,c)=>{
  if(!follow)return response({answer:c?resume(c):ordinary});
  attempts++;
  if(attempts===1)return response({answer:{...ordinary,blocks:[{...ordinary.blocks[0],kind:'notice',markdown:'用户报告目标改为查明原因，原因尚未确定。'}]}});
  const text=JSON.stringify(body);assert(text.includes('outcome=answered 不能只有 notice'));assert(text.includes('不要通过伪造资料引用修复'));
  return response({answer:{...ordinary,blocks:[{...ordinary.blocks[0],markdown:'用户报告目标改为查明原因，原因尚未确定。'}]}});
 });
 await ask(f,'我想验证方案，先出计划。');await build(f);follow=true;
 const a=await ask(f,'现在改为查清失败原因，尚不能归因。');assert.equal(attempts,2);assert.equal(a.blocks[0].kind,'general');assert.equal(a.resume,undefined);assert.deepEqual(a.citations,[]);
});


test('non-string provenance enums cannot bypass confirmation checks in either model format',async()=>{
 const {parseAnswerDraft}=await import('../dist/shared/answer.js');
 for(const field of ['basis','role'])for(const inline of [false,true]){
  const d=resume({messages:[],coverage:{}}),item=d.resume.sections[0].items[0];
  item.basis=field==='basis'?['user_confirmed']:'user_confirmed';item.messages=field==='role'?[{messageId:`msg_${randomUUID()}`,role:['user'],quote:'伪造确认'}]:[];
  if(inline){d.blocks=d.blocks.map(block=>{const s=d.resume.sections.find(s=>s.items.some(i=>i.blockId===block.id)),i=s.items[0];return{...block,resume:{section:s.kind,basis:i.basis,messages:i.messages}};});delete d.resume;}
  assert.equal(parseAnswerDraft(JSON.stringify(d)),null);
 }
});
