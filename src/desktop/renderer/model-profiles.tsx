import { useEffect, useState, type FormEvent } from 'react';
import { defaultPricing, isModelId, isSaveModelProfile, type ModelProfile, type ModelProfilesView, type SaveModelProfile } from '../../shared/model-profiles.js';
import type { ModelSettingsView } from '../../shared/model.js';
import type { PanelActions } from './panels.js';
import { api, errorText } from './client.js';
import { Dialog } from './common.js';

type Draft = Omit<SaveModelProfile, 'expectedRevision' | 'pricing'> & { apiKey: string; inputRate: string; outputRate: string };
const empty = (): Draft => ({ name: 'DeepSeek', provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash',
  modelIds: ['deepseek-flash', 'deepseek-v4-pro'], apiKey: '', inputRate: '2', outputRate: '8' });
const edit = (profile: ModelProfile): Draft => ({ id: profile.id, name: profile.name, provider: profile.provider, baseUrl: profile.baseUrl,
  model: profile.model, modelIds: [...new Set([profile.model, ...profile.modelIds])], apiKey: '',
  inputRate: profile.pricing === null ? '' : String(profile.pricing.input), outputRate: profile.pricing === null ? '' : String(profile.pricing.output) });

export function ModelProfilesPanel({ models, hasVault, actions }: { models: ModelSettingsView; hasVault: boolean; actions: PanelActions }) {
  const [view, setView] = useState<ModelProfilesView | null>(null), [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [manual, setManual] = useState(''), [removing, setRemoving] = useState<ModelProfile | null>(null);
  useEffect(() => {
    let active = true;
    void api<ModelProfilesView>('/api/v1/model/profiles').then(result => { if (active) setView(result); })
      .catch(reason => { if (active) setError(errorText(reason)); });
    return () => { active = false; };
  }, [models]);
  const locked = busy || actions.disabled || !!view?.busy;
  const change = (patch: Partial<Draft>) => setDraft(value => value ? { ...value, ...patch } : null);
  function selectModel(model: string, ids = draft?.modelIds ?? []) {
    if (!draft) return;
    const rates = defaultPricing({ ...draft, model });
    change({ model, modelIds: ids, inputRate: rates ? String(rates.input) : '', outputRate: rates ? String(rates.output) : '' });
  }
  async function mutate(work: () => Promise<ModelProfilesView>, success: string) {
    if (locked) return; setBusy(true); setError(''); setNotice('');
    try { setView(await work()); setNotice(success); await actions.refresh(); }
    catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!draft || !view || locked) return;
    const { inputRate, outputRate, apiKey, ...config } = draft;
    const pricing = inputRate.trim() === '' && outputRate.trim() === '' ? null :
      { input: inputRate.trim() === '' ? NaN : Number(inputRate), output: outputRate.trim() === '' ? NaN : Number(outputRate) };
    const input = { ...config, pricing, expectedRevision: view.revision, ...(apiKey ? { apiKey } : {}) };
    if (!isSaveModelProfile(input)) { setError('请检查配置名称、HTTPS 地址、模型 ID、密钥和两项计费单价。'); return; }
    await mutate(async () => { const result = await api<ModelProfilesView>('/api/v1/model/profiles', { method: 'PUT', body: input }); setDraft(null); return result; }, '配置已保存。');
    change({ apiKey: '' });
  }
  async function catalog() {
    if (!draft || !view || locked) return; setBusy(true); setError(''); setNotice('');
    try {
      const result = await api<{ models: string[] }>('/api/v1/model/catalog', { method: 'POST', body: {
        provider: draft.provider, baseUrl: draft.baseUrl, expectedRevision: view.revision, ...(draft.id ? { id: draft.id } : {}), ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
      } });
      const ids = [...new Set([...(draft.model ? [draft.model] : []), ...result.models])].slice(0, 100);
      change({ modelIds: ids });
      setNotice(result.models.length ? '已获取模型目录。' : '服务未返回模型目录，可以手动添加模型 ID。');
    } catch (reason) { setError(`${errorText(reason)} 仍可手动添加模型 ID。`); } finally { setBusy(false); }
  }
  async function probe() {
    if (locked) return; setBusy(true); setError('');
    try { actions.track(await actions.commands.send('/api/v1/model/probe')); setNotice('连接测试已提交，结果见任务状态。'); await actions.refresh(); }
    catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  }
  const active = view?.profiles.find(profile => profile.id === view.activeId);
  const saved = view?.profiles.find(profile => profile.id === draft?.id);
  const keepsKey = !!saved?.credentialConfigured && saved.provider === draft?.provider && saved.baseUrl === draft?.baseUrl;
  return <section className="settings-section model-profiles">
    <div className="row between"><h2>模型配置</h2><button className="button secondary" disabled={locked || !view || view.profiles.length >= 20} onClick={() => { setDraft(empty()); setManual(''); setError(''); setNotice(''); }}>添加配置</button></div>
    {!view && <p role="status">正在读取模型配置…</p>}
    {view?.busy && <p role="status">问答或连接测试进行中。</p>}
    {view?.profiles.map(profile => <article className={`model-profile-card${profile.id === view.activeId ? ' active' : ''}`} key={profile.id}>
      <div className="row">
        <strong title={profile.model}>{profile.name}</strong>
        {profile.id === view.activeId && <span>当前使用</span>}
        {profile.connection === 'failed' && <span role="status">连接未通过</span>}
      </div>
      <div className="row"><button className="text-button" disabled={locked} onClick={() => { setDraft(edit(profile)); setManual(''); setError(''); setNotice(''); }}>编辑</button>
        {profile.id !== view.activeId && <button className="button secondary" disabled={locked} onClick={() => void mutate(() => api(`/api/v1/model/profiles/${profile.id}/activate`, { method: 'POST', body: { expectedRevision: view.revision } }), '已设为当前配置。')}>设为当前</button>}
        <button className="text-button" disabled={locked} onClick={() => setRemoving(profile)}>删除</button></div>
    </article>)}
    {draft && <form className="model-profile-editor settings-form" onSubmit={event => void save(event)}>
      <div className="model-provider-tabs" aria-label="模型接口类型">
        {([['deepseek', '第三方模型提供商'], ['openai-compatible', '自定义模型 API']] as const).map(([provider, label]) => <button type="button" key={provider}
          aria-pressed={draft.provider === provider} className={draft.provider === provider ? 'active' : ''} disabled={locked} onClick={() => {
            if (provider === draft.provider) return;
            setDraft({ ...empty(), ...(draft.id ? { id: draft.id } : {}), provider, name: provider === 'deepseek' ? 'DeepSeek' : '自定义 API',
              ...(provider === 'openai-compatible' ? { baseUrl: '', model: '', modelIds: [], inputRate: '', outputRate: '' } : {}) });
          }}>{label}</button>)}
      </div>
      {draft.provider === 'deepseek' && <label className="field">提供商<select value="deepseek" disabled><option value="deepseek">DeepSeek</option></select></label>}
      <label className="field">配置名称<input value={draft.name} maxLength={80} required disabled={locked} onChange={event => change({ name: event.target.value })} /></label>
      <label className="field">API 密钥<input type="password" value={draft.apiKey} autoComplete="new-password" maxLength={512} disabled={locked}
        placeholder={keepsKey ? '已保存' : undefined} onChange={event => change({ apiKey: event.target.value })} /></label>
      <details className="model-custom-settings" open={draft.provider !== 'deepseek'}><summary>自定义设置</summary>
        <label className="field">API 地址<input type="url" value={draft.baseUrl} required readOnly={draft.provider === 'deepseek'} disabled={locked}
          placeholder="https://api.example.com/v1" onChange={event => change({ baseUrl: event.target.value })} /></label>
      </details>
      <div className="row between"><h3>模型目录</h3><button type="button" className="text-button" disabled={locked || !draft.baseUrl || (!draft.apiKey && !keepsKey)} onClick={() => void catalog()}>获取可用模型</button></div>
      <label className="field">当前模型<select value={draft.model} required disabled={locked} onChange={event => selectModel(event.target.value)}>
        <option value="" disabled>请选择或添加模型</option>{draft.modelIds.map(id => <option key={id} value={id}>{id}</option>)}
      </select></label>
      <div className="row model-manual"><label className="field"><span className="sr-only">手动模型 ID</span><input value={manual} disabled={locked} placeholder="手动输入模型 ID" maxLength={128} onChange={event => setManual(event.target.value)} /></label>
        <button type="button" className="button secondary" disabled={locked || !isModelId(manual.trim()) || draft.modelIds.length >= 100} onClick={() => { const id = manual.trim(); selectModel(id, [...new Set([...draft.modelIds, id])]); setManual(''); }}>＋ 添加模型</button></div>
      <details className="model-pricing" open={!defaultPricing(draft)}><summary>计费单价（元／百万 Token）</summary>
        <div className="model-rate-fields"><label className="field">输入<input type="number" min="0" max="10000" step="any" value={draft.inputRate} disabled={locked} readOnly={!!defaultPricing(draft)} onChange={event => change({ inputRate: event.target.value })} /></label>
          <label className="field">输出<input type="number" min="0" max="10000" step="any" value={draft.outputRate} disabled={locked} readOnly={!!defaultPricing(draft)} onChange={event => change({ outputRate: event.target.value })} /></label></div>
      </details>
      <div className="row end"><button type="button" className="button secondary" disabled={busy} onClick={() => setDraft(null)}>取消</button><button className="button primary" disabled={locked || !draft.model}>保存配置</button></div>
    </form>}
    {active && <div className="model-probe row end">
      {!hasVault && <span role="status">请先连接知识库。</span>}
      {hasVault && !active.pricing && <span role="status">请补齐计费单价。</span>}
      <button className="button secondary" disabled={locked || !hasVault || !active.credentialConfigured || !active.pricing}
        title="测试会消耗少量 Token" onClick={() => void probe()}>测试当前连接</button>
    </div>}
    {error && <p className="error-text" role="alert">{error}</p>}{notice && <p className="success-text" role="status">{notice}</p>}
    {removing && view && <Dialog title="删除模型配置" onClose={() => { if (!busy) setRemoving(null); }}>
      <p>删除“{removing.name}”及其保存的密钥。聊天记录会保留。{removing.id === view.activeId && '这是当前配置，删除后需要重新选择模型。'}</p>
      <div className="row end"><button className="button secondary" disabled={busy} onClick={() => setRemoving(null)}>取消</button><button className="button danger" disabled={locked} onClick={() => void mutate(async () => {
        const result = await api<ModelProfilesView>(`/api/v1/model/profiles/${removing.id}?expectedRevision=${view.revision}`, { method: 'DELETE' });
        setRemoving(null); if (draft?.id === removing.id) setDraft(null); return result;
      }, '配置已删除。')}>确认删除</button></div>
    </Dialog>}
  </section>;
}
