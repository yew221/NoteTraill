import { hasFields, isId, isIdempotencyKey, isPayloadHash, isExpectedRevision } from '../../dist/shared/contracts.js';
import { isConversationInput, isDeletionImpact, isHistoryTerm, isQuestionInput, parseSessionCursor } from '../../dist/shared/chat.js';
import { ERROR_CATALOG } from '../../dist/shared/api.js';
import { isVaultInput, isVaultUpdate, MAX_FILE_BYTES } from '../../dist/shared/vault.js';
import { isProfileId, isSaveModelProfile, isModelCatalogRequest } from '../../dist/shared/model-profiles.js';
import { isModelRequest, isCredentialRequest } from '../../dist/shared/model.js';
import { isIngestInput } from '../../dist/shared/ingest.js';
import { isMemoryInput, isMemoryPatch } from '../../dist/shared/memory.js';
import { isAnswerSelection } from '../../dist/shared/answer.js';
import { isWatchInput, isWatchPatch } from '../../dist/shared/watch.js';

export const CHANNEL = 'notetrail:desktop:v1';
export const DESKTOP_URL = 'notetrail://app/index.html';
export const DESKTOP_ERRORS = {
  ...Object.fromEntries(Object.entries(ERROR_CATALOG).map(([code, value]) => [code, value.message])),
  BAD_REQUEST: '请求格式不正确。',
  UNAUTHORIZED: '本机会话已失效，请点击“重新连接”恢复连接。',
  DATABASE_BUSY: '这份数据正在被另一个 NoteTrail 使用。请先正常退出那个应用，再重试。',
  DATA_DIRECTORY_INVALID: '数据目录不可用，请检查目录位置和访问权限。',
  DATA_DIRECTORY_UNRECOGNIZED: '数据目录包含无法识别的内容，原文件已保留。',
  DATABASE_INVALID: '本机数据无法读取，原文件已保留。',
  DATABASE_TOO_NEW: '这份数据来自更新版本，请使用兼容的 NoteTrail。',
  RUNTIME_MISMATCH: '本机运行组件版本不匹配，请重新构建桌面版本。',
  START_FAILED: '本机服务未能启动，请重试。',
  SERVICE_UNAVAILABLE: '本机服务已停止，请重新连接。',
  NOT_FOUND: '这条记录已不存在，请刷新会话列表。',
  SUBMISSION_UNKNOWN: '未能确认提交结果。草稿已保留，重试同一内容会沿用原提交标识；也可先查看历史。',
  EXPORT_EXISTS: '目标文件已经存在，请选择新名称，原文件不会被覆盖。',
  DRAFT_STORAGE_FAILED: '草稿未能安全保存，本次操作没有继续。请检查本机可用空间后重试。',
  DRAFT_INVALID: '本机草稿记录无法读取，原文件已保留；聊天历史与知识库未改变。',
  DRAFT_LIMIT: '未发送的草稿或附件已达到本机暂存上限，请先处理已有草稿。',
};
export function publicFailure(code) {
  const safe = Object.hasOwn(DESKTOP_ERRORS, code) ? code : 'SERVICE_UNAVAILABLE';
  return { error: { code: safe, message: DESKTOP_ERRORS[safe] } };
}
export function trustedSender(event, window) {
  return Boolean(window && !window.isDestroyed() && event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === DESKTOP_URL);
}

