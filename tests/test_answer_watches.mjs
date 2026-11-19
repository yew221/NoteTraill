import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, completed, response } from './fixtures/watched-answers.mjs';
import { RunService } from '../dist/server/runs.js';
import { backupData, restoreData } from '../dist/server/maintenance.js';
import { openStorage } from '../dist/server/storage.js';
import { randomUUID, randomBytes } from 'node:crypto';
import { createApp } from '../dist/server/app.js';
import { BrowserSession } from '../dist/server/session.js';
import { requestRoute } from '../src/desktop/bridge.mjs';

const options = { skip: process.platform !== 'darwin', timeout: 30000 };
function reviewContext(body) {
  const system = body.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const marker = '历史及变化线索：', start = system.indexOf(marker);
  return start < 0 ? null : JSON.parse(system.slice(start+marker.length).split('\n')[0]);
}
function model(body) {
  const results = body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content)).filter(r => r.ok);
  const search = results.find(r => r.data.matches), evidence = results.flatMap(r => r.data.evidence ? [{ ...r.data.evidence, sourceId:r.data.source.sourceId }] : []);
  if (!search && !evidence.length) return response({ calls: [{ id: 'search', name: 'vault_search', arguments: { terms: ['工具箱'] } }] });
  const unread = [...new Set((search?.data.matches ?? []).map(m => m.sourceId))].filter(id => !evidence.some(e => e.sourceId === id));
  if (unread.length) return response({ calls: unread.slice(0,10).map((id,i) => ({ id: `read_${i}`, name: 'vault_read', arguments: { sourceId: id, startLine: 1, maxLines: 20 } })) });
  const blocks = evidence.length ? evidence.map((e,i) => ({ id: `b${i}`, kind: 'grounded', markdown: e.excerpt.trim(), evidenceIds: [e.id] })) :
    [{ id: 'none',kind: 'notice',markdown: '本轮未找到工具箱资料。', evidenceIds: [] }];
  const context = reviewContext(body);
  const same = context && context.previous.map(b => b.markdown).join('') === blocks.map(b => b.markdown).join('');
  return response({ answer: { outcome: evidence.length ? 'answered' : 'insufficient_evidence', blocks, limitations: [],
    ...(context ? { review: { kind: !context.comparisonAvailable || !evidence.length ? 'uncertain' : same ? 'unchanged' : 'changed',
      summary: same ? '本轮未发现需修改的事实。' : '根据本轮原文重新核对工具箱位置。',
      changes: [{ before: context.previous.map(b => b.id), after: blocks.map(b => b.id), explanation: '对应原文位置与当前答案，保留具体记录。' }] } } : {}) } });
}
async function start(t, override, scope) {
  let f;
  f = await fixture(t,(body,round,init) => override?.(body,round,init,f) ?? model(body));
  const first = await completed(f,f.ask('工具箱目前在哪里？',scope?{scope}:{})); assert.equal(first.state,'succeeded',JSON.stringify(first.error));
  const original = f.answers.stored(first.result.answerId);
  const watch = f.runs.watches.create(original.id,{ question:'工具箱目前在哪里？',expectedAnswerRevision:1 });
  return { ...f, watch, original };
}
async function update(f) {
  await f.vaults.scan(f.conversation.vaultId);
  const now = Date.now(); f.runs.watches.reconcile(now); f.runs.watches.reconcile(now+31000);
  const watch = f.runs.watches.get(f.watch.id); assert(watch.runId,'a changed catalog should schedule a review');
  const run = await completed(f,{ runId:watch.runId });
  return { run, watch:f.runs.watches.get(f.watch.id) };
}

