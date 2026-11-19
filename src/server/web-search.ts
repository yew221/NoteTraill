import { hasFields, type Id } from '../shared/contracts.js';
import { WEB_SEARCH_LIMITS, type ToolResult, type WebEvidence } from '../shared/tools.js';
import { ApiError, newId } from './contracts.js';
import type { ModelSettings } from './model-settings.js';
import type { ModelLedger } from './model-ledger.js';
import { webUrl } from './web-fetch.js';
import { SearchPrivacy } from './search-privacy.js';

export const SEARCH_ENDPOINT = 'https://api.deepseek.com/v1/tools/search';
const clean = (s: string, limit: number) => Array.from(s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')).slice(0, limit).join('');
export class WebSearch {
  constructor(private readonly settings: ModelSettings, private readonly ledger: ModelLedger,
    private readonly privacy: SearchPrivacy, private readonly fetcher: typeof fetch = fetch,
    private readonly beforeSend?: () => Promise<void>) {}
  async execute(runId: Id<'run'>, revision: number, args: unknown, signal: AbortSignal): Promise<ToolResult> {
    if (!hasFields(args, ['query','reason']) || typeof args.query !== 'string' || !args.query.trim() || Array.from(args.query).length > WEB_SEARCH_LIMITS.queryChars ||
      /[\x00-\x1f\x7f]|\bsk-[\w-]+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\/(?:Users|home)\//i.test(args.query) ||
      typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > WEB_SEARCH_LIMITS.reasonChars) throw new ApiError('BAD_REQUEST');
    if (!(this.privacy instanceof SearchPrivacy)) throw new ApiError('SEARCH_PRIVACY_BLOCKED');
    this.privacy.check(args.query);
    const auth = await this.settings.forSearch();
    if (auth.revision !== revision) throw new ApiError('CONTEXT_CHANGED');
    signal.throwIfAborted();
    const id = this.ledger.reserveSearch(runId);
    let sent = false, ended = false;
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(WEB_SEARCH_LIMITS.timeoutMs)]);
    try {
      await this.beforeSend?.();
      requestSignal.throwIfAborted(); this.ledger.sentSearch(id); sent = true;
      // Only the public search terms leave the process. Never send the question, notes, history or the local insufficiency reason.
      const response = await this.fetcher(SEARCH_ENDPOINT, { method: 'POST', redirect: 'error', signal: requestSignal,
        headers: { Authorization: `Bearer ${auth.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: args.query.trim(), count: WEB_SEARCH_LIMITS.results, need_content: true }) });
      if (!response.ok) {
        this.ledger.endSearch(id, 'free'); ended = true; await response.body?.cancel(); throw new ApiError('SEARCH_UNAVAILABLE');
      }
      const reader = response.body?.getReader(); if (!reader) throw new ApiError('SEARCH_UNAVAILABLE');
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) { requestSignal.throwIfAborted(); const part = await reader.read(); if (part.done) break;
          size += part.value.length; if (size > 2 * 1024 * 1024) throw new ApiError('SEARCH_UNAVAILABLE'); chunks.push(part.value); }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!hasFields(body, ['results']) || !Array.isArray(body.results) || body.results.length > 50) throw new ApiError('SEARCH_UNAVAILABLE');
      this.ledger.endSearch(id, body.results.length ? 'charged' : 'free'); ended = true;
      const results: WebEvidence[] = [], seen = new Set<string>(), retrievedAt = new Date().toISOString();
      let truncated = body.results.length > WEB_SEARCH_LIMITS.results;
      for (const item of body.results) {
        if (!item || typeof item !== 'object' || typeof item.url !== 'string' || typeof item.title !== 'string') continue;
        let url: string; try { url = webUrl(item.url).href; } catch { continue; }
        if (seen.has(url)) continue;
        const content = typeof item.content === 'string' && item.content.trim() ? item.content : null;
        const summary = typeof item.summary === 'string' && item.summary.trim() ? item.summary : item.snippet;
        if (!content && (typeof summary !== 'string' || !summary.trim())) continue;
        const excerpt = clean(content ?? summary, WEB_SEARCH_LIMITS.excerptChars);
        if (Array.from(content ?? summary).length > WEB_SEARCH_LIMITS.excerptChars) truncated = true;
        const e: WebEvidence = { id: newId('evidence'), runId, url, title: clean(item.title, 120) || new URL(url).hostname,
          excerpt, retrievedAt, publishedAt: typeof item.date === 'string' && Number.isFinite(Date.parse(item.date)) ? new Date(item.date).toISOString() : null,
          contentKind: content ? 'content' : 'summary', provider: 'deepseek' };
        // Leave room for the tool envelope and its truncation warning.
        if (Buffer.byteLength(JSON.stringify([...results, e])) > WEB_SEARCH_LIMITS.resultBytes - 1024) { truncated = true; break; }
        seen.add(url); results.push(e); if (results.length >= WEB_SEARCH_LIMITS.results) break;
      }
      return { ok: true, data: { kind: 'web_search', results }, warnings: !results.length ?
        [{ code: 'SEARCH_EMPTY', message: '本次联网搜索没有返回可引用的网页内容。', sourceId: null }] : truncated ?
        [{ code: 'WEB_EXCERPT_TRUNCATED', message: '部分网页摘录或结果因容量省略；这些摘录不代表网页全文，可围绕缺口换词继续搜索。', sourceId: null }] : [], truncated, nextCursor: null };
    } catch (error) {
      if (!ended) this.ledger.endSearch(id, sent ? 'unknown' : 'not_sent');
      if (signal.aborted) throw new ApiError('RUN_INTERRUPTED');
      if (error instanceof ApiError && error.publicError.code === 'CONTEXT_CHANGED') throw error;
      throw new ApiError('SEARCH_UNAVAILABLE');
    }
  }
}
