import { installApiTransport, ClientError, type RequestOptions } from './client.js';
import { data } from './api.js';
import { isDeletionImpact } from '../../shared/chat.js';
import { fingerprint, type Workspace } from './workspace.js';

// Reuse the existing forms; their HTTP vocabulary becomes named, validated desktop capabilities.
export function installDesktopTransport(workspace: Workspace): void {
  installApiTransport(async (path, options) => {
    if (options.signal?.aborted) throw options.signal.reason;
    try {
      const result = options.key && options.method === 'POST' ? await workspace.auxiliary(await fingerprint({ path, body: options.body ?? null }),
        key => invoke(path, { ...options, key })) : await invoke(path, options);
      if (options.signal?.aborted) throw options.signal.reason;
      return result;
    } catch (error) { const reason = error as Error & { code?: string }; throw new ClientError(reason.message, reason.code); }
  });
}
async function invoke(path: string, options: RequestOptions): Promise<unknown> {
  const api = window.notetrail, method = options.method ?? 'GET', body = options.body, key = options.key ?? '';
  const [pathname, query = ''] = path.split('?'), params = new URLSearchParams(query);
  const cursor = params.get('cursor') ?? undefined;
  if (method === 'GET' && pathname === '/api/v1/sessions/search' &&
      [...params.keys()].every(name => ['vaultId','q','cursor','sessionId'].includes(name) && params.getAll(name).length === 1)) {
    return data(api.searchHistory(params.get('vaultId') ?? '', params.get('q') ?? '', cursor, params.get('sessionId') ?? undefined));
  }
  if ([...params.keys()].some(name => !['limit', 'cursor', 'vaultId', 'expectedRevision'].includes(name))) throw new ClientError('请求格式不正确。', 'BAD_REQUEST');
  if (method === 'GET') {
    if (pathname === '/api/v1/model/profiles') return data(api.modelProfiles());
    if (pathname === '/api/v1/settings') return data(api.settings());
    if (pathname === '/api/v1/vaults') return data(api.vaults());
    if (pathname === '/api/v1/sessions') return data(api.sessions(params.get('vaultId') ?? '', cursor));
    const entity = /^\/api\/v1\/sessions\/([^/]+)$/.exec(pathname);
    if (entity && !query) return data(api.session(entity[1]));
    const impact = /^\/api\/v1\/sessions\/([^/]+)\/deletion-impact$/.exec(pathname);
    if (impact) return data(api.deletionImpact(impact[1]));
    const catalog = /^\/api\/v1\/vaults\/([^/]+)\/catalog-revision$/.exec(pathname);
    if (catalog) return data(api.catalogRevision(catalog[1]));
    const list = /^\/api\/v1\/vaults\/([^/]+)\/(sources|memories)$/.exec(pathname);
    if (list) return list[2] === 'sources' ? data(api.sources(list[1], cursor)) : data(api.memories(list[1], cursor));
  }
  if (method === 'PUT' && pathname === '/api/v1/model/profiles') return data(api.saveModelProfile(body));
  if (method === 'POST' && pathname === '/api/v1/model/catalog') return data(api.modelCatalog(body));
  const profile = /^\/api\/v1\/model\/profiles\/([^/]+)(\/activate)?$/.exec(pathname);
  if (profile && method === 'POST' && profile[2]) return data(api.activateModelProfile(profile[1], body));
  if (profile && method === 'DELETE' && !profile[2]) return data(api.deleteModelProfile(profile[1], { expectedRevision: Number(params.get('expectedRevision')) }));
  if (method === 'PUT' && pathname === '/api/v1/model') return data(api.setModel(body));
  if (method === 'PUT' && pathname === '/api/v1/model/credential') return data(api.setCredential(body));
  if (method === 'POST') {
    if (pathname === '/api/v1/vaults') return data(api.connectVault(body));
    if (pathname === '/api/v1/memories') return data(api.createMemory(body, key));
    if (pathname === '/api/v1/model/probe') return data(api.probe(key));
    if (pathname === '/api/v1/ingestions') {
      if (options.form) {
        const file = options.form.get('file'), meta = options.form.get('meta');
        if (!(file instanceof File) || typeof meta !== 'string') throw new ClientError('文件提交格式不正确。', 'BAD_REQUEST');
        return data(api.ingest(JSON.parse(meta), key, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }));
      }
      return data(api.ingest(body, key));
    }
    const action = /^\/api\/v1\/(vaults|sources|answers)\/([^/]+)\/(refresh|retry|save)$/.exec(pathname);
    if (action?.[1] === 'vaults' && action[3] === 'refresh') return data(api.refreshVault(action[2], key));
    if (action?.[1] === 'sources' && action[3] === 'retry') return data(api.retrySource(action[2], key));
    if (action?.[1] === 'answers' && action[3] === 'save') return data(api.saveAnswer(action[2], body, key));
  }
  const entity = /^\/api\/v1\/(vaults|memories|sessions)\/([^/]+)$/.exec(pathname);
  if (entity?.[1] === 'vaults' && method === 'PATCH') return data(api.updateVault(entity[2], body));
  if (entity?.[1] === 'memories' && method === 'PATCH') return data(api.updateMemory(entity[2], body));
  if (entity?.[1] === 'memories' && method === 'DELETE') return data(api.deleteMemory(entity[2], { expectedRevision: Number(params.get('expectedRevision')) }));
  if (entity?.[1] === 'sessions' && method === 'DELETE' && isDeletionImpact(body)) return data(api.deleteSession(entity[2], body));
  throw new ClientError('这项操作尚未接入桌面。', 'BAD_REQUEST');
}
