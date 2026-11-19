import { createHash } from 'node:crypto';
import { isIngestInput, type IngestInput } from '../shared/ingest.js';
import { isExcluded, MAX_FILE_BYTES, type Source } from '../shared/vault.js';
import type { Id } from '../shared/contracts.js';
import { ApiError, newId } from './contracts.js';
import { isErrorCode } from '../shared/api.js';
import { WebFetcher, webUrl } from './web-fetch.js';
import type { SqliteDatabase } from './storage.js';
import type { VaultService } from './vaults.js';
import { IngestFiles } from './ingest-files.js';

export type Upload = { filename: string; bytes: Buffer };
export type Intake = { vaultId: Id<'vault'>; revision: number; origin: Source['origin']; filename: string;
  version: string; bytes: Buffer; payloadHash: string };
export type StagedIntake = { operationId: Id<'operation'>; sourceId: Id<'source'>; relativePath: string };
type Operation = { id: Id<'operation'>; source_id: Id<'source'>; vault_id: Id<'vault'>; vault_revision: number;
  filename: string; version: string; bytes: number; phase: 'prepared' | 'published' | 'registered'; staged: number };
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function safeFilename(name: string): string {
  const cleaned = name.normalize('NFC').replace(/[\\/\x00-\x1f\x7f:*?\[\]]/g, '-').replace(/^\.+/, '').trim() || '资料';
  const extension = cleaned.match(/\.[a-zA-Z0-9]{1,12}$/)?.[0] ?? '';
  let stem = '';
  for (const char of cleaned.slice(0, cleaned.length - extension.length)) {
    if (Buffer.byteLength(stem + char) > 180) break;
    stem += char;
  }
  return (stem || '资料') + extension;
}

