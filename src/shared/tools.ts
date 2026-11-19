import type { AppError } from './api.js';
import { hasFields, type Id } from './contracts.js';
import { isRelativePath, type Source } from './vault.js';

export type Scope = { mode: 'vault' } | { mode: 'selected'; paths: string[] };
export function inScope(scope: Scope, relativePath: string): boolean {
  const p = relativePath.normalize('NFC');
  return scope.mode === 'vault' || scope.paths.some(value => { const parent = value.replace(/\/$/, '').normalize('NFC'); return p === parent || p.startsWith(`${parent}/`); });
}
export const isScope = (value: unknown): value is Scope =>
  (hasFields(value, ['mode']) && value.mode === 'vault') ||
  (hasFields(value, ['mode', 'paths']) && value.mode === 'selected' && Array.isArray(value.paths) &&
    value.paths.length > 0 && value.paths.length <= 50 && value.paths.every(item => isRelativePath(item, true)));
export const TOOL_NAMES = ['vault_list', 'vault_search', 'vault_read', 'vault_status', 'web_search'] as const;
export type ToolName = typeof TOOL_NAMES[number];
export const WEB_SEARCH_LIMITS = Object.freeze({ calls: 6, results: 5, excerptChars: 2000,
  queryChars: 128, reasonChars: 1000, timeoutMs: 45000, resultBytes: 32 * 1024 });
export const LOCAL_SEARCH_LIMITS = Object.freeze({ terms: 16, termBytes: 512, perFile: 5000, candidates: 20000 });
export type ToolWarning = { code: string; message: string; sourceId: Id<'source'> | null };
export type ToolResult<T = unknown> = { ok: true; data: T; warnings: ToolWarning[]; truncated: boolean; nextCursor: string | null } |
  { ok: false; error: AppError };
export type Evidence = {
  id: Id<'evidence'>; runId: Id<'run'>; sourceId: Id<'source'>;
  sourceVersion: string; representationHash: string; excerpt: string;
  location: { kind: 'markdown_lines'; startLine: number; endLine: number; heading: string | null; refersTo: 'original' | 'extracted'; startOffset?: number; endOffset?: number };
  originalLocator: null | { kind: 'page'; page: number } | { kind: 'sheet'; sheet: string; range: string | null };
  origin: Source['origin']; warnings: ToolWarning[];
};
export type WebEvidence = { id: Id<'evidence'>; runId: Id<'run'>; url: string; title: string;
  excerpt: string; retrievedAt: string; publishedAt: string | null; contentKind: 'content' | 'summary'; provider: 'deepseek' };
// Keep CRLF, trailing newlines and UTF-16 offsets identical when producing and reopening citations.
export function evidenceExcerpt(text: string, location: Evidence['location']): string | null {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const { startLine, endLine } = location;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > lines.length) return null;
  const selected = lines.slice(startLine - 1, endLine);
  const from = location.startOffset ?? 0, to = location.endOffset ?? selected.at(-1)!.length;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 1 || from >= selected[0].length || to > selected.at(-1)!.length || (selected.length === 1 && to <= from)) return null;
  selected[selected.length - 1] = selected.at(-1)!.slice(0, to);
  selected[0] = selected[0].slice(from);
  return selected.join('');
}
export type ToolLimits = { maxToolCalls: number; maxReadBytes: number; maxReadLines: number; maxReadBytesPerCall: number };
export const TOOL_LIMITS: Readonly<ToolLimits> = Object.freeze({
  maxToolCalls: 60, maxReadBytes: 256 * 1024, maxReadLines: 10000, maxReadBytesPerCall: 16 * 1024,
});
