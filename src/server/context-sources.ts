import { createHash } from 'node:crypto';
import { isExcluded, type Source } from '../shared/vault.js';
import { inScope, type Scope } from '../shared/tools.js';
export { inScope };
import type { SqliteDatabase } from './storage.js';
import type { VaultService } from './vaults.js';
import { ApiError } from './contracts.js';

export const normalizeScope = (scope: Scope): Scope => scope.mode === 'vault' ? { mode: 'vault' } :
  { mode: 'selected', paths: [...new Set(scope.paths.map(p => p.replace(/\/$/, '').normalize('NFC')))].sort() };
// Only facts returned to the model participate. updatedAt and scan timestamps are not content.
export function sourceSnapshot(source: Source): string {
  return JSON.stringify({ id: source.id, vaultId: source.vaultId, relativePath: source.relativePath,
    state: source.state, version: source.version, representation: source.readableRepresentation,
    origin: source.origin, sourceUrl: source.sourceUrl, capturedAt: source.capturedAt, warnings: source.warnings });
}
export function scopedSources(vaults: VaultService, vaultId: string, scope: Scope): Source[] {
  const exclusions = vaults.get(vaultId).exclusions, result: Source[] = [];
  let cursor: string | null = null;
  do {
    const page = vaults.sources(vaultId, { limit: '50', ...(cursor ? { cursor } : {}) });
    result.push(...page.items.filter(s => inScope(scope, s.relativePath) && !isExcluded(s.relativePath, exclusions)));
    cursor = page.nextCursor;
  } while (cursor);
  return result.sort((a, b) => a.id.localeCompare(b.id));
}
export const catalogHash = (vaults: VaultService, vaultId: string, scope: Scope): string =>
  createHash('sha256').update(JSON.stringify(scopedSources(vaults, vaultId, scope).map(sourceSnapshot))).digest('hex');

export function recordSource(db: SqliteDatabase, runId: string, source: Source): void {
  // Keep the first value: seeing a new version in the same run must not erase an older dependency.
  db.prepare('INSERT OR IGNORE INTO context_sources(run_id,source_id,snapshot_json) VALUES (?,?,?)')
    .run(runId, source.id, sourceSnapshot(source));
}

// Pre-existing answers may inherit facts from a Pi segment without making their own tool call.
// Resolve that lineage as well as explicit version continuations; never inspect later messages.
export function answerDependencyRuns(db: SqliteDatabase, runId: string): string[] {
  const seen=new Set<string>(), segments=new Map<string,number>(), pending=[runId];
  while(pending.length) {
    const id=pending.pop()!; if(seen.has(id))continue; seen.add(id);
    const message=db.prepare('SELECT session_id,segment_id,ordinal,input_json FROM messages WHERE run_id=?').get(id) as
      {session_id:string;segment_id:string|null;ordinal:number;input_json:string}|undefined;
    if(!message)continue;
    const segment=`${message.session_id}:${message.segment_id}`;
    if(message.segment_id && (segments.get(segment) ?? 0)<message.ordinal) { segments.set(segment,message.ordinal); for(const row of db.prepare('SELECT run_id FROM messages WHERE session_id=? AND segment_id=? AND ordinal<?')
      .all(message.session_id,message.segment_id,message.ordinal) as {run_id:string}[]) if(!seen.has(row.run_id))pending.push(row.run_id); }
    const reference=JSON.parse(message.input_json).basedOnAnswerId;
    // This server-written flag means that old body was deliberately omitted. Actual inherited sources are copied at commit.
    const omittedReference=!!db.prepare("SELECT 1 FROM answers WHERE run_id=? AND json_extract(body_json,'$.retrospectiveBase.available')=0").get(id);
    if(reference && !omittedReference) { const answer=db.prepare('SELECT run_id FROM answers WHERE id=? AND session_id=?').get(reference,message.session_id) as {run_id:string}|undefined;
      if(answer && !seen.has(answer.run_id))pending.push(answer.run_id); }
  }
  return [...seen];
}
export async function checkSources(db: SqliteDatabase, vaults: VaultService, runIds: string[], vaultId: string,
  scope: Scope, signal: AbortSignal, verified?:Map<string,string>): Promise<void> {
  const seen = new Map<string, string>();
  for (const runId of runIds) {
    const rows = db.prepare('SELECT source_id,snapshot_json FROM context_sources WHERE run_id=?').all(runId) as
      { source_id: string; snapshot_json: string }[];
    for (const row of rows) {
      if (seen.has(row.source_id) && seen.get(row.source_id) !== row.snapshot_json) throw new ApiError('CONTEXT_CHANGED');
      seen.set(row.source_id, row.snapshot_json);
    }
  }
  for (const [id, snapshot] of seen) {
    if (signal.aborted) throw new ApiError('RUN_INTERRUPTED');
    const source = vaults.source(id);
    if (source.vaultId !== vaultId || !inScope(scope, source.relativePath) ||
      isExcluded(source.relativePath, vaults.get(vaultId).exclusions) || sourceSnapshot(source) !== snapshot) throw new ApiError('CONTEXT_CHANGED');
    if (verified?.get(id) !== snapshot && source.version && source.readableRepresentation) await vaults.content(id, 'text', source.version, signal);
    if (sourceSnapshot(vaults.source(id)) !== snapshot) throw new ApiError('CONTEXT_CHANGED');
    verified?.set(id,snapshot);
  }
}

export function checkSourceRecords(db: SqliteDatabase, vaults: VaultService, runIds: string[]): void {
  // Run this again in the final transaction; asynchronous validation must not overwrite a newer scan.
  for (const runId of runIds) {
    const rows = db.prepare('SELECT source_id,snapshot_json FROM context_sources WHERE run_id=?').all(runId) as
      { source_id: string; snapshot_json: string }[];
    for (const row of rows) if (sourceSnapshot(vaults.source(row.source_id)) !== row.snapshot_json) throw new ApiError('CONTEXT_CHANGED');
  }
}
