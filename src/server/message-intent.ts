import { isId } from '../shared/contracts.js';
import { isMemoryAction, isMemoryText, type Memory, type MemoryAction } from '../shared/memory.js';
import type { AcceptedQuestion } from './conversations.js';
import { ApiError } from './contracts.js';

type PreviousMemory = { memoryId: string; revision: number } | null;
const unquote = (text: string): string => text.trim().replace(/^(?:“([\s\S]*)”|「([\s\S]*)」|"([\s\S]*)")$/, (_all, a, b, c) => a ?? b ?? c).trim();
export function resolveMessage(input: AcceptedQuestion, memories: Memory[], previous: PreviousMemory): { action: 'ask' } | MemoryAction {
  if (input.action === 'ask') return { action: 'ask' };
  if (input.action === 'remember' || input.action === 'update_memory' || input.action === 'forget') return input;
  const unclear = (): never => { throw new ApiError('INTENT_UNCLEAR', {
    memoryCandidates: memories.map(item => ({ memoryId: item.id, text: item.text, revision: item.revision })) }); };
  const text = input.text.trim().replace(/^(?:请帮我|请|帮我|麻烦(?:你)?)[，,\s]*/, '');
  if (/(?:不要|别|不用|无需|不必|不想|不希望|不能).*(?:记住|记下|忘记|删除记忆)/.test(text)) return { action: 'ask' };
  const target = (raw: string): { memoryId: Memory['id']; expectedRevision: number } => {
    const name = unquote(raw.replace(/[。.]$/, ''));
    if (['那条','这条','那条记忆','这条记忆','刚才那条','刚才这条'].includes(name)) {
      const item = previous && memories.find(item => item.id === previous.memoryId);
      return item && previous ? { memoryId: item.id, expectedRevision: previous.revision } : unclear();
    }
    const matches = memories.filter(item => isId(name, 'memory') ? item.id === name : item.text === name);
    if (matches.length !== 1) return unclear();
    return { memoryId: matches[0].id, expectedRevision: matches[0].revision };
  };
  // Literal current-user commands only. No model, prior answer or retrieved text can supply an action.
  const remember = /^(?:记住|记下|记一下|remember\b)\s*[:：，,]?\s*([\s\S]*)$/i.exec(text) ??
    /^(.+?)[，,；;\s]+(?:请)?(?:记住|记下)(?:这点|这一点|这个偏好)?[。.!！]?$/.exec(text);
  const update = /^(?:把|将)?(这条记忆|那条记忆)\s*(?:改为|改成|修改为|更新为)\s*[:：]?\s*([\s\S]+)$/.exec(text) ??
    /^(?:修改|更新)(这条记忆|那条记忆)\s*(?:为|成|[:：])\s*([\s\S]+)$/.exec(text) ??
    /^(?:把|将)?记忆\s*(.+?)\s*(?:改为|改成|修改为|更新为)\s*[:：]?\s*([\s\S]+)$/.exec(text) ??
    /^(?:修改|更新)记忆\s*(.+?)\s*[:：]\s*([\s\S]+)$/.exec(text);
  const forget = /^(?:忘记|删除记忆|移除记忆|forget\b)\s*[:：]?\s*([\s\S]*)$/i.exec(text);
  if (remember || update || forget) {
    if (/[?？]\s*$|(?:怎么|如何|为什么|能否|是否|是什么意思|有什么含义)|(?:然后|同时|并且|顺便).*(?:记住|忘记|删除|保存|修改|更新)/.test(text)) return unclear();
    if (remember) {
      const memoryText = unquote(remember[1]);
      if (!isMemoryText(memoryText) || /^(?:这|那)(?:个|条)|^(?:上面|刚才|以上)(?:的|内容|回答)?[。.]?$|^(?:我)?(?:刚才|之前|前面)(?:说的)?(?:话|内容|偏好)[。.]?$|^(?:this|that|it|what I said|the above)[.!]?$/i.test(memoryText)) return unclear();
      return { action: 'remember', actionInput: { memoryText, category: 'user_note' } };
    }
    if (update) {
      const operation = { action: 'update_memory', actionInput: { ...target(update[1]), memoryText: unquote(update[2]) } };
      return isMemoryAction(operation) ? operation : unclear();
    }
    return { action: 'forget', actionInput: target(forget![1]) };
  }
  // Unsupported/ambiguous write requests never fall through to an answer that claims the write happened.
  if (/^(?:修改|更新|保存|收藏|删除|移除|忘记|remember\b|forget\b)|^(?:把|将).*(?:记忆|偏好).*(?:改|更新|删除)/i.test(text)) return unclear();
  return { action: 'ask' };
}
