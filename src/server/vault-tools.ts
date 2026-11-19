import { createHash, randomUUID } from 'node:crypto';
import { TOOL_HINTS, type ErrorCode } from '../shared/api.js';
import { MODEL_LIMITS } from '../shared/model-run.js';
import { hasFields, isId, isPayloadHash, isRevision, type Id } from '../shared/contracts.js';
import { isExcluded, isRelativePath, type Source } from '../shared/vault.js';
import { isScope, TOOL_LIMITS, LOCAL_SEARCH_LIMITS, WEB_SEARCH_LIMITS, type Scope, type ToolLimits, type ToolResult, type ToolWarning, type Evidence } from '../shared/tools.js';
import { ApiError, newId } from './contracts.js';
import type { SqliteDatabase } from './storage.js';
import { VaultService } from './vaults.js';
import { Ripgrep, rankSearchLines, searchOutline } from './ripgrep.js';
import { recordSource } from './context-sources.js';

export type ToolRunContext = { runId: Id<'run'>; vaultId: Id<'vault'>; scope: Scope; scopeRevision: number;
  deadline: number; signal: AbortSignal; limits?: Partial<ToolLimits>; readResultBytes?: number;
  prepareVault?: () => Promise<unknown>; ignoredSourceIds?: string[];
  observeLocal?: (result: ToolResult) => void;
  webSearch?: (args: unknown, signal: AbortSignal) => Promise<ToolResult> };
type Cursor = { key: string; stamp: string; index: number; line: number; ranking?: string };
const canonical = (value: string) => value.replace(/\/$/, '').normalize('NFC');
const contains = (parent: string, child: string) => parent === child || child.startsWith(`${parent}/`);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const fatal = (code: ErrorCode) => ['BUDGET_EXCEEDED', 'DEADLINE_EXCEEDED', 'CONTEXT_CHANGED', 'RUN_INTERRUPTED'].includes(code);
const coverageWarning: ToolWarning = { code: 'COVERAGE_INCOMPLETE', message: '本轮未覆盖所有登记资料，请结合处理状态和后续分页判断。', sourceId: null };
const success = (data: unknown, warnings: ToolWarning[] = [], nextCursor: string | null = null): Extract<ToolResult, { ok: true }> =>
  ({ ok: true, data, warnings, truncated: nextCursor !== null, nextCursor });
function summary(source: Source) {
  return { sourceId: source.id, relativePath: source.relativePath, state: source.state, version: source.version, origin: source.origin,
    ...(source.title === source.relativePath.split('/').at(-1) ? {} : { title: source.title }),
    ...(source.sourceUrl === null ? {} : { sourceUrl: source.sourceUrl }), ...(source.capturedAt === null ? {} : { capturedAt: source.capturedAt }),
    ...(source.warnings.length ? { warnings: source.warnings } : {}) };
}
function visitLines(text: string, visit: (start: number, end: number, line: number) => void | boolean): number {
  let start = 0, line = 0;
  while (start < text.length) {
    const newline = text.indexOf('\n', start), end = newline < 0 ? text.length : newline + 1;
    if (visit(start, end, ++line) === false) break;
    start = end;
  }
  return line;
}
function preview(line: string): string {
  const bytes = Buffer.from(line); let end = Math.min(512, bytes.length);
  while (end > 0) {
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, end)); }
    catch { end--; }
  }
  return '';
}