test('watched answers preserve chat, publish fresh evidence, deduplicate scans, and keep version history',options,async t => {
  const f = await start(t), before = f.conversations.get(f.conversation.id);
  let r = await update(f); assert.equal(r.run.state,'succeeded',JSON.stringify(r.run.error));
  assert.equal(r.watch.latestReview.kind,'unchanged');
  fs.writeFileSync(path.join(f.vault,'allowed/new.md'),'# 新登记\n工具箱新增登记在五楼，旧记录仍待复核。\n');
  r = await update(f); assert.equal(r.run.state,'succeeded',JSON.stringify(r.run.error));
  assert.equal(r.watch.latestReview.kind,'changed');
  const view = await f.answers.get(r.watch.latestAnswerId); assert.match(view.answer.markdown,/五楼/);
  assert(view.citationStatus.every(s => s.status === 'current'));
  assert.deepEqual(f.answers.stored(f.original.id),f.original);
  assert.equal(f.conversations.messages(f.conversation.id,{}).items.length,1);
  assert.equal(f.conversations.get(f.conversation.id).activeSegmentId,before.activeSegmentId);
  assert.equal(f.runs.watches.detail(f.watch.id).versions.length,3);
  const requests=f.requests.length; f.runs.watches.reconcile(Date.now()+100000);
  await new Promise(r=>setTimeout(r,40)); assert.equal(f.requests.length,requests);
});

test('excluded old evidence never returns through review context; scoped additions stay outside',options,async t => {
  const f=await start(t); await update(f);
  const at=f.requests.length;
  fs.writeFileSync(path.join(f.vault,'other/new.md'),'工具箱绝密地址应不被读取。');
  f.vaults.update(f.conversation.vaultId,{expectedRevision:f.vaults.get(f.conversation.vaultId).revision,exclusions:['allowed/a.md']});
  const r=await update(f); assert.equal(r.run.state,'succeeded',JSON.stringify(r.run.error));
  assert.equal(r.watch.latestReview.kind,'uncertain');
  const sent=JSON.stringify(f.requests.slice(at)); assert(!sent.includes('旧事实甲')); assert(!sent.includes('绝密地址'));
  assert(f.requests.slice(at).every(b=>reviewContext(b)?.previous.length===0));
});

test('deleted source marks uncertainty while historical snapshots survive',options,async t => {
  const f=await start(t); await update(f); fs.unlinkSync(path.join(f.vault,'allowed/a.md'));
  const at=f.requests.length,r=await update(f); assert.equal(r.run.state,'succeeded',JSON.stringify(r.run.error));
  assert.equal(r.watch.latestReview.kind,'uncertain'); assert(!JSON.stringify(f.requests.slice(at)).includes('旧事实甲'));
  assert.match(f.answers.stored(f.original.id).markdown,/旧事实甲/);
});

test('experience review keeps its structure when prior content is revoked',options,async t=>{
  const f=await start(t,async body=>{
    const raw=await model(body).text();
    const payload=JSON.parse(raw.split('\n')[0].slice(6));
    const content=payload.choices?.[0]?.delta?.content;
    if(!content) return new Response(raw,{headers:{'content-type':'text/event-stream'}});
    const answer=JSON.parse(content);answer.experiences={cases:[]};
    return response({answer});
  });
  f.vaults.update(f.conversation.vaultId,{expectedRevision:f.vaults.get(f.conversation.vaultId).revision,exclusions:['allowed/a.md']});
  const at=f.requests.length,r=await update(f);
  assert.equal(r.run.state,'succeeded',JSON.stringify(r.run.error));
  for(const body of f.requests.slice(at)) {
    const context=reviewContext(body);assert.equal(context.experienceComparison,true);
    assert.equal(context.comparisonAvailable,false);assert.deepEqual(context.previous,[]);
    assert.equal(context.previousExperiences,undefined);
    assert(!JSON.stringify(body).includes('旧事实甲'));
  }
  assert.deepEqual(f.answers.stored(r.watch.latestAnswerId).experiences,{cases:[]});
});

test('pause cancels queued updates, persists opt-out, and re-enable checks the latest catalog',options,async t => {
  const f=await start(t); let w=f.runs.watches.patch(f.watch.id,{expectedRevision:1,enabled:false});
  fs.writeFileSync(path.join(f.vault,'allowed/new.md'),'工具箱新增在九楼。');
  await f.vaults.scan(f.conversation.vaultId); const calls=f.requests.length;
  f.runs.watches.reconcile(Date.now()+31000); assert.equal(f.requests.length,calls); assert.equal(f.runs.watches.get(w.id).state,'paused');
  assert.throws(()=>f.runs.watches.patch(w.id,{expectedRevision:1,enabled:true}),e=>e.publicError?.code==='REVISION_CONFLICT');
  f.runs.watches.patch(w.id,{expectedRevision:w.revision,enabled:true});
  const r=await update(f); assert.equal(r.run.state,'succeeded',JSON.stringify(r.run.error));
  assert.match(f.answers.stored(r.watch.latestAnswerId).markdown,/九楼/);
});

