import { ApiError } from './contracts.js';

const normalized = (text: string) => text.normalize('NFKC').replace(/[\p{Cf}\p{M}]/gu, '').toLowerCase();
const compact = (text: string) => normalized(text).replace(/[\p{P}\p{Z}\p{S}\s]/gu, '');
const fields = /(?:项目(?:名称|代号)?|客户(?:名称)?|负责人|联系人|姓名|工号|订单号|合同号|预算|金额|地址|project(?:\s+(?:name|code))?|customer|contact|employee\s*id|budget|amount)\s*[:：=]\s*([^\n\r,，;；|]{2,80})/giu;
const privateQuestion = /(?:我的|我们|内部|私密|保密|客户|联系人|负责人|合同|笔记|附件|my\s|our\s|internal|confidential)/i;
const MAX_PRIVATE_BYTES = 8 * 1024 * 1024;

// A deterministic outbound check, not a claim of semantic confidentiality.
// Unknown paraphrases/translations can evade matching; do not use a model's "safe" flag as authority.
export class SearchPrivacy {
  private texts: string[] = [];
  private identifiers = new Set<string>();
  private seen = new Set<string>();
  private bytes = 0;
  private overflow = false;

  question(text: string): void {
    this.identify(text);
    if (privateQuestion.test(text)) this.remember(text);
  }
  private identify(text: string): void {
    for (const match of text.matchAll(fields)) {
      const value = compact(match[1]);
      if (value.length >= 2) this.identifiers.add(value);
      for (const number of match[1].matchAll(/\d[\d,.]*\d/g)) this.identifiers.add(compact(number[0]));
    }
  }
  remember(text: string): void {
    if (this.overflow || !text) return;
    this.identify(text);
    const value = compact(text);
    if (!value || this.seen.has(value)) return;
    this.bytes += Buffer.byteLength(value);
    if (this.bytes > MAX_PRIVATE_BYTES) { this.overflow = true; return; }
    this.seen.add(value); this.texts.push(value);
  }
  local(value: unknown, depth = 0): void {
    if (depth > 24) { this.overflow = true; return; }
    if (typeof value === 'string') { this.remember(value); return; }
    if (!value || typeof value !== 'object') return;
    const row = value as Record<string, unknown>;
    if (row.kind === 'web_search') return;
    if (Array.isArray(value)) { for (const item of value) this.local(item, depth + 1); return; }
    for (const [key, item] of Object.entries(row)) {
      if (['relativePath','name','title'].includes(key) && typeof item === 'string') {
        for (const part of item.split(/[\\/]/)) {
          const name = compact(part.replace(/\.[a-z0-9]{1,8}$/i, ''));
          if (name.length >= 4) this.identifiers.add(name);
        }
      }
      this.local(item, depth + 1);
    }
  }
  history(bytes: Buffer): void {
    for (const line of bytes.toString('utf8').trim().split('\n')) {
      const entry = JSON.parse(line);
      if (entry.type === 'compaction') { this.local(entry.summary); continue; }
      const message = entry.message;
      if (!message) continue;
      const text = typeof message.content === 'string' ? message.content :
        Array.isArray(message.content) ? message.content.filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('\n') : '';
      if (!text) continue;
      if (message.role === 'user') { this.remember(text); continue; }
      try {
        const data = JSON.parse(text);
        if (Array.isArray(data.blocks)) {
          for (const block of data.blocks) if (['grounded','inference'].includes(block.kind)) this.remember(block.markdown);
        } else this.local(data);
      } catch { this.remember(text); }
    }
  }
  check(query: string): void {
    const deny = (): never => { throw new ApiError('SEARCH_PRIVACY_BLOCKED'); };
    if (this.overflow) deny();
    let decodedQuery = query;
    for (let round = 0; round < 2; round++) {
      if (!/%[a-f0-9]{2}/i.test(decodedQuery)) break;
      try { const decoded = decodeURIComponent(decodedQuery); if (decoded === decodedQuery) break; decodedQuery = decoded; }
      catch { deny(); }
    }
    const text = normalized(decodedQuery), variants = [text];
    if (/%[a-f0-9]{2}/i.test(text)) deny();
    for (const match of decodedQuery.matchAll(/[A-Za-z0-9+/_-]{8,}={0,2}/g)) {
      const token = match[0].replaceAll('-', '+').replaceAll('_', '/'), bytes = Buffer.from(token, 'base64');
      if (bytes.toString('base64').replace(/=+$/, '') !== token.replace(/=+$/, '')) continue;
      try { variants.push(normalized(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); } catch { /* Not encoded text. */ }
    }
    // Encoded text must pass the same check as readable keywords.
    for (const text of variants) {
      if (/[\x00-\x1f\x7f]|\b(?:sk|api[_-]?key|secret|password|token)\s*[-:=]\s*[\w-]{4,}|[\w.+-]+\s*@\s*[\w.-]+\.[a-z]{2,}|\/(?:users|home|private|volumes)\/|[a-z]:[\\/]|https?:\/\//i.test(text) ||
          /(?:\+\d[\d ()-]{8,}\d|\b1[3-9](?:[ -]?\d){9}\b|\b\d{17}[\dx]\b)|\b[a-f0-9]{24,}\b/i.test(text)) deny();
      // Reject opaque encoded arguments; the search service only needs readable public keywords.
      if (/(?:[A-Za-z0-9+/]{28,}={0,2})/.test(query) && /[A-Z]/.test(query) && /\d|[+/=]/.test(query)) deny();
      const value = compact(text);
      if (/1[3-9]\d{9}|\d{17}[\dx]/i.test(value)) deny();
      for (const identifier of this.identifiers) if (value.includes(identifier)) deny();
      // Match copied fragments even after whitespace/punctuation obfuscation. Short common terms remain usable.
      const length = /\p{Script=Han}/u.test(value) ? 6 : 12;
      for (let i = 0; i <= value.length - length; i++) {
        const fragment = value.slice(i, i + length);
        if (this.texts.some(source => source.includes(fragment))) deny();
      }
    }
  }
}
