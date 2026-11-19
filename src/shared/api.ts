import { MEMORY_LIMITS } from './memory.js';
import { hasFields, isId, isRevision, type Id, type Revision } from './contracts.js';

export const ERROR_CATALOG = {
  BAD_REQUEST: { status: 400, retryable: false, message: '请求格式不正确。' },
  QUESTION_TOO_LONG: { status: 413, retryable: false, message: '问题最多 16,000 UTF-8 字节，请缩短后发送；草稿已保留。' },
  CONTEXT_LIMIT: { status: 422, retryable: false, message: '本轮必要内容超出模型上下文容量，请缩小资料范围或分开提问；历史与资料已保留。' },
  BUDGET_REVIEW_REQUIRED: { status: 422, retryable: false, message: '这条旧请求因费用保护暂停；当前版本已取消费用上限，可以重新发送。' },
  TOOL_READ_LIMIT: { status: 422, retryable: false, message: '本轮资料读取额度已用完，请根据已读内容回答，并说明仍未核实的部分。' },
  UNAUTHORIZED: { status: 401, retryable: false, message: '会话已失效，请重新打开 NoteTrail。' },
  ORIGIN_DENIED: { status: 403, retryable: false, message: '请使用启动时显示的本机地址打开 NoteTrail。' },
  VAULT_ACCESS_DENIED: { status: 403, retryable: false, message: '无法访问所选知识库，请检查访问权限。' },
  PATH_OUTSIDE_SCOPE: { status: 403, retryable: false, message: '请求的资料不在允许范围内。' },
  SOURCE_EXCLUDED: { status: 403, retryable: false, message: '这份资料已被排除。' },
  NOT_FOUND: { status: 404, retryable: false, message: '请求的内容不存在。' },
  SOURCE_MISSING: { status: 410, retryable: false, message: '已登记的原资料找不到了。' },
  SOURCE_CHANGED: { status: 409, retryable: false, message: '资料已修改，请重新读取。' },
  SOURCE_NOT_READY: { status: 409, retryable: false, message: '资料尚未准备好，请查看处理状态。' },
  SESSION_BUSY: { status: 409, retryable: false, message: '当前会话还有任务未结束。' },
  IDEMPOTENCY_CONFLICT: { status: 409, retryable: false, message: '同一提交标识已经用于不同内容或操作。' },
  REVISION_CONFLICT: { status: 409, retryable: false, message: '内容已被更新，请刷新后确认修改。' },
  CONTEXT_CHANGED: { status: 409, retryable: false, message: '本轮使用的资料范围或上下文已改变。' },
  DERIVED_MODIFIED: { status: 409, retryable: false, message: '提取文本已被人工修改，需要检查后继续。' },
  FILE_TOO_LARGE: { status: 413, retryable: false, message: '请求或文件超过当前大小限制。' },
  CONFIG_REQUIRED: { status: 422, retryable: false, message: '请先完成所需配置。' },
  INTENT_UNCLEAR: { status: 422, retryable: false, message: '无法确定要执行的操作，请补充说明。' },
  UNSUPPORTED_FORMAT: { status: 422, retryable: false, message: '当前不支持读取这种格式的正文。' },
  CONVERSION_FAILED: { status: 422, retryable: false, message: '资料转换失败，请查看处理状态。' },
  EXTRACTION_EMPTY: { status: 422, retryable: false, message: '没有提取到可用正文。' },
  EXTRACTION_PARTIAL: { status: 422, retryable: false, message: '部分图像或嵌入内容未提取，请对照原件核查。' },
  CITATION_INVALID: { status: 422, retryable: false, message: '回答的引用未通过检查。' },
  BUDGET_EXCEEDED: { status: 422, retryable: false, message: '已达到任务上限，处理尚未完成。' },
  MEMORY_LIMIT_EXCEEDED: { status: 422, retryable: false, message: '记忆已达到条数或总字数上限，请精简或删除后再保存。' },
  URL_BLOCKED: { status: 403, retryable: false, message: '不允许访问这个网页地址。' },
  URL_FETCH_FAILED: { status: 502, retryable: false, message: '未能取得网页正文。可改用粘贴正文或提交导出文件。' },
  SEARCH_CONFIG_REQUIRED: { status: 422, retryable: false, message: '联网搜索需要已保存的 DeepSeek 官方接口密钥，请在模型设置中添加。' },
  SEARCH_PRIVACY_BLOCKED: { status: 422, retryable: false, message: '搜索包含可能的私密内容，已在发送前拦截；可改用不含私人标识或资料细节的公开关键词。' },
  SEARCH_UNAVAILABLE: { status: 503, retryable: false, message: '本次联网搜索未成功，可能是网络、余额或接口暂不可用；未取得可引用的网页内容。' },
  SEARCH_LIMIT_REACHED: { status: 422, retryable: false, message: '本题联网搜索次数已达上限或已有请求正在处理，请依据已有内容说明缺口。' },
  MODEL_PRICING_REQUIRED: { status: 422, retryable: false, message: '请在模型设置中填写该模型的计费单价后再使用。' },
  MODEL_REQUEST_BUSY: { status: 409, retryable: true, message: '还有模型请求正在处理，请稍后再试。' },
  MODEL_SETTINGS_BUSY: { status: 409, retryable: false, message: '还有问答或连接测试正在进行，请结束后再修改或切换模型。' },
  MODEL_AUTH_FAILED: { status: 502, retryable: false, message: '模型服务凭据验证失败。' },
  MODEL_PROTOCOL_ERROR: { status: 502, retryable: false, message: '模型返回的内容不符合预期协议。' },
  MODEL_RATE_LIMITED: { status: 503, retryable: true, message: '模型服务暂时限流，请稍后再试。' },
  MODEL_UNAVAILABLE: { status: 503, retryable: true, message: '模型服务暂时不可用。' },
  CREDENTIAL_STORE_UNAVAILABLE: { status: 503, retryable: false, message: '无法访问密钥存储，请检查本机配置。' },
  SERVICE_UNAVAILABLE: { status: 503, retryable: true, message: '本机服务暂时不可用，请稍后重试。' },
  DEADLINE_EXCEEDED: { status: 504, retryable: false, message: '任务超过等待上限，已停止后续处理。' },
  WORKER_EXITED: { status: 500, retryable: false, message: '任务工作进程意外退出。' },
  SESSION_UNREADABLE: { status: 500, retryable: false, message: '无法读取会话，原文件已保留。' },
  RUN_INTERRUPTED: { status: 409, retryable: false, message: '服务重启前任务未结束，未自动重新执行。' },
} as const;
export type ErrorCode = keyof typeof ERROR_CATALOG;
export const TOOL_HINTS = {
  vault_read: 'sourceId 必须复制搜索返回的完整 s_ 编号；startLine/maxLines 是正整数。expectedVersion 可省略；如填写必须完整复制 64 位版本哈希，格式错误时去掉该可选参数重新读取，后端仍会核对当前资料版本。按 nextLine/nextOffset 续读；maxLines 会按容量分页。编号 e_ 是引用，不能用于 sourceId。',
  vault_search: 'terms 为 1–16 个非空字面词，每词最多 512 UTF-8 字节；paths 最多 50 项且限授权范围；limit 为 1–50。翻页保持原 terms/paths/limit，换词或路径时移除 cursor。',
  vault_list: 'path 是授权范围内的相对目录，不能包含 ..；limit 为 1–50，cursor 仅使用本轮同一查询返回的值。',
  vault_status: 'sourceIds 可省略；提供时为 1–50 个搜索或目录返回的完整 s_ 编号。',
  web_search: 'query 为 1–128 字符的公开查询；reason 为 1–1000 字符。不能发送私人资料。',
} as const;
export type ErrorDetails = { sourceId?: Id<'source'>; runId?: Id<'run'>; currentRevision?: Revision; toolHint?: string;
  memoryCandidates?: Array<{ memoryId: Id<'memory'>; text: string; revision: number }> };
