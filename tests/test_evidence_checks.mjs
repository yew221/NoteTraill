import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, completed, response } from './fixtures/watched-answers.mjs';
import { isAnswerDraft } from '../dist/shared/answer.js';
import { inlineParts } from '../dist/shared/presentation.js';
import { issueMarkdown } from '../dist/shared/evidence-check.js';

const options={skip:process.platform!=='darwin',timeout:30000};
const checks = es => [{id:'i1',kind:'conflict',blockIds:['b1'],summary:'两个楼层记录需要核对',impact:'不能据此确认当前楼层',nextStep:'核对记录日期和同一工具箱',
  evidence:es.map(e=>({kind:'local',evidenceId:e.id,quote:e.excerpt.trim()}))}];
const draft = es => ({outcome:'answered',blocks:[{id:'b1',kind:'grounded',markdown:'工具箱的楼层尚待核对。',evidenceIds:[es[0].id]},
  {id:'b2',kind:'general',markdown:'写作时可以使用短句。',evidenceIds:[]}],limitations:[],checks:checks(es)});
const evidence = body => body.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content)).flatMap(r=>r.ok&&r.data.evidence?[r.data.evidence]:[]);
async function answerFixture(t){let f;f=await fixture(t,(body,n)=>n===0?response({calls:[f.a,f.b].map((s,i)=>({id:`read${i}`,name:'vault_read',arguments:{sourceId:s.id,startLine:1,maxLines:2}}))}):response({answer:draft(evidence(body))}));
  const run=await completed(f,f.ask());assert.equal(run.state,'succeeded',JSON.stringify(run.error));return{...f,run,answer:f.answers.stored(run.result.answerId)};}
function selection(a,text){const start=a.markdown.indexOf(text);assert(start>=0);return{expectedAnswerRevision:1,selection:{start,end:start+text.length,expectedText:text}};}
const context=f=>({runId:f.run.id,sessionId:f.conversation.id,vaultId:f.conversation.vaultId,scope:{mode:'selected',paths:['allowed/']},signal:new AbortController().signal,check(){}});

test('a combined factual claim about planned and completed work is returned for correction by source', options, async t => {
  let f, plan, done;
  f = await fixture(t, (body, round) => {
    if (round === 0) return response({ calls:[f.a,f.b].map((s,i) => ({ id:`read${i}`, name:'vault_read', arguments:{ sourceId:s.id,startLine:1,maxLines:2 } })) });
    if (round === 1) {
      const sources = evidence(body);
      plan = sources.find(e => e.excerpt.trim() === '计划访谈。');
      done = sources.find(e => e.excerpt.trim() === '访谈已完成。');
      if (!plan || !done) return response();
    }
    const claim = (id,markdown,evidenceIds) => ({ id,kind:'grounded',markdown,evidenceIds });
    if (round === 1) return response({ answer:{ outcome:'answered', blocks:[claim('both','两份材料均确认访谈已完成。',[plan.id,done.id])], limitations:[] } });
    return response({ answer:{ outcome:'answered', blocks:[
      claim('plan','计划记录只写计划访谈。',[plan.id]), claim('done','执行记录确认访谈已完成。',[done.id]),
      { id:'compare',kind:'inference',markdown:'两份材料反映了不同阶段。',evidenceIds:[plan.id,done.id] }
    ], limitations:[] } });
  });
  fs.writeFileSync(path.join(f.vault,'allowed/a.md'),'计划访谈。\n');
  fs.writeFileSync(path.join(f.vault,'allowed/b.md'),'访谈已完成。\n');
  await f.vaults.scan(f.conversation.vaultId);
  const run = await completed(f,f.ask('两份材料各自记录了哪些访谈进展？'));
  assert.equal(run.state,'succeeded',JSON.stringify(run.error));
  assert(plan && done, 'both original passages were read before validation');
  assert.equal(f.requests.length,3,'the faulty multi-source factual block triggered the existing correction path');
  const answer=f.answers.stored(run.result.answerId);
  assert.deepEqual(answer.blocks.slice(0,2).map(b => answer.citations.find(e => e.id===b.evidenceIds[0]).sourceId),[f.a.id,f.b.id]);
  assert.match(answer.citations.find(e => e.sourceId===f.b.id).excerpt,/访谈已完成/);
});

