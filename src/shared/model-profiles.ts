import { hasFields, isRevision } from './contracts.js';
import { canonicalModelUrl, isApiKey, isModelConfig, type ModelConfig } from './model.js';

// Rates are CNY per million tokens (= micro-yuan per token), deliberately
// separate from usage. Null means unknown and must never become a zero charge.
export type ModelPricing = { input: number; output: number };
export type ModelProfile = ModelConfig & { id: string; name: string; credentialConfigured: boolean;
  pricing: ModelPricing | null; modelIds: string[]; connection: 'untested' | 'passed' | 'failed' };
export type ModelProfilesView = { revision: number; activeId: string | null; profiles: ModelProfile[]; busy: boolean };
export type SaveModelProfile = ModelConfig & { id?: string; name: string; pricing: ModelPricing | null;
  modelIds: string[]; apiKey?: string; expectedRevision: number };
export type ModelCatalogRequest = { provider: string; baseUrl: string; id?: string; apiKey?: string; expectedRevision: number };
export const isProfileId = (id: unknown): id is string => typeof id === 'string' && /^mp_(?:default|[a-f0-9-]{36})$/.test(id);
export const isModelId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(id);
export const isModelPricing = (value: unknown): value is ModelPricing => hasFields(value, ['input', 'output']) &&
  Object.values(value).every(rate => typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 && rate <= 10000);
export function defaultPricing(config: ModelConfig): ModelPricing | null {
  if (config.provider !== 'deepseek' || config.baseUrl !== 'https://api.deepseek.com') return null;
  // Official CNY peak, cache-miss rates verified 2026-11-16. No FX assumption.
  if (['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(config.model)) return { input: 2, output: 8 };
  if (config.model === 'deepseek-v4-pro') return { input: 9, output: 27 };
  return null;
}
export const supportedModel = (config: ModelConfig): boolean => config.provider === 'openai-compatible' ||
  config.provider === 'deepseek' && canonicalModelUrl(config.baseUrl) === 'https://api.deepseek.com';
export const isSaveModelProfile = (value: unknown): value is SaveModelProfile =>
  hasFields(value, ['provider','model','baseUrl','name','pricing','modelIds','expectedRevision'], ['id','apiKey']) &&
  isModelConfig({ provider: value.provider, model: value.model, baseUrl: value.baseUrl }) && supportedModel(value as SaveModelProfile) &&
  typeof value.name === 'string' && value.name.trim().length > 0 && value.name.length <= 80 && !/[\x00-\x1f]/.test(value.name) &&
  (value.id === undefined || isProfileId(value.id)) && isRevision(value.expectedRevision) &&
  (value.pricing === null || isModelPricing(value.pricing)) && (value.apiKey === undefined || isApiKey(value.apiKey)) &&
  Array.isArray(value.modelIds) && value.modelIds.length <= 100 && value.modelIds.every(isModelId) && new Set(value.modelIds).size === value.modelIds.length;
export const completionEndpoint = (config: ModelConfig) => `${config.baseUrl}/chat/completions`;
export const completionLimitField = (config: ModelConfig): 'max_tokens' | 'max_completion_tokens' =>
  new URL(config.baseUrl).hostname === 'api.openai.com' ? 'max_completion_tokens' : 'max_tokens';
export const isModelCatalogRequest = (value: unknown): value is ModelCatalogRequest =>
  hasFields(value, ['provider','baseUrl','expectedRevision'], ['id','apiKey']) &&
  isRevision(value.expectedRevision) && (value.id === undefined || isProfileId(value.id)) &&
  (value.apiKey === undefined || isApiKey(value.apiKey)) &&
  isModelConfig({ provider: value.provider, baseUrl: value.baseUrl, model: 'catalog' }) &&
  supportedModel({ provider: value.provider as string, baseUrl: value.baseUrl as string, model: 'catalog' });
