import { hasFields, isId, isRevision, type Id } from './contracts.js';

export const MEMORY_LIMITS = Object.freeze({ textLength: 2000, count: 100, totalLength: 12000 });
export type MemoryCategory = 'preference' | 'focus' | 'user_note';
export type Memory = { id: Id<'memory'>; vaultId: Id<'vault'>; text: string; category: MemoryCategory; revision: number;
  createdAt: string; updatedAt: string; sourceUserMessageId: Id<'message'> | null };
export type MemoryInput = { vaultId: Id<'vault'>; text: string; category: MemoryCategory };
export type MemoryResult = { memoryId: Id<'memory'>; deleted: boolean; revision: number; memory: Memory | null };
export type MemoryAction = { action: 'remember'; actionInput: { memoryText: string; category: MemoryCategory } } |
  { action: 'update_memory'; actionInput: { memoryId: Id<'memory'>; expectedRevision: number; memoryText: string } } |
  { action: 'forget'; actionInput: { memoryId: Id<'memory'>; expectedRevision: number } };
export const isMemoryText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 &&
  value.length <= MEMORY_LIMITS.textLength && !/[\x00\ud800-\udfff]/u.test(value);
export const isMemoryCategory = (value: unknown): value is MemoryCategory => typeof value === 'string' && ['preference','focus','user_note'].includes(value);
export const isMemoryInput = (value: unknown): value is MemoryInput => hasFields(value, ['vaultId','text','category']) &&
  isId(value.vaultId, 'vault') && isMemoryText(value.text) && isMemoryCategory(value.category);
export const isMemoryPatch = (value: unknown): value is { text: string; expectedRevision: number } =>
  hasFields(value, ['text','expectedRevision']) && isMemoryText(value.text) && isRevision(value.expectedRevision);
export function isMemoryAction(value: unknown): value is MemoryAction {
  if (!hasFields(value, ['action','actionInput'])) return false;
  const input = value.actionInput;
  if (value.action === 'remember') return hasFields(input, ['memoryText','category']) && isMemoryText(input.memoryText) && isMemoryCategory(input.category);
  if (value.action === 'update_memory') return hasFields(input, ['memoryId','expectedRevision','memoryText']) &&
    isId(input.memoryId, 'memory') && isRevision(input.expectedRevision) && isMemoryText(input.memoryText);
  return value.action === 'forget' && hasFields(input, ['memoryId','expectedRevision']) && isId(input.memoryId, 'memory') && isRevision(input.expectedRevision);
}
