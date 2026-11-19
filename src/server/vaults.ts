import { createHash } from 'node:crypto';
import path from 'node:path';
import { watch, type FSWatcher } from 'node:fs';
import { setMaxListeners } from 'node:events';
import { makeError, isErrorCode, type ErrorCode } from '../shared/api.js';
import { hasFields, isId, isPayloadHash } from '../shared/contracts.js';
import { isVaultInput, isVaultUpdate, isExclusions, isExcluded, isRelativePath, isSourceState,
  type VaultInput, type VaultUpdate, type Vault, type Source, type Page } from '../shared/vault.js';
import { ApiError, checkRevision, newId, requireId } from './contracts.js';
import type { SqliteDatabase } from './storage.js';
import { VaultFiles, type VaultLocation } from './vault-files.js';
import { ConversionFiles, conversionInput } from './conversion-files.js';
import type { RefreshResult } from '../shared/run.js';

type VaultRow = { id: Vault['id']; root_path: string; root_device: string; root_inode: string; revision: number;
  exclusions_json: string; scan_generation: number; scan_state: Vault['discovery']['state'];
  scanned_at: string | null; scan_error_code: ErrorCode | null; skipped_count: number };
type SourceRow = { id: Source['id']; vault_id: Source['vaultId']; relative_path: string; origin: Source['origin'];
  media_type: string; version: string | null; state: Source['state']; original_saved: number;
  source_url: string | null; captured_at: string | null; warnings_json: string; updated_at: string };