test('verbatim statements and explicit short quotes cannot link to the other passage of the same file', options, async t => {
  let f;
  f = await fixture(t, (body, round) => {
    if (round === 0) return response({ calls:[1,2].map(line => ({
      id:`line${line}`, name:'vault_read', arguments:{ sourceId:f.a.id, startLine:line, maxLines:1 }
    })) });
    const cites = evidence(body);
    return response({answer:{outcome:'answered',blocks:cites.map((e,index)=>({id:`b${index}`,kind:'grounded',
      markdown:e.excerpt.trim(),evidenceIds:[e.id],sourceQuote:{ evidenceId:e.id, quote:e.excerpt.trim() }})),limitations:[]}});
  });
  fs.writeFileSync(path.join(f.vault,'allowed/a.md'),'甲项目计划访谈。\n乙项目已完成访谈。\n');
  await f.vaults.scan(f.conversation.vaultId);
  const run = await completed(f,f.ask('逐项列出两个项目的访谈状态。'));
  assert.equal(run.state,'succeeded',JSON.stringify(run.error));
  const {blocks} = f.answers.stored(run.result.answerId);
  for (const variant of ['quote','literal','formatted','single']) {
    const swapped = blocks.map((block,index) => {
      const id=blocks[1-index].evidenceIds[0];
      return {...block,markdown:variant==='formatted'?`**${block.markdown}**`:block.markdown,evidenceIds:[id],
        sourceQuote:variant==='quote'?{ ...block.sourceQuote, evidenceId:id }:undefined};
    });
    await assert.rejects(f.answers.prepare({outcome:'answered',blocks:variant==='single'?swapped.slice(0,1):swapped,limitations:[]},context({...f,run})),
      error => error.publicError?.code==='CITATION_INVALID');
  }
});

test('checks validate their own current evidence and selection retains only relevant uncertainty',options,async t=>{
  const f=await answerFixture(t), a=f.answer;
  assert.equal(a.checkStatus,'reviewed');assert.equal(a.citations.length,2,'issue-only evidence is included');
  const saved=await f.answers.selection(a.id,selection(a,'工具箱的楼层尚待核对。'));
  assert.match(saved.text,/两个楼层记录/);assert.match(saved.text,/三楼/);assert.match(saved.text,/二楼/);assert.match(saved.text,/allowed\/b.md/);
  const other=await f.answers.selection(a.id,selection(a,'写作时可以使用短句。'));assert.doesNotMatch(other.text,/两个楼层记录|allowed\/b.md/);
  const quoted=await f.answers.selection(a.id,selection(a,'两个楼层记录需要核对'));assert.match(quoted.text,/allowed\/a.md/);
  const original=draft(a.citations);
  for(const change of [d=>d.checks[0].evidence[1].quote='未经读取的文字',d=>d.checks[0].evidence[1].evidenceId=`e_${randomUUID()}`,
    d=>d.checks[0].blockIds=['missing'],d=>d.checks[0].evidence[1].kind='web']){
    const bad=structuredClone(original);change(bad);await assert.rejects(f.answers.prepare(bad,context(f)),e=>e.publicError?.code==='CITATION_INVALID');
  }
  fs.writeFileSync(path.join(f.vault,'allowed/b.md'),'# 更新\n工具箱已搬走。');await f.vaults.scan(f.conversation.vaultId);
  await assert.rejects(f.answers.selection(a.id,selection(a,'工具箱的楼层尚待核对。')),e=>e.publicError?.code==='SOURCE_CHANGED');
  assert.deepEqual(f.answers.stored(a.id),a,'history is immutable');
});

test('runtime failure remains partial even when the model repeats the same limitation',options,async t=>{
  let f;f=await fixture(t,(body,n)=>n===0?response({calls:[{id:'missing',name:'vault_read',arguments:{sourceId:`s_${randomUUID()}`,startLine:1,maxLines:2}}]}):response({answer:{outcome:'insufficient_evidence',blocks:[{id:'b1',kind:'notice',markdown:'尚未完成核对。',evidenceIds:[]}],
    limitations:['本轮工具报告过读取失败、截断或覆盖限制；未返回的内容不能视为不存在。'],checks:[]}}));
  const run=await completed(f,f.ask());assert.equal(run.state,'succeeded',JSON.stringify(run.error));const a=f.answers.stored(run.result.answerId);
  assert.equal(a.checkStatus,'partial');assert(a.checks.some(i=>i.kind==='coverage'));
  assert.match((await f.answers.selection(a.id,selection(a,'尚未完成核对。'))).text,/未返回不等于不存在/);
});

