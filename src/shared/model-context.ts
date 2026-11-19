// Estimates guide context packing only. Accounting reserves a separate UTF-8 upper envelope
// and settles from the provider's actual usage; no estimate is presented as exact tokens.
export const MODEL_CONTEXT_WINDOW = 32000;
export const MODEL_CONTEXT_INPUT = 28000;
export const HISTORY_LIMITS = Object.freeze({ questions: 24, bytes: 32 * 1024 });
export const REPAIR_PREFIX = 'NoteTrail 回答核对反馈：';
export function packModelContext(value: Record<string, unknown>): Record<string, unknown> {
  const payload = structuredClone(value), messages = payload.messages as Array<{ role: string; content: unknown }>;
  let removed = false;
  while (estimatedInputTokens(payload) > MODEL_CONTEXT_INPUT - 2000) {
    const users = messages.flatMap((m, i) => m.role === 'user' && !JSON.stringify(m.content).includes(REPAIR_PREFIX) ? [i] : []);
    if (users.length < 2) break;
    messages.splice(users[0], users[1] - users[0]); removed = true;
  }
  if (removed) messages.unshift({ role: 'system', content: '较早的完整问答已从本次上下文移出，完整记录仍保存在应用中。不能假装记得未提供的细节；指代不清时请用户补充。本轮证据未被删减。' });
  return payload;
}
export function estimatedInputTokens(value: unknown): number {
  const text = JSON.stringify(value);
  let weight = 0;
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    weight += cp < 128 ? 0.5 : cp >= 0x2e80 && cp <= 0x9fff ? 1.5 : 3;
  }
  return Math.ceil(weight) + 1024;
}
