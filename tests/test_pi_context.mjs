import assert from 'node:assert/strict';
import test from 'node:test';
import { contextDecision, assertContext, assertToolPairs, extractTestSchedule } from '../scripts/context_checks.mjs';

const baseline = { complete: true, scopeRevision: 1, memoryGeneration: 1,
  sources: [{ id: 'schedule', version: 'sha256:old', status: 'ready' }] };

test('the fixed summary model extracts a schedule fact rather than the preceding question', () => {
  const question = '例行巡检安排在每周什么时候？';
  assert.equal(extractTestSchedule(question), undefined);
  for (const fact of ['例行巡检安排在每周二 09:00。', '例行巡检安排在每周四 10:00。']) {
    assert.equal(extractTestSchedule(`${question}\n[Tool result]: 本文件为合成测试资料。\n${fact}`), fact);
  }
});

test('context reuse requires unchanged scope, memory and every source dependency', () => {
  assert.equal(contextDecision(baseline, structuredClone(baseline)).rebuild, false);
  assert.equal(contextDecision(baseline, { ...baseline, sources: [...baseline.sources, { id: 'unrelated' }] }).rebuild, false);
  for (const status of ['missing', 'excluded', 'stale', 'failed', 'processing']) {
    assert(contextDecision(baseline, { ...baseline, sources: [{ ...baseline.sources[0], status }] }).rebuild, status);
  }
  assert(contextDecision(baseline, { ...baseline, sources: [] }).rebuild);
  assert(contextDecision(baseline, { ...baseline, sources: [{ ...baseline.sources[0], version: 'sha256:new' }] }).rebuild);
  assert(contextDecision(baseline, { ...baseline, scopeRevision: 2 }).rebuild);
  assert(contextDecision(baseline, { ...baseline, memoryGeneration: 2 }).rebuild);
  assert(contextDecision(undefined, baseline).rebuild);
  assert(contextDecision(baseline, { ...baseline, complete: false }).rebuild);
  assert(contextDecision(baseline, { ...baseline, memoryGeneration: undefined }).rebuild);
});

test('stale-content checks inspect summaries and metadata, not only assistant output', () => {
  const clean = { messages: [{ role: 'user', content: 'current question' }] };
  assertContext(clean, ['stale fact'], ['current question']);
  for (const field of ['content', 'summary', 'details']) {
    assert.throws(() => assertContext({ ...clean, [field]: 'stale fact' }, ['stale fact']), /stale context/);
  }
  assert.throws(() => assertContext(clean, [], ['missing evidence']), /missing current context/);
});

test('protocol checks reject orphan, missing, mismatched and duplicate tool results', () => {
  const call = { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'read' }] };
  const result = { role: 'toolResult', toolCallId: 'a', toolName: 'read' };
  assertToolPairs([call, result, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }]);
  assert.throws(() => assertToolPairs([result]), /orphan/);
  assert.throws(() => assertToolPairs([call]), /unresolved/);
  assert.throws(() => assertToolPairs([call, { ...result, toolName: 'write' }]), /mismatch/);
  assert.throws(() => assertToolPairs([call, result, call, result]), /duplicate/);
  assert.throws(() => assertToolPairs([call, { role: 'user', content: 'next' }]), /missing/);
});
