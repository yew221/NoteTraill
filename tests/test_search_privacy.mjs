import assert from 'node:assert/strict';
import test from 'node:test';
import { SearchPrivacy } from '../dist/server/search-privacy.js';
import { WebSearch } from '../dist/server/web-search.js';

const blocked = fn => assert.throws(fn, error => error.publicError?.code === 'SEARCH_PRIVACY_BLOCKED');
test('private fields and copied text are blocked while short public concepts remain searchable', () => {
  const privacy = new SearchPrivacy();
  privacy.local({ source: { relativePath: '项目/青鹭内部计划.md' }, evidence: {
    excerpt: '项目：青鹭计划，负责人：林雨，预算：384200元。\n本次交接的验收时间为周五下午。SKU 是商品单位。' } });
  for (const query of ['青鹭计划 进展', '林雨 简历', '384200 预算', '青 鹭 内 部 计 划', '本次交接的验收时间', encodeURIComponent('青鹭计划'),
    encodeURIComponent(encodeURIComponent(encodeURIComponent('青鹭计划'))), Buffer.from('林雨').toString('base64'),
    Buffer.from('青鹭计划').toString('base64url'), '138，0000，0000']) {
    blocked(() => privacy.check(query));
  }
  for (const query of ['SKU 定义', 'Python 官方文档', 'Apple 最新发布会 2026', '库存 周转 公式']) assert.doesNotThrow(() => privacy.check(query));
});
test('resumed private messages, compaction, attachments and preferences remain protected before any new read', () => {
  const privacy = new SearchPrivacy();
  privacy.local(['我的合同号：HX827361']);
  privacy.local([{ name: '蓝鹊机密附件.pdf' }]);
  privacy.history(Buffer.from([
    { type: 'message', message: { role: 'user', content: '我们内部代号银桥远航行动的安排' } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ blocks: [{ kind: 'grounded', markdown: '客户：紫杉公司' }] }) }] } },
    { type: 'compaction', summary: '联系人：周澄；项目：玄武测试计划' },
  ].map(value => JSON.stringify(value)).join('\n')));
  for (const query of ['HX827361', '蓝鹊机密附件', '银桥远航行动', '紫杉公司', '周澄 资料', '玄武测试计划']) blocked(() => privacy.check(query));
});
test('web excerpts do not become private sources and private-context overflow fails closed', () => {
  const privacy = new SearchPrivacy();
  privacy.local({ ok: true, data: { kind: 'web_search', results: [{ title: '公开新版说明', excerpt: '这是从公开网页得到的产品版本说明。' }] } });
  assert.doesNotThrow(() => privacy.check('公开新版说明 产品版本说明'));
  privacy.remember('X'.repeat(8 * 1024 * 1024 + 1));
  blocked(() => privacy.check('SKU'));
});
test('privacy enforcement precedes credentials, charging and transport, and cannot be omitted', async () => {
  const privacy = new SearchPrivacy(); privacy.remember('项目：青鹭计划');
  let credentials = 0, sent = 0, charges = 0;
  const settings = { async forSearch() { credentials++; return { revision: 1, apiKey: 'SYNTHETIC_ONLY' }; } };
  const ledger = { reserveSearch() { charges++; return 'test'; }, sentSearch() {}, endSearch() {} };
  const fetcher = async () => { sent++; return Response.json({ results: [] }); };
  const search = new WebSearch(settings, ledger, privacy, fetcher);
  const call = (tool, query) => tool.execute('r_synthetic', 1, { query, reason: '本机检查；不发送这段说明' }, new AbortController().signal);
  await assert.rejects(call(search, '青鹭计划'), e => e.publicError?.code === 'SEARCH_PRIVACY_BLOCKED');
  await assert.rejects(call(new WebSearch(settings, ledger, undefined, fetcher), 'SKU'), e => e.publicError?.code === 'SEARCH_PRIVACY_BLOCKED');
  assert.deepEqual({ credentials, sent, charges }, { credentials: 0, sent: 0, charges: 0 });
  await call(search, 'SKU 定义');
  assert.deepEqual({ credentials, sent, charges }, { credentials: 1, sent: 1, charges: 1 });
});
