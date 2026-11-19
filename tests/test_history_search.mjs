import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { fixture, completed, response } from './fixtures/watched-answers.mjs';
import { createApp } from '../dist/server/app.js';
import { BrowserSession } from '../dist/server/session.js';
import { historyWindow } from '../dist/shared/chat.js';
import { requestRoute } from '../src/desktop/bridge.mjs';

test('search returns title, user text, and precise answer hits only while they are visible in the requested vault', { skip:process.platform !== 'darwin', timeout:30000 }, async t => {
  let f;
  f = await fixture(t, (body, round) => {
    if (round === 0) return response({ calls:[{ id:'read', name:'vault_read', arguments:{ sourceId:f.a.id, startLine:1, maxLines:2 } }] });
    const evidence = body.messages.filter(item => item.role === 'tool').map(item => JSON.parse(item.content)).find(item => item.ok && item.data.evidence).data.evidence;
    return response({ answer:{ outcome:'answered', blocks:[{ id:'b', kind:'grounded', markdown:evidence.excerpt.trim(), evidenceIds:[evidence.id] }], limitations:[] } });
  });
  fs.writeFileSync(path.join(f.vault, 'allowed/a.md'), '🧰蓝色工具箱在二号柜。\n');
  await f.vaults.scan(f.conversation.vaultId);
  const run = await completed(f, f.ask('要核对的记录 🗒️ NIGHT-4%_。'));
  assert.equal(run.state, 'succeeded', JSON.stringify(run.error));
  const vaultId = f.conversation.vaultId, message = f.conversations.messages(f.conversation.id, {}).items[0];
  const title = f.conversations.create({ vaultId, title:'蓝色工具箱 · 索引' });
  const search = (q, options = {}) => f.conversations.search({ vaultId, q, ...options });
  const hits = (await search('蓝色工具箱')).items;
  assert.equal(hits.length,2);
  assert.deepEqual(hits.find(item => item.sessionId === title.id).position,null);
  const answer = hits.find(item => item.sessionId === f.conversation.id);
  assert.deepEqual(answer.position,{ messageId:message.id, role:'assistant' });
  assert.equal(answer.snippet.before,'🧰');
  assert.equal(answer.snippet.match,'蓝色工具箱');
  assert.equal(answer.snippet.after,'在二号柜。');
  assert.deepEqual((await search('night-4%_')).items[0].position,{ messageId:message.id, role:'user' });
  assert.equal((await search('night-4%_')).items[0].snippet.match,'NIGHT-4%_');
  assert.equal((await search('NIGHT-4__')).items.length,0);

  assert.equal((await search('蓝色工具箱',{sessionId:f.conversation.id})).items[0].position.messageId,message.id);
  const first = await search('蓝色工具箱', { limit:'1' });
  assert(first.nextCursor);
  assert.notEqual((await search('蓝色工具箱',{ limit:'1', cursor:first.nextCursor })).items[0].sessionId,first.items[0].sessionId);
  await assert.rejects(() => search('蓝色工具箱',{ cursor:first.nextCursor.replace(vaultId,'v_'+randomUUID()) }),e => e.publicError.code==='BAD_REQUEST');
  await assert.rejects(() => search('蓝色工具箱',{ vaultId:'v_'+randomUUID() }),e => e.publicError.code==='NOT_FOUND');
  for (const q of ['', '\r', 'a'.repeat(121), ['蓝色工具箱']]) await assert.rejects(() => search(q),e => e.publicError.code==='BAD_REQUEST');

  const token = randomBytes(32).toString('base64url'), app = createApp(new BrowserSession(token),f.models,f.vaults,f.runs,f.questions);
  await app.listen({host:'127.0.0.1',port:0}); t.after(() => app.close());
  const origin = 'http://127.0.0.1:'+app.server.address().port;
  const route = requestRoute({ op:'searchHistory', vaultId, q:'NIGHT-4%_' });
  assert.equal(route.method,'GET');
  assert.equal((await fetch(origin+route.path)).status,401);
  const bootstrap = await fetch(origin+'/api/v1/bootstrap',{ method:'POST', headers:{ origin,'content-type':'application/json' }, body:JSON.stringify({token}) });
  const headers = { cookie:bootstrap.headers.get('set-cookie').split(';')[0] };
  const http = await fetch(origin+route.path,{headers});
  assert.equal(http.status,200); assert.equal((await http.json()).data.items[0].position.messageId,message.id);
  assert.throws(() => requestRoute({ op:'searchHistory', vaultId, q:'ok', path:'/other' }));
  const attempts = f.requests.length;

  const sourcePath = 'allowed/a.md';
  await f.vaults.update(vaultId,{ expectedRevision:f.vaults.get(vaultId).revision, exclusions:[sourcePath] });
  assert.deepEqual((await search('蓝色工具箱')).items.map(hit => hit.sessionId),[title.id]);
  assert.equal((await search('NIGHT-4%_')).items[0].position.messageId,message.id,'own submitted text stays searchable');
  assert.deepEqual((await search('蓝色工具箱',{sessionId:f.conversation.id})).items,[]);
  f.db.prepare("UPDATE conversations SET deletion_state='deleting' WHERE id=?").run(f.conversation.id);
  assert.deepEqual((await search('NIGHT-4%_')).items,[]);
  await f.runs.deleteSession(f.conversation.id);
  assert.deepEqual((await (await fetch(origin+route.path,{headers})).json()).data.items,[]);
  assert.equal(f.requests.length,attempts,'search never uses the model');
});

test('a search position keeps an old message in a bounded window, with an explicit return to the latest', () => {
  const messages = Array.from({length:200},() => ({ id:'msg_'+randomUUID() }));
  const first = historyWindow(messages,50,{ messageId:messages[13].id, role:'assistant' });
  assert.equal(first.items.length,50);
  assert.equal(first.items[13].id,messages[13].id);
  assert.equal(first.earlier,0); assert.equal(first.later,150);
  const middle = historyWindow(messages,50,{ messageId:messages[85].id, role:'user' });
  assert.equal(middle.items.length,50); assert(middle.items.includes(messages[85])); assert(middle.earlier>0&&middle.later>0);
  const latest = historyWindow(messages,50);
  assert.equal(latest.later,0); assert.equal(latest.items[0],messages[150]);
});
