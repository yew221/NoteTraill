import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import ts from 'typescript';
import { newId } from '../dist/server/contracts.js';

// Exercise the renderer's actual command/polling code without Electron or a network/model request.
const source = fs.readFileSync(new URL('../src/desktop/renderer/api.ts', import.meta.url), 'utf8')
  .replace('../../shared/contracts.js', new URL('../dist/shared/contracts.js', import.meta.url).href);
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { Questions, watchRun } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const tick = () => new Promise(resolve => setImmediate(resolve));
function bridge(t, api) {
  const previous = globalThis.window; globalThis.window = { notetrail: api };
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
}

test('desktop draft retries keep the original key until an acknowledged submission', async t => {
  const calls = [], runId = newId('run'), ref = { runId, state: 'queued', eventsUrl: `/api/v1/runs/${runId}/events` };
  bridge(t, { async ask(session, input, key) {
    calls.push({ session, input, key });
    return calls.length === 1 ? { error: { code: 'SUBMISSION_UNKNOWN', message: '提交结果未确认' } } : { data: ref };
  } });
  const questions = new Questions(), session = newId('session'), input = { text: '公开测试问题', action: 'ask' };
  await assert.rejects(questions.send(session, input), { code: 'SUBMISSION_UNKNOWN' });
  assert.equal((await questions.send(session, input)).runId, runId);
  assert.equal(calls[0].key, calls[1].key);
  await questions.send(session, input); assert.notEqual(calls[1].key, calls[2].key);
});

test('desktop polling reconnects by reading snapshots, stops at completion and never resubmits', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const id = newId('run'), changed = [], errors = []; let reads = 0;
  bridge(t, { async run() {
    reads++;
    if (reads === 1) return { error: { code: 'SERVICE_UNAVAILABLE', message: '连接中断' } };
    return { data: { id, state: reads === 2 ? 'running' : 'succeeded' } };
  }, ask() { assert.fail('polling must never submit'); } });
  const stop = watchRun(id, run => changed.push(run.state), error => errors.push(error)); t.after(stop);
  await tick(); t.mock.timers.tick(1000); await tick(); t.mock.timers.tick(1000); await tick();
  assert.deepEqual(changed, ['running', 'succeeded']); assert.deepEqual(errors, ['连接中断', '', '']);
  t.mock.timers.tick(5000); await tick(); assert.equal(reads, 3);
});

test('desktop ignores late responses after unsubscribe and stops polling an expired session', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolve, reads = 0, changed = 0;
  bridge(t, { run() { reads++; return new Promise(done => { resolve = done; }); } });
  const stop = watchRun(newId('run'), () => changed++, () => {});
  stop(); resolve({ data: { state: 'running' } }); await tick(); t.mock.timers.tick(5000); await tick();
  assert.equal(changed, 0); assert.equal(reads, 1);
  globalThis.window.notetrail.run = async () => { reads++; return { error: { code: 'UNAUTHORIZED', message: '会话失效，请重新打开' } }; };
  const end = watchRun(newId('run'), () => changed++, () => {}); t.after(end);
  await tick(); t.mock.timers.tick(5000); await tick(); assert.equal(reads, 2); assert.equal(changed, 0);
});
