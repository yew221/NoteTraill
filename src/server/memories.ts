import { createHash } from 'node:crypto';
import { hasFields, type Id, type IdempotencyIdentity } from '../shared/contracts.js';
import { MEMORY_LIMITS, isMemoryAction, isMemoryInput, isMemoryPatch, type Memory, type MemoryAction, type MemoryResult } from '../shared/memory.js';
import { ApiError, checkIdempotency, checkRevision, newId, requireId, requireIdempotencyKey, requireRevision } from './contracts.js';
import type { SqliteDatabase } from './storage.js';
import type { VaultService } from './vaults.js';

type Row = { id: Id<'memory'>; vault_id: Id<'vault'>; text: string; category: Memory['category']; revision: number;
  created_at: string; updated_at: string; source_user_message_id: Id<'message'> | null; deleted_at: string | null };
export class MemoryService {
  private readonly listeners = new Set<(vaultId: string) => void>();
  constructor(private readonly db: SqliteDatabase, private readonly vaults: VaultService) {}
  onChange(listener: (vaultId: string) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  notify(vaultId: string): void { for (const listener of this.listeners) { try { listener(vaultId); } catch { /* An observer cannot undo a committed edit. */ } } }
  generation(vaultId: string): number {
    this.vaults.get(vaultId);
    return (this.db.prepare('SELECT generation FROM memory_state WHERE vault_id=?').get(vaultId) as { generation: number } | undefined)?.generation ?? 1;
  }
  private row(id: string): Row {
    requireId(id, 'memory'); const row = this.db.prepare('SELECT * FROM memories WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new ApiError('NOT_FOUND'); return row;
  }
  get(id: string): Memory {
    const row = this.row(id); if (row.deleted_at) throw new ApiError('NOT_FOUND');
    return { id: row.id, vaultId: row.vault_id, text: row.text, category: row.category, revision: row.revision,
      createdAt: row.created_at, updatedAt: row.updated_at, sourceUserMessageId: row.source_user_message_id };
  }
  snapshot(vaultId: string): { generation: number; items: Memory[] } {
    const generation = this.generation(vaultId);
    const rows = this.db.prepare('SELECT id FROM memories WHERE vault_id=? AND deleted_at IS NULL ORDER BY id').all(vaultId) as { id: string }[];
    return { generation, items: rows.map(row => this.get(row.id)) };
  }
  list(vaultId: string, query: unknown): { items: Memory[]; nextCursor: string | null } {
    if (!hasFields(query, [], ['cursor','limit']) || (query.limit !== undefined && (typeof query.limit !== 'string' || !/^[1-9]\d?$/.test(query.limit) || Number(query.limit) > 50))) throw new ApiError('BAD_REQUEST');
    const { items } = this.snapshot(vaultId), limit = Number(query.limit ?? 20);
    let after = '';
    if (query.cursor !== undefined) { const row = this.row(requireId(query.cursor, 'memory')); if (row.vault_id !== vaultId) throw new ApiError('BAD_REQUEST'); after = row.id; }
    const remaining = items.filter(item => item.id > after);
    return { items: remaining.slice(0, limit), nextCursor: remaining.length > limit ? remaining[limit - 1].id : null };
  }
  private bump(vaultId: string): void {
    if (this.generation(vaultId) >= Number.MAX_SAFE_INTEGER) throw new ApiError('SERVICE_UNAVAILABLE');
    this.db.prepare(`INSERT INTO memory_state(vault_id,generation) VALUES (?,2)
      ON CONFLICT(vault_id) DO UPDATE SET generation=generation+1`).run(vaultId);
  }
  private capacity(vaultId: string, replacement: string, except?: string): void {
    const items = this.snapshot(vaultId).items.filter(item => item.id !== except);
    if (items.length >= MEMORY_LIMITS.count || items.reduce((n, item) => n + item.text.length, replacement.length) > MEMORY_LIMITS.totalLength) {
      throw new ApiError('MEMORY_LIMIT_EXCEEDED');
    }
  }
  private transaction<T>(vaultId: string, work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const before = this.generation(vaultId), result = work(), changed = this.generation(vaultId) !== before;
      this.db.exec('COMMIT'); if (changed) this.notify(vaultId); return result; }
    catch (error) { if (this.db.inTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  create(input: unknown, key: unknown): Memory {
    if (!isMemoryInput(input)) throw new ApiError('BAD_REQUEST');
    const identity: IdempotencyIdentity = { key: requireIdempotencyKey(key), operation: 'memory.create', scopeId: input.vaultId,
      payloadHash: createHash('sha256').update(JSON.stringify({ text: input.text.trim(), category: input.category })).digest('hex') };
    return this.transaction(input.vaultId, () => {
      const old = this.db.prepare('SELECT * FROM idempotency_records WHERE key=?').get(identity.key) as
        { key: string; operation: string; scope_id: string; payload_hash: string; result_json: string } | undefined;
      checkIdempotency(old ? { key: old.key, operation: old.operation, scopeId: old.scope_id, payloadHash: old.payload_hash } as IdempotencyIdentity : null, identity);
      if (old) return this.get(requireId(JSON.parse(old.result_json).memoryId, 'memory'));
      const result = this.apply(input.vaultId, { action: 'remember', actionInput: { memoryText: input.text, category: input.category } }, null);
      // Store an identity, not a hidden second copy of deleted preference text.
      this.db.prepare('INSERT INTO idempotency_records(key,operation,scope_id,payload_hash,result_json) VALUES (?,?,?,?,?)')
        .run(identity.key, identity.operation, identity.scopeId, identity.payloadHash, JSON.stringify({ memoryId: result.memoryId }));
      return result.memory!;
    });
  }
  update(id: string, input: unknown): Memory {
    if (!isMemoryPatch(input)) throw new ApiError('BAD_REQUEST');
    const row = this.row(id);
    return this.transaction(row.vault_id, () => this.apply(row.vault_id, { action: 'update_memory',
      actionInput: { memoryId: row.id, memoryText: input.text, expectedRevision: input.expectedRevision } }, null).memory!);
  }
  delete(id: string, expected: unknown): { deleted: true } {
    const row = this.row(id), expectedRevision = requireRevision(expected);
    this.transaction(row.vault_id, () => this.apply(row.vault_id, { action: 'forget', actionInput: { memoryId: row.id, expectedRevision } }, null));
    return { deleted: true };
  }
  // A message action and its terminal run are committed in one transaction by RunService.
  apply(vaultId: string, operation: MemoryAction, messageId: Id<'message'> | null): MemoryResult {
    if (!this.db.inTransaction) throw new ApiError('SERVICE_UNAVAILABLE');
    if (!isMemoryAction(operation)) throw new ApiError('BAD_REQUEST');
    const vault = this.vaults.get(vaultId), now = new Date().toISOString();
    if (messageId && !this.db.prepare('SELECT m.id FROM messages m JOIN conversations c ON c.id=m.session_id WHERE m.id=? AND c.vault_id=?').get(messageId, vaultId)) throw new ApiError('BAD_REQUEST');
    if (operation.action === 'remember') {
      const text = operation.actionInput.memoryText.trim(); this.capacity(vaultId, text);
      const id = newId('memory');
      this.db.prepare('INSERT INTO memories(id,vault_id,text,category,created_at,updated_at,source_user_message_id) VALUES (?,?,?,?,?,?,?)')
        .run(id, vault.id, text, operation.actionInput.category, now, now, messageId);
      this.bump(vaultId); return { memoryId: id, deleted: false, revision: 1, memory: this.get(id) };
    }
    const input = operation.actionInput, row = this.row(input.memoryId);
    if (row.vault_id !== vaultId) throw new ApiError('NOT_FOUND');
    if (row.deleted_at) {
      if (operation.action === 'forget' && [row.revision - 1, row.revision].includes(input.expectedRevision)) return { memoryId: row.id, deleted: true, revision: row.revision, memory: null };
      throw new ApiError('NOT_FOUND');
    }
    checkRevision(input.expectedRevision, row.revision);
    if (row.revision >= Number.MAX_SAFE_INTEGER) throw new ApiError('SERVICE_UNAVAILABLE');
    if (operation.action === 'forget') this.db.prepare("UPDATE memories SET text='',revision=revision+1,updated_at=?,deleted_at=? WHERE id=?").run(now, now, row.id);
    else {
      const text = operation.actionInput.memoryText.trim(); this.capacity(vaultId, text, row.id);
      this.db.prepare('UPDATE memories SET text=?,revision=revision+1,updated_at=?,source_user_message_id=COALESCE(?,source_user_message_id) WHERE id=?')
        .run(text, now, messageId, row.id);
    }
    this.bump(vaultId);
    return { memoryId: row.id, deleted: operation.action === 'forget', revision: row.revision + 1,
      memory: operation.action === 'forget' ? null : this.get(row.id) };
  }
}