// Named capabilities only; the renderer never chooses a URL, method or headers.
export function readRoute(request) {
  if (hasFields(request, ['op','vaultId','q'], ['cursor','sessionId']) && request.op === 'searchHistory' && isId(request.vaultId,'vault') &&
      isHistoryTerm(request.q) && (request.cursor === undefined || parseSessionCursor(request.cursor)?.vaultId === request.vaultId) &&
      (request.sessionId === undefined || (isId(request.sessionId, 'session') && request.cursor === undefined))) {
    const query = new URLSearchParams({ vaultId:request.vaultId, q:request.q, ...(request.cursor ? { cursor:request.cursor } : {}),
      ...(request.sessionId ? { sessionId:request.sessionId } : {}) });
    return '/api/v1/sessions/search?' + query.toString();
  }
  if (hasFields(request, ['op','vaultId'], ['cursor']) && request.op === 'watches' && isId(request.vaultId,'vault') &&
    (request.cursor === undefined || isId(request.cursor,'watch'))) return `/api/v1/vaults/${request.vaultId}/watches${request.cursor ? `?cursor=${request.cursor}` : ''}`;
  if (hasFields(request, ['op','watchId'], ['cursor']) && request.op === 'watch' && isId(request.watchId,'watch') &&
    (request.cursor === undefined || isId(request.cursor,'answer'))) return `/api/v1/watches/${request.watchId}${request.cursor ? `?cursor=${request.cursor}` : ''}`;
  if (hasFields(request, ['op']) && request.op === 'vaults') return '/api/v1/vaults';
  if (hasFields(request, ['op']) && request.op === 'modelProfiles') return '/api/v1/model/profiles';
  if (hasFields(request, ['op']) && request.op === 'settings') return '/api/v1/settings';
  if (hasFields(request, ['op', 'vaultId'], ['cursor']) && request.op === 'sessions' && isId(request.vaultId, 'vault') &&
      (request.cursor === undefined || isId(request.cursor, 'session') || parseSessionCursor(request.cursor)?.vaultId === request.vaultId)) {
    return `/api/v1/sessions?vaultId=${request.vaultId}&limit=50${request.cursor ? `&cursor=${encodeURIComponent(request.cursor)}` : ''}`;
  }
  if (hasFields(request, ['op', 'sessionId'], ['cursor']) && request.op === 'messages' && isId(request.sessionId, 'session') &&
      (request.cursor === undefined || isId(request.cursor, 'message'))) {
    return `/api/v1/sessions/${request.sessionId}/messages?limit=50${request.cursor ? `&cursor=${request.cursor}` : ''}`;
  }
  if (hasFields(request, ['op', 'answerId']) && request.op === 'answer' && isId(request.answerId, 'answer')) {
    return `/api/v1/answers/${request.answerId}`;
  }
  if (hasFields(request, ['op', 'runId']) && request.op === 'run' && isId(request.runId, 'run')) return `/api/v1/runs/${request.runId}`;
  if (hasFields(request, ['op', 'sourceId']) && request.op === 'source' && isId(request.sourceId, 'source')) return `/api/v1/sources/${request.sourceId}`;
  if (hasFields(request, ['op', 'sessionId']) && request.op === 'session' && isId(request.sessionId, 'session')) return `/api/v1/sessions/${request.sessionId}`;
  if (hasFields(request,['op','sessionId','messageId']) && request.op==='messageReference' && isId(request.sessionId,'session') && isId(request.messageId,'message')) return `/api/v1/sessions/${request.sessionId}/messages/${request.messageId}`;
  if (hasFields(request, ['op', 'vaultId'], ['cursor']) && request.op === 'sources' && isId(request.vaultId, 'vault') &&
      (request.cursor === undefined || isId(request.cursor, 'source'))) {
    return `/api/v1/vaults/${request.vaultId}/sources?limit=50${request.cursor ? `&cursor=${request.cursor}` : ''}`;
  }
  if (hasFields(request, ['op', 'vaultId'], ['cursor']) && request.op === 'memories' && isId(request.vaultId, 'vault') &&
      (request.cursor === undefined || isId(request.cursor, 'memory'))) {
    return `/api/v1/vaults/${request.vaultId}/memories?limit=50${request.cursor ? `&cursor=${request.cursor}` : ''}`;
  }
  throw Object.assign(new Error('BAD_REQUEST'), { code: 'BAD_REQUEST' });
}

