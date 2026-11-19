import { defaultPricing, isModelCatalogRequest, type ModelCatalogRequest, isModelPricing, isProfileId, isSaveModelProfile, isModelId, supportedModel, type ModelProfile, type ModelProfilesView, type ModelPricing, type SaveModelProfile } from '../shared/model-profiles.js';
import { randomUUID } from 'node:crypto';
import { isRevision } from '../shared/contracts.js';
import { canonicalModelUrl, isApiKey, isModelConfig, type ModelConfig, type ModelSettingsView, type CredentialSaved } from '../shared/model.js';
import { ApiError, checkRevision } from './contracts.js';
import { credentialBinding, type CredentialBinding, type CredentialStore } from './credentials.js';
import type { SqliteDatabase } from './storage.js';

type State = { revision: number; model: ModelConfig | null; credentialId: string | null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const credentialError = (error: unknown): ApiError => error instanceof ApiError &&
  ['CONFIG_REQUIRED', 'CREDENTIAL_STORE_UNAVAILABLE'].includes(error.publicError.code) ? error : new ApiError('CREDENTIAL_STORE_UNAVAILABLE');

export class ModelSettings {
  private readonly listeners = new Set<() => void>();
  constructor(private readonly db: SqliteDatabase, private readonly credentials: CredentialStore,
    private readonly runDb: SqliteDatabase = db) {}
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  private state(): State {
    const row = this.db.prepare('SELECT revision, provider, model, base_url, credential_id FROM model_settings WHERE singleton=1').get() as
      { revision: unknown; provider: unknown; model: unknown; base_url: unknown; credential_id: unknown } | undefined;
    if (!row || !isRevision(row.revision) || !(row.credential_id === null ||
        (typeof row.credential_id === 'string' && UUID.test(row.credential_id)))) throw new ApiError('SERVICE_UNAVAILABLE');
    const model = row.provider === null && row.model === null && row.base_url === null ? null :
      { provider: row.provider, model: row.model, baseUrl: row.base_url };
    if ((model === null && row.credential_id !== null) || (model !== null && (!isModelConfig(model) ||
        model.baseUrl !== canonicalModelUrl(model.baseUrl)))) throw new ApiError('SERVICE_UNAVAILABLE');
    return { revision: row.revision, model: model as ModelConfig | null, credentialId: row.credential_id };
  }
  view(): ModelSettingsView {
    const state = this.state();
    // Do not serialize a database row or a Keychain result into public configuration.
    return { revision: state.revision, model: state.model, credentialConfigured: state.credentialId !== null };
  }
  private change(expected: number, update: (current: State, revision: number) => void, sync = true): number {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.state(); checkRevision(expected, state.revision);
      if (state.revision === Number.MAX_SAFE_INTEGER) throw new ApiError('SERVICE_UNAVAILABLE');
      const revision = state.revision + 1;
      update(state, revision);
      if (sync) this.syncProfile();
      this.db.exec('COMMIT');
      for (const listener of this.listeners) { try { listener(); } catch { /* Observers cannot undo a committed setting. */ } }
      return revision;
    } catch (error) { if (this.db.inTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  private retire(binding: CredentialBinding): void {
    this.db.prepare('INSERT OR IGNORE INTO retired_credentials(account, service) VALUES (?, ?)').run(binding.account, binding.service);
  }
  async cleanupRetired(): Promise<boolean> {
    const item = this.db.prepare(`SELECT account, service FROM retired_credentials
      WHERE account != COALESCE((SELECT credential_id FROM model_settings WHERE singleton=1), '')
      AND account NOT IN (SELECT credential_id FROM model_profiles WHERE credential_id IS NOT NULL)
      ORDER BY account LIMIT 1`).get() as CredentialBinding | undefined;
    if (!item) return true;
    try {
      await this.credentials.remove(item);
      this.db.prepare('DELETE FROM retired_credentials WHERE account=? AND service=?').run(item.account, item.service);
      return true;
    } catch { return false; } // Keep only the non-secret cleanup reference for a later retry.
  }

  async setModel(model: ModelConfig, expectedRevision: number): Promise<ModelSettingsView> {
    if (!isModelConfig(model)) throw new ApiError('BAD_REQUEST');
    const saved = { provider: model.provider, model: model.model, baseUrl: canonicalModelUrl(model.baseUrl)! };
    this.change(expectedRevision, (current, revision) => {
      const sameService = current.model?.provider === saved.provider && current.model.baseUrl === saved.baseUrl;
      if (!sameService && current.model && current.credentialId) this.retire(credentialBinding(current.model, current.credentialId));
      this.db.prepare(`UPDATE model_settings SET revision=?, provider=?, model=?, base_url=?, credential_id=? WHERE singleton=1`)
        .run(revision, saved.provider, saved.model, saved.baseUrl, sameService ? current.credentialId : null);
    });
    const result = this.view();
    await this.cleanupRetired();
    return result;
  }

  async setCredential(secret: string, expectedRevision: number): Promise<CredentialSaved> {
    if (!isApiKey(secret)) throw new ApiError('BAD_REQUEST');
    const current = this.state(); checkRevision(expectedRevision, current.revision);
    if (current.revision === Number.MAX_SAFE_INTEGER) throw new ApiError('SERVICE_UNAVAILABLE');
    if (!current.model) throw new ApiError('CONFIG_REQUIRED');
    const id = randomUUID(), binding = credentialBinding(current.model, id);
    try { await this.credentials.write(binding, secret); }
    catch (error) {
      try { this.retire(binding); await this.cleanupRetired(); } catch { /* A failed save never becomes the active reference. */ }
      throw credentialError(error);
    }
    let revision: number;
    try {
      revision = this.change(expectedRevision, (state, next) => {
        if (state.model && state.credentialId) this.retire(credentialBinding(state.model, state.credentialId));
        this.db.prepare('UPDATE model_settings SET credential_id=?, revision=? WHERE singleton=1').run(id, next);
      });
    } catch (error) {
      try { this.retire(binding); await this.cleanupRetired(); } catch { /* Preserve the original safe failure. */ }
      throw error;
    }
    await this.cleanupRetired();
    return { configured: true, revision };
  }


  private activeId(): string | null {
    return (this.db.prepare('SELECT active_profile_id FROM model_settings WHERE singleton=1').get() as { active_profile_id: string | null }).active_profile_id;
  }
  private profileRow(id: string) {
    if (!isProfileId(id)) throw new ApiError('BAD_REQUEST');
    const row = this.db.prepare('SELECT * FROM model_profiles WHERE id=?').get(id) as
      { id: string; name: string; provider: string; model: string; base_url: string; credential_id: string | null;
        pricing_json: string | null; model_ids_json: string; connection: ModelProfile['connection'] } | undefined;
    if (!row) throw new ApiError('NOT_FOUND');
    return row;
  }
  private syncProfile(): void {
    const state = this.state(); if (!state.model) return;
    const id = this.activeId() ?? 'mp_default', model = state.model;
    const old = this.db.prepare('SELECT * FROM model_profiles WHERE id=?').get(id) as { provider: string; model: string; base_url: string; pricing_json: string | null } | undefined;
    const unchanged = old?.provider === model.provider && old.model === model.model && old.base_url === model.baseUrl;
    const pricing = defaultPricing(model);
    this.db.prepare(`INSERT INTO model_profiles(id,name,provider,model,base_url,credential_id,pricing_json,model_ids_json)
      VALUES (?,'现有模型',?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,model=excluded.model,
      base_url=excluded.base_url,credential_id=excluded.credential_id,pricing_json=excluded.pricing_json,connection='untested'`)
      .run(id, model.provider, model.model, model.baseUrl, state.credentialId, unchanged ? old!.pricing_json : pricing ? JSON.stringify(pricing) : null, JSON.stringify([model.model]));
    this.db.prepare('UPDATE model_settings SET active_profile_id=? WHERE singleton=1').run(id);
  }
  private busy(): boolean {
    return !!this.runDb.prepare("SELECT 1 FROM runs WHERE kind IN ('message','model_probe') AND state IN ('queued','running','cancelling') LIMIT 1").get();
  }
  private idle(): void { if (this.busy()) throw new ApiError('MODEL_SETTINGS_BUSY'); }
  profiles(): ModelProfilesView {
    return { revision: this.state().revision, activeId: this.activeId(), busy: this.busy(),
      profiles: (this.db.prepare('SELECT id FROM model_profiles ORDER BY rowid').all() as { id: string }[]).map(({ id }) => {
        const row = this.profileRow(id);
        return { id, name: row.name, provider: row.provider, model: row.model, baseUrl: row.base_url,
          credentialConfigured: row.credential_id !== null, pricing: row.pricing_json ? JSON.parse(row.pricing_json) as ModelPricing : null,
          modelIds: JSON.parse(row.model_ids_json) as string[], connection: row.connection };
      }) };
  }
  activePricing(): ModelPricing | null {
    const id = this.activeId(); if (!id) return null;
    const row = this.profileRow(id), pricing: unknown = row.pricing_json ? JSON.parse(row.pricing_json) : null;
    return isModelPricing(pricing) ? pricing : null;
  }
  async saveProfile(input: SaveModelProfile): Promise<ModelProfilesView> {
    if (!isSaveModelProfile(input)) throw new ApiError('BAD_REQUEST');
    checkRevision(input.expectedRevision, this.state().revision); this.idle();
    if (!input.id && (this.db.prepare('SELECT count(*) AS n FROM model_profiles').get() as { n: number }).n >= 20) throw new ApiError('BAD_REQUEST');
    const old = input.id ? this.profileRow(input.id) : null, id = old?.id ?? `mp_${randomUUID()}`;
    const config = { provider: input.provider, model: input.model, baseUrl: canonicalModelUrl(input.baseUrl)! };
    const sameService = old?.provider === config.provider && old.base_url === config.baseUrl;
    const credentialId = input.apiKey ? randomUUID() : sameService ? old!.credential_id : null;
    const binding = input.apiKey ? credentialBinding(config, credentialId!) : null;
    const pricing = defaultPricing(config) ?? input.pricing;
    try {
      if (binding) { try { await this.credentials.write(binding, input.apiKey!); } catch (error) { throw credentialError(error); } }
      this.change(input.expectedRevision, (_current, revision) => {
        this.idle();
        if (!old && (this.db.prepare('SELECT count(*) AS n FROM model_profiles').get() as { n: number }).n >= 20) throw new ApiError('BAD_REQUEST');
        if (old?.credential_id && old.credential_id !== credentialId) this.retire(credentialBinding({ provider: old.provider, model: old.model, baseUrl: old.base_url }, old.credential_id));
        this.db.prepare(`INSERT INTO model_profiles(id,name,provider,model,base_url,credential_id,pricing_json,model_ids_json)
          VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,provider=excluded.provider,model=excluded.model,
          base_url=excluded.base_url,credential_id=excluded.credential_id,pricing_json=excluded.pricing_json,model_ids_json=excluded.model_ids_json,connection='untested'`)
          .run(id, input.name.trim(), config.provider, config.model, config.baseUrl, credentialId, pricing ? JSON.stringify(pricing) : null,
            JSON.stringify([...new Set([config.model, ...input.modelIds])].slice(0, 100)));
        this.db.prepare('UPDATE model_settings SET revision=? WHERE singleton=1').run(revision);
        if (!this.activeId() || this.activeId() === id) this.useProfile(id);
      }, false);
    } catch (error) {
      if (binding) { try { this.retire(binding); await this.cleanupRetired(); } catch { /* Retain the safe original failure. */ } }
      throw error;
    }
    await this.cleanupRetired(); return this.profiles();
  }
  private useProfile(id: string): void {
    const row = this.profileRow(id);
    this.db.prepare('UPDATE model_settings SET active_profile_id=?,provider=?,model=?,base_url=?,credential_id=? WHERE singleton=1')
      .run(id, row.provider, row.model, row.base_url, row.credential_id);
  }
  activateProfile(id: string, expectedRevision: number): ModelProfilesView {
    this.change(expectedRevision, (_current, revision) => {
      this.idle(); this.useProfile(id);
      this.db.prepare('UPDATE model_settings SET revision=? WHERE singleton=1').run(revision);
    }, false);
    return this.profiles();
  }
  async deleteProfile(id: string, expectedRevision: number): Promise<ModelProfilesView> {
    this.change(expectedRevision, (_current, revision) => {
      this.idle(); const row = this.profileRow(id);
      if (id === this.activeId()) this.db.prepare('UPDATE model_settings SET active_profile_id=NULL,provider=NULL,model=NULL,base_url=NULL,credential_id=NULL WHERE singleton=1').run();
      if (row.credential_id) this.retire(credentialBinding({ provider: row.provider, model: row.model, baseUrl: row.base_url }, row.credential_id));
      this.db.prepare('DELETE FROM model_profiles WHERE id=?').run(id);
      this.db.prepare('UPDATE model_settings SET revision=? WHERE singleton=1').run(revision);
    }, false);
    await this.cleanupRetired(); return this.profiles();
  }
  recordProbe(revision: number, passed: boolean): void {
    if (revision !== this.state().revision) return;
    this.db.prepare('UPDATE model_profiles SET connection=? WHERE id=?').run(passed ? 'passed' : 'failed', this.activeId());
  }
  async catalog(input: ModelCatalogRequest, fetcher: typeof fetch = fetch): Promise<{ models: string[] }> {
    if (!isModelCatalogRequest(input)) throw new ApiError('BAD_REQUEST');
    const expectedRevision = input.expectedRevision;
    checkRevision(expectedRevision, this.state().revision);
    const config = { provider: input.provider, baseUrl: canonicalModelUrl(input.baseUrl)!, model: 'catalog' };
    let secret: string | undefined = input.apiKey;
    if (!secret && input.id) {
      const row = this.profileRow(input.id);
      if (row.provider !== config.provider || row.base_url !== config.baseUrl || !row.credential_id) throw new ApiError('CONFIG_REQUIRED');
      try { secret = await this.credentials.read(credentialBinding(config, row.credential_id)); } catch (error) { throw credentialError(error); }
    }
    if (!isApiKey(secret)) throw new ApiError('CONFIG_REQUIRED');
    checkRevision(expectedRevision, this.state().revision);
    try {
      const response = await fetcher(`${config.baseUrl}/models`, { redirect: 'error', signal: AbortSignal.timeout(10000), headers: { authorization: `Bearer ${secret}` } });
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new ApiError(response.status === 401 || response.status === 403 ? 'MODEL_AUTH_FAILED' : 'MODEL_UNAVAILABLE'); }
      if (!response.body) throw new ApiError('MODEL_PROTOCOL_ERROR');
      const reader = response.body.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
      try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 1024 * 1024) throw new ApiError('MODEL_PROTOCOL_ERROR'); chunks.push(chunk.value); } }
      finally { void reader.cancel().catch(() => {}); }
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.includes(secret)) throw new ApiError('MODEL_PROTOCOL_ERROR');
      const payload = JSON.parse(text) as { data?: Array<{ id?: unknown }> };
      if (!Array.isArray(payload.data) || payload.data.length > 10000) throw new ApiError('MODEL_PROTOCOL_ERROR');
      if (payload.data.some(item => typeof item?.id === 'string' && item.id.includes(secret!))) throw new ApiError('MODEL_PROTOCOL_ERROR');
      checkRevision(expectedRevision, this.state().revision);
      return { models: [...new Set(payload.data.map(item => item?.id).filter(isModelId))].sort().slice(0, 100) };
    } catch (error) { throw error instanceof ApiError ? error : new ApiError('MODEL_UNAVAILABLE'); }
  }

  async forSearch(): Promise<{ apiKey: string; revision: number }> {
    const revision = this.state().revision;
    const row = this.db.prepare(`SELECT id FROM model_profiles WHERE provider='deepseek' AND base_url='https://api.deepseek.com'
      AND credential_id IS NOT NULL ORDER BY id=COALESCE((SELECT active_profile_id FROM model_settings WHERE singleton=1),'') DESC,id LIMIT 1`).get() as { id: string } | undefined;
    if (!row) throw new ApiError('SEARCH_CONFIG_REQUIRED');
    const profile = this.profileRow(row.id);
    let apiKey: string;
    try { apiKey = await this.credentials.read(credentialBinding({ provider: 'deepseek', model: profile.model, baseUrl: profile.base_url }, profile.credential_id!)); }
    catch (error) { throw credentialError(error); }
    if (!isApiKey(apiKey)) throw new ApiError('CREDENTIAL_STORE_UNAVAILABLE');
    checkRevision(revision, this.state().revision);
    return { apiKey, revision };
  }
  async forRequest(): Promise<ModelConfig & { apiKey: string; revision: number; pricing: ModelPricing | null }> {
    const state = this.state();
    if (!state.model || !state.credentialId) throw new ApiError('CONFIG_REQUIRED');
    let apiKey: string;
    try { apiKey = await this.credentials.read(credentialBinding(state.model, state.credentialId)); }
    catch (error) { throw credentialError(error); }
    if (!isApiKey(apiKey)) throw new ApiError('CREDENTIAL_STORE_UNAVAILABLE');
    checkRevision(state.revision, this.state().revision);
    return { ...state.model, revision: state.revision, apiKey, pricing: this.activePricing() };
  }
}
