import { isId, isPayloadHash } from './contracts.js';
import type { Evidence } from './tools.js';

export function intakeKind(text: string): 'empty' | 'url' | 'text' {
  const value = text.trim();
  if (!value) return 'empty';
  if (/^https?:\/\/\S+$/i.test(value)) {
    try { const url = new URL(value); if (url.hostname) return 'url'; } catch { /* Keep mixed or malformed input as original text. */ }
  }
  return 'text';
}
export function contentPath(id: string, version: string, view: 'text' | 'original'): string {
  if (!isId(id, 'source') || !isPayloadHash(version)) throw new Error('资料链接无效。');
  return `/api/v1/sources/${id}/content?view=${view}&expectedVersion=${version}`;
}
export function safeContentPath(value: string): string | null {
  const match = /^\/api\/v1\/sources\/(s_[a-f0-9-]+)\/content\?view=(text|original)&expectedVersion=([a-f0-9]{64})$/.exec(value);
  if (!match || !isId(match[1], 'source')) return null;
  return contentPath(match[1], match[3], match[2] as 'text' | 'original');
}
export type InlinePart = { text: string; start: number; end: number; kind: 'text' | 'strong' | 'code' | 'link'; href?: string };
export function citationIndexForLink(markdown: string, part: InlinePart, citations: Evidence[]): number | null {
  const lineStart = markdown.lastIndexOf('\n', part.start - 1) + 1;
  const number = /^(?:资料 )([1-9][0-9]*)$/.exec(part.text)?.[1] ??
    (part.text === '查看已核对版本' ? /^资料 ([1-9][0-9]*)（/.exec(markdown.slice(lineStart, part.start))?.[1] : undefined);
  if (!number) return null;
  const index = Number(number) - 1, citation = citations[index];
  return citation && part.href === contentPath(citation.sourceId, citation.sourceVersion, 'text') ? index : null;
}
export function inlineParts(text: string, offset = 0): InlinePart[] {
  const result: InlinePart[] = [];
  const pattern = /\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\n]+)\)/g;
  let cursor = 0;
  const plain = (start: number, end: number) => {
    if (end > start) result.push({ text: text.slice(start, end), start: offset + start, end: offset + end, kind: 'text' });
  };
  for (const match of text.matchAll(pattern)) {
    plain(cursor, match.index);
    const href = match[4] ? safeContentPath(match[4]) : null;
    if (match[3] && !href) plain(match.index, match.index + match[0].length);
    else {
      const value = match[1] ?? match[2] ?? match[3], start = offset + match.index + (match[1] ? 2 : 1);
      result.push({ text: value, start, end: start + value.length, kind: match[1] ? 'strong' : match[2] ? 'code' : 'link', ...(href ? { href } : {}) });
    }
    cursor = match.index + match[0].length;
  }
  plain(cursor, text.length); return result;
}
export type MarkdownPart = { kind: 'paragraph' | 'heading' | 'code' | 'list'; start: number; text: string;
  ordered?: boolean; items?: { text: string; start: number }[] };
// shortcut: a small safe Markdown subset; unsupported syntax remains readable text instead of HTML.
export function markdownParts(markdown: string): MarkdownPart[] {
  const lines: { text: string; start: number }[] = []; let offset = 0;
  for (const line of markdown.split('\n')) { lines.push({ text: line, start: offset }); offset += line.length + 1; }
  const result: MarkdownPart[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.text.trim()) { i++; continue; }
    if (/^\s*```/.test(line.text)) {
      const start = lines[i + 1]?.start ?? markdown.length; let end = start; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i].text)) { end = lines[i].start + lines[i].text.length; i++; }
      result.push({ kind: 'code', start, text: markdown.slice(start, end) }); if (i < lines.length) i++; continue;
    }
    const heading = /^(#{1,6})\s+/.exec(line.text);
    if (heading) { result.push({ kind: 'heading', start: line.start + heading[0].length, text: line.text.slice(heading[0].length) }); i++; continue; }
    const list = /^(?:[-*+] |\d+\. )/.exec(line.text);
    if (list) {
      const ordered = /^\d/.test(list[0]), items = [];
      while (i < lines.length) {
        const prefix = /^(?:[-*+] |\d+\. )/.exec(lines[i].text);
        if (!prefix || /^\d/.test(prefix[0]) !== ordered) break;
        items.push({ text: lines[i].text.slice(prefix[0].length), start: lines[i].start + prefix[0].length }); i++;
      }
      result.push({ kind: 'list', start: line.start, text: '', ordered, items }); continue;
    }
    const start = line.start; let end = start;
    do { end = lines[i].start + lines[i].text.length; i++; }
    while (i < lines.length && lines[i].text.trim() && !/^(?:\s*```|#{1,6}\s|[-*+] |\d+\. )/.test(lines[i].text));
    result.push({ kind: 'paragraph', start, text: markdown.slice(start, end) });
  }
  return result;
}

// Keep keyboard/touch selection tied to the same canonical answer, without showing internal URLs.
export function selectableMarkdown(markdown: string): { text: string; offsets: Array<number | null> } {
  let text = ''; const offsets: Array<number | null> = [];
  for (const block of markdownParts(markdown)) for (const item of block.items ?? [block]) {
    if (text) { text += '\n\n'; offsets.push(null, null); }
    const parts = block.kind === 'code' ? [{ text: item.text, start: item.start }] : inlineParts(item.text, item.start);
    for (const part of parts) { text += part.text; for (let i = 0; i < part.text.length; i++) offsets.push(part.start + i); }
  }
  return { text, offsets };
}

// Authenticate using the canonical range, but save visible words instead of dangling formatting or URLs.
export function selectedAnswerText(markdown: string, start: number, end: number): string {
  const mapped = selectableMarkdown(markdown);
  let first = -1, last = -1;
  for (let i = 0; i < mapped.offsets.length; i++) {
    const offset = mapped.offsets[i];
    if (offset !== null && offset >= start && offset < end) { if (first < 0) first = i; last = i; }
  }
  return first < 0 ? '' : mapped.text.slice(first, last + 1);
}
