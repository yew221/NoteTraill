import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { hasFields, isId, isPayloadHash } from '../shared/contracts.js';
import { isRelativePath, MAX_FILE_BYTES } from '../shared/vault.js';
import { ApiError } from './contracts.js';

export type FileIdentity = { device: string; inode: string };
export type VaultLocation = { root: string; identity: FileIdentity; exclusions: string[] };
type FileStamp = { relativePath: string; bytes: number; fingerprint: string };
export type FileRecord = FileStamp & { version: string | null;
  state: 'ready' | 'pending' | 'failed' | 'unsupported'; mediaType: string; warningCode: string | null };
type Inventory = { items: FileStamp[]; skipped: number; derived: Record<string, string> };
type Snapshot = Omit<Inventory, 'items'> & { items: FileRecord[] };
const ERRORS = ['BAD_REQUEST', 'VAULT_ACCESS_DENIED', 'PATH_OUTSIDE_SCOPE', 'SOURCE_MISSING', 'SOURCE_CHANGED',
  'SOURCE_EXCLUDED', 'FILE_TOO_LARGE', 'BUDGET_EXCEEDED', 'DEADLINE_EXCEEDED', 'SERVICE_UNAVAILABLE', 'DERIVED_MODIFIED',
  'UNSUPPORTED_FORMAT', 'CONVERSION_FAILED', 'EXTRACTION_EMPTY', 'URL_FETCH_FAILED'] as const;
const isIdentity = (value: unknown): value is FileIdentity => hasFields(value, ['device', 'inode']) &&
  [value.device, value.inode].every(item => typeof item === 'string' && /^[0-9]{1,30}$/.test(item));

