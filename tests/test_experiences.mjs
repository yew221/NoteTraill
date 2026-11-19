import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import path from 'node:path';
import {createApp} from '../dist/server/app.js';
import {BrowserSession} from '../dist/server/session.js';
import {requestRoute} from '../src/desktop/bridge.mjs';
import {fixture,completed,response} from './fixtures/watched-answers.mjs';
import {experienceSections} from '../dist/shared/experiences.js';
import {parseAnswerDraft} from '../dist/shared/answer.js';

const options={skip:process.platform!=='darwin',timeout:30000};
function draft(evidence,two=false){
 const blocks=[],cases=[];
 for(let i=0;i<(two?2:1);i++){
  const title=`案例 ${i+1}`,sections=[];
  for(const kind of Object.keys(experienceSections)){
   const id=`c${i}_${kind}`,e=kind==='conditions'?evidence[1]:evidence[0];
   const grounded=['problem','conditions','action'].includes(kind);
   blocks.push({id,kind:grounded?'grounded':kind==='outcome'?'notice':'general',markdown:kind==='outcome'?'没有实际结果记录，不能判定成功。':kind==='lesson'?`经验 ${i+1}：仅供下一次小试点验证。`:grounded?e.excerpt.trim():`案例 ${i+1} 的 ${kind} 仍需核对。`,evidenceIds:grounded?[e.id]:[]});
   sections.push({kind,blockIds:[id]});
  }
  cases.push({title,sections});
 }
 return{outcome:'answered',blocks,limitations:[],experiences:{cases},checks:[{id:'gap',kind:'gap',blockIds:['c0_conditions'],summary:'适用规模尚不明确',impact:'不能扩大应用',nextStep:'补充规模和约束',evidence:[]}]};
}
async function setup(t,two=false){
 let firstDraft;const f=await fixture(t,(body,n)=>{
  if(n===0)return response({calls:[{id:'read_a',name:'vault_read',arguments:{sourceId:f.a.id,startLine:1,maxLines:2}},{id:'read_b',name:'vault_read',arguments:{sourceId:f.b.id,startLine:1,maxLines:2}}]});
  if(n>1)return response({answer:{outcome:'answered',blocks:[{id:'next',kind:'general',markdown:'先核对适用条件。',evidenceIds:[]}],limitations:[]}});
  const es=body.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content)).filter(x=>x.ok&&x.data.evidence).map(x=>x.data.evidence);
  firstDraft=draft(es,two);return response({answer:firstDraft});
 });
 const run=await completed(f,f.ask('找找过往经验',{action:'ask'}));assert.equal(run.state,'succeeded',JSON.stringify(run.error));
 return{...f,answer:f.answers.stored(run.result.answerId),draft:firstDraft};
}
function select(a,text){const start=a.markdown.indexOf(text);assert(start>=0);return{expectedAnswerRevision:1,selection:{start,end:start+text.length,expectedText:text}};}

test('saving one lesson keeps its whole case, uncertainty and sources without another case',options,async t=>{
 const f=await setup(t,true),a=f.answer;
 const s=await f.answers.selection(a.id,select(a,'经验 1：仅供下一次小试点验证。'));
 assert.match(s.text,/相关案例背景与适用边界/);assert.match(s.text,/可借鉴与需验证的部分 · 模型建议/);assert.match(s.text,/没有实际结果记录/);assert.match(s.text,/适用规模尚不明确/);
 assert.match(s.text,/资料 1：\[原资料\]/);assert.match(s.text,/资料 2：\[原资料\]/);assert.match(s.text,/allowed\/a.md/);assert.match(s.text,/allowed\/b.md/);assert(!s.text.includes('经验 2'));
 const before=f.requests.length,r=await completed(f,f.ask('继续比较',{action:'ask',basedOnAnswerId:a.id}));assert.equal(r.state,'succeeded');
 const sent=JSON.stringify(f.requests[before]);assert(sent.includes('experiences'));assert(sent.includes('conditions'));assert(sent.includes('lesson'));
});
test('a revoked source used only by an attached case condition still blocks saving',options,async t=>{
 const f=await setup(t);f.vaults.update(f.conversation.vaultId,{expectedRevision:f.vaults.get(f.conversation.vaultId).revision,exclusions:['allowed/b.md']});
 await assert.rejects(f.answers.selection(f.answer.id,select(f.answer,'经验 1：仅供下一次小试点验证。')),e=>['SOURCE_EXCLUDED','CONTEXT_CHANGED'].includes(e.publicError?.code));
});
test('case contracts reject missing fields, duplicate block attribution and unsupported historical claims',options,async t=>{
 const f=await setup(t),a=f.answer,ctx={runId:a.runId,sessionId:a.sessionId,vaultId:f.conversation.vaultId,scope:{mode:'selected',paths:['allowed/']},signal:new AbortController().signal,check(){}};
 for(const mutate of [d=>d.experiences.cases[0].sections.pop(),d=>d.experiences.cases[0].sections[1].blockIds=['c0_problem'],d=>d.experiences.cases[0].sections[1].blockIds=['missing'],d=>{d.blocks[0].kind='general';d.blocks[0].evidenceIds=[];}]){
  const d=structuredClone(f.draft);mutate(d);await assert.rejects(f.answers.prepare(d,ctx),e=>e.publicError?.code==='CITATION_INVALID');
 }
});
test('inline experience fields preserve labels and references and reject mixed or unknown metadata',()=>{
 const d=draft([{id:`e_${randomUUID()}`,excerpt:'原始案例'},{id:`e_${randomUUID()}`,excerpt:'适用条件'}]);
 const flat={...d,blocks:d.blocks.map(b=>({...b,experience:{caseTitle:'案例 1',section:d.experiences.cases[0].sections.find(s=>s.blockIds.includes(b.id)).kind}}))};delete flat.experiences;
 assert.deepEqual(parseAnswerDraft(JSON.stringify(flat)),d);
 assert.equal(parseAnswerDraft(JSON.stringify({...flat,experiences:d.experiences})),null);
 flat.blocks[0].experience.extra='not-allowed';assert.equal(parseAnswerDraft(JSON.stringify(flat)),null);
});
test('no matching experience stays an ordinary source-free answer',()=>{
 const d={outcome:'insufficient_evidence',blocks:[{id:'none',kind:'notice',markdown:'本轮没有找到匹配案例。',evidenceIds:[]}],limitations:[],experiences:{cases:[]}};
 assert.deepEqual(parseAnswerDraft(JSON.stringify(d)),d);
 d.experiences.cases=[{title:'虚构成功案例',sections:[]}];assert.equal(parseAnswerDraft(JSON.stringify(d)),null);
});

