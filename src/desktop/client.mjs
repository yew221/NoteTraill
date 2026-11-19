import { createHash } from 'node:crypto';
import { isApiFailure, isApiSuccess, isErrorCode } from '../../dist/shared/api.js';
import { evidenceExcerpt } from '../../dist/shared/tools.js';
import { requestRoute } from './bridge.mjs';

const failure = code => Object.assign(new Error(code), { code });
// Lives in the main process. The cookie and the HTTP transport never cross the bridge.
export class DesktopClient {
  #origin; #cookie; #fetch;
  constructor(origin, cookie, transport = fetch) { this.#origin = origin; this.#cookie = cookie; this.#fetch = transport; }
  async #request({ path, method = 'GET', body, key, upload }, text = false) {
    let response;
    try {
      let form;
      if (upload) { form = new FormData(); form.set('meta', JSON.stringify(body)); form.set('file', new Blob([upload.bytes]), upload.name); }
      response = await this.#fetch(this.#origin + path, { method, redirect: 'error', signal: AbortSignal.timeout(path === '/api/v1/ingestions' ? 120_000 : 30_000),
        headers: { origin: this.#origin, cookie: this.#cookie, ...(body === undefined || form ? {} : { 'content-type': 'application/json' }),
          ...(key ? { 'idempotency-key': key } : {}) }, ...(form ? { body: form } : body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (text && response.ok) return Buffer.from(await response.arrayBuffer());
      const value = await response.json();
      if (isApiFailure(value)) throw failure(value.error.code);
      if (!response.ok || !isApiSuccess(value, data => data !== undefined)) throw failure(method !== 'GET' ? 'SUBMISSION_UNKNOWN' : 'SERVICE_UNAVAILABLE');
      return value.data;
    } catch (error) { throw failure(isErrorCode(error.code) || error.code === 'SUBMISSION_UNKNOWN' ? error.code : method !== 'GET' ? 'SUBMISSION_UNKNOWN' : 'SERVICE_UNAVAILABLE'); }
    finally { if (body && typeof body.apiKey === 'string') body.apiKey = ''; }
  }
  async request(input) {
    const route = requestRoute(input);
    if (route.content) {
      const { sourceId, version, view } = route.content;
      const bytes = await this.#request({ path: `/api/v1/sources/${sourceId}/content?view=${view}&expectedVersion=${version}` }, true);
      if (view === 'text') return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const source = await this.#request({ path: `/api/v1/sources/${sourceId}` });
      return { bytes, filename: source.relativePath.split('/').at(-1) };
    }
    if (!route.citation) return this.#request(route);
    const { answerId, evidenceId } = route.citation;
    const view = await this.#request({ path: `/api/v1/answers/${answerId}` });
    const evidence = view.answer.citations.find(item => item.id === evidenceId);
    if (!evidence) throw failure('NOT_FOUND');
    const status = view.citationStatus.find(item => item.evidenceId === evidenceId)?.status ?? 'unavailable';
    const result = { status, checkedAt: view.checkedAt };
    // A revoked/missing/changed source must not leave an old excerpt masquerading as current text.
    if (status !== 'current') return result;
    const source = await this.#request({ path: `/api/v1/sources/${evidence.sourceId}` });
    const bytes = await this.#request({ path: `/api/v1/sources/${evidence.sourceId}/content?view=text&expectedVersion=${evidence.sourceVersion}` }, true);
    if (createHash('sha256').update(bytes).digest('hex') !== evidence.representationHash) throw failure('SOURCE_CHANGED');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (evidenceExcerpt(text, evidence.location) !== evidence.excerpt) throw failure('CITATION_INVALID');
    return { ...result, source, evidence, text };
  }
}