export function requestRoute(request) {
  if(hasFields(request,['op','answerId','input'])&&request.op==='previewAnswerSelection'&&isId(request.answerId,'answer')&&isAnswerSelection(request.input))
    return {path:`/api/v1/answers/${request.answerId}/selection-preview`,method:'POST',body:request.input};
  if (hasFields(request, ['op','answerId','input']) && request.op === 'watchAnswer' && isId(request.answerId,'answer') && isWatchInput(request.input))
    return { path: `/api/v1/answers/${request.answerId}/watch`, method: 'PUT', body: request.input };
  if (hasFields(request, ['op','watchId','input']) && request.op === 'updateWatch' && isId(request.watchId,'watch') && isWatchPatch(request.input))
    return { path: `/api/v1/watches/${request.watchId}`, method: 'PATCH', body: request.input };
  if (hasFields(request, ['op', 'input'], ['key']) && request.op === 'createSession' && isConversationInput(request.input) &&
      (request.key === undefined || isIdempotencyKey(request.key))) {
    return { path: '/api/v1/sessions', method: 'POST', body: request.input, ...(request.key ? { key: request.key } : {}) };
  }
  if (hasFields(request, ['op', 'sessionId', 'input', 'key']) && request.op === 'ask' && isId(request.sessionId, 'session') &&
      isIdempotencyKey(request.key) && isQuestionInput(request.input) && ['ask', 'auto'].includes(request.input.action) &&
      !Object.hasOwn(request.input, 'actionInput')) {
    return { path: `/api/v1/sessions/${request.sessionId}/messages`, method: 'POST', body: request.input, key: request.key };
  }
  if (hasFields(request, ['op', 'runId']) && request.op === 'cancel' && isId(request.runId, 'run')) {
    return { path: `/api/v1/runs/${request.runId}/cancel`, method: 'POST' };
  }
  if (hasFields(request, ['op', 'answerId', 'evidenceId']) && request.op === 'citation' &&
      isId(request.answerId, 'answer') && isId(request.evidenceId, 'evidence')) return { citation: request };
  if (hasFields(request, ['op', 'input'])) {
    if (request.op === 'connectVault' && isVaultInput(request.input)) return { path: '/api/v1/vaults', method: 'POST', body: request.input };
    if (request.op === 'saveModelProfile' && isSaveModelProfile(request.input)) return { path: '/api/v1/model/profiles', method: 'PUT', body: request.input };
    if (request.op === 'modelCatalog' && isModelCatalogRequest(request.input)) return { path: '/api/v1/model/catalog', method: 'POST', body: request.input };
    if (request.op === 'setModel' && isModelRequest(request.input)) return { path: '/api/v1/model', method: 'PUT', body: request.input };
    if (request.op === 'setCredential' && isCredentialRequest(request.input)) return { path: '/api/v1/model/credential', method: 'PUT', body: request.input };
  }
  if (hasFields(request, ['op','id','input']) && isProfileId(request.id) && isExpectedRevision(request.input)) {
    if (request.op === 'activateModelProfile') return { path: `/api/v1/model/profiles/${request.id}/activate`, method: 'POST', body: request.input };
    if (request.op === 'deleteModelProfile') return { path: `/api/v1/model/profiles/${request.id}?expectedRevision=${request.input.expectedRevision}`, method: 'DELETE' };
  }
  if (hasFields(request, ['op', 'vaultId', 'input']) && request.op === 'updateVault' && isId(request.vaultId, 'vault') && isVaultUpdate(request.input)) {
    return { path: `/api/v1/vaults/${request.vaultId}`, method: 'PATCH', body: request.input };
  }
  if (hasFields(request, ['op', 'input', 'key']) && request.op === 'createMemory' && isMemoryInput(request.input) && isIdempotencyKey(request.key)) {
    return { path: '/api/v1/memories', method: 'POST', body: request.input, key: request.key };
  }
  if (hasFields(request, ['op', 'memoryId', 'input']) && isId(request.memoryId, 'memory')) {
    if (request.op === 'updateMemory' && isMemoryPatch(request.input)) return { path: `/api/v1/memories/${request.memoryId}`, method: 'PATCH', body: request.input };
    if (request.op === 'deleteMemory' && isExpectedRevision(request.input)) return { path: `/api/v1/memories/${request.memoryId}?expectedRevision=${request.input.expectedRevision}`, method: 'DELETE' };
  }
  if (hasFields(request, ['op', 'vaultId']) && request.op === 'catalogRevision' && isId(request.vaultId, 'vault')) {
    return { path: `/api/v1/vaults/${request.vaultId}/catalog-revision` };
  }
  if (hasFields(request, ['op', 'sessionId']) && request.op === 'deletionImpact' && isId(request.sessionId, 'session')) {
    return { path: `/api/v1/sessions/${request.sessionId}/deletion-impact` };
  }
  if (hasFields(request, ['op', 'sessionId'], ['expected']) && request.op === 'deleteSession' && isId(request.sessionId, 'session') &&
      (request.expected === undefined || isDeletionImpact(request.expected))) {
    return { path: `/api/v1/sessions/${request.sessionId}`, method: 'DELETE', ...(request.expected && { body: request.expected }) };
  }
  if (hasFields(request, ['op', 'key']) && request.op === 'probe' && isIdempotencyKey(request.key)) return { path: '/api/v1/model/probe', method: 'POST', key: request.key };
  if (hasFields(request, ['op', 'vaultId', 'key']) && request.op === 'refreshVault' && isId(request.vaultId, 'vault') && isIdempotencyKey(request.key)) {
    return { path: `/api/v1/vaults/${request.vaultId}/refresh`, method: 'POST', key: request.key };
  }
  if (hasFields(request, ['op', 'sourceId', 'key']) && request.op === 'retrySource' && isId(request.sourceId, 'source') && isIdempotencyKey(request.key)) {
    return { path: `/api/v1/sources/${request.sourceId}/retry`, method: 'POST', key: request.key };
  }
  if (hasFields(request, ['op', 'answerId', 'input', 'key']) && request.op === 'saveAnswer' && isId(request.answerId, 'answer') &&
      isAnswerSelection(request.input) && isIdempotencyKey(request.key)) return { path: `/api/v1/answers/${request.answerId}/save`, method: 'POST', body: request.input, key: request.key };
  if (hasFields(request, ['op', 'input', 'key'], ['upload']) && request.op === 'ingest' && isIngestInput(request.input) && isIdempotencyKey(request.key)) {
    const input = request.input.input, upload = request.upload;
    if (input.kind === 'upload' ? hasFields(upload, ['name', 'bytes']) && typeof upload.name === 'string' && upload.name.length > 0 && upload.name.length <= 255 &&
        !/[\/\\\x00-\x1f]/.test(upload.name) && upload.bytes instanceof Uint8Array && upload.bytes.byteLength <= MAX_FILE_BYTES :
        upload === undefined && (input.kind !== 'text' || Buffer.byteLength(input.text, 'utf8') <= MAX_FILE_BYTES)) {
      return { path: '/api/v1/ingestions', method: 'POST', body: request.input, key: request.key, ...(upload ? { upload } : {}) };
    }
  }
  if (hasFields(request, ['op', 'sourceId', 'version']) && ['sourceText', 'sourceOriginal'].includes(request.op) &&
      isId(request.sourceId, 'source') && isPayloadHash(request.version)) return { content: { sourceId: request.sourceId, version: request.version,
        view: request.op === 'sourceText' ? 'text' : 'original' } };
  return { path: readRoute(request), method: 'GET' };
}