export class VaultFiles {
  private readonly shutdown = new AbortController();
  private scanSequence = 0;
  private snapshotCache?: { key: string; items: Map<string, FileRecord> };
  constructor(private readonly python: string, private readonly forbiddenRoots: string[],
    private readonly helper = fileURLToPath(new URL('./vault-files.py', import.meta.url))) {}
  close(): void { this.shutdown.abort(); this.snapshotCache = undefined; }
  protected async execute(op: 'inspect' | 'snapshot' | 'inventory' | 'read' | 'missing' | 'stage' | 'discard' | 'publish' | 'recover' |
    'extract' | 'derived_check' | 'derived_read' | 'derived_publish', input: object, signal?: AbortSignal): Promise<unknown> {
    const abort = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
    if (abort.aborted) throw new ApiError('RUN_INTERRUPTED');
    if (!path.isAbsolute(this.python)) throw new ApiError('SERVICE_UNAVAILABLE');
    const request = JSON.stringify({ op, ...input, forbiddenRoots: this.forbiddenRoots });
    const listing = op === 'snapshot' || op === 'inventory';
    if (Buffer.byteLength(request) > (op === 'stage' ? 140 * 1024 * 1024 : op === 'derived_publish' ? 28 * 1024 * 1024 : 131072)) throw new ApiError('BAD_REQUEST');
    return new Promise((resolve, reject) => {
      const child = spawn(this.python, ['-I', '-B', this.helper], { stdio: ['pipe', 'pipe', 'ignore'],
        env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' } });
      const chunks: Buffer[] = [], batches: unknown[] = []; let bytes = 0, failed = false, timedOut = false, batchBuffer = '';
      const fail = () => { failed = true; child.kill('SIGKILL'); };
      abort.addEventListener('abort', fail, { once: true });
      const timer = setTimeout(() => { timedOut = true; fail(); }, listing ? 300000 : op === 'extract' ? 180000 : ['stage', 'publish', 'recover', 'read', 'derived_publish', 'derived_read'].includes(op) ? 60000 : 15000);
      child.once('error', fail); child.stdin.once('error', fail);
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        const maximum = op === 'read' ? 140 * 1024 * 1024 : ['extract', 'derived_read'].includes(op) ? 28 * 1024 * 1024 : 512 * 1024;
        if (listing) {
          if (bytes > 64 * 1024 * 1024) { fail(); return; }
          batchBuffer += chunk.toString('utf8'); // Python emits ASCII JSON, including escaped Unicode.
          let end: number;
          while ((end = batchBuffer.indexOf('\n')) >= 0) {
            const line = batchBuffer.slice(0, end); batchBuffer = batchBuffer.slice(end + 1);
            try { const value = JSON.parse(line);
              if (hasFields(value, ['batch']) && Array.isArray(value.batch) && value.batch.length <= 100 && batches.length + value.batch.length <= 50000) batches.push(...value.batch);
              else chunks.push(Buffer.from(line));
            } catch { fail(); }
          }
        } else if (bytes > maximum) fail(); else chunks.push(chunk);
      });
      child.once('close', code => {
        clearTimeout(timer);
        abort.removeEventListener('abort', fail);
        try {
          if (abort.aborted) throw new ApiError('RUN_INTERRUPTED');
          if (failed || code !== 0) throw new ApiError(timedOut ? 'DEADLINE_EXCEEDED' : 'SERVICE_UNAVAILABLE');
          const response: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (hasFields(response, ['ok', 'error']) && response.ok === false) {
            const error = ERRORS.find(item => item === response.error);
            if (error) throw new ApiError(error);
          }
          if (!hasFields(response, ['ok', 'value']) || response.ok !== true) throw new ApiError('SERVICE_UNAVAILABLE');
          if (listing) {
            if (batchBuffer.trim() || !hasFields(response.value, ['items', 'skipped', 'derived']) || !Array.isArray(response.value.items)) throw new ApiError('SERVICE_UNAVAILABLE');
            response.value.items = [...batches, ...response.value.items];
          }
          resolve(response.value);
        } catch (error) { reject(error instanceof ApiError ? error : new ApiError('SERVICE_UNAVAILABLE')); }
      });
      child.stdin.end(request);
    });
  }
  async inspect(root: string, exclusions: string[]): Promise<FileIdentity> {
    const result = await this.execute('inspect', { root, exclusions });
    if (!isIdentity(result)) throw new ApiError('SERVICE_UNAVAILABLE');
    return result;
  }
  private async listing(op: 'snapshot' | 'inventory', location: VaultLocation, signal?: AbortSignal, paths?: string[]): Promise<Inventory> {
    const result = await this.execute(op, { ...location, ...(paths ? { paths } : {}) }, signal);
    if (!hasFields(result, ['items', 'skipped', 'derived']) || !Array.isArray(result.items) || result.items.length > 50000 ||
        !result.derived || typeof result.derived !== 'object' || Array.isArray(result.derived) ||
        Object.keys(result.derived).length > 50000 || !Object.entries(result.derived).every(([id, stamp]) => isId(id, 'source') && isPayloadHash(stamp)) ||
        !Number.isSafeInteger(result.skipped) || (result.skipped as number) < 0 || !result.items.every(item =>
          hasFields(item, op === 'inventory' ? ['relativePath', 'bytes', 'fingerprint'] : ['relativePath', 'bytes', 'fingerprint', 'version', 'state', 'mediaType', 'warningCode']) &&
          isRelativePath(item.relativePath) && isPayloadHash(item.fingerprint) && Number.isSafeInteger(item.bytes) && (item.bytes as number) >= 0 &&
          (op === 'inventory' || (
          (item.version === null || isPayloadHash(item.version)) && ['ready', 'pending', 'failed', 'unsupported'].includes(item.state as string) &&
          typeof item.mediaType === 'string' && item.mediaType.length <= 128 &&
          (item.warningCode === null || ['FILE_TOO_LARGE', 'EXTRACTION_EMPTY', 'UNSUPPORTED_FORMAT'].includes(item.warningCode as string)) &&
          (item.state !== 'ready' || (['text/markdown', 'text/plain'].includes(item.mediaType as string) && isPayloadHash(item.version))))))) {
      throw new ApiError('SERVICE_UNAVAILABLE');
    }
    if (new Set(result.items.map(item => item.relativePath)).size !== result.items.length) throw new ApiError('SERVICE_UNAVAILABLE');
    return result as Inventory;
  }
  async snapshot(location: VaultLocation, signal?: AbortSignal, force = false): Promise<Snapshot> {
    const sequence = ++this.scanSequence, key = JSON.stringify(location);
    const cached = this.snapshotCache?.key === key ? this.snapshotCache.items : undefined;
    try {
      let snapshot: Snapshot;
      if (force || !cached) snapshot = await this.listing('snapshot', location, signal) as Snapshot;
      else {
        const inventory = await this.listing('inventory', location, signal);
        const changed = inventory.items.filter(item => cached.get(item.relativePath)?.fingerprint !== item.fingerprint);
        // Large change sets are cheaper in one descriptor-checked scan than many helper processes.
        if (changed.length > 100) snapshot = await this.listing('snapshot', location, signal) as Snapshot;
        else {
          const fresh = new Map<string, FileRecord>();
          for (let offset = 0; offset < changed.length; offset += 16) {
            const batch = changed.slice(offset, offset + 16), expected = new Map(batch.map(item => [item.relativePath, item.fingerprint]));
            const result = await this.listing('snapshot', location, signal, batch.map(item => item.relativePath)) as Snapshot;
            if (result.items.length !== batch.length || result.items.some(item => expected.get(item.relativePath) !== item.fingerprint)) throw new ApiError('SOURCE_CHANGED');
            for (const item of result.items) fresh.set(item.relativePath, item);
          }
          snapshot = { ...inventory, items: inventory.items.map(item => fresh.get(item.relativePath) ?? cached.get(item.relativePath)!) };
        }
      }
      if (this.shutdown.signal.aborted || signal?.aborted) throw new ApiError('RUN_INTERRUPTED');
      if (sequence === this.scanSequence) this.snapshotCache = { key, items: new Map(snapshot.items.map(item => [item.relativePath, { ...item }])) };
      return snapshot;
    } catch (error) { if (sequence === this.scanSequence) this.snapshotCache = undefined; throw error; }
  }
  async missing(location: VaultLocation, relativePath: string, signal?: AbortSignal): Promise<boolean> {
    if (!isRelativePath(relativePath)) throw new ApiError('BAD_REQUEST');
    const result = await this.execute('missing', { ...location, relativePath }, signal);
    if (typeof result !== 'boolean') throw new ApiError('SERVICE_UNAVAILABLE');
    return result;
  }
  async read(location: VaultLocation, relativePath: string, expectedVersion: string, signal?: AbortSignal): Promise<Buffer> {
    if (!isRelativePath(relativePath) || !isPayloadHash(expectedVersion)) throw new ApiError('BAD_REQUEST');
    const result = await this.execute('read', { ...location, relativePath, expectedVersion }, signal);
    if (!hasFields(result, ['version', 'base64']) || result.version !== expectedVersion || typeof result.base64 !== 'string') {
      throw new ApiError('SERVICE_UNAVAILABLE');
    }
    const content = Buffer.from(result.base64, 'base64');
    if (content.length > MAX_FILE_BYTES || content.toString('base64') !== result.base64 ||
        createHash('sha256').update(content).digest('hex') !== expectedVersion) throw new ApiError('SERVICE_UNAVAILABLE');
    return content;
  }
}