test('generation changed during inference cannot publish a stale latest answer',options,async t => {
  let changed=false;
  const f=await start(t,async(body,_round,_init,current)=>{
    if(reviewContext(body) && !changed) { changed=true; fs.writeFileSync(path.join(current.vault,'allowed/a.md'),'工具箱已搬到新楼。'); await current.vaults.scan(current.conversation.vaultId); }
    return model(body);
  });
  const r=await update(f); assert.equal(r.run.state,'failed'); assert.equal(r.watch.latestAnswerId,f.original.id);
  assert.equal(f.runs.watches.detail(f.watch.id).versions.length,1);
});

test('completed review snapshots survive backup/restore and deletion removes subscriptions',options,async t=>{
  const f=await start(t); const r=await update(f); assert.equal(r.run.state,'succeeded',JSON.stringify(r.run.error));
  await f.stop(); f.storage.close();
  const backup=path.join(f.directory,'backup'),restore=path.join(f.directory,'restored');
  backupData(f.storage.directory,backup); restoreData(backup,restore);
  const restored=openStorage(restore); assert.equal(restored.db.prepare('SELECT count(*) AS n FROM answer_watches').get().n,1);
  assert.equal(restored.db.prepare('SELECT count(*) AS n FROM answer_watch_runs WHERE answer_id IS NOT NULL').get().n,1); restored.close();
});

test('deleting a conversation removes watched versions but preserves model accounting',options,async t=>{
  const f=await start(t), id=f.conversation.id, initial=f.conversations.deletionImpact(id);
  assert.deepEqual(initial,{watches:1,versions:1});
  const firstCheck=f.runs.watches.get(f.watch.id).runId;
  if (!firstCheck) f.runs.watches.reconcile(Date.now()+31000);
  await assert.rejects(f.runs.deleteSession(id,initial),e=>e.publicError.code==='SESSION_BUSY');
  assert(f.runs.watches.get(f.watch.id).enabled);
  const run=await completed(f,{runId:f.runs.watches.get(f.watch.id).runId}), watch=f.runs.watches.get(f.watch.id);
  assert.equal(run.state,'succeeded',JSON.stringify(run.error));
  const attempts=f.db.prepare('SELECT count(*) AS n FROM model_attempts').get().n;
  await assert.rejects(f.runs.deleteSession(id,initial),e=>e.publicError.code==='REVISION_CONFLICT');
  await assert.rejects(f.runs.deleteSession(id),e=>e.publicError.code==='REVISION_CONFLICT');
  assert(f.runs.watches.get(f.watch.id).enabled);
  f.runs.watches.patch(f.watch.id,{expectedRevision:watch.revision,enabled:false});
  const current=f.conversations.deletionImpact(id);assert.deepEqual(current,{watches:1,versions:2});
  assert.equal(f.runs.watches.detail(f.watch.id).versions.length,current.versions);
  const other = f.conversations.create({vaultId:f.conversation.vaultId});
  assert.deepEqual(f.conversations.deletionImpact(other.id),{watches:0,versions:0});
  await f.runs.deleteSession(id,current);
  assert.deepEqual(await f.runs.deleteSession(id,current),{deleted:true});
  assert.deepEqual(await f.runs.deleteSession(f.conversation.id),{deleted:true});
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM answer_watches').get().n,0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM answer_watch_runs').get().n,0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM model_attempts').get().n,attempts);
});

test('A to B to A creates a new observation instead of replaying an earlier paid run',options,async t=>{
  const f=await start(t),file=path.join(f.vault,'allowed/a.md'),original=fs.readFileSync(file);
  const a=await update(f); assert.equal(a.run.state,'succeeded');
  fs.writeFileSync(file,'工具箱在十楼。');const b=await update(f);assert.equal(b.run.state,'succeeded');
  fs.writeFileSync(file,original);const again=await update(f);assert.equal(again.run.state,'succeeded');
  assert.notEqual(again.run.id,a.run.id);assert.notEqual(again.run.id,b.run.id);
  assert.match(f.answers.stored(again.watch.latestAnswerId).markdown,/三楼/);
});

