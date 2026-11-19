import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Load the actual renderer components; no new DOM or browser dependency is needed.
const modules = new Map();
function componentUrl(file) {
  if (modules.has(file.href)) return modules.get(file.href);
  let code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  code = code.replace(/from (['"])([^'"]+)\1/g, (_match, _quote, specifier) => {
    let target;
    if (!specifier.startsWith('.')) target = import.meta.resolve(specifier);
    else {
      const resolved = new URL(specifier, file);
      const source = ['.tsx', '.ts'].map(extension => new URL(resolved.href.replace(/\.js$/, extension))).find(url => fs.existsSync(url));
      target = source ? componentUrl(source) : resolved.href.replace('/src/', '/dist/');
    }
    return `from ${JSON.stringify(target)}`;
  });
  const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  modules.set(file.href, url); return url;
}
const { Composer } = await import(componentUrl(new URL('../src/desktop/renderer/composer.tsx', import.meta.url)));
const { Answer } = await import(componentUrl(new URL('../src/desktop/renderer/answers.tsx', import.meta.url)));
const { Markdown } = await import(componentUrl(new URL('../src/desktop/renderer/markdown.tsx', import.meta.url)));
function nodes(tree, match) {
  if (Array.isArray(tree)) return tree.flatMap(item => nodes(item, match));
  if (!tree || typeof tree !== 'object') return [];
  return [...(match(tree) ? [tree] : []), ...nodes(tree.props?.children, match)];
}
function composer(patch = {}) {
  let sends = 0, stops = 0;
  const tree = Composer({ draft: '公开问题', mode: 'ask', file: null, disabled: false, busy: false,
    onSend: () => sends++, onStop: () => stops++, ...patch });
  const input = nodes(tree, node => node.type === 'textarea')[0];
  return { key(event = {}) {
    let prevented = false;
    input.props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: false }, preventDefault() { prevented = true; }, ...event });
    return { sends, stops, prevented };
  } };
}
test('desktop Enter submits once; Shift+Enter and IME confirmation stay in the composer', () => {
  const plain = composer(); assert.deepEqual(plain.key(), { sends: 1, stops: 0, prevented: true });
  assert.deepEqual(plain.key({ repeat: true }), { sends: 1, stops: 0, prevented: true });
  for (const event of [{ shiftKey: true }, { nativeEvent: { isComposing: true } }, { keyCode: 229 }, { altKey: true }]) {
    assert.deepEqual(composer().key(event), { sends: 0, stops: 0, prevented: false });
  }
  assert.equal(composer({ mode: 'store' }).key().sends, 1);
  assert.equal(composer({ file: { name: '公开资料.md' }, draft: '帮我入库' }).key().sends, 1);
  assert.equal(composer().key({ metaKey: true }).sends, 1);
});
test('Enter cannot submit blank, disabled or busy drafts and never invokes Stop', () => {
  for (const patch of [{ draft: ' \n ' }, { disabled: true }, { busy: true }]) {
    assert.deepEqual(composer(patch).key(), { sends: 0, stops: 0, prevented: true });
  }
});
function answer(markdown) {
  const evidence = index => ({ id: `e_${index}`, sourceId: `s_${index}`,
    location: { refersTo: 'original', startLine: index, endLine: index + 2 } });
  return { answer: { id: 'a_public', blocks: [{ id: 'b1', kind: 'grounded', markdown, evidenceIds: ['e_2', 'e_1'] }],
    citations: [evidence(1), evidence(2)], limitations: [] },
    citationStatus: [{ evidenceId: 'e_1', status: 'current' }, { evidenceId: 'e_2', status: 'changed' }] };
}
const sources = [{ id: 's_1', title: '公开资料甲.md' }, { id: 's_2', title: '公开资料乙.md' }];
test('citations follow the final paragraph with stable evidence targets and visible stale status', () => {
  const selected = [], tree = Answer({ view: answer('第一段。\n\n第二段 **结论**。'), sources, onCitation: target => selected.push(target) });
  const markdown = nodes(tree, node => node.type === Markdown)[0];
  const buttons = markdown.props.trailing;
  buttons[0].props.onClick(); buttons[1].props.onClick();
  assert.deepEqual(selected, [{ answerId: 'a_public', evidenceId: 'e_2' }, { answerId: 'a_public', evidenceId: 'e_1' }]);
  const html = renderToStaticMarkup(tree), paragraphs = html.match(/<p>.*?<\/p>/gs);
  assert.equal(paragraphs.length, 2); assert(!paragraphs[0].includes('<button'));
  assert.equal((paragraphs[1].match(/<button/g) ?? []).length, 2);
  assert.match(paragraphs[1], /公开资料乙.md · 原文 2–4 行 · 需核对/);
  assert.match(paragraphs[1], /\[资料 2 · 需核对\]/); assert.match(paragraphs[1], /\[资料 1\]/);
});
test('block citations stay outside code and list items; plain shared Markdown remains unchanged', () => {
  for (const markdown of ['```text\n<unsafe>\n```', '- 第一条\n- 第二条']) {
    const html = renderToStaticMarkup(createElement(Answer, { view: answer(markdown), sources, onCitation() {} }));
    const content = html.match(markdown.startsWith('```') ? /<pre>.*?<\/pre>/s : /<ul>.*?<\/ul>/s)[0];
    assert(!content.includes('<button')); assert(html.indexOf('markdown__references') > html.indexOf(content));
    assert(!html.includes('<unsafe>'));
  }
  const plain = renderToStaticMarkup(createElement(Markdown, { text: '**原话** 与 `代码`' }));
  assert(!plain.includes('markdown__references')); assert.match(plain, /data-md-start="2" data-md-end="4">原话/);
  const noEvidence = answer('没有出处的运行说明。'); noEvidence.answer.blocks[0].evidenceIds = [];
  assert(!renderToStaticMarkup(createElement(Answer, { view: noEvidence, sources, onCitation() {} })).includes('<button'));
});

test('web sources use separate labels, server URLs and retained excerpts rather than knowledge citations', () => {
  const view = answer('资料事实。');
  view.answer.blocks.unshift({ id: 'web', kind: 'web', markdown: '网页定义。', evidenceIds: ['e_web'] });
  view.answer.webCitations = [{ id: 'e_web', title: '公开术语说明', url: 'https://example.com/sku', excerpt: 'SKU means stock keeping unit.', contentKind: 'summary', retrievedAt: '2026-11-16T00:00:00Z' }];
  const html = renderToStaticMarkup(createElement(Answer, { view, sources, onCitation() { assert.fail('web is not local'); } }));
  assert.match(html, /网页补充/); assert.match(html, /\[网页 1\]/); assert.match(html, /\[资料 1\]/);
  assert.match(html, /href="https:\/\/example.com\/sku"/); assert.match(html, /搜索摘要/); assert.match(html, /SKU means stock keeping unit/);
});

test('a standalone model answer is labeled directly and has no fabricated reference controls', () => {
  const view = { answer: { id: 'a_public', blocks: [{ id: 'g', kind: 'general', markdown: 'SKU 是库存管理单位。', evidenceIds: [] }], citations: [], limitations: [] }, citationStatus: [] };
  const html = renderToStaticMarkup(createElement(Answer, { view, sources: [], onCitation() { assert.fail('no citations'); } }));
  assert.match(html, /模型回答/); assert.match(html, /SKU/);
  assert(!html.includes('通用补充')); assert(!html.includes('网页来源')); assert(!html.includes('citation-button'));
});
