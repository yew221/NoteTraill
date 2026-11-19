import test from 'node:test';
import assert from 'node:assert/strict';
import { answerPreview } from '../dist/shared/answer-preview.js';

test('unfinished JSON exposes only block Markdown and handles split escapes and Unicode', () => {
  const body = JSON.stringify({ outcome: 'answered', blocks: [{ id: 'b1', kind: 'notice', markdown: '公开\n"引文"🙂', evidenceIds: ['e_PRIVATE'] },
    { id: 'b2', kind: 'notice', markdown: '第二段', evidenceIds: [] }], limitations: ['PRIVATE_LIMIT'] });
  for (let n = 0; n <= body.length; n++) {
    const preview = answerPreview(body.slice(0, n));
    assert('公开\n"引文"🙂\n\n第二段'.startsWith(preview)); assert(!preview.includes('PRIVATE'));
  }
  assert.equal(answerPreview('```json\n' + body + '\n```'), '公开\n"引文"🙂\n\n第二段');
  assert.equal(answerPreview('{"blocks":[{"markdown":"a\\u4e'), 'a');
  assert.equal(answerPreview('{"blocks":[{"markdown":"a\\u4e2d'), 'a中');
  assert.equal(answerPreview('{"tool":{"markdown":"private"}}'), '');
  assert.equal(answerPreview('{"blocks":[{"markdown":"text\\x"}]}'), '');
  assert.equal(answerPreview('raw model deliberation'), '');
});
