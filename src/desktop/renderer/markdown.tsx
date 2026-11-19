import { inlineParts, markdownParts, type InlinePart } from '../../shared/presentation.js';
import type { AnswerSelection } from '../../shared/answer.js';
import { Fragment, type ReactNode } from 'react';

type RenderLink = (part: InlinePart, label: ReactNode) => ReactNode;
function Inline({ text, start, renderLink }: { text: string; start: number; renderLink?: RenderLink }) {
  return inlineParts(text, start).map((part, i) => {
    const leaf = <span data-md-start={part.start} data-md-end={part.end}>{part.text}</span>;
    if (part.kind === 'strong') return <strong key={i}>{leaf}</strong>;
    if (part.kind === 'code') return <code key={i}>{leaf}</code>;
    if (part.kind === 'link') return <Fragment key={i}>{renderLink?.(part, leaf) ??
      <a href={part.href} target="_blank" rel="noopener noreferrer">{leaf}</a>}</Fragment>;
    return <span key={i}>{leaf}</span>;
  });
}
export function Markdown({ text, trailing, renderLink }: { text: string; trailing?: ReactNode; renderLink?: RenderLink }) {
  const parts = markdownParts(text);
  return <div className="markdown">{parts.map((part, i) => {
    const tail = i === parts.length - 1 ? trailing : null;
    if (part.kind === 'heading') return <h3 key={i}><Inline text={part.text} start={part.start} renderLink={renderLink} />{tail}</h3>;
    if (part.kind === 'code') return <pre key={i}><code><span data-md-start={part.start} data-md-end={part.start + part.text.length}>{part.text}</span></code></pre>;
    if (part.kind === 'list') {
      const items = part.items!.map((item, j) => <li key={j}><Inline {...item} renderLink={renderLink} /></li>);
      return part.ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
    }
    return <p key={i}><Inline text={part.text} start={part.start} renderLink={renderLink} />{tail}</p>;
  })}
    {/* Block-level evidence stays outside lists and code, rather than implying support for only the last item. */}
    {trailing && (parts.at(-1)?.kind === 'code' || parts.at(-1)?.kind === 'list') && <div className="markdown__references">{trailing}</div>}
  </div>;
}
export function selectedMarkdown(root: HTMLElement, markdown: string): AnswerSelection['selection'] | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  let start = Infinity, end = -1;
  for (const span of root.querySelectorAll<HTMLElement>('[data-md-start]')) {
    const node = span.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE || !range.intersectsNode(node)) continue;
    const length = node.textContent?.length ?? 0;
    if (range.comparePoint(node, length) < 0 || range.comparePoint(node, 0) > 0) continue;
    const from = node === range.startContainer ? range.startOffset : 0;
    const to = node === range.endContainer ? range.endOffset : length;
    if (to <= from) continue;
    start = Math.min(start, Number(span.dataset.mdStart) + from); end = Math.max(end, Number(span.dataset.mdStart) + to);
  }
  if (!Number.isSafeInteger(start) || end <= start || end - start > 64000) return null;
  const expectedText = markdown.slice(start, end);
  return expectedText.trim() ? { start, end, expectedText } : null;
}