export type AppError = { code: ErrorCode; message: string; retryable: boolean; details?: ErrorDetails };
export type ApiSuccess<T> = { data: T; requestId: Id<'request'> };
export type ApiFailure = { error: AppError; requestId: Id<'request'> };
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;
export type Health = { status: 'ok' };
export type SessionStatus = { authenticated: true };
export type BootstrapRequest = { token: string };

export const isErrorCode = (value: unknown): value is ErrorCode => typeof value === 'string' && Object.hasOwn(ERROR_CATALOG, value);

export function makeError(code: ErrorCode, details?: unknown): AppError {
  const { message, retryable } = ERROR_CATALOG[code];
  const error: AppError = { code, message, retryable };
  // Project selected values; never forward an SDK error or an arbitrary details object.
  if (typeof details === 'object' && details !== null && !Array.isArray(details)) {
    const safe: ErrorDetails = {};
    const sourceId: unknown = Object.getOwnPropertyDescriptor(details, 'sourceId')?.value;
    const runId: unknown = Object.getOwnPropertyDescriptor(details, 'runId')?.value;
    const currentRevision: unknown = Object.getOwnPropertyDescriptor(details, 'currentRevision')?.value;
    const memoryCandidates: unknown = Object.getOwnPropertyDescriptor(details, 'memoryCandidates')?.value;
    const toolHint: unknown = Object.getOwnPropertyDescriptor(details, 'toolHint')?.value;
    if (typeof toolHint === 'string' && Object.values(TOOL_HINTS).includes(toolHint as typeof TOOL_HINTS[keyof typeof TOOL_HINTS])) safe.toolHint = toolHint;
    if (isId(sourceId, 'source')) safe.sourceId = sourceId;
    if (isId(runId, 'run')) safe.runId = runId;
    if (isRevision(currentRevision)) safe.currentRevision = currentRevision;
    if (code === 'INTENT_UNCLEAR' && isMemoryCandidates(memoryCandidates)) safe.memoryCandidates = memoryCandidates.map(item => ({ ...item }));
    if (Object.keys(safe).length) error.details = safe;
  }
  return error;
}

