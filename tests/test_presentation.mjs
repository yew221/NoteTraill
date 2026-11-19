import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import ts from 'typescript';
import { citationIndexForLink, intakeKind, contentPath, safeContentPath, inlineParts, markdownParts, selectableMarkdown, selectedAnswerText } from '../dist/shared/presentation.js';

test('shared composer classifies a single URL, preserves mixed text and rejects empty intake', () => {
  assert.equal(intakeKind('  https://example.com/文章?q=1#位置\n'), 'url');
  for (const value of ['原话 https://example.com', 'https://example.com\n请阅读', 'https://', 'javascript:alert(1)', '两段\n记录']) assert.equal(intakeKind(value), 'text');
  assert.equal(intakeKind(' \n'), 'empty');
});
const id = 's_12345678-1234-4123-8123-123456789abc', version = 'a'.repeat(64), url = contentPath(id, version, 'text');
test('two numbered links to the same source and version open distinct evidence passages', () => {
  const citations = [
    { sourceId:id, sourceVersion:version, location:{startLine:1} },
    { sourceId:id, sourceVersion:version, location:{startLine:9} }
  ];
  const markdown = `计划访谈。 [资料 1](${url})\n\n访谈已完成。 [资料 2](${url})\n\n资料 2（原文第 9–9 行）：[查看已核对版本](${url})`;
  const parts = inlineParts(markdown).filter(part => part.href);
  assert.deepEqual(parts.map(part => citations[citationIndexForLink(markdown,part,citations)].location.startLine),[1,9,9]);
  assert.equal(citationIndexForLink(markdown,{...parts[1],href:url.replace(version,'b'.repeat(64))},citations),null);
});
test('rendered links permit only version-bound local content routes', () => {
  assert.equal(safeContentPath(url), url);
  for (const value of [url + '&other=true', '//example.com', 'javascript:alert(1)', 'https://example.com', '/api/v1/settings', url.replace('s_', 'v_'), url.replace(version, 'a')]) assert.equal(safeContentPath(value), null);
  assert.throws(() => contentPath('s_bad', version, 'text'));
  for (const value of ['[链接](https://example.com)', '[点击](javascript:alert(1))', '<img src=x onerror=alert(1)>', '![图](https://example.com)']) {
    assert(inlineParts(value).every(part => !part.href)); assert.equal(inlineParts(value).map(part => part.text).join(''), value);
  }
});
test('Markdown offsets preserve canonical UTF-16 through headings, lists, formatting and code', () => {
  const original = `# 标题🙂\n\n**粗体😀** 原话 [资料 1](${url})\n\n- 第一个\n- 第二个\n\n1. 顺序\n\n\`\`\`\n<script>alert(1)</script>\n中文\n\`\`\``;
  const blocks = markdownParts(original); assert.deepEqual(blocks.map(part => part.kind), ['heading','paragraph','list','list','code']);
  for (const block of blocks) for (const item of block.items ?? [block]) {
    assert.equal(original.slice(item.start, item.start + item.text.length), item.text);
    for (const part of inlineParts(item.text, item.start)) assert.equal(original.slice(part.start, part.end), part.text);
  }
  assert.equal(inlineParts('**😀**')[0].end - inlineParts('**😀**')[0].start, 2);
});