export class IngestService {
  constructor(private readonly db: SqliteDatabase, private readonly vaults: VaultService, private readonly files: IngestFiles,
    private readonly web = new WebFetcher()) {}
  normalize(input: IngestInput, upload?: Upload): Intake {
    if (!isIngestInput(input) || input.input.kind === 'url' || (input.input.kind === 'upload') !== (upload !== undefined)) throw new ApiError('BAD_REQUEST');
    const vault = this.vaults.get(input.vaultId);
    if (upload && (!Buffer.isBuffer(upload.bytes) || typeof upload.filename !== 'string' ||
        upload.filename.length > 1024 || /[\ud800-\udfff]/u.test(upload.filename))) throw new ApiError('BAD_REQUEST');
    const bytes = input.input.kind === 'text' ? Buffer.from(input.input.text, 'utf8') : upload!.bytes;
    if (bytes.length > MAX_FILE_BYTES) throw new ApiError('FILE_TOO_LARGE');
    const filename = safeFilename(input.input.kind === 'text' ? `${input.input.title ?? '资料'}.md` : upload!.filename);
    const origin = input.input.kind === 'text' ? input.input.origin ?? 'pasted_text' : 'imported_file';
    const version = hash(bytes);
    return { vaultId: vault.id, revision: vault.revision, origin, filename, version, bytes,
      payloadHash: hash(JSON.stringify({ vaultId: vault.id, origin, filename, version })) };
  }
  normalizeWeb(input: IngestInput): { vaultId: Id<'vault'>; revision: number; url: string; payloadHash: string } {
    if (!isIngestInput(input) || input.input.kind !== 'url') throw new ApiError('BAD_REQUEST');
    const vault = this.vaults.get(input.vaultId), url = webUrl(input.input.url).href;
    return { vaultId: vault.id, revision: vault.revision, url, payloadHash: hash(JSON.stringify({ vaultId: vault.id, url })) };
  }
  registerWeb(runId: string, input: ReturnType<IngestService['normalizeWeb']>): void {
    const id = newId('source'), relativePath = `助手资料/原件/${id}/网页.html`;
    if (isExcluded(relativePath, this.vaults.get(input.vaultId).exclusions)) throw new ApiError('SOURCE_EXCLUDED');
    this.db.prepare(`INSERT INTO sources(id,vault_id,relative_path,origin,media_type,state,original_saved,source_url,warnings_json,updated_at)
      VALUES (?,?,?,'web_snapshot','text/html','pending',0,?,'[]',?)`).run(id, input.vaultId, relativePath, input.url, new Date().toISOString());
    this.db.prepare('INSERT INTO web_inputs(source_id,requested_url) VALUES (?,?)').run(id, input.url);
    this.db.prepare('UPDATE runs SET source_id=?,scope_revision=? WHERE id=?').run(id, input.revision, runId);
  }
  private async fetchWeb(source: Source, url: string, revision: number, signal: AbortSignal, onSaved: (source: Source) => void) {
    const scopeAbort = new AbortController();
    const unsubscribe = this.vaults.onScopeChange(id => { if (id === source.vaultId) scopeAbort.abort(); });
    const cancel = AbortSignal.any([signal, scopeAbort.signal]);
    let staged: StagedIntake | undefined, version: string | undefined, registered = false;
    try {
      if (this.vaults.get(source.vaultId).revision !== revision) throw new ApiError('CONTEXT_CHANGED');
      onSaved(source);
      const snapshot = await this.web.fetch(url, cancel);
      version = hash(snapshot.bytes);
      staged = { sourceId: source.id, operationId: newId('operation'), relativePath: `助手资料/原件/${source.id}/${snapshot.filename}` };
      await this.files.stage(staged.operationId, version, snapshot.bytes, cancel);
      if (cancel.aborted) throw new ApiError('RUN_INTERRUPTED');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (this.vaults.get(source.vaultId).revision !== revision) throw new ApiError('CONTEXT_CHANGED');
        this.db.prepare('UPDATE sources SET relative_path=?,source_url=?,captured_at=?,state=\'pending\',warnings_json=\'[]\',updated_at=? WHERE id=?')
          .run(staged.relativePath, snapshot.sourceUrl, snapshot.capturedAt, new Date().toISOString(), source.id);
        this.db.prepare(`INSERT INTO ingest_operations(id,source_id,vault_id,vault_revision,filename,version,bytes,phase)
          VALUES (?,?,?,?,?,?,?,'prepared')`).run(staged.operationId, source.id, source.vaultId, revision, snapshot.filename, version, snapshot.bytes.length);
        this.db.exec('COMMIT'); registered = true;
      } catch (error) { if (this.db.inTransaction) this.db.exec('ROLLBACK'); throw error; }
      return await this.execute(staged.operationId, cancel, onSaved, revision);
    } catch (error) {
      const code = scopeAbort.signal.aborted ? 'CONTEXT_CHANGED' : error instanceof ApiError ? error.publicError.code : 'URL_FETCH_FAILED';
      this.db.prepare("UPDATE sources SET state='failed',warnings_json=?,updated_at=? WHERE id=? AND original_saved=0 AND state!='excluded'")
        .run(JSON.stringify([code]), new Date().toISOString(), source.id);
      throw new ApiError(code, { sourceId: source.id });
    } finally {
      unsubscribe();
      if (staged && version && !registered) await this.files.discard(staged.operationId, version).catch(() => {});
    }
  }
  async stage(intake: Intake): Promise<StagedIntake> {
    const sourceId = newId('source'), operationId = newId('operation');
    const relativePath = `助手资料/原件/${sourceId}/${intake.filename}`;
    if (isExcluded(relativePath, this.vaults.get(intake.vaultId).exclusions)) throw new ApiError('SOURCE_EXCLUDED');
    await this.files.stage(operationId, intake.version, intake.bytes);
    return { operationId, sourceId, relativePath };
  }
  register(runId: Id<'run'>, intake: Intake, staged: StagedIntake): void {
    const vault = this.vaults.get(intake.vaultId);
    if (vault.revision !== intake.revision) throw new ApiError('CONTEXT_CHANGED');
    this.db.prepare(`INSERT INTO sources(id,vault_id,relative_path,origin,media_type,state,original_saved,warnings_json,updated_at)
      VALUES (?,?,?,?,'application/octet-stream','pending',0,'[]',?)`)
      .run(staged.sourceId, vault.id, staged.relativePath, intake.origin, new Date().toISOString());
    this.db.prepare(`INSERT INTO ingest_operations(id,source_id,vault_id,vault_revision,filename,version,bytes,phase)
      VALUES (?,?,?,?,?,?,?,'prepared')`)
      .run(staged.operationId, staged.sourceId, vault.id, vault.revision, intake.filename, intake.version, intake.bytes.length);
    this.db.prepare('UPDATE runs SET operation_id=? WHERE id=?').run(staged.operationId, runId);
  }
  discard(staged: StagedIntake, version: string): Promise<void> { return this.files.discard(staged.operationId, version); }
  private operation(id: string): Operation {
    const operation = this.db.prepare('SELECT * FROM ingest_operations WHERE id=?').get(id) as Operation | undefined;
    if (!operation) throw new ApiError('SERVICE_UNAVAILABLE');
    return operation;
  }
  private async publication(operation: Operation, signal: AbortSignal, recover: boolean): Promise<boolean> {
    const { revision: _revision, ...location } = this.vaults.context(operation.vault_id);
    return this.files.publish({ ...location, operationId: operation.id, sourceId: operation.source_id,
      vaultId: operation.vault_id, version: operation.version, filename: operation.filename }, signal, recover);
  }
  private saved(operation: Operation): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE sources SET original_saved=1,version=?,state='pending',warnings_json='[]',updated_at=? WHERE id=?")
        .run(operation.version, new Date().toISOString(), operation.source_id);
      this.db.prepare("UPDATE ingest_operations SET phase='published' WHERE id=?").run(operation.id);
      this.db.exec('COMMIT');
    } catch (error) { if (this.db.inTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  private async registered(operation: Operation): Promise<void> {
    this.db.prepare("UPDATE ingest_operations SET phase='registered' WHERE id=?").run(operation.id);
    try {
      await this.files.discard(operation.id, operation.version);
      this.db.prepare('UPDATE ingest_operations SET staged=0 WHERE id=?').run(operation.id);
    } catch { /* Keep the staged bytes and reference when cleanup cannot be verified. */ }
  }
  private result(source: Source): { sourceId: Id<'source'>; sourceState: Source['state'] } {
    if (!['ready', 'partial', 'unsupported'].includes(source.state)) {
      const code = source.warnings[0]?.code;
      throw new ApiError(isErrorCode(code) ? code : 'SOURCE_NOT_READY', { sourceId: source.id });
    }
    return { sourceId: source.id, sourceState: source.state };
  }
  async retry(sourceId: string, expectedVersion: string | null, revision: number, signal: AbortSignal, onSaved: (source: Source) => void) {
    const source = this.vaults.source(sourceId);
    if (source.state === 'missing') throw new ApiError('SOURCE_MISSING', { sourceId: source.id });
    if (source.state === 'excluded') throw new ApiError('SOURCE_EXCLUDED', { sourceId: source.id });
    if (!source.originalSaved) {
      const operation = this.db.prepare('SELECT id FROM ingest_operations WHERE source_id=?').get(sourceId) as { id: string } | undefined;
      if (operation) return this.execute(operation.id, signal, onSaved, revision);
      const web = this.db.prepare('SELECT requested_url FROM web_inputs WHERE source_id=?').get(sourceId) as { requested_url: string } | undefined;
      if (web) return this.fetchWeb(source, web.requested_url, revision, signal, onSaved);
      throw new ApiError('SOURCE_NOT_READY', { sourceId: source.id });
    }
    const prepared = await this.vaults.retrySource(sourceId, expectedVersion, revision, signal, onSaved);
    onSaved(prepared); return this.result(prepared);
  }
  async execute(operationId: string, signal: AbortSignal, onSaved: (source: Source) => void, revision?: number): Promise<{ sourceId: Id<'source'>; sourceState: Source['state'] }> {
    const operation = this.operation(operationId), scopeAbort = new AbortController();
    const unsubscribe = this.vaults.onScopeChange(id => { if (id === operation.vault_id) scopeAbort.abort(); });
    const cancel = AbortSignal.any([signal, scopeAbort.signal]);
    try {
      if (this.vaults.get(operation.vault_id).revision !== (revision ?? operation.vault_revision)) throw new ApiError('CONTEXT_CHANGED');
      const alreadySaved = await this.publication(operation, cancel, true);
      if (!alreadySaved) {
        await this.vaults.checkIntakeCapacity(operation.vault_id, operation.bytes, cancel);
        if (cancel.aborted) throw new ApiError('RUN_INTERRUPTED');
        await this.publication(operation, cancel, false);
      }
      if (cancel.aborted) throw new ApiError('RUN_INTERRUPTED');
      this.saved(operation);
      onSaved(this.vaults.source(operation.source_id));
      await this.vaults.scan(operation.vault_id, cancel);
      if (cancel.aborted) throw new ApiError('RUN_INTERRUPTED');
      let source = this.vaults.source(operation.source_id);
      if (source.version !== operation.version) throw new ApiError('SOURCE_CHANGED', { sourceId: source.id });
      if (cancel.aborted) throw new ApiError('RUN_INTERRUPTED');
      [source] = await Promise.all([this.vaults.prepareSource(source.id, cancel, onSaved), this.registered(operation)]);
      if (cancel.aborted) throw new ApiError('RUN_INTERRUPTED');
      if (source.version !== operation.version) throw new ApiError('SOURCE_CHANGED', { sourceId: source.id });
      onSaved(source);
      return this.result(source);
    } catch (error) {
      if (scopeAbort.signal.aborted) throw new ApiError('CONTEXT_CHANGED', { sourceId: operation.source_id });
      const code = error instanceof ApiError ? error.publicError.code : 'SERVICE_UNAVAILABLE';
      this.db.prepare("UPDATE sources SET state='failed',warnings_json=?,updated_at=? WHERE id=? AND original_saved=0 AND state='pending'")
        .run(JSON.stringify([code]), new Date().toISOString(), operation.source_id);
      throw new ApiError(code, { sourceId: operation.source_id });
    } finally { unsubscribe(); }
  }
  async recover(): Promise<void> {
    const rows = this.db.prepare('SELECT * FROM ingest_operations WHERE phase!=? OR staged=1').all('registered') as Operation[];
    for (const operation of rows) {
      try {
        if (operation.phase === 'registered') { await this.registered(operation); continue; }
        if (await this.publication(operation, new AbortController().signal, true)) {
          this.saved(operation);
          await this.vaults.scan(operation.vault_id);
          if (this.vaults.source(operation.source_id).version === operation.version) await this.registered(operation);
        }
      } catch { /* Never recreate missing originals or overwrite ambiguous files during recovery. */ }
    }
  }
  close(): void { this.files.close(); }
}