test('complete selection preview is authenticated, read only, and matches the eventual saved content',options,async t=>{
 const f=await setup(t),token=randomBytes(32).toString('base64url'),app=createApp(new BrowserSession(token),f.models,f.vaults,f.runs,f.questions);
 await app.listen({host:'127.0.0.1',port:0});t.after(()=>app.close());
 const origin=`http://127.0.0.1:${app.server.address().port}`,headers={origin,'content-type':'application/json'};
 const boot=await fetch(origin+'/api/v1/bootstrap',{method:'POST',headers,body:JSON.stringify({token})});headers.cookie=boot.headers.get('set-cookie').split(';')[0];
 const input=select(f.answer,'经验 1：仅供下一次小试点验证。'),route=requestRoute({op:'previewAnswerSelection',answerId:f.answer.id,input}),body=JSON.stringify(input);
 const count=f.db.prepare('SELECT count(*) n FROM runs').get().n;
 assert.equal((await fetch(origin+route.path,{method:'POST',headers:{'content-type':'application/json',origin},body})).status,401);
 assert.equal((await fetch(origin+route.path,{method:'POST',headers:{...headers,origin:'https://outside.invalid'},body})).status,403);
 const preview=await fetch(origin+route.path,{method:route.method,headers,body});assert.equal(preview.status,200);
 assert.deepEqual((await preview.json()).data,await f.answers.selection(f.answer.id,input));assert.equal(f.db.prepare('SELECT count(*) n FROM runs').get().n,count);
 assert.throws(()=>requestRoute({op:'previewAnswerSelection',answerId:f.answer.id,input:{...input,scope:{mode:'vault'}}}));
});

test('repair names the missing case field so the model can correct an incomplete comparison',options,async t=>{
 let feedback,attempts=0;
 const f=await fixture(t,(body,n)=>{
  if(n===0)return response({calls:[{id:'read_a',name:'vault_read',arguments:{sourceId:f.a.id,startLine:1,maxLines:2}},{id:'read_b',name:'vault_read',arguments:{sourceId:f.b.id,startLine:1,maxLines:2}}]});
  const es=body.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content)).filter(x=>x.ok&&x.data.evidence).map(x=>x.data.evidence);
  const d=draft(es);attempts++;if(attempts===1){d.blocks=d.blocks.filter(b=>b.id!=='c0_similarities').map(b=>({...b,experience:{caseTitle:'案例 1',section:d.experiences.cases[0].sections.find(s=>s.blockIds.includes(b.id)).kind}}));delete d.experiences;}else feedback=JSON.stringify(body);
  return response({answer:d});
 });
 const run=await completed(f,f.ask('找找过往经验',{action:'ask'}));assert.equal(run.state,'succeeded');assert.equal(attempts,2);assert(feedback.includes('similarities'));assert(feedback.includes('缺少'));
});

test('explicit comparison cannot silently return an unstructured answer',options,async t=>{
 let calls=0,repair;
 const f=await fixture(t,body=>{calls++;if(calls>1)repair=JSON.stringify(body);return response({answer:{outcome:'insufficient_evidence',blocks:[{id:'none',kind:'notice',markdown:'没有匹配案例。',evidenceIds:[]}],limitations:[],...(calls>1?{experiences:{cases:[]}}:{})}});});
 const run=await completed(f,f.ask('找找过往经验',{action:'ask',experienceComparison:true}));assert.equal(run.state,'succeeded');assert.equal(calls,2);assert(repair.includes('本轮需要案例对照'));
 assert.deepEqual(f.answers.stored(run.result.answerId).experiences,{cases:[]});
 assert.throws(()=>f.ask('不要改变模式',{experienceComparison:true}),e=>e.publicError?.code==='BAD_REQUEST');
});
