import { hasFields, isId, type Id } from './contracts.js';

export function isIngestInstruction(text: string): boolean {
  const value = text.trim().replace(/[\s，,。.!！]/g, '');
  return /^(?:请|麻烦)?(?:帮我|替我)?(?:把|将)?(?:这(?:个|份)?(?:文件|资料|文档)|附件)?(?:入库|收录|收藏|(?:存入|保存到|保存至|导入|加入|放入|存到)(?:我的)?(?:知识库|资料库|资料))(?:吧|一下)?$/.test(value);
}
export type IngestInput = { vaultId: Id<'vault'>; input:
  | { kind: 'text'; text: string; title?: string; origin?: 'pasted_text' | 'imported_chat' }
  | { kind: 'url'; url: string }
  | { kind: 'upload'; filePart: 'file' }; conversation?: { sessionId: Id<'session'>; text: string } };
export function isIngestInput(value: unknown): value is IngestInput {
  if (!hasFields(value, ['vaultId', 'input'], ['conversation']) || !isId(value.vaultId, 'vault')) return false;
  const input = value.input;
  if (value.conversation !== undefined && (!hasFields(input, ['kind', 'filePart']) || input.kind !== 'upload' ||
      !hasFields(value.conversation, ['sessionId', 'text']) || !isId(value.conversation.sessionId, 'session') ||
      typeof value.conversation.text !== 'string' || value.conversation.text.length > 500 || !isIngestInstruction(value.conversation.text))) return false;
  if (hasFields(input, ['kind', 'url']) && input.kind === 'url' && typeof input.url === 'string' && input.url.length <= 2048) return true;
  if (hasFields(input, ['kind', 'filePart']) && input.kind === 'upload' && input.filePart === 'file') return true;
  return hasFields(input, ['kind', 'text'], ['title', 'origin']) && input.kind === 'text' &&
    typeof input.text === 'string' && input.text.trim().length > 0 && !/[\x00\ud800-\udfff]/u.test(input.text) &&
    (input.title === undefined || (typeof input.title === 'string' && input.title.trim().length > 0 && input.title.length <= 200 &&
      !/[\x00-\x1f\x7f\ud800-\udfff]/u.test(input.title))) &&
    (input.origin === undefined || input.origin === 'pasted_text' || input.origin === 'imported_chat');
}
