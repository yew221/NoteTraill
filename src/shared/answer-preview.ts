import { ANSWER_LIMITS } from './answer.js';
// Read only blocks[].markdown from a possibly unfinished answer JSON. Other fields,
// tool arguments and reasoning are never presentation text. Final validation is separate.
export function answerPreview(input: string): string {
  if (input.length > ANSWER_LIMITS.serializedChars) return '';
  const source = input.trimStart().replace(/^```(?:json)?\s*\n/, '');
  const parts: string[] = [], incomplete = Symbol('incomplete');
  let at = 0;
  const space = () => { while (/\s/.test(source[at] ?? '') && at < source.length) at++; };
  const need = () => { space(); if (at >= source.length) throw incomplete; };
  function string(capture = false): string {
    if (source[at++] !== '"') throw new Error();
    let value = '';
    const publish = () => { if (capture) parts.push(value.replace(/[\ud800-\udbff]$/u, '')); };
    while (at < source.length) {
      let ch = source[at++];
      if (ch === '"') { publish(); return value; }
      if (ch === '\\') {
        if (at === source.length) { publish(); throw incomplete; }
        const escaped = source[at++];
        if (escaped === 'u') {
          if (source.length - at < 4) { publish(); throw incomplete; }
          const hex = source.slice(at, at + 4);
          if (!/^[a-f\d]{4}$/i.test(hex)) throw new Error();
          ch = String.fromCharCode(parseInt(hex, 16)); at += 4;
        } else {
          const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (!(escaped in escapes)) throw new Error(); ch = escapes[escaped];
        }
      } else if (ch.charCodeAt(0) < 32) throw new Error();
      value += ch;
    }
    publish(); throw incomplete;
  }
  function value(path: Array<string | number>, depth: number): void {
    if (depth > 8) throw new Error();
    need(); const ch = source[at];
    if (ch === '"') { string(path.length === 3 && path[0] === 'blocks' && typeof path[1] === 'number' && path[1] < 32 && path[2] === 'markdown'); return; }
    if (ch === '{' || ch === '[') {
      at++; need(); const end = ch === '{' ? '}' : ']'; let index = 0;
      const keys = new Set<string>();
      if (source[at] === end) { at++; return; }
      for (;;) {
        need(); let key: string | number = index++;
        if (ch === '{') { key = string(); if (keys.has(key)) throw new Error(); keys.add(key); need(); if (source[at++] !== ':') throw new Error(); }
        value([...path, key], depth + 1); need();
        if (source[at] === end) { at++; return; }
        if (source[at++] !== ',') throw new Error();
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(at));
    if (!match) { if (at + 5 >= source.length) throw incomplete; throw new Error(); }
    at += match[0].length;
  }
  try { need(); if (source[at] !== '{') return ''; value([], 0); }
  catch (error) { if (error !== incomplete) return ''; }
  return parts.join('\n\n').slice(0, ANSWER_LIMITS.draftChars);
}