test('legacy answers remain unchecked; pure knowledge answers are not forced to invent evidence gaps',options,async t=>{
  const f=await fixture(t,()=>response());
  const d={outcome:'answered',blocks:[{id:'b1',kind:'general',markdown:'一个稳定概念。',evidenceIds:[]}],limitations:[]};
  const c={runId:`r_${randomUUID()}`,sessionId:f.conversation.id,vaultId:f.conversation.vaultId,scope:{mode:'vault'},signal:new AbortController().signal,check(){}};
  assert.equal((await f.answers.prepare(d,c)).checkStatus,'not_checked');
  assert.equal((await f.answers.prepare({...d,checks:[]},c)).checkStatus,'not_applicable');
  const base={...d,checks:[{id:'x',kind:'gap',blockIds:['b1'],summary:'缺少记录',impact:'无法确认',nextStep:'补充资料',evidence:[]}]};
  assert(isAnswerDraft(base));assert(!isAnswerDraft({...base,checks:[{...base.checks[0],kind:'coverage'}]}));
  assert(!isAnswerDraft({...base,checks:[{...base.checks[0],kind:'conflict'}]}));
});

test('issue prose cannot manufacture clickable local citations',()=>{
  const link=`[资料 1](/api/v1/sources/s_${randomUUID()}/content?view=text&expectedVersion=${'a'.repeat(64)})`;
  const markdown=issueMarkdown({id:'x',kind:'gap',blockIds:['b1'],summary:link,impact:link,nextStep:link,evidence:[{kind:'local',evidenceId:`e_${randomUUID()}`,quote:link}]});
  assert.equal(inlineParts(markdown).filter(p=>p.kind==='link').length,0);
});

test('selecting the second identical issue keeps its own source',options,async t=>{
  const f=await answerFixture(t),d=draft(f.answer.citations);
  d.blocks[1]={id:'b2',kind:'grounded',markdown:'另一条有待核查的结论。',evidenceIds:[f.answer.citations[1].id]};
  d.checks=f.answer.citations.map((e,i)=>({id:`i${i}`,kind:'gap',blockIds:[`b${i+1}`],summary:'存在相同的文字',impact:'尚不能判断',nextStep:'补充日期',evidence:[{kind:'local',evidenceId:e.id,quote:'工具箱'}]}));
  const a={...await f.answers.prepare(d,context(f)),id:f.answer.id};
  f.db.prepare('UPDATE answers SET body_json=? WHERE id=?').run(JSON.stringify(a),a.id);
  const text='影响：尚不能判断',start=a.markdown.indexOf(text,a.markdown.indexOf(text)+1);assert(start>0);
  const saved=await f.answers.selection(a.id,{expectedAnswerRevision:1,selection:{start,end:start+text.length,expectedText:text}});
  assert.match(saved.text,/与选段有关的待核对事项/);assert.match(saved.text,/allowed\/b.md/);assert.doesNotMatch(saved.text,/allowed\/a.md/);
});

test('revoked issue source is not resent through a version follow-up',options,async t=>{
  const f=await answerFixture(t),at=f.requests.length;
  f.vaults.update(f.conversation.vaultId,{expectedRevision:f.vaults.get(f.conversation.vaultId).revision,exclusions:['allowed/b.md']});
  const ref=f.ask('请继续核对此版本的第 1 项待核对事项。',{basedOnAnswerId:f.answer.id});
  await completed(f,ref);
  assert(f.requests.length>at);const first=JSON.stringify(f.requests[at]);
  assert(!first.includes('事实乙'));assert(!first.includes('两个楼层记录需要核对'));
});


test('parsing a gap with omitted evidence means no source, while a conflict still requires two real excerpts',async()=>{
  const {parseAnswerDraft}=await import('../dist/shared/answer.js');
  const draft={outcome:'answered',blocks:[{id:'b1',kind:'general',markdown:'结果尚未提供。',evidenceIds:[]}],limitations:[],checks:[{id:'i1',kind:'gap',blockIds:['b1'],summary:'缺少结果',impact:'无法评价效果',nextStep:'补充结果记录'}]};
  assert.deepEqual(parseAnswerDraft(JSON.stringify(draft)).checks[0].evidence,[]);
  draft.checks[0].kind='conflict';assert.equal(parseAnswerDraft(JSON.stringify(draft)),null);
});
