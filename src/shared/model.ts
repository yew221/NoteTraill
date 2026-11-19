import { hasFields, isRevision, type Revision } from './contracts.js';

export type ModelConfig = { provider: string; model: string; baseUrl: string };
export type ModelSettingsView = { revision: Revision; model: ModelConfig | null; credentialConfigured: boolean };
export type ModelRequest = ModelConfig & { expectedRevision: Revision };
export type CredentialRequest = { apiKey: string; expectedRevision: Revision };
export type CredentialSaved = { configured: true; revision: Revision };

export function canonicalModelUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048 || value !== value.trim() || /[\s\\\x00-\x1f\x7f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) return null;
    const canonical = url.href.replace(/\/$/, '');
    return canonical.length <= 2048 ? canonical : null;
  } catch { return null; }
}
export const isApiKey = (value: unknown): value is string =>
  typeof value === 'string' && /^[\x21-\x7e]{16,512}$/.test(value);
export const isModelConfig = (value: unknown): value is ModelConfig =>
  hasFields(value, ['provider', 'model', 'baseUrl']) && typeof value.provider === 'string' &&
  /^[a-z][a-z0-9-]{0,63}$/.test(value.provider) && typeof value.model === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value.model) && canonicalModelUrl(value.baseUrl) !== null;
export const isModelRequest = (value: unknown): value is ModelRequest =>
  hasFields(value, ['provider', 'model', 'baseUrl', 'expectedRevision']) && isRevision(value.expectedRevision) &&
  isModelConfig({ provider: value.provider, model: value.model, baseUrl: value.baseUrl });
export const isCredentialRequest = (value: unknown): value is CredentialRequest =>
  hasFields(value, ['apiKey', 'expectedRevision']) && isApiKey(value.apiKey) && isRevision(value.expectedRevision);
export const isModelSettingsView = (value: unknown): value is ModelSettingsView =>
  hasFields(value, ['revision', 'model', 'credentialConfigured']) && isRevision(value.revision) &&
  (value.model === null || isModelConfig(value.model)) && typeof value.credentialConfigured === 'boolean' &&
  (value.model !== null || value.credentialConfigured === false);
export const isCredentialSaved = (value: unknown): value is CredentialSaved =>
  hasFields(value, ['configured', 'revision']) && value.configured === true && isRevision(value.revision);