test('memory revocation immediately stops further review requests',options,async t=>{
  let memory,requestsAfterDeletion=0,deleted=false;
  const f=await start(t,(body,_n,_init,current)=>{
    if(deleted)requestsAfterDeletion++;
    if(reviewContext(body) && !deleted){current.questions.memories.delete(memory.id,memory.revision);deleted=true;}
    return model(body);
  });
  memory=f.questions.memories.create({vaultId:f.conversation.vaultId,text:'偏好合成标记 MEMORY_REVOKED_PUBLIC',category:'preference'},randomUUID());
  const r=await update(f);assert.notEqual(r.run.state,'succeeded');assert(deleted);assert.equal(requestsAfterDeletion,0);
});

test('legacy inherited facts are revoked for both automatic review and explicit version follow-ups',options,async t=>{
  const f=await start(t,(body)=>{
    const last=body.messages.findLast(m=>m.role==='user');const text=typeof last?.content==='string'?last.content:JSON.stringify(last?.content);
    if(text?.includes('复述上一题') && !reviewContext(body))return response({answer:{outcome:'answered',blocks:[{id:'b0',kind:'general',markdown:'旧事实甲：工具箱在三楼。',evidenceIds:[]}],limitations:[]}});
    return model(body);
  });
  f.runs.watches.patch(f.watch.id,{expectedRevision:1,enabled:false});
  const second=await completed(f,f.ask('复述上一题'));assert.equal(second.state,'succeeded');
  // Simulate an answer created before inherited dependencies were recorded on each new run.
  f.db.prepare('DELETE FROM context_sources WHERE run_id=?').run(second.id);
  const lookup = { vaultId:f.conversation.vaultId, q:'旧事实甲' };
  assert.equal((await f.conversations.search(lookup)).items[0].position.role,'assistant');
  f.watch=f.runs.watches.create(second.result.answerId,{question:'工具箱目前在哪里？',expectedAnswerRevision:1});
  fs.unlinkSync(path.join(f.vault,'allowed/a.md'));const at=f.requests.length;
  const r=await update(f);assert.equal(r.run.state,'succeeded',JSON.stringify(r.run.error));
  assert(!JSON.stringify(f.requests.slice(at)).includes('旧事实甲'));
  assert.deepEqual((await f.conversations.search(lookup)).items,[],'history search also rejects revoked inherited facts');
  const before=f.requests.length,follow=await completed(f,f.ask('现在再查一下',{basedOnAnswerId:second.result.answerId}));
  assert.equal(follow.state,'succeeded',JSON.stringify(follow.error));
  assert(!JSON.stringify(f.requests.slice(before)).includes('旧事实甲'));
});

test('queued reviews resume as new work after restart without replaying a started request',options,async t=>{
  const f=await start(t);f.runs.watches.reconcile(Date.now()+31000);
  const queued=f.runs.watches.get(f.watch.id).runId;assert(queued);assert.equal(f.runs.get(queued).state,'queued');
  await f.runs.close();f.runs=new RunService(f.db,f.vaults,f.ingestions,f.questions);
  try {const r=await update(f);assert.equal(r.run.state,'succeeded',JSON.stringify(r.run.error));assert.notEqual(r.run.id,queued);
    assert.equal(f.runs.get(queued).state,'interrupted');}
  finally{await f.runs.close();}
});

test('saved descendants cannot trigger or become evidence for their own watched answer',options,async t=>{
  const f=await start(t,undefined,{mode:'vault'});const r=await update(f);assert.equal(r.run.state,'succeeded');
  const answer=f.answers.stored(r.watch.latestAnswerId),before=f.requests.length;
  const saved=await completed(f,await f.runs.saveAnswer(answer.id,{expectedAnswerRevision:1,selection:{start:0,end:answer.markdown.length,expectedText:answer.markdown}},randomUUID()));
  assert.equal(saved.state,'succeeded',JSON.stringify(saved.error));
  assert(f.runs.watches.ignoredSources(f.watch.id).includes(saved.result.sourceId));
  await f.vaults.scan(f.conversation.vaultId);f.runs.watches.reconcile();f.runs.watches.reconcile(Date.now()+31000);
  assert.equal(f.requests.length,before);assert.equal(f.runs.watches.get(f.watch.id).latestAnswerId,answer.id);
});

