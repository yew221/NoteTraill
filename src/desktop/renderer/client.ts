import type { AppError } from '../../shared/api.js';
import { isId, type RunRef } from '../../shared/contracts.js';
import type { Page } from '../../shared/vault.js';

export class ClientError extends Error {
  constructor(message: string, readonly code = 'CONNECTION_LOST', readonly details?: AppError['details']) { super(message); }
}
export const errorText = (error: unknown): string => error instanceof ClientError ? error.message : '操作未完成，请重试。';
export type RequestOptions = { method?: string; body?: unknown; form?: FormData; key?: string; signal?: AbortSignal };
let transport: ((path: string, options: RequestOptions) => Promise<unknown>) | undefined;
export function installApiTransport(value: NonNullable<typeof transport>): void { transport = value; }
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  if (!path.startsWith('/api/v1/')) throw new ClientError('请求地址无效。', 'BAD_REQUEST');
  if (!transport) throw new ClientError('暂时无法连接本机服务。');
  return await transport(path, options) as T;
}
export async function allPages<T>(path: string, signal?: AbortSignal): Promise<T[]> {
  const result: T[] = [], seen = new Set<string>(); let cursor: string | null = null;
  do {
    const page: Page<T> = await api(`${path}${path.includes('?') ? '&' : '?'}limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal });
    if (!Array.isArray(page.items) || (page.nextCursor !== null && typeof page.nextCursor !== 'string') || (page.nextCursor && seen.has(page.nextCursor))) {
      throw new ClientError('列表未能完整读取，请重新载入。', 'INVALID_RESPONSE');
    }
    result.push(...page.items); cursor = page.nextCursor; if (cursor) seen.add(cursor);
  } while (cursor);
  return result;
}
export class RunCommands {
  private readonly pending = new Map<string, { signature: string; file?: File; key: string }>();
  async send(path: string, body?: unknown, file?: File): Promise<RunRef> {
    const signature = JSON.stringify(body) ?? '', previous = this.pending.get(path);
    const current = previous?.signature === signature && previous.file === file ? previous : { signature, file, key: crypto.randomUUID() };
    this.pending.set(path, current);
    let form: FormData | undefined;
    if (file) { form = new FormData(); form.set('meta', signature); form.set('file', file); }
    const result = await api<RunRef>(path, { method: 'POST', key: current.key, ...(form ? { form } : body !== undefined ? { body } : {}) });
    if (!isId(result.runId, 'run')) throw new ClientError('任务结果无效，请查看已有记录。', 'INVALID_RESPONSE');
    this.pending.delete(path); return result;
  }
}