function isMemoryCandidates(value: unknown): value is NonNullable<ErrorDetails['memoryCandidates']> {
  return Array.isArray(value) && value.length > 0 && value.length <= MEMORY_LIMITS.count && value.every(item =>
    hasFields(item, ['memoryId','text','revision']) && isId(item.memoryId, 'memory') && isRevision(item.revision) &&
    typeof item.text === 'string' && item.text.length > 0 && item.text.length <= MEMORY_LIMITS.textLength);
}

export function apiSuccess<T>(data: T, requestId: string): ApiSuccess<T> {
  if (!isId(requestId, 'request')) throw new TypeError('Invalid request ID');
  return { data, requestId };
}
export function apiFailure(code: ErrorCode, requestId: string, details?: unknown): ApiFailure {
  if (!isId(requestId, 'request')) throw new TypeError('Invalid request ID');
  return { error: makeError(code, details), requestId };
}

export function isAppError(value: unknown): value is AppError {
  if (!hasFields(value, ['code', 'message', 'retryable'], ['details']) || !isErrorCode(value.code)) return false;
  const entry = ERROR_CATALOG[value.code];
  if (value.message !== entry.message || value.retryable !== entry.retryable) return false;
  if (!Object.hasOwn(value, 'details')) return true;
  const details = value.details;
  return hasFields(details, [], ['sourceId', 'runId', 'currentRevision','memoryCandidates','toolHint']) && Object.keys(details).length > 0 &&
    (details.toolHint === undefined || Object.values(TOOL_HINTS).includes(details.toolHint as typeof TOOL_HINTS[keyof typeof TOOL_HINTS])) &&
    (!Object.hasOwn(details, 'sourceId') || isId(details.sourceId, 'source')) &&
    (!Object.hasOwn(details, 'runId') || isId(details.runId, 'run')) &&
    (!Object.hasOwn(details, 'currentRevision') || isRevision(details.currentRevision)) &&
    (!Object.hasOwn(details, 'memoryCandidates') || (value.code === 'INTENT_UNCLEAR' && isMemoryCandidates(details.memoryCandidates)));
}
export function isApiFailure(value: unknown): value is ApiFailure {
  return hasFields(value, ['error', 'requestId']) && isId(value.requestId, 'request') && isAppError(value.error);
}
export function isApiSuccess<T>(value: unknown, isData: (data: unknown) => data is T): value is ApiSuccess<T> {
  return hasFields(value, ['data', 'requestId']) && isId(value.requestId, 'request') && isData(value.data);
}
export const isBootstrapRequest = (value: unknown): value is BootstrapRequest =>
  hasFields(value, ['token']) && typeof value.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.token);
export const isSessionResponse = (value: unknown): value is ApiSuccess<SessionStatus> =>
  isApiSuccess(value, (data): data is SessionStatus => hasFields(data, ['authenticated']) && data.authenticated === true);
export const isHealthResponse = (value: unknown): value is ApiSuccess<Health> =>
  isApiSuccess(value, (data): data is Health => hasFields(data, ['status']) && data.status === 'ok');