test('a cancelled observation can return to the same content and still be reviewed',options,async t=>{
  let entered,hold=true;const started=new Promise(r=>{entered=r;});
  const f=await start(t,async(body,_n,init)=>{
    if(reviewContext(body) && hold){hold=false;entered();await new Promise((_r,reject)=>{
      if(init.signal.aborted)reject(init.signal.reason);else init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});
    });}
    return model(body);
  });
  const file=path.join(f.vault,'allowed/a.md'),original=fs.readFileSync(file);
  f.runs.watches.reconcile(Date.now()+31000);const first=f.runs.watches.get(f.watch.id).runId;await started;
  fs.writeFileSync(file,'工具箱在临时楼。');await f.vaults.scan(f.conversation.vaultId);f.runs.watches.reconcile();
  const cancelled=await completed(f,{runId:first});assert.equal(cancelled.state,'cancelled');
  fs.writeFileSync(file,original);const r=await update(f);assert.equal(r.run.state,'succeeded',JSON.stringify(r.run.error));
  assert.notEqual(r.run.id,first);
});

test('watch HTTP and named desktop capabilities validate scope, origin, revisions and duplicate creation',options,async t=>{
  const f=await start(t),token=randomBytes(32).toString('base64url');
  const app=createApp(new BrowserSession(token),f.models,f.vaults,f.runs,f.questions);
  await app.listen({host:'127.0.0.1',port:0});t.after(()=>app.close());
  const origin=`http://127.0.0.1:${app.server.address().port}`,headers={origin,'content-type':'application/json'};
  const boot=await fetch(origin+'/api/v1/bootstrap',{method:'POST',headers,body:JSON.stringify({token})});
  const cookie=boot.headers.get('set-cookie').split(';')[0];headers.cookie=cookie;
  assert.equal((await fetch(origin+`/api/v1/watches/${f.watch.id}`)).status,401);
  assert.equal((await fetch(origin+`/api/v1/watches/${f.watch.id}`,{method:'PATCH',headers:{...headers,origin:'https://outside.invalid'},body:JSON.stringify({expectedRevision:1,enabled:false})})).status,403);
  const create=requestRoute({op:'watchAnswer',answerId:f.original.id,input:{question:f.watch.question,expectedAnswerRevision:1}});
  const result=await fetch(origin+create.path,{method:create.method,headers,body:JSON.stringify(create.body)});
  assert.equal(result.status,200);assert.equal((await result.json()).data.id,f.watch.id);
  assert.throws(()=>requestRoute({op:'watchAnswer',answerId:f.original.id,input:{question:'x',expectedAnswerRevision:1,scope:{mode:'vault'}}}));
  const list=requestRoute({op:'watches',vaultId:f.conversation.vaultId});
  assert.equal((await (await fetch(origin+list.path,{headers})).json()).data.items.length,1);
  const patch=requestRoute({op:'updateWatch',watchId:f.watch.id,input:{expectedRevision:1,enabled:false}});
  assert.equal((await fetch(origin+patch.path,{method:patch.method,headers,body:JSON.stringify(patch.body)})).status,200);
  assert.equal((await fetch(origin+patch.path,{method:patch.method,headers,body:JSON.stringify(patch.body)})).status,409);
  assert.equal((await fetch(origin+`/api/v1/watches/${f.watch.id}?cursor=bad`,{headers})).status,400);
  const impactRoute=requestRoute({op:'deletionImpact',sessionId:f.conversation.id});
  const impact=(await (await fetch(origin+impactRoute.path,{headers})).json()).data;
  assert.deepEqual(impact,{watches:1,versions:1});
  const confirm=requestRoute({op:'deleteSession',sessionId:f.conversation.id,expected:impact});
  assert.equal((await fetch(origin+confirm.path,{method:'DELETE',headers,body:JSON.stringify({watches:0,versions:0})})).status,409);
  assert.throws(()=>requestRoute({op:'deleteSession',sessionId:f.conversation.id,expected:{watches:1,versions:0}}));
  assert.equal((await fetch(origin+confirm.path,{method:'DELETE',headers,body:JSON.stringify(confirm.body)})).status,200);
});

