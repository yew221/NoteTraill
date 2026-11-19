import { isLegacyAnswerPolicy, type LegacyAnswerPolicy } from './chat.js';
import { isRelativePath, MAX_FILE_BYTES } from './vault.js';
import { hasFields, isId, isIdempotencyKey, isPayloadHash, type Id } from './contracts.js';
import { isScope, type Scope } from './tools.js';

export type DraftFile = { id: string; name: string; size: number; lastModified: number };
export type DesktopDraft = {
  text: string; mode: 'ask' | 'store'; title: string;
  options: { scope: Scope; answerPolicy?: LegacyAnswerPolicy };
  attachment?: DraftFile;
  pending?: { signature: string; key: string; sessionKey: string; fileOnly?: true; questionPath?: string };
  questionFileRun?: Id<'run'>;
  policyVersion?: 1;
  basedOnAnswerId?: Id<'answer'>;
  experienceComparison?:true;
};
export type DesktopWorkspace = {
  version: 1; vaultId: string; sessionId: string | null; page: 'chat' | 'sources' | 'settings' | 'watches'; sidebarWidth: number;
  drafts: Record<string, DesktopDraft>; pending: Record<string, string>;
  tasks: Array<{ runId: string; sessionId: string | null; finished: boolean }>;
  inspector?: { open: boolean; tab: 'collect' | 'read'; width: number };
};
export const emptyWorkspace = (): DesktopWorkspace => ({ version: 1, vaultId: '', sessionId: null, page: 'chat', sidebarWidth: 248, drafts: {}, pending: {}, tasks: [] });
export const emptyDraft = (): DesktopDraft => ({ text: '', mode: 'ask', title: '', options: { scope: { mode: 'vault' } } });
export const isDraftKey = (value: unknown): value is string => typeof value === 'string' &&
  (isId(value, 'session') || (value.startsWith('new:') && isId(value.slice(4), 'vault')) || (value.startsWith('collect:') && isId(value.slice(8), 'vault')));
export const isDraftFile = (value: unknown): value is DraftFile => hasFields(value, ['id', 'name', 'size', 'lastModified']) &&
  isPayloadHash(value.id) && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 255 && !/[\/\\\x00-\x1f]/.test(value.name) &&
  typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0 && value.size <= MAX_FILE_BYTES &&
  typeof value.lastModified === 'number' && Number.isSafeInteger(value.lastModified) && value.lastModified >= 0;
export const isDesktopDraft = (value: unknown): value is DesktopDraft => hasFields(value, ['text', 'mode', 'title', 'options'], ['attachment', 'pending', 'policyVersion', 'basedOnAnswerId','experienceComparison','questionFileRun']) &&
  (value.questionFileRun === undefined || isId(value.questionFileRun, 'run')) &&
  (value.experienceComparison===undefined || value.experienceComparison===true) &&
  (value.basedOnAnswerId === undefined || isId(value.basedOnAnswerId,'answer')) &&
  (value.policyVersion === undefined || value.policyVersion === 1) &&
  typeof value.text === 'string' && value.text.length <= 1_000_000 && !value.text.includes('\0') && ['ask', 'store'].includes(value.mode as string) &&
  typeof value.title === 'string' && value.title.length <= 200 && hasFields(value.options, ['scope'], ['answerPolicy']) &&
  isScope(value.options.scope) && (value.options.answerPolicy === undefined || isLegacyAnswerPolicy(value.options.answerPolicy)) &&
  (value.attachment === undefined || isDraftFile(value.attachment)) && (value.pending === undefined ||
    hasFields(value.pending, ['signature', 'key', 'sessionKey'], ['fileOnly','questionPath']) && (value.pending.fileOnly === undefined || (value.pending.fileOnly === true && !!value.attachment)) &&
    (value.pending.questionPath === undefined || (isRelativePath(value.pending.questionPath) && !!value.questionFileRun && !value.pending.fileOnly)) &&
    isPayloadHash(value.pending.signature) && isIdempotencyKey(value.pending.key) && isIdempotencyKey(value.pending.sessionKey));
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
export function pruneEmptyDrafts(state: DesktopWorkspace): DesktopWorkspace {
  const active = state.sessionId ?? `new:${state.vaultId}`;
  return { ...state, drafts: Object.fromEntries(Object.entries(state.drafts).filter(([key, draft]) =>
    key === active || key.startsWith('collect:') || !isDesktopDraft(draft) || draft.text !== '' || draft.title !== '' || !!draft.attachment || !!draft.pending ||
    !!draft.basedOnAnswerId || !!draft.experienceComparison || !!draft.questionFileRun || draft.mode !== 'ask' || draft.options.scope.mode !== 'vault')) };
}
export function isDesktopWorkspace(value: unknown): value is DesktopWorkspace {
  return hasFields(value, ['version', 'vaultId', 'sessionId', 'page', 'sidebarWidth', 'drafts', 'pending', 'tasks'], ['inspector']) && value.version === 1 &&
    (value.inspector === undefined || (hasFields(value.inspector, ['open', 'tab', 'width']) && typeof value.inspector.open === 'boolean' &&
      ['collect', 'read'].includes(value.inspector.tab as string) && typeof value.inspector.width === 'number' && Number.isFinite(value.inspector.width) && value.inspector.width >= 300 && value.inspector.width <= 640)) &&
    (value.vaultId === '' || isId(value.vaultId, 'vault')) && (value.sessionId === null || isId(value.sessionId, 'session')) &&
    ['chat', 'sources', 'settings', 'watches'].includes(value.page as string) && typeof value.sidebarWidth === 'number' && Number.isFinite(value.sidebarWidth) && value.sidebarWidth >= 180 && value.sidebarWidth <= 600 &&
    record(value.drafts) && Object.keys(value.drafts).length <= 100 && Object.entries(value.drafts).every(([key, draft]) => isDraftKey(key) && isDesktopDraft(draft)) &&
    record(value.pending) && Object.keys(value.pending).length <= 100 && Object.entries(value.pending).every(([key, item]) => isPayloadHash(key) && isIdempotencyKey(item)) &&
    Array.isArray(value.tasks) && value.tasks.length <= 100 && value.tasks.every(item => hasFields(item, ['runId', 'sessionId', 'finished']) && typeof item.finished === 'boolean' && isId(item.runId, 'run') && (item.sessionId === null || isId(item.sessionId, 'session')));
}