export class VaultService {
  private watcher?: FSWatcher;
  private interval?: NodeJS.Timeout;
  private debounce?: NodeJS.Timeout;
  private rescanRequested = false;
  private closed = false;
  private readonly scans = new Set<Promise<Vault>>();
  private readonly derivedChecks = new Map<string, string>();
  private readonly scopeListeners = new Set<(id: string) => void>();
  private conversionTail: Promise<unknown> = Promise.resolve();
  private readonly conversions = new Map<string, { sourceId: string; version: string; abort: AbortController;
    listeners: Set<(source: Source) => void>; promise: Promise<Source> }>();
  constructor(private readonly db: SqliteDatabase, private readonly files: VaultFiles, private readonly converter?: ConversionFiles) {
    // Track committed metadata changes on this service's SQLite connection. No user database migration or disk scan.
    this.db.exec('CREATE TEMP TABLE IF NOT EXISTS source_catalog_revisions(vault_id TEXT PRIMARY KEY, revision INTEGER NOT NULL)');
    for (const [event, ref, guard] of [
      ['INSERT', 'NEW', ''], ['DELETE', 'OLD', ''],
      ['UPDATE', 'NEW', `WHEN NEW.updated_at IS NOT OLD.updated_at OR NEW.state IS NOT OLD.state OR NEW.version IS NOT OLD.version
        OR NEW.relative_path IS NOT OLD.relative_path OR NEW.original_saved IS NOT OLD.original_saved OR NEW.warnings_json IS NOT OLD.warnings_json
        OR NEW.origin IS NOT OLD.origin OR NEW.media_type IS NOT OLD.media_type OR NEW.source_url IS NOT OLD.source_url OR NEW.captured_at IS NOT OLD.captured_at`],
    ]) this.db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS catalog_after_${event} AFTER ${event} ON main.sources ${guard} BEGIN
      INSERT INTO source_catalog_revisions(vault_id,revision) VALUES(${ref}.vault_id,1)
      ON CONFLICT(vault_id) DO UPDATE SET revision=revision+1; END`);
    if (converter) this.db.prepare("UPDATE sources SET state='pending' WHERE state='processing'").run();
  }
  catalogRevision(vaultId: string): number {
    this.row(vaultId);
    return (this.db.prepare('SELECT revision FROM temp.source_catalog_revisions WHERE vault_id=?').get(vaultId) as {revision:number} | undefined)?.revision ?? 0;
  }
  startMonitoring(): void {
    if (this.closed || this.interval) return;
    this.interval = setInterval(() => { this.ensureWatcher(); this.requestScan(); }, 2000);
    this.interval.unref();
    this.ensureWatcher();
    this.requestScan();
  }
  private ensureWatcher(): void {
    if (this.closed || this.watcher || !this.interval) return;
    const row = this.db.prepare('SELECT root_path FROM vaults WHERE singleton=1').get() as { root_path: string } | undefined;
    if (!row) return;
    try {
      // Notifications schedule descriptor-checked reconciliation; their paths are never trusted.
      const watcher = watch(row.root_path, { recursive: true, persistent: false }, () => this.requestScan());
      this.watcher = watcher;
      watcher.on('error', () => {
        watcher.close();
        if (this.watcher === watcher) this.watcher = undefined;
        this.requestScan();
      });
    } catch { /* Periodic reconciliation still runs when native watching is unavailable. */ }
  }
  private requestScan(): void {
    if (this.closed) return;
    this.rescanRequested = true;
    if (this.debounce || this.scans.size) return;
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      if (this.closed || this.scans.size) return;
      this.rescanRequested = false;
      const row = this.db.prepare('SELECT id FROM vaults WHERE singleton=1').get() as { id: string } | undefined;
      if (row) void this.scan(row.id).catch(() => { /* The vault exposes the failed discovery state. */ });
    }, 100);
    this.debounce.unref();
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.interval); clearTimeout(this.debounce);
    this.watcher?.close(); this.files.close(); this.converter?.close();
    this.derivedChecks.clear();
    for (const job of this.conversions.values()) job.abort.abort();
    await Promise.allSettled(this.scans);
    await this.conversionTail;
  }
  private row(id?: string): VaultRow {
    if (id !== undefined) requireId(id, 'vault');
    const row = this.db.prepare('SELECT * FROM vaults WHERE singleton=1').get() as VaultRow | undefined;
    if (!row || (id !== undefined && row.id !== id)) throw new ApiError('NOT_FOUND');
    if (!isId(row.id, 'vault') || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new ApiError('SERVICE_UNAVAILABLE');
    return row;
  }
  private location(row: VaultRow): VaultLocation {
    const exclusions: unknown = JSON.parse(row.exclusions_json);
    if (!isExclusions(exclusions)) throw new ApiError('SERVICE_UNAVAILABLE');
    return { root: row.root_path, identity: { device: row.root_device, inode: row.root_inode }, exclusions };
  }
  context(id: string): VaultLocation & { revision: number } {
    const row = this.row(id);
    return { ...this.location(row), revision: row.revision };
  }
  async checkIntakeCapacity(id: string, bytes: number, signal: AbortSignal): Promise<void> {
    const { revision: _revision, ...location } = this.context(id);
    const snapshot = await this.files.snapshot(location, signal);
    if (snapshot.items.length >= 50000) {
      throw new ApiError('BUDGET_EXCEEDED');
    }
  }
  onScopeChange(listener: (id: string) => void): () => void {
    this.scopeListeners.add(listener);
    return () => { this.scopeListeners.delete(listener); };
  }
  get(id?: string): Vault {
    const row = this.row(id);
    return { locationKey: createHash('sha256').update(`${row.root_device}:${row.root_inode}`).digest('hex'), id: row.id, name: path.basename(row.root_path), revision: row.revision,
      exclusions: this.location(row).exclusions, discovery: { state: row.scan_state, checkedAt: row.scanned_at,
        scanned: (this.db.prepare('SELECT count(*) AS n FROM sources WHERE vault_id=? AND original_saved=1 AND state NOT IN (?,?)')
          .get(row.id, 'missing', 'excluded') as { n: number }).n,
        skipped: row.skipped_count, error: row.scan_error_code && isErrorCode(row.scan_error_code) ? makeError(row.scan_error_code) : null } };
  }
  list(): Page<Vault> {
    return { items: this.db.prepare('SELECT id FROM vaults').get() ? [this.get()] : [], nextCursor: null };
  }
  async connect(input: VaultInput): Promise<Vault> {
    if (this.closed) throw new ApiError('SERVICE_UNAVAILABLE');
    if (!isVaultInput(input)) throw new ApiError('BAD_REQUEST');
    const identity = await this.files.inspect(input.absolutePath, input.exclusions);
    this.db.exec('BEGIN IMMEDIATE');
    let id: Vault['id'];
    try {
      const existing = this.db.prepare('SELECT * FROM vaults WHERE singleton=1').get() as VaultRow | undefined;
      if (existing) {
        if (existing.root_device !== identity.device || existing.root_inode !== identity.inode ||
            existing.exclusions_json !== JSON.stringify(input.exclusions)) throw new ApiError('BAD_REQUEST');
        this.db.exec('COMMIT'); return this.get(existing.id);
      }
      id = newId('vault');
      this.db.prepare('INSERT INTO vaults(id,singleton,root_path,root_device,root_inode,exclusions_json) VALUES (?,1,?,?,?,?)')
        .run(id, input.absolutePath, identity.device, identity.inode, JSON.stringify(input.exclusions));
      this.db.exec('COMMIT');
    } catch (error) { if (this.db.inTransaction) this.db.exec('ROLLBACK'); throw error; }
    this.ensureWatcher();
    try { await this.scan(id); } catch { /* Discovery failure is explicitly exposed on the connected vault. */ }
    return this.get(id);
  }
  update(id: string, input: VaultUpdate): Vault {
    if (this.closed) throw new ApiError('SERVICE_UNAVAILABLE');
    if (!isVaultUpdate(input)) throw new ApiError('BAD_REQUEST');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.row(id);
      checkRevision(input.expectedRevision, row.revision);
      if (row.revision === Number.MAX_SAFE_INTEGER) throw new ApiError('SERVICE_UNAVAILABLE');
      const now = new Date().toISOString();
      this.db.prepare("UPDATE vaults SET revision=revision+1,exclusions_json=?,scan_state='pending',scan_error_code=NULL WHERE id=?")
        .run(JSON.stringify(input.exclusions), id);
      const sources = this.db.prepare('SELECT * FROM sources WHERE vault_id=?').all(id) as SourceRow[];
      for (const source of sources) if (isExcluded(source.relative_path, input.exclusions)) {
        this.db.prepare("UPDATE sources SET state='excluded',version=NULL,warnings_json=?,updated_at=? WHERE id=?")
          .run(JSON.stringify(['SOURCE_EXCLUDED']), now, source.id);
        this.db.prepare('DELETE FROM representations WHERE source_id=?').run(source.id);
      }
      this.db.exec('COMMIT');
    } catch (error) { if (this.db.inTransaction) this.db.exec('ROLLBACK'); throw error; }
    for (const listener of this.scopeListeners) listener(id);
    for (const job of this.conversions.values()) job.abort.abort();
    this.requestScan();
    return this.get(id);
  }
  scan(id: string, signal?: AbortSignal, force = false): Promise<Vault> {
    if (this.closed) return Promise.reject(new ApiError('SERVICE_UNAVAILABLE'));
    const task = this.performScan(id, signal, force).finally(() => {
      this.scans.delete(task);
      if (this.rescanRequested) this.requestScan();
    });
    this.scans.add(task);
    return task;
  }
  private async performScan(id: string, signal?: AbortSignal, force = false): Promise<Vault> {
    const before = this.row(id), generation = before.scan_generation + 1;
    if (signal?.aborted) throw new ApiError('RUN_INTERRUPTED');
    if (!Number.isSafeInteger(generation)) throw new ApiError('SERVICE_UNAVAILABLE');
    this.db.prepare("UPDATE vaults SET scan_generation=?,scan_state='scanning',scan_error_code=NULL WHERE id=?").run(generation, id);
    try {
      const location = this.location(before), snapshot = await this.files.snapshot(location, signal, force);
      const known = this.db.prepare('SELECT * FROM sources WHERE vault_id=?').all(id) as SourceRow[];
      const knownByPath = new Map(known.map(source => [source.relative_path, source]));
      const incomingPaths = new Set(snapshot.items.map(item => item.relativePath));
      const versionCounts = new Map<string, number>();
      const knownByVersion = new Map<string, SourceRow[]>();
      for (const item of snapshot.items) if (item.version) versionCounts.set(item.version, (versionCounts.get(item.version) ?? 0) + 1);
      for (const source of known) if (source.version) knownByVersion.set(source.version, [...(knownByVersion.get(source.version) ?? []), source]);
      const derivedStates = new Map<string, { state: Source['state']; warnings: string }>();
      const checkedDerived = new Map<string, string>();
      if (this.converter) for (const item of snapshot.items) {
        const previous = knownByPath.get(item.relativePath);
        if (!previous || item.state !== 'pending' || previous.version !== item.version || !['ready', 'partial'].includes(previous.state)) continue;
        const source = this.source(previous.id);
        if (source.readableRepresentation?.kind !== 'extracted_markdown') continue;
        const stamp = snapshot.derived[source.id], token = JSON.stringify([before.revision, item.version, source.readableRepresentation.hash, stamp]);
        if (!force && stamp && this.derivedChecks.get(source.id) === token) { checkedDerived.set(source.id, token); continue; }
        try {
          const result = await this.converter.check(conversionInput(location, source), source.readableRepresentation.hash, signal);
          if (!result) derivedStates.set(source.id, { state: 'pending', warnings: '[]' });
          else if (stamp) checkedDerived.set(source.id, token);
        } catch (error) {
          if (!(error instanceof ApiError) || error.publicError.code !== 'DERIVED_MODIFIED') throw error;
          derivedStates.set(source.id, { state: 'needs_review', warnings: JSON.stringify(['DERIVED_MODIFIED']) });
        }
      }
      const renames = new Map<string, SourceRow>();
      for (const item of snapshot.items) {
        if (!item.version || knownByPath.has(item.relativePath) ||
            versionCounts.get(item.version) !== 1) continue;
        const matches = (knownByVersion.get(item.version) ?? []);
        if (matches.length !== 1) continue;
        const candidate = matches[0];
        if (isExcluded(candidate.relative_path, location.exclusions) ||
            incomingPaths.has(candidate.relative_path)) continue;
        if (await this.files.missing(location, candidate.relative_path, signal)) renames.set(item.relativePath, candidate);
      }
      if (this.closed || signal?.aborted) throw new ApiError('RUN_INTERRUPTED');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const current = this.row(id);
        if (current.revision !== before.revision || current.scan_generation !== generation) throw new ApiError('CONTEXT_CHANGED');
        const existing = this.db.prepare('SELECT * FROM sources WHERE vault_id=?').all(id) as SourceRow[];
        const byPath = new Map(existing.map(source => [source.relative_path, source]));
        const now = new Date().toISOString();
        for (const item of snapshot.items) {
          const candidate = renames.get(item.relativePath);
          if (candidate && byPath.get(candidate.relative_path)?.version === candidate.version && !byPath.has(item.relativePath)) {
            this.db.prepare('UPDATE sources SET relative_path=? WHERE id=?').run(item.relativePath, candidate.id);
            byPath.delete(candidate.relative_path); byPath.set(item.relativePath, candidate);
          }
          const previous = byPath.get(item.relativePath), sourceId = previous?.id ?? newId('source');
          const preserve = previous && item.state === 'pending' && previous.version === item.version &&
            ['ready', 'partial', 'processing', 'failed', 'unsupported', 'needs_review'].includes(previous.state);
          const derived = previous && derivedStates.get(previous.id);
          const state = derived?.state ?? (preserve ? previous.state : item.state);
          const warnings = derived?.warnings ?? (preserve ? previous.warnings_json : JSON.stringify(item.warningCode ? [item.warningCode] : []));
          const changed = !previous || previous.relative_path !== item.relativePath || previous.version !== item.version ||
            previous.state !== state || previous.warnings_json !== warnings;
          this.db.prepare(`INSERT INTO sources(id,vault_id,relative_path,media_type,version,state,original_saved,warnings_json,updated_at)
            VALUES (?,?,?,?,?,?,1,?,?) ON CONFLICT(vault_id,relative_path) DO UPDATE SET
            media_type=excluded.media_type,version=excluded.version,state=excluded.state,original_saved=1,
            warnings_json=excluded.warnings_json,updated_at=excluded.updated_at`)
            .run(sourceId, id, item.relativePath, item.mediaType, item.version, state, warnings, changed ? now : previous.updated_at);
          if (!preserve || derived) this.db.prepare('DELETE FROM representations WHERE source_id=?').run(sourceId);
          if (item.state === 'ready') this.db.prepare(`INSERT INTO representations(source_id,source_version,kind,hash,relative_path)
            VALUES (?,?,'original_text',?,?)`).run(sourceId, item.version, item.version, item.relativePath);
          byPath.delete(item.relativePath);
        }
        for (const source of byPath.values()) {
          const excluded = isExcluded(source.relative_path, this.location(current).exclusions);
          // An accepted intake can still be staged outside the vault; absence is not deletion.
          if (!excluded && source.original_saved === 0 && !['missing', 'excluded'].includes(source.state)) continue;
          if (source.state === (excluded ? 'excluded' : 'missing') && source.version === null) continue;
          this.db.prepare('UPDATE sources SET version=NULL,state=?,original_saved=?,warnings_json=?,updated_at=? WHERE id=?')
            .run(excluded ? 'excluded' : 'missing', excluded ? source.original_saved : 0,
              JSON.stringify([excluded ? 'SOURCE_EXCLUDED' : 'SOURCE_MISSING']), now, source.id);
          this.db.prepare('DELETE FROM representations WHERE source_id=?').run(source.id);
        }
        this.db.prepare("UPDATE vaults SET scan_state='ready',scanned_at=?,scan_error_code=NULL,skipped_count=? WHERE id=?")
          .run(now, snapshot.skipped, id);
        this.db.exec('COMMIT');
      } catch (error) { if (this.db.inTransaction) this.db.exec('ROLLBACK'); throw error; }
      this.derivedChecks.clear();
      for (const [sourceId, token] of checkedDerived) this.derivedChecks.set(sourceId, token);
      for (const job of this.conversions.values()) if (this.source(job.sourceId).version !== job.version) job.abort.abort();
      if (this.converter) for (const row of this.db.prepare("SELECT id FROM sources WHERE vault_id=? AND state='pending' AND original_saved=1").all(id) as { id: string }[]) {
        void this.prepareSource(row.id).catch(() => { /* Failure remains on the source; only a new version or explicit retry runs again. */ });
      }
      return this.get(id);
    } catch (error) {
      const code = error instanceof ApiError ? error.publicError.code : 'SERVICE_UNAVAILABLE';
      this.db.prepare("UPDATE vaults SET scan_state='failed',scan_error_code=? WHERE id=? AND scan_generation=? AND revision=?")
        .run(code, id, generation, before.revision);
      throw error instanceof ApiError ? error : new ApiError('SERVICE_UNAVAILABLE');
    }
  }
  async refresh(id: string, signal: AbortSignal, listener: (source: Source) => void): Promise<RefreshResult> {
    const revision = this.get(id).revision, scopeAbort = new AbortController();
    const unsubscribe = this.onScopeChange(changed => { if (changed === id) scopeAbort.abort(); });
    const cancel = AbortSignal.any([signal, scopeAbort.signal]);
    setMaxListeners(64, cancel); // The accepted small-vault envelope permits 50 simultaneous waiters on the serial queue.
    try {
      await this.scan(id, cancel, true);
      const sources = this.db.prepare("SELECT id,version FROM sources WHERE vault_id=? AND original_saved=1 AND state NOT IN ('missing','excluded')")
        .all(id) as { id: string; version: string | null }[];
      await Promise.allSettled(sources.map(source => this.prepareSource(source.id, cancel, listener)));
      if (this.get(id).revision !== revision) throw new ApiError('CONTEXT_CHANGED');
      if (cancel.aborted) throw new ApiError('RUN_INTERRUPTED');
      if (sources.some(source => this.source(source.id).version !== source.version)) throw new ApiError('SOURCE_CHANGED');
      const rows = this.db.prepare('SELECT state,count(*) AS n FROM sources WHERE vault_id=? GROUP BY state').all(id) as { state: string; n: number }[];
      const counts = new Map(rows.map(row => [row.state, row.n]));
      const vault = this.get(id);
      return { scanned: vault.discovery.scanned, skipped: vault.discovery.skipped, ready: counts.get('ready') ?? 0,
        partial: counts.get('partial') ?? 0, failed: counts.get('failed') ?? 0,
        pending: (counts.get('pending') ?? 0) + (counts.get('processing') ?? 0) + (counts.get('stale') ?? 0),
        unsupported: counts.get('unsupported') ?? 0, needsReview: counts.get('needs_review') ?? 0,
        missing: counts.get('missing') ?? 0, excluded: counts.get('excluded') ?? 0 };
    } finally { unsubscribe(); }
  }
  async retrySource(id: string, expectedVersion: string | null, revision: number, signal: AbortSignal,
    listener: (source: Source) => void): Promise<Source> {
    const before = this.source(id);
    const check = () => {
      if (signal.aborted || this.closed) throw new ApiError('RUN_INTERRUPTED');
      if (this.get(before.vaultId).revision !== revision) throw new ApiError('CONTEXT_CHANGED');
      const current = this.source(id);
      if (current.state === 'missing') throw new ApiError('SOURCE_MISSING', { sourceId: current.id });
      if (current.state === 'excluded') throw new ApiError('SOURCE_EXCLUDED', { sourceId: current.id });
      if (expectedVersion !== null && current.version !== expectedVersion) throw new ApiError('SOURCE_CHANGED', { sourceId: current.id });
    };
    check(); await this.scan(before.vaultId, signal); check();
    const current = this.source(id);
    if (this.converter && current.version && ['failed', 'needs_review'].includes(current.state) &&
        !['text/markdown', 'text/plain', 'application/octet-stream'].includes(current.mediaType)) {
      this.db.prepare("UPDATE sources SET state='pending',warnings_json='[]',updated_at=? WHERE id=?")
        .run(new Date().toISOString(), id);
    }
    const result = await this.prepareSource(id, signal, listener); check(); return result;
  }
  async prepareSource(id: string, signal?: AbortSignal, listener?: (source: Source) => void): Promise<Source> {
    const source = this.source(id);
    if (!this.converter || !source.version || !['pending', 'processing'].includes(source.state)) return source;
    if (this.closed || signal?.aborted) throw new ApiError('RUN_INTERRUPTED');
    const key = `${id}:${source.version}`;
    let job = this.conversions.get(key);
    if (!job) {
      const abort = new AbortController(), listeners = new Set<(source: Source) => void>();
      const revision = this.get(source.vaultId).revision;
      const promise = this.conversionTail.then(() => this.convertSource(source, revision, abort.signal,
        current => { for (const notify of listeners) notify(current); })).finally(() => { this.conversions.delete(key); });
      job = { sourceId: id, version: source.version, abort, listeners, promise };
      this.conversions.set(key, job);
      this.conversionTail = promise.catch(() => { /* Keep the serial queue available after a failed file. */ });
    }
    const abort = () => job!.abort.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (listener) {
      job.listeners.add(listener);
      if (this.source(id).state === 'processing') listener(this.source(id));
    }
    try { return await job.promise; }
    finally { signal?.removeEventListener('abort', abort); if (listener) job.listeners.delete(listener); }
  }
  private async convertSource(source: Source, revision: number, signal: AbortSignal, notify: (source: Source) => void): Promise<Source> {
    const valid = () => {
      if (this.closed || signal.aborted) throw new ApiError('RUN_INTERRUPTED');
      if (this.get(source.vaultId).revision !== revision) throw new ApiError('CONTEXT_CHANGED');
      const current = this.source(source.id);
      if (current.version !== source.version || current.relativePath !== source.relativePath) throw new ApiError('SOURCE_CHANGED');
      if (current.state === 'excluded') throw new ApiError('SOURCE_EXCLUDED');
    };
    try {
      valid();
      this.db.prepare("UPDATE sources SET state='processing',updated_at=? WHERE id=?").run(new Date().toISOString(), source.id);
      notify(this.source(source.id));
      const input = conversionInput(this.context(source.vaultId), source);
      let result = await this.converter!.check(input, null, signal);
      if (!result) {
        const extracted = await this.converter!.extract(input, signal);
        valid();
        result = await this.converter!.publish(input, extracted, signal);
      }
      valid();
      // Read through the relationship once more before making the representation available.
      await this.converter!.readDerived(input, result.hash, signal);
      valid();
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare(`INSERT INTO representations(source_id,source_version,kind,hash,relative_path,extractor_version)
          VALUES (?,?,'extracted_markdown',?,?,?) ON CONFLICT(source_id) DO UPDATE SET source_version=excluded.source_version,
          kind=excluded.kind,hash=excluded.hash,relative_path=excluded.relative_path,extractor_version=excluded.extractor_version`)
          .run(source.id, source.version, result.hash, result.relativePath, result.extractorVersion);
        this.db.prepare('UPDATE sources SET state=?,warnings_json=?,updated_at=? WHERE id=?')
          .run(result.state, JSON.stringify(result.warningCodes), new Date().toISOString(), source.id);
        this.db.exec('COMMIT');
      } catch (error) { if (this.db.inTransaction) this.db.exec('ROLLBACK'); throw error; }
      const current = this.source(source.id); notify(current); return current;
    } catch (error) {
      const code = error instanceof ApiError ? error.publicError.code : 'CONVERSION_FAILED';
      const state = code === 'DERIVED_MODIFIED' ? 'needs_review' : code === 'UNSUPPORTED_FORMAT' ? 'unsupported' : 'failed';
      this.db.prepare("UPDATE sources SET state=?,warnings_json=?,updated_at=? WHERE id=? AND version=? AND state IN ('pending','processing')")
        .run(state, JSON.stringify([code]), new Date().toISOString(), source.id, source.version);
      notify(this.source(source.id));
      throw new ApiError(code, { sourceId: source.id });
    }
  }
  private sourceRow(id: string): SourceRow {
    requireId(id, 'source');
    const row = this.db.prepare('SELECT * FROM sources WHERE id=?').get(id) as SourceRow | undefined;
    if (!row) throw new ApiError('NOT_FOUND');
    if (!isRelativePath(row.relative_path) || !isSourceState(row.state) ||
        (row.version !== null && !isPayloadHash(row.version))) throw new ApiError('SERVICE_UNAVAILABLE');
    return row;
  }
  source(id: string): Source {
    const row = this.sourceRow(id);
    const representation = this.db.prepare('SELECT * FROM representations WHERE source_id=?').get(id) as
      { source_version: string; kind: 'original_text' | 'extracted_markdown'; hash: string; relative_path: string; extractor_version: string | null } | undefined;
    const warnings: unknown = JSON.parse(row.warnings_json);
    if (!Array.isArray(warnings) || !warnings.every(isErrorCode)) throw new ApiError('SERVICE_UNAVAILABLE');
    return { id: row.id, vaultId: row.vault_id, relativePath: row.relative_path, title: path.basename(row.relative_path),
      origin: row.origin, mediaType: row.media_type, version: row.version, state: row.state,
      readableRepresentation: representation && representation.source_version === row.version && ['ready', 'partial'].includes(row.state) ? {
        kind: representation.kind, hash: representation.hash, relativePath: representation.relative_path, extractorVersion: representation.extractor_version,
      } : null, originalSaved: row.original_saved === 1, sourceUrl: row.source_url, capturedAt: row.captured_at,
      warnings: warnings.map(code => ({ code, message: makeError(code).message, sourceId: row.id })), updatedAt: row.updated_at };
  }
  sources(vaultId: string, query: unknown): Page<Source> {
    this.row(vaultId);
    if (!hasFields(query, [], ['state', 'cursor', 'limit']) ||
        (query.state !== undefined && !isSourceState(query.state)) ||
        (query.cursor !== undefined && !isId(query.cursor, 'source')) ||
        (query.limit !== undefined && (typeof query.limit !== 'string' || !/^[1-9]\d?$/.test(query.limit) || Number(query.limit) > 50))) {
      throw new ApiError('BAD_REQUEST');
    }
    if (query.cursor && !this.db.prepare('SELECT id FROM sources WHERE id=? AND vault_id=?').get(query.cursor as string, vaultId)) {
      throw new ApiError('BAD_REQUEST');
    }
    const limit = Number(query.limit ?? 20), state = query.state as string | undefined;
    const rows = this.db.prepare(`SELECT id FROM sources WHERE vault_id=? AND id>? ${state ? 'AND state=?' : ''} ORDER BY id LIMIT ?`)
      .all(vaultId, (query.cursor as string | undefined) ?? '', ...(state ? [state] : []), limit + 1) as { id: string }[];
    return { items: rows.slice(0, limit).map(row => this.source(row.id)), nextCursor: rows.length > limit ? rows[limit - 1].id : null };
  }
  async content(id: string, view: 'original' | 'text', expectedVersion: string, signal?: AbortSignal): Promise<{ bytes: Buffer; source: Source }> {
    if (signal?.aborted) throw new ApiError('RUN_INTERRUPTED');
    const source = this.source(id), vault = this.row(source.vaultId), location = this.location(vault);
    if (source.state === 'excluded' || isExcluded(source.relativePath, location.exclusions)) throw new ApiError('SOURCE_EXCLUDED');
    if (source.state === 'missing') throw new ApiError('SOURCE_MISSING');
    if (source.version !== expectedVersion) throw new ApiError('SOURCE_CHANGED');
    const representation = source.readableRepresentation;
    if (view === 'text' && (!['ready', 'partial'].includes(source.state) || !representation ||
        (representation.kind === 'original_text' && (representation.hash !== expectedVersion || representation.relativePath !== source.relativePath)) ||
        (representation.kind === 'extracted_markdown' && !this.converter))) throw new ApiError('SOURCE_NOT_READY');
    try {
      const bytes = view === 'text' && representation?.kind === 'extracted_markdown'
        ? await this.converter!.readDerived(conversionInput(location, source), representation.hash, signal)
        : await this.files.read(location, source.relativePath, expectedVersion, signal);
      if (signal?.aborted) throw new ApiError('RUN_INTERRUPTED');
      if (this.row(vault.id).revision !== vault.revision) throw new ApiError('CONTEXT_CHANGED');
      if (this.source(id).version !== expectedVersion) throw new ApiError('SOURCE_CHANGED');
      return { bytes, source };
    } catch (error) {
      const code = error instanceof ApiError ? error.publicError.code : 'SERVICE_UNAVAILABLE';
      if (code === 'DERIVED_MODIFIED') {
        this.db.prepare("UPDATE sources SET state='needs_review',warnings_json=?,updated_at=? WHERE id=? AND version=?")
          .run(JSON.stringify([code]), new Date().toISOString(), id, expectedVersion);
      }
      const state = code === 'SOURCE_MISSING' ? 'missing' : code === 'SOURCE_CHANGED' ? 'stale' :
        ['PATH_OUTSIDE_SCOPE', 'SOURCE_EXCLUDED'].includes(code) ? 'excluded' : null;
      if (state) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          const changed = this.db.prepare('UPDATE sources SET state=?,version=NULL,original_saved=?,warnings_json=?,updated_at=? WHERE id=? AND version=?')
            .run(state, state === 'missing' ? 0 : 1, JSON.stringify([code]), new Date().toISOString(), id, expectedVersion).changes;
          if (changed) this.db.prepare('DELETE FROM representations WHERE source_id=?').run(id);
          this.db.exec('COMMIT');
        } catch (failure) { if (this.db.inTransaction) this.db.exec('ROLLBACK'); throw failure; }
      }
      throw error instanceof ApiError ? error : new ApiError('SERVICE_UNAVAILABLE');
    }
  }
}
