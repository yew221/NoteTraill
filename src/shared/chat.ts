import { hasFields, isId, type Id } from './contracts.js';
import { isScope, type Scope } from './tools.js';
// Accepted only when reading/retrying a pre-unified client request; never an execution policy.
export type LegacyAnswerPolicy = 'vault_only' | 'vault_first';
export const isLegacyAnswerPolicy = (value: unknown): value is LegacyAnswerPolicy => value === 'vault_only' || value === 'vault_first';
import { isMemoryAction, type MemoryAction } from './memory.js';
import type { RunResult } from './run.js';
import { retrospectiveRequestText } from './retrospective.js';
import { resumeRequestText } from './continuation.js';

export const QUESTION_MAX_BYTES = 16000;
export const questionBytes = (text: string): number => new TextEncoder().encode(text).length;
export const questionTooLong = (text: string): boolean => questionBytes(text) > QUESTION_MAX_BYTES;

export type Conversation = { id: Id<'session'>; vaultId: Id<'vault'>; title: string; createdAt: string;
  updatedAt: string; activeSegmentId: Id<'segment'> | null; contextGeneration: number };
export type DeletionImpact = { watches: number; versions: number };
export const isDeletionImpact = (value: unknown): value is DeletionImpact =>
  hasFields(value, ['watches','versions']) && typeof value.watches === 'number' && Number.isSafeInteger(value.watches) && value.watches >= 0 &&
  typeof value.versions === 'number' && Number.isSafeInteger(value.versions) && value.versions >= value.watches &&
  (value.watches !== 0 || value.versions === 0);
export function parseSessionCursor(value: unknown): { vaultId: Id<'vault'>; updatedAt: string; id: Id<'session'> } | null {
  if (typeof value !== 'string' || value.length > 128) return null;
  const parts = value.split('~'), [version, vaultId, updatedAt, id] = parts;
  if (parts.length !== 4 || version !== 'v1' || !isId(vaultId, 'vault') || !isId(id, 'session') ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(updatedAt) || !Number.isFinite(Date.parse(updatedAt)) ||
      new Date(updatedAt).toISOString() !== updatedAt) return null;
  return { vaultId, updatedAt, id };
}
export type QuestionInput = { text: string; scope?: Scope; answerPolicy?: LegacyAnswerPolicy; basedOnAnswerId?: Id<'answer'>; workflow?:'resume'|'retrospective'; workflowNote?:string; experienceComparison?:true } &
  ({ action?: 'auto' | 'ask'; actionInput?: never } | MemoryAction);
export type Message = { id: Id<'message'>; sessionId: Id<'session'>; runId: Id<'run'>; text: string;
  scope: Scope; createdAt: string; answerId: Id<'answer'> | null; basedOnAnswerId?: Id<'answer'>; workflow?:'resume'|'retrospective';
  resolvedAction: string | null; result: RunResult | null; attachment?: { name: string; sourceId: Id<'source'> } };
export const HISTORY_TERM_LIMIT = 120;
export function isHistoryTerm(value: unknown): value is string {
  return typeof value === 'string' && value.length <= HISTORY_TERM_LIMIT && !!value.trim() &&
    !/[\x00-\x1f\x7f\ud800-\udfff]/u.test(value);
}
export type HistoryPosition = { messageId: Id<'message'>; role: 'user' | 'assistant' };
export type HistoryHit = { sessionId: Id<'session'>; title: string;
  position: HistoryPosition | null; snippet: { before: string; match: string; after: string } };
export function historyWindow<T extends Pick<Message, 'id'>>(messages: T[], count: number, position?: HistoryPosition | null) {
  const index = position ? messages.findIndex(message => message.id === position.messageId) : -1;
  const end = index < 0 ? messages.length : Math.min(messages.length, Math.max(count, index + 1 + Math.floor(count / 2)));
  const start = Math.max(0, end - count);
  return { items: messages.slice(start, end), earlier: start, later: messages.length - end };
}
export const isConversationInput = (value: unknown): value is { vaultId: Id<'vault'>; title?: string } =>
  hasFields(value, ['vaultId'], ['title']) && isId(value.vaultId, 'vault') &&
  (value.title === undefined || (typeof value.title === 'string' && value.title.trim().length > 0 && value.title.length <= 120));
export const isQuestionInput = (value: unknown): value is QuestionInput =>
  hasFields(value, ['text'], ['scope','answerPolicy','action','actionInput','basedOnAnswerId','workflow','workflowNote','experienceComparison']) && typeof value.text === 'string' &&
  value.text.trim().length > 0 && !questionTooLong(value.text) && !value.text.includes('\0') &&
  (value.scope === undefined || isScope(value.scope)) &&
  (value.experienceComparison===undefined || (value.experienceComparison===true && value.action==='ask' && value.workflow===undefined && value.actionInput===undefined)) &&
  (value.workflowNote===undefined || ((value.workflow==='resume'||value.workflow==='retrospective') && typeof value.workflowNote==='string' && value.workflowNote.length<=3000)) &&
  (value.workflow === undefined || ((value.workflow === 'resume'||value.workflow==='retrospective') && value.action === 'ask' && (value.workflow==='retrospective'||value.basedOnAnswerId === undefined) && value.actionInput === undefined && value.text===(value.workflow==='resume'?resumeRequestText:retrospectiveRequestText)(value.workflowNote as string|undefined))) &&
  (value.basedOnAnswerId === undefined || (isId(value.basedOnAnswerId,'answer') && value.actionInput === undefined)) &&
  (value.answerPolicy === undefined || isLegacyAnswerPolicy(value.answerPolicy)) &&
  ((value.actionInput === undefined && (value.action === undefined || value.action === 'auto' || value.action === 'ask')) ||
    isMemoryAction({ action: value.action, actionInput: value.actionInput }));