// Exercise the actual renderer commands with a disposable IPC transport.
let clientSource = ts.transpileModule(fs.readFileSync(new URL('../src/desktop/renderer/client.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
clientSource = clientSource.replace(/from '(\.\.\/\.\.\/shared\/[^']+)'/g, (_match, specifier) => `from '${new URL(specifier.replace('../../shared/', '../dist/shared/'), import.meta.url).href}'`);
const { ClientError, RunCommands, allPages, installApiTransport } = await import(`data:text/javascript;base64,${Buffer.from(clientSource).toString('base64')}`);
const runId = 'r_12345678-1234-4123-8123-123456789abc';
const ref = { runId, state: 'queued', eventsUrl: '/api/v1/runs/' + runId + '/events' };
test('lost mutation response reuses its identity; accepted submission and changed input use fresh keys', async () => {
  const calls = []; let lost = true;
  installApiTransport(async (url, options) => { calls.push({ url, ...options }); if (lost) { lost = false; throw new ClientError('未能确认提交结果'); } return ref; });
  const commands = new RunCommands(), path = '/api/v1/sessions/c_test/messages';
  await assert.rejects(commands.send(path, { text: '保留原话' }), /未能确认/);
  await commands.send(path, { text: '保留原话' }); assert.equal(calls[0].key, calls[1].key);
  await commands.send(path, { text: '保留原话' }); assert.notEqual(calls[1].key, calls[2].key);
  lost = true; await assert.rejects(commands.send(path, { text: '甲' })); await commands.send(path, { text: '乙' }); assert.notEqual(calls[3].key, calls[4].key);
  assert(calls.every(call => call.method === 'POST'));
});
test('multipart upload contains exactly meta and one original file and retries with its identity', async () => {
  const calls = []; let lost = true;
  installApiTransport(async (_url, options) => { calls.push(options); if (lost) { lost = false; throw new ClientError('提交中断'); } return ref; });
  const file = new File(['原始内容'], '资料.md'), body = { vaultId: 'test', input: { kind: 'upload', filePart: 'file' } }, commands = new RunCommands();
  await assert.rejects(commands.send('/api/v1/ingestions', body, file)); await commands.send('/api/v1/ingestions', body, file);
  assert.equal(calls[0].key, calls[1].key);
  assert.deepEqual([...calls[1].form.keys()], ['meta','file']); assert.equal(calls[1].form.get('meta'), JSON.stringify(body));
  assert.equal(await calls[1].form.get('file').text(), '原始内容'); assert.equal(calls[1].form.get('file').name, '资料.md'); assert.equal(calls[1].body, undefined);
});
test('pagination consumes all pages and detects repeated cursors instead of looping', async () => {
  const urls = [];
  installApiTransport(async url => { urls.push(url); return urls.length === 1 ? { items: ['a'], nextCursor: 'next' } : { items: ['b'], nextCursor: null }; });
  assert.deepEqual(await allPages('/api/v1/sessions?vaultId=v_test'), ['a','b']); assert.match(urls[1], /&cursor=next$/);
  installApiTransport(async () => ({ items: [], nextCursor: 'repeat' }));
  await assert.rejects(allPages('/api/v1/list'), /未能完整读取/);
});

test('keyboard selection hides URLs and maps formatted Unicode back to the exact answer', () => {
  const original = `## 标题\n\n前言 **中文😀** [资料 1](${url})\n\n- 末尾`;
  const mapped = selectableMarkdown(original); assert(!mapped.text.includes('/api/')); assert(!mapped.text.includes('**'));
  assert.equal(mapped.text.length, mapped.offsets.length);
  for (let i = 0; i < mapped.text.length; i++) if (mapped.offsets[i] !== null) assert.equal(original[mapped.offsets[i]], mapped.text[i]);
  const start = mapped.text.indexOf('中文'), end = start + '中文😀'.length;
  assert.equal(original.slice(mapped.offsets[start], mapped.offsets[end - 1] + 1), '中文😀');
});

test('selected visible words exclude dangling Markdown, hidden URLs and unselected formatted text', () => {
  const original = `**结论：** 每周三 14:30。 [资料 1](${url}) [资料 2](${url})\n\n不能带上的下一段。`;
  const mapped = selectableMarkdown(original), visibleEnd = mapped.text.indexOf('\n\n');
  const start = mapped.offsets[0], end = mapped.offsets[visibleEnd - 1] + 1;
  assert(original.slice(start, end).startsWith('结论：**'));
  assert.equal(selectedAnswerText(original, start, end), '结论： 每周三 14:30。 资料 1 资料 2');
  for (const markdown of ['前言 **未选中😀已选中** 后文', '前言 `未选中😀已选中` 后文', `前言 [未选中😀已选中](${url}) 后文`]) {
    const from = markdown.indexOf('😀'), to = markdown.indexOf(' 后文');
    assert.equal(selectedAnswerText(markdown, from, to), '😀已选中');
  }
  assert.equal(selectedAnswerText('**只有标记**', 0, 2), '');
  const code = '```\n**代码原字面量**\n```';
  assert.equal(selectedAnswerText(code, 4, code.lastIndexOf('\n')), '**代码原字面量**');
});
