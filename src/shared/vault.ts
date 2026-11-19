import { hasFields, isPayloadHash, isRevision, type Id } from './contracts.js';
import type { AppError } from './api.js';

export const SOURCE_STATES = ['pending', 'processing', 'ready', 'partial', 'failed', 'unsupported',
  'stale', 'missing', 'excluded', 'needs_review'] as const;
export type SourceState = typeof SOURCE_STATES[number];
export const isSourceState = (value: unknown): value is SourceState =>
  typeof value === 'string' && SOURCE_STATES.some(state => state === value);
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const DEFAULT_EXCLUSIONS = ['.obsidian/', '.git/', '.trash/', '助手资料/提取文本/'] as const;
export type VaultInput = { absolutePath: string; exclusions: string[] };
export type VaultUpdate = { expectedRevision: number; exclusions: string[] };
export type Vault = {
  locationKey?: string;
  id: Id<'vault'>; name: string; revision: number; exclusions: string[];
  discovery: { state: 'pending' | 'scanning' | 'ready' | 'failed'; checkedAt: string | null;
    scanned: number; skipped: number; error: AppError | null };
};
export type Source = {
  id: Id<'source'>; vaultId: Id<'vault'>; relativePath: string; title: string;
  origin: 'existing_file' | 'imported_file' | 'web_snapshot' | 'pasted_text' | 'imported_chat' | 'ai_saved';
  mediaType: string; version: string | null; state: SourceState;
  readableRepresentation: { kind: 'original_text' | 'extracted_markdown'; hash: string;
    relativePath: string; extractorVersion: string | null } | null;
  originalSaved: boolean; sourceUrl: string | null; capturedAt: string | null;
  warnings: Array<{ code: string; message: string; sourceId: Id<'source'> }>; updatedAt: string;
};
export type Page<T> = { items: T[]; nextCursor: string | null };

const clean = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
  value.length <= 1024 && !/[\\\x00-\x1f\x7f]/.test(value) && !/[\ud800-\udfff]/u.test(value);
export function isRelativePath(value: unknown, directory = false): value is string {
  if (!clean(value) || value.startsWith('/')) return false;
  const parts = (directory && value.endsWith('/') ? value.slice(0, -1) : value).split('/');
  return parts.every(part => part !== '' && part !== '.' && part !== '..');
}
export const isExclusions = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 50 && value.every(item => isRelativePath(item, true)) &&
  new Set(value.map(item => item.normalize('NFC').toLowerCase())).size === value.length;
export const isVaultInput = (value: unknown): value is VaultInput =>
  hasFields(value, ['absolutePath', 'exclusions']) && clean(value.absolutePath) &&
  value.absolutePath.startsWith('/') && isRelativePath(value.absolutePath.slice(1)) && isExclusions(value.exclusions);
export const isVaultUpdate = (value: unknown): value is VaultUpdate =>
  hasFields(value, ['expectedRevision', 'exclusions']) && isRevision(value.expectedRevision) && isExclusions(value.exclusions);
export function isExcluded(relativePath: string, exclusions: readonly string[]): boolean {
  const candidate = relativePath.normalize('NFC').toLowerCase();
  if (candidate.split('/').some(part => ['.obsidian', '.git', '.trash', '.ds_store'].includes(part))) return true;
  if (candidate.split('/').some(part => part.startsWith('.notetrail-'))) return true;
  return [...DEFAULT_EXCLUSIONS, ...exclusions].some(item => {
    const rule = item.replace(/\/$/, '').normalize('NFC').toLowerCase();
    return candidate === rule || candidate.startsWith(`${rule}/`);
  });
}
export const isContentQuery = (value: unknown): value is { view: 'original' | 'text'; expectedVersion: string } =>
  hasFields(value, ['view', 'expectedVersion']) && (value.view === 'original' || value.view === 'text') && isPayloadHash(value.expectedVersion);
