import { hasFields } from './contracts.js';

export const MODEL_LIMITS = Object.freeze({ maxRequests: 16, maxRetries: 1, maxInputTokens: 1000000,
  maxOutputTokens: 32768, requestInputTokens: 128000, requestOutputTokens: 8192,
  requestMs: 90000, questionMs: 300000 });
export type ModelLimits = { [K in keyof typeof MODEL_LIMITS]: number };
export type RawUsage = { prompt_tokens: number; completion_tokens: number; total_tokens: number;
  prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number };
export const isRawUsage = (value: unknown): value is RawUsage => {
  if (!hasFields(value, ['prompt_tokens', 'completion_tokens', 'total_tokens'],
    ['prompt_cache_hit_tokens', 'prompt_cache_miss_tokens'])) return false;
  if (!Object.values(value).every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) return false;
  const usage = value as RawUsage;
  return usage.prompt_tokens > 0 && usage.total_tokens === usage.prompt_tokens + usage.completion_tokens &&
    (usage.prompt_cache_hit_tokens === undefined || usage.prompt_cache_hit_tokens <= usage.prompt_tokens) &&
    (usage.prompt_cache_miss_tokens === undefined || usage.prompt_cache_miss_tokens <= usage.prompt_tokens) &&
    (usage.prompt_cache_hit_tokens === undefined || usage.prompt_cache_miss_tokens === undefined ||
      usage.prompt_cache_hit_tokens + usage.prompt_cache_miss_tokens === usage.prompt_tokens);
};
export type ModelReservation = { id: string; number: number; inputReserved: number; outputLimit: number; timeoutMs: number };
export type ModelTotals = { inputTokens: number | null; outputTokens: number | null; modelRequests: number;
  knownInputTokens: number; knownOutputTokens: number; costMicroYuan: number | null;
  knownCostMicroYuan: number; reservedMicroYuan: number; retries: number; searchRequests?: number };
