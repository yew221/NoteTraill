import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ApiError } from './contracts.js';

export const MAX_WEB_BYTES = 2 * 1024 * 1024;
export function publicAddress(value: string): boolean {
  if (isIP(value) === 4) {
    const [a, b, c] = value.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && ((b === 0 && (c === 0 || c === 2)) || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(value) !== 6 || value.includes('.') || value.includes('%')) return false;
  const [left, right = ''] = value.toLowerCase().split('::');
  const first = left ? left.split(':') : [], last = right ? right.split(':') : [];
  const words = value.includes('::') ? [...first, ...Array(8 - first.length - last.length).fill('0'), ...last] : first;
  const [a, b] = words.map(word => parseInt(word, 16));
  // Conservative global-unicast policy, excluding IANA special-purpose and transition ranges.
  return a >= 0x2000 && a <= 0x3fff && !(a === 0x2001 && (b <= 0x1ff || b === 0xdb8)) &&
    a !== 0x2002 && !(a === 0x3fff && b <= 0xfff);
}
export function webUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\x00-\x1f\x7f]/u.test(value)) throw new ApiError('URL_BLOCKED');
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError('URL_BLOCKED'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname || url.href.length > 2048) {
    throw new ApiError('URL_BLOCKED');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (hostname === 'localhost' || /\.(localhost|local|internal|home|lan|test|invalid)$/.test(hostname) ||
      (isIP(hostname) ? !publicAddress(hostname) : !hostname.includes('.'))) throw new ApiError('URL_BLOCKED');
  url.hash = ''; return url;
}
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ApiError('RUN_INTERRUPTED'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export type WebSnapshot = { bytes: Buffer; filename: string; sourceUrl: string; capturedAt: string };
export class WebFetcher {
  protected addresses(hostname: string): Promise<LookupAddress[]> { return lookup(hostname, { all: true, verbatim: true }); }
  protected request(url: URL, address: LookupAddress, signal: AbortSignal): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).request(url, {
        method: 'GET', agent: false, family: address.family, maxHeaderSize: 16384,
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family), signal,
        headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9', 'accept-encoding': 'gzip,deflate,br', 'user-agent': 'NoteTrail/0.1' },
      }, response => { response.on('error', () => {}); resolve(response); });
      request.on('error', reject); request.end();
    });
  }
  async fetch(input: string, signal: AbortSignal): Promise<WebSnapshot> {
    const timeout = new AbortController(), cancel = AbortSignal.any([signal, timeout.signal]);
    const timer = setTimeout(() => timeout.abort(), 15000);
    try {
      let url = webUrl(input);
      for (let redirects = 0; redirects <= 3; redirects++) {
        if (cancel.aborted) throw new ApiError('RUN_INTERRUPTED');
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await bounded(this.addresses(hostname), cancel);
        if (!addresses.length || addresses.some(address => !publicAddress(address.address) || isIP(address.address) !== address.family)) {
          throw new ApiError('URL_BLOCKED');
        }
        const response = await this.request(url, addresses[0], cancel);
        try {
          if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
            if (redirects === 3 || !response.headers.location) throw new ApiError('URL_FETCH_FAILED');
            url = webUrl(new URL(response.headers.location, url).href); continue;
          }
          const media = response.headers['content-type']?.split(';')[0].trim().toLowerCase();
          if (response.statusCode !== 200 || !['text/html', 'application/xhtml+xml', 'text/plain'].includes(media ?? '')) {
            throw new ApiError('URL_FETCH_FAILED');
          }
          const length = response.headers['content-length'];
          if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_WEB_BYTES)) throw new ApiError('FILE_TOO_LARGE');
          const encoding = response.headers['content-encoding']?.trim().toLowerCase() ?? 'identity';
          if (!['identity', 'gzip', 'deflate', 'br'].includes(encoding)) throw new ApiError('URL_FETCH_FAILED');
          const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null;
          const chunks: Buffer[] = []; let size = 0, wire = 0;
          response.on('data', (chunk: Buffer) => { wire += chunk.length; if (wire > MAX_WEB_BYTES) response.destroy(new ApiError('FILE_TOO_LARGE')); });
          const sink = new Writable({ write(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            if (size > MAX_WEB_BYTES) { callback(new ApiError('FILE_TOO_LARGE')); return; }
            chunks.push(Buffer.from(chunk)); callback();
          } });
          if (decoder) await pipeline(response, decoder, sink, { signal: cancel });
          else await pipeline(response, sink, { signal: cancel });
          if (!size) throw new ApiError('URL_FETCH_FAILED');
          return { bytes: Buffer.concat(chunks), filename: media === 'text/plain' ? '网页.txt' : '网页.html',
            sourceUrl: url.href, capturedAt: new Date().toISOString() };
        } finally { response.destroy(); }
      }
      throw new ApiError('URL_FETCH_FAILED');
    } catch (error) {
      if (signal.aborted) throw new ApiError('RUN_INTERRUPTED');
      if (timeout.signal.aborted) throw new ApiError('DEADLINE_EXCEEDED');
      throw error instanceof ApiError ? error : new ApiError('URL_FETCH_FAILED');
    } finally { clearTimeout(timer); }
  }
}