test('source revocation between model turns stops the next outbound request immediately',options,async t=>{
  let removed=false,after=0;
  const f=await start(t,async(body,_n,_init,current)=>{
    if(removed)after++;
    if(reviewContext(body) && !removed){removed=true;fs.unlinkSync(path.join(current.vault,'allowed/a.md'));await current.vaults.scan(current.conversation.vaultId);}
    return model(body);
  });
  const r=await update(f);assert.notEqual(r.run.state,'succeeded');assert(removed);assert.equal(after,0);
});

test('explicit retry can recover an uncertain review without requiring another file edit',options,async t=>{
  const f=await start(t);const first=await update(f);assert.equal(first.run.state,'succeeded');
  const w=f.runs.watches.get(f.watch.id);f.runs.watches.patch(w.id,{expectedRevision:w.revision,enabled:true,retry:true});
  const second=await update(f);assert.equal(second.run.state,'succeeded');assert.notEqual(first.run.id,second.run.id);
});

for (const mode of ['dns-retry','web-tool']) test(`source revocation blocks each actual outbound ${mode} attempt`,options,async t=>{
  let removed=false,after=0;
  const f=await start(t,async(body,_n,_init,current)=>{
    if(removed){after++;return body.query ? new Response(JSON.stringify({results:[]})) : response();}
    if(reviewContext(body)){
      fs.unlinkSync(path.join(current.vault,'allowed/a.md'));await current.vaults.scan(current.conversation.vaultId);
      assert.equal(current.vaults.source(current.a.id).state,'missing');removed=true;
      if(mode==='dns-retry')throw new TypeError('Synthetic confirmed-unsent DNS failure',{
        cause:{code:'EAI_AGAIN',syscall:'getaddrinfo',hostname:'api.deepseek.com'},
      });
      return response({calls:[{id:'web_after_revocation',name:'web_search',arguments:{query:'JavaScript Promise specification',reason:'查证公开概念'}}]});
    }
    return model(body);
  });
  const r=await update(f);assert(removed,'the source must actually be revoked during inference');
  assert.equal(after,0);assert.equal(r.run.state,'failed');assert.equal(r.run.error.code,'CONTEXT_CHANGED');
  assert.deepEqual(f.db.prepare('SELECT state FROM model_attempts WHERE run_id=? ORDER BY ordinal').all(r.run.id).map(a=>a.state),
    mode==='dns-retry'?['not_sent','not_sent']:['settled']);
  assert.deepEqual(f.db.prepare('SELECT state FROM search_attempts WHERE run_id=?').all(r.run.id).map(a=>a.state),
    mode==='web-tool'?['not_sent']:[]);
});

test('an unavailable vault visibly invalidates the last checked status and recovers when restored',options,async t=>{
  const f=await start(t),r=await update(f);assert.equal(r.run.state,'succeeded');assert.equal(r.watch.state,'checked');
  const moved=f.vault+'-temporarily-unavailable';fs.renameSync(f.vault,moved);
  try{
    await assert.rejects(f.vaults.scan(f.conversation.vaultId),e=>e.publicError?.code==='SOURCE_MISSING');
    assert.equal(f.vaults.get(f.conversation.vaultId).discovery.state,'failed');
    const unavailable=f.runs.watches.get(f.watch.id);assert.equal(unavailable.state,'failed');assert(unavailable.error);
    assert.equal(unavailable.latestAnswerId,r.watch.latestAnswerId);
  }finally{fs.renameSync(moved,f.vault);}
  await f.vaults.scan(f.conversation.vaultId);f.runs.watches.reconcile();
  const recovered=f.runs.watches.get(f.watch.id);assert.equal(recovered.state,'checked');assert.equal(recovered.error,null);
});