export class VaultToolSession {
  get vaultId(): Id<'vault'> { return this.context.vaultId; }
  private readonly context: ToolRunContext;
  private readonly limits: ToolLimits;
  private readonly abort = new AbortController();
  private readonly signal: AbortSignal;
  private readonly timer: NodeJS.Timeout;
  private readonly unsubscribe: () => void;
  private readonly cursors = new Map<string, Cursor>();
  private tail: Promise<unknown> = Promise.resolve();
  private calls = 0;
  private prepared = false;
  private bytes = 0;
  private readonly proposed = new Map<string, { name: string; args: unknown; started: boolean; result?: ToolResult; delivered: boolean }>();
  constructor(private readonly db: SqliteDatabase, private readonly vaults: VaultService,
    private readonly ripgrep: Ripgrep, context: ToolRunContext) {
    if (!isId(context.runId, 'run') || !isId(context.vaultId, 'vault') || !isScope(context.scope) ||
        !isRevision(context.scopeRevision) || !Number.isSafeInteger(context.deadline) || !(context.signal instanceof AbortSignal) ||
        (context.limits !== undefined && !hasFields(context.limits, [], Object.keys(TOOL_LIMITS)))) throw new ApiError('BAD_REQUEST');
    this.limits = { ...TOOL_LIMITS, ...context.limits };
    for (const key of Object.keys(TOOL_LIMITS) as Array<keyof ToolLimits>) {
      if (!positive(this.limits[key]) || this.limits[key] > TOOL_LIMITS[key]) throw new ApiError('BAD_REQUEST');
    }
    if (context.readResultBytes !== undefined && (!positive(context.readResultBytes) || context.readResultBytes > this.limits.maxReadBytesPerCall)) throw new ApiError('BAD_REQUEST');
    this.context = { ...context, scope: context.scope.mode === 'vault' ? { mode: 'vault' } :
      { mode: 'selected', paths: [...new Set(context.scope.paths.map(canonical))] } };
    const vault = vaults.get(context.vaultId);
    if (this.context.scope.mode === 'selected' && this.context.scope.paths.some(p => isExcluded(p, vault.exclusions))) {
      throw new ApiError('PATH_OUTSIDE_SCOPE');
    }
    const run = db.prepare('SELECT kind,vault_id,started_at FROM runs WHERE id=?').get(context.runId) as
      { kind: string; vault_id: string; started_at: string | null } | undefined;
    if (!run || !['message','answer_update'].includes(run.kind) || run.vault_id !== context.vaultId || !run.started_at ||
        !Number.isFinite(Date.parse(run.started_at)) || context.deadline > Date.parse(run.started_at) + MODEL_LIMITS.questionMs) throw new ApiError('BAD_REQUEST');
    this.signal = AbortSignal.any([context.signal, this.abort.signal]);
    this.check();
    this.db.prepare('INSERT OR IGNORE INTO tool_usage(run_id) VALUES (?)').run(context.runId);
    this.timer = setTimeout(() => this.abort.abort(), Math.max(0, context.deadline - Date.now())); this.timer.unref();
    this.unsubscribe = vaults.onScopeChange(id => { if (id === context.vaultId) this.abort.abort(); });
  }
  usage(): { toolCalls: number; readBytes: number } {
    const row = this.db.prepare('SELECT tool_calls,read_bytes FROM tool_usage WHERE run_id=?').get(this.context.runId) as
      { tool_calls: number; read_bytes: number } | undefined;
    return { toolCalls: row?.tool_calls ?? 0, readBytes: row?.read_bytes ?? 0 };
  }
  close(): void { clearTimeout(this.timer); this.unsubscribe(); this.abort.abort(); this.cursors.clear(); }
  selectedSourceHints(): Array<{ sourceId: string; relativePath: string; state: string }> {
    this.check();
    if (this.context.scope.mode !== 'selected') return [];
    const paths = this.context.scope.paths, hints: Array<{ sourceId: string; relativePath: string; state: string }> = [];
    for (const source of this.sources().filter(source => paths.includes(canonical(source.relativePath)))) {
      const hint = { sourceId: source.id, relativePath: source.relativePath, state: source.state };
      if (size([...hints, hint]) > 2000) break;
      hints.push(hint);
    }
    return hints;
  }
  private check(): void {
    if (this.vaults.get(this.context.vaultId).revision !== this.context.scopeRevision) throw new ApiError('CONTEXT_CHANGED');
    if (Date.now() >= this.context.deadline) throw new ApiError('DEADLINE_EXCEEDED');
    if (this.signal.aborted) throw new ApiError('RUN_INTERRUPTED');
    const run = this.db.prepare('SELECT state FROM runs WHERE id=?').get(this.context.runId) as { state: string } | undefined;
    if (run?.state !== 'running') throw new ApiError('RUN_INTERRUPTED');
    const current = this.usage(); this.calls = current.toolCalls; this.bytes = current.readBytes;
  }
  private allowed(relativePath: string): boolean {
    const scope = this.context.scope;
    return scope.mode === 'vault' || scope.paths.some(p => contains(p, canonical(relativePath)));
  }
  private source(id: string): Source {
    const source = this.vaults.source(id);
    if (this.context.ignoredSourceIds?.includes(source.id) || source.vaultId !== this.context.vaultId || !this.allowed(source.relativePath) ||
        isExcluded(source.relativePath, this.vaults.get(source.vaultId).exclusions)) throw new ApiError('PATH_OUTSIDE_SCOPE');
    return source;
  }
  private sources(): Source[] {
    const output: Source[] = [], exclusions = this.vaults.get(this.context.vaultId).exclusions;
    let cursor: string | null = null;
    do {
      this.check();
      const page = this.vaults.sources(this.context.vaultId, { limit: '50', ...(cursor ? { cursor } : {}) });
      output.push(...page.items.filter(source => !this.context.ignoredSourceIds?.includes(source.id) && this.allowed(source.relativePath) && !isExcluded(source.relativePath, exclusions)));
      cursor = page.nextCursor;
    } while (cursor);
    return output.sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : a.id < b.id ? -1 : 1);
  }
  private stamp(sources: Source[]): string {
    return digest(sources.map(s => [s.id, s.relativePath, s.version, s.state, s.readableRepresentation?.hash]));
  }
  private capacity(): number { return Math.min(this.limits.maxReadBytesPerCall, this.limits.maxReadBytes - this.bytes); }
  private fit(result: ToolResult): boolean { return size(result) <= this.capacity(); }
  private finish(result: ToolResult, evidence?: Evidence, capacity = this.capacity()): ToolResult {
    this.check();
    if (size(result) > capacity || (evidence && size(result) > (this.context.readResultBytes ?? this.limits.maxReadBytesPerCall))) throw new ApiError('BUDGET_EXCEEDED');
    if (evidence) {
      const source = this.source(evidence.sourceId);
      if (source.version !== evidence.sourceVersion || source.readableRepresentation?.hash !== evidence.representationHash) throw new ApiError('SOURCE_CHANGED');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (result.ok) {
        // Server-created tool shapes only; include search previews and metadata, not just citations.
        const data = result.data as { source?: Record<string, unknown>; items?: Record<string, unknown>[]; sources?: Record<string, unknown>[]; matches?: Record<string, unknown>[] };
        for (const item of [data.source, ...(data.items ?? []), ...(data.sources ?? data.matches ?? [])]) {
          if (!item?.sourceId) continue;
          const source = this.source(item.sourceId as string), current = summary(source);
          if (Object.entries(current).some(([key, value]) => JSON.stringify(item[key]) !== JSON.stringify(value)) ||
            (item.representationHash !== undefined && item.representationHash !== source.readableRepresentation?.hash)) throw new ApiError('SOURCE_CHANGED');
          recordSource(this.db, this.context.runId, source);
        }
      }
      if (evidence) this.db.prepare('INSERT INTO evidence(id,run_id,source_id,source_version,representation_hash,body_json) VALUES (?,?,?,?,?,?)')
        .run(evidence.id, evidence.runId, evidence.sourceId, evidence.sourceVersion, evidence.representationHash, JSON.stringify(evidence));
      this.db.prepare('UPDATE tool_usage SET read_bytes=read_bytes+? WHERE run_id=?').run(size(result), this.context.runId);
      this.db.exec('COMMIT');
    } catch (error) { if (this.db.inTransaction) this.db.exec('ROLLBACK'); throw error; }
    this.bytes += size(result);
    if (result.ok && (result.data as { kind?: string })?.kind !== 'web_search') this.context.observeLocal?.(result);
    return result;
  }
  execute(name: string, args: unknown): Promise<ToolResult> {
    return this.enqueue(name, args, true);
  }
  reserveCalls(calls: Array<{ id: string; name: string; arguments: unknown }>): void {
    this.check();
    this.calls += calls.length;
    this.db.prepare('UPDATE tool_usage SET tool_calls=tool_calls+? WHERE run_id=?').run(calls.length, this.context.runId);
    if (this.calls > this.limits.maxToolCalls) throw new ApiError('BUDGET_EXCEEDED');
    if (calls.some(call => typeof call.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(call.id) ||
      typeof call.name !== 'string' || call.name.length > 128 || this.proposed.has(call.id)) ||
      new Set(calls.map(call => call.id)).size !== calls.length) throw new ApiError('MODEL_PROTOCOL_ERROR');
    for (const call of calls) this.proposed.set(call.id, { name: call.name, args: structuredClone(call.arguments), started: false, delivered: false });
  }
  async executeReserved(id: string): Promise<ToolResult> {
    this.check();
    const call = this.proposed.get(id);
    if (!call || call.started || call.delivered) throw new ApiError('MODEL_PROTOCOL_ERROR');
    call.started = true;
    const result = await this.enqueue(call.name, call.args, false);
    call.result = result; return result;
  }
  reconcileResult(id: string, resultText: string, isError: boolean): ToolResult {
    this.check();
    const call = this.proposed.get(id);
    if (!call || call.delivered || (call.started && !call.result)) throw new ApiError('MODEL_PROTOCOL_ERROR');
    if (call.result) {
      if (JSON.stringify(call.result) !== resultText) throw new ApiError('MODEL_PROTOCOL_ERROR');
    } else {
      if (!isError) throw new ApiError('MODEL_PROTOCOL_ERROR');
      // SDK schema rejection and unknown tools never reach execute; charge their sanitized error too.
      call.result = this.finish({ ok: false, error: new ApiError('BAD_REQUEST', { toolHint: TOOL_HINTS[call.name as keyof typeof TOOL_HINTS] }).publicError });
    }
    this.db.prepare('INSERT INTO tool_results(run_id,call_id,result_json) VALUES (?,?,?)')
      .run(this.context.runId, id, JSON.stringify(call.result));
    call.delivered = true; return call.result;
  }
  assertToolsSettled(): void {
    this.check();
    if ([...this.proposed.values()].some(call => !call.delivered)) throw new ApiError('MODEL_PROTOCOL_ERROR');
  }
  private enqueue(name: string, args: unknown, count: boolean): Promise<ToolResult> {
    const task = this.tail.then(async () => {
      this.check();
      if (count && this.calls >= this.limits.maxToolCalls) throw new ApiError('BUDGET_EXCEEDED');
      if (this.bytes >= this.limits.maxReadBytes) return { ok: false, error: new ApiError('TOOL_READ_LIMIT').publicError } as ToolResult;
      if (count) {
        this.calls++;
        this.db.prepare('UPDATE tool_usage SET tool_calls=tool_calls+1 WHERE run_id=?').run(this.context.runId);
      }
      try {
        if (name === 'web_search') {
          if (!this.context.webSearch) throw new ApiError('BAD_REQUEST');
          return this.finish(await this.context.webSearch(args, this.signal), undefined,
            Math.min(WEB_SEARCH_LIMITS.resultBytes, this.limits.maxReadBytes - this.bytes));
        }
        if (!this.prepared && this.context.prepareVault) { await this.context.prepareVault(); this.prepared = true; this.check(); }
        if (name === 'vault_read') { const read = await this.read(args); return this.finish(read.result, read.evidence); }
        const result = name === 'vault_list' ? this.list(args) : name === 'vault_search' ? await this.search(args) :
          name === 'vault_status' ? this.status(args) : null;
        if (!result) throw new ApiError('BAD_REQUEST');
        return this.finish(result);
      } catch (error) {
        this.check();
        const failure = error instanceof ApiError ? error : new ApiError('SERVICE_UNAVAILABLE');
        if (['TOOL_READ_LIMIT','BUDGET_EXCEEDED'].includes(failure.publicError.code)) {
          const result: ToolResult = { ok: false, error: new ApiError('TOOL_READ_LIMIT').publicError };
          return this.fit(result) ? this.finish(result) : result;
        }
        if (fatal(failure.publicError.code)) throw failure;
        return this.finish({ ok: false, error: failure.publicError.code === 'BAD_REQUEST' ?
          new ApiError('BAD_REQUEST', { toolHint: TOOL_HINTS[name as keyof typeof TOOL_HINTS] }).publicError : failure.publicError });
      }
    });
    this.tail = task.catch(() => {}); return task;
  }
  private pageArgs(args: Record<string, unknown>): number {
    if ((args.limit !== undefined && (!positive(args.limit) || args.limit > 50)) ||
        (args.cursor !== undefined && (typeof args.cursor !== 'string' || args.cursor.length > 128))) throw new ApiError('BAD_REQUEST');
    return (args.limit as number | undefined) ?? 20;
  }
  private cursor(input: unknown, key: string, stamp: string): Cursor {
    if (input === undefined) return { key, stamp, index: 0, line: 1 };
    const saved = this.cursors.get(input as string);
    if (!saved || saved.key !== key) throw new ApiError('BAD_REQUEST');
    if (saved.stamp !== stamp) throw new ApiError('SOURCE_CHANGED');
    return saved;
  }
  private list(args: unknown): ToolResult {
    if (!hasFields(args, [], ['path', 'cursor', 'limit']) || (args.path !== undefined && !isRelativePath(args.path, true))) throw new ApiError('BAD_REQUEST');
    const limit = this.pageArgs(args), directory = args.path === undefined ? '' : canonical(args.path as string);
    const scope = this.context.scope;
    if (directory && (isExcluded(directory, this.vaults.get(this.context.vaultId).exclusions) ||
        (scope.mode === 'selected' && !scope.paths.some(p => contains(p, directory) || contains(directory, p))))) throw new ApiError('PATH_OUTSIDE_SCOPE');
    const sources = this.sources(), entries = new Map<string, object>();
    for (const source of sources) {
      const relative = canonical(source.relativePath);
      if (directory && !contains(directory, relative)) continue;
      const rest = directory ? relative.slice(directory.length + 1) : relative;
      if (!rest) { entries.set(relative, { kind: 'source', ...summary(source) }); continue; }
      const slash = rest.indexOf('/');
      if (slash < 0) entries.set(relative, { kind: 'source', ...summary(source) });
      else { const p = (directory ? `${directory}/` : '') + rest.slice(0, slash); entries.set(p, { kind: 'directory', relativePath: p }); }
    }
    const all = [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, entry]) => entry);
    const key = digest(['vault_list', directory, limit]), stamp = this.stamp(sources), cursor = this.cursor(args.cursor, key, stamp);
    const token = randomUUID(), items = all.slice(cursor.index, cursor.index + limit);
    const build = () => success({ items }, [], cursor.index + items.length < all.length ? token : null);
    while (items.length && !this.fit(build())) items.pop();
    if (!items.length && cursor.index < all.length) throw new ApiError('BUDGET_EXCEEDED');
    const result = build();
    if (result.ok && result.nextCursor) this.cursors.set(token, { key, stamp, index: cursor.index + items.length, line: 1 });
    return result;
  }
  private status(args: unknown): ToolResult {
    if (!hasFields(args, [], ['sourceIds']) || (args.sourceIds !== undefined && (!Array.isArray(args.sourceIds) ||
        args.sourceIds.length < 1 || args.sourceIds.length > 50 || !args.sourceIds.every(id => isId(id, 'source'))))) throw new ApiError('BAD_REQUEST');
    if (args.sourceIds) return success({ items: [...new Set(args.sourceIds as string[])].map(id => summary(this.source(id))) });
    const counts: Record<string, number> = {};
    for (const source of this.sources()) counts[source.state] = (counts[source.state] ?? 0) + 1;
    const discovery = this.vaults.get(this.context.vaultId).discovery;
    return success({ counts, discoveryState: discovery.state }, discovery.state === 'ready' ? [] : [coverageWarning]);
  }
  private async search(args: unknown): Promise<ToolResult> {
    if (!hasFields(args, ['terms'], ['paths', 'cursor', 'limit']) || !Array.isArray(args.terms) ||
        args.terms.length < 1 || args.terms.length > LOCAL_SEARCH_LIMITS.terms || !args.terms.every(term => typeof term === 'string' && term.trim() &&
          Buffer.byteLength(term) <= LOCAL_SEARCH_LIMITS.termBytes && !/[\x00-\x1f\x7f\ud800-\udfff]/u.test(term)) ||
        (args.paths !== undefined && (!Array.isArray(args.paths) || args.paths.length < 1 || args.paths.length > 50 ||
          !args.paths.every(p => isRelativePath(p, true))))) throw new ApiError('BAD_REQUEST');
    const limit = this.pageArgs(args), terms = [...new Set(args.terms as string[])].sort();
    const paths = args.paths === undefined ? [] : [...new Set((args.paths as string[]).map(canonical))].sort();
    if (paths.some(p => !this.allowed(p) || isExcluded(p, this.vaults.get(this.context.vaultId).exclusions))) throw new ApiError('PATH_OUTSIDE_SCOPE');
    const sources = this.sources().filter(source => !paths.length || paths.some(p => contains(p, canonical(source.relativePath))));
    const key = digest(['vault_search', terms, paths, limit]), stamp = this.stamp(sources), cursor = this.cursor(args.cursor, key, stamp);
    const candidates: Array<{ hit: Record<string, unknown>; rank: number; score: number; sourceIndex: number }> = [];
    const outlines = new Map<string, ReturnType<typeof searchOutline>>();
    const unavailable: Record<string, number> = {};
    for (const source of sources) if (!source.readableRepresentation) unavailable[source.state] = (unavailable[source.state] ?? 0) + 1;
    let searched = 0, failures = 0, limited = false, firstFailure: ApiError | undefined;
    for (let index = 0; index < sources.length; index++) {
      this.check(); const source = sources[index];
      if (!source.version || !source.readableRepresentation) continue;
      // Bound the local ranking scan; disclose omitted candidates instead of claiming an exhaustive search.
      if (candidates.length >= LOCAL_SEARCH_LIMITS.candidates) { limited = true; break; }
      try {
        const read = await this.vaults.content(source.id, 'text', source.version, this.signal); this.check();
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(read.bytes);
        const found = await this.ripgrep.lines(text, terms, LOCAL_SEARCH_LIMITS.perFile + 1, this.signal); this.check();
        const current = this.source(source.id);
        if (current.version !== source.version || current.readableRepresentation?.hash !== read.source.readableRepresentation?.hash) throw new ApiError('SOURCE_CHANGED');
        const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
        if (found.some(line => line > lines.length)) throw new ApiError('SERVICE_UNAVAILABLE');
        const remaining = Math.min(LOCAL_SEARCH_LIMITS.perFile, LOCAL_SEARCH_LIMITS.candidates - candidates.length);
        if (found.length > remaining) limited = true;
        const ranked = rankSearchLines(text, found.slice(0, remaining), terms);
        outlines.set(source.id, searchOutline(text, terms));
        ranked.forEach(({ line, score }, rank) => {
          const wholeLine = lines[line - 1], snippet = preview(wholeLine);
          candidates.push({ rank, score, sourceIndex: index, hit: { ...summary(read.source),
            representationHash: read.source.readableRepresentation!.hash, line, snippet, snippetTruncated: snippet !== wholeLine,
            refersTo: read.source.readableRepresentation!.kind === 'original_text' ? 'original' : 'extracted' } });
        });
        searched++;
      } catch (error) {
        this.check(); const failure = error instanceof ApiError ? error : new ApiError('SERVICE_UNAVAILABLE');
        if (fatal(failure.publicError.code)) throw failure;
        failures++; firstFailure ??= failure;
      }
    }
    if (firstFailure && searched === 0) throw firstFailure;
    // Interleave sources before taking their second passage. Scope and original locators are unchanged.
    candidates.sort((a, b) => a.rank - b.rank || b.score - a.score || a.sourceIndex - b.sourceIndex);
    const ranking = digest(candidates);
    if (cursor.ranking && cursor.ranking !== ranking) throw new ApiError('SOURCE_CHANGED');
    const token = randomUUID(), matches: Record<string, unknown>[] = [];
    let position = cursor.index;
    const build = (): ToolResult => {
      const more = position < candidates.length;
      const complete = !more && !limited && !Object.keys(unavailable).length && failures === 0 && this.vaults.get(this.context.vaultId).discovery.state === 'ready';
      const summaries = new Map<unknown, Record<string, unknown>>();
      const snippets = matches.map(({ line, snippet, snippetTruncated, refersTo, ...source }) => {
        summaries.set(source.sourceId, source);
        return { sourceId: source.sourceId, line, snippet, snippetTruncated, refersTo };
      });
      const outlineBudget = Math.floor(4800 / Math.max(1, summaries.size));
      for (const source of summaries.values()) {
        const outline = outlines.get(source.sourceId as string)!;
        const items: typeof outline.items = [];
        for (const item of outline.items) { if (size([...items, item]) > outlineBudget) break; items.push(item); }
        source.outline = { items, truncated: outline.truncated || items.length < outline.items.length };
      }
      return { ...success({ matches: snippets, sources: [...summaries.values()], coverage: { registered: sources.length, searched, unavailable, readFailures: failures,
        remainingSources: Math.max(0, sources.length - searched - Object.values(unavailable).reduce((a, b) => a + b, 0)),
        matchesLimited: limited, complete } }, complete ? [] : [coverageWarning], more ? token : null), truncated: more || limited };
    };
    while (position < candidates.length && matches.length < limit) {
      matches.push(candidates[position++].hit);
      if (!this.fit(build())) { matches.pop(); position--; break; }
    }
    if (!matches.length && position < candidates.length) throw new ApiError('BUDGET_EXCEEDED');
    if (position < candidates.length) this.cursors.set(token, { key, stamp, index: position, line: 1, ranking });
    return build();
  }

  private async read(args: unknown): Promise<{ result: ToolResult; evidence: Evidence }> {
    if (!hasFields(args, ['sourceId', 'startLine', 'maxLines'], ['expectedVersion', 'startOffset']) || !isId(args.sourceId, 'source') ||
        !positive(args.startLine) || !positive(args.maxLines) || (args.startOffset !== undefined && (!Number.isSafeInteger(args.startOffset) || (args.startOffset as number) < 0)) || (args.expectedVersion !== undefined && !isPayloadHash(args.expectedVersion))) throw new ApiError('BAD_REQUEST');
    const source = this.source(args.sourceId);
    if (source.state === 'missing') throw new ApiError('SOURCE_MISSING');
    if (source.state === 'excluded') throw new ApiError('SOURCE_EXCLUDED');
    if (!source.version) throw new ApiError('SOURCE_NOT_READY');
    if (args.expectedVersion !== undefined && args.expectedVersion !== source.version) throw new ApiError('SOURCE_CHANGED');
    const read = await this.vaults.content(source.id, 'text', source.version, this.signal); this.check();
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(read.bytes);
    const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [], totalLines = lines.length, startLine = args.startLine;
    const startOffset = (args.startOffset as number | undefined) ?? 0;
    if (startLine > totalLines || startOffset >= lines[startLine - 1].length ||
      (startOffset > 0 && /[\udc00-\udfff]/.test(lines[startLine - 1][startOffset]))) throw new ApiError('BAD_REQUEST');
    const wanted = lines.slice(startLine - 1, startLine - 1 + Math.min(args.maxLines, this.limits.maxReadLines));
    const passage = wanted.join('').slice(startOffset);
    const readCapacity = Math.min(this.context.readResultBytes ?? this.limits.maxReadBytesPerCall, this.capacity());
    const evidence: Evidence = { id: newId('evidence'), runId: this.context.runId, sourceId: source.id, sourceVersion: source.version,
      representationHash: read.source.readableRepresentation!.hash, excerpt: '', origin: source.origin, warnings: read.source.warnings,
      location: { kind: 'markdown_lines', startLine, endLine: startLine, heading: null,
        refersTo: read.source.readableRepresentation!.kind === 'original_text' ? 'original' : 'extracted' }, originalLocator: null };
    const build = (length: number) => {
      if (length < passage.length && /[\udc00-\udfff]/.test(passage[length])) length--;
      evidence.excerpt = passage.slice(0, length);
      let remaining = length + startOffset, last = 0;
      while (last < wanted.length - 1 && remaining > wanted[last].length) remaining -= wanted[last++].length;
      evidence.location.endLine = startLine + last;
      delete evidence.location.startOffset; delete evidence.location.endOffset;
      if (startOffset) evidence.location.startOffset = startOffset;
      const partial = remaining < wanted[last].length;
      if (partial) evidence.location.endOffset = remaining;
      const nextLine = partial ? startLine + last : startLine + last < totalLines ? startLine + last + 1 : null;
      const nextOffset = partial ? remaining : 0;
      return success({ source: summary(read.source), evidence, totalLines, nextLine, nextOffset }, evidence.warnings,
        nextLine === null ? null : nextOffset ? `${nextLine}:${nextOffset}` : String(nextLine));
    };
    // Binary-search the serialized result, preserving exact UTF-16 boundaries and source bytes.
    let low = 0, high = Math.min(passage.length, readCapacity);
    while (low < high) { const middle = Math.ceil((low + high) / 2); if (size(build(middle)) <= readCapacity) low = middle; else high = middle - 1; }
    let result = build(low);
    // Prefer whole lines; split a line only when it cannot fit even on its own.
    if (evidence.location.endOffset !== undefined && evidence.excerpt.includes('\n')) result = build(evidence.excerpt.lastIndexOf('\n') + 1);
    if (!evidence.excerpt) throw new ApiError('TOOL_READ_LIMIT');
    return { result, evidence };
  }
}
