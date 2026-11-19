const { contextBridge, ipcRenderer } = require('electron');
const channel = 'notetrail:desktop:v1';
let token;
const invoke = request => ipcRenderer.invoke(channel, request, token);
contextBridge.exposeInMainWorld('notetrail', {
  status: () => invoke({ op: 'status' }),
  loadWorkspace: () => {
    const reply = ipcRenderer.sendSync(channel + ':workspace', { op: 'load' }, token);
    if (reply.error) return reply;
    token = reply.token;
    return { data: reply.data };
  },
  saveWorkspace: state => ipcRenderer.sendSync(channel + ':workspace', { op: 'save', state }, token),
  putDraftFile: input => invoke({ op: 'putDraftFile', input }),
  getDraftFile: file => invoke({ op: 'getDraftFile', file }),
  retry: () => invoke({ op: 'retry' }),
  vaults: () => invoke({ op: 'vaults' }),
  vaultWorkspaces: () => invoke({ op: 'vaultWorkspaces' }),
  selectWorkspace: id => invoke({ op: 'selectWorkspace', id }),
  addWorkspace: directory => invoke({ op: 'addWorkspace', directory }),
  sessions: (vaultId, cursor) => invoke({ op: 'sessions', vaultId, ...(cursor === undefined ? {} : { cursor }) }),
  messages: (sessionId, cursor) => invoke({ op: 'messages', sessionId, ...(cursor === undefined ? {} : { cursor }) }),
  messageReference: (sessionId, messageId) => invoke({op:'messageReference',sessionId,messageId}),
  answer: answerId => invoke({ op: 'answer', answerId }),
  watches: (vaultId, cursor) => invoke({ op:'watches',vaultId,...(cursor ? { cursor } : {}) }),
  watch: (watchId, cursor) => invoke({ op:'watch',watchId,...(cursor ? { cursor } : {}) }),
  watchAnswer: (answerId,input) => invoke({ op:'watchAnswer',answerId,input }),
  updateWatch: (watchId,input) => invoke({ op:'updateWatch',watchId,input }),
  session: sessionId => invoke({ op: 'session', sessionId }),
  createSession: (input, key) => invoke({ op: 'createSession', input, ...(key ? { key } : {}) }),
  ask: (sessionId, input, key) => invoke({ op: 'ask', sessionId, input, key }),
  run: runId => invoke({ op: 'run', runId }),
  cancel: runId => invoke({ op: 'cancel', runId }),
  catalogRevision: vaultId => invoke({ op: 'catalogRevision', vaultId }),
  sources: (vaultId, cursor) => invoke({ op: 'sources', vaultId, ...(cursor === undefined ? {} : { cursor }) }),
  source: sourceId => invoke({ op: 'source', sourceId }),
  citation: (answerId, evidenceId) => invoke({ op: 'citation', answerId, evidenceId }),
  modelProfiles: () => invoke({ op: 'modelProfiles' }),
  saveModelProfile: input => invoke({ op: 'saveModelProfile', input }),
  modelCatalog: input => invoke({ op: 'modelCatalog', input }),
  activateModelProfile: (id, input) => invoke({ op: 'activateModelProfile', id, input }),
  deleteModelProfile: (id, input) => invoke({ op: 'deleteModelProfile', id, input }),
  settings: () => invoke({ op: 'settings' }),
  connectVault: input => invoke({ op: 'connectVault', input }),
  updateVault: (vaultId, input) => invoke({ op: 'updateVault', vaultId, input }),
  setModel: input => invoke({ op: 'setModel', input }),
  setCredential: input => invoke({ op: 'setCredential', input }),
  probe: key => invoke({ op: 'probe', key }),
  ingest: (input, key, upload) => invoke({ op: 'ingest', input, key, ...(upload ? { upload } : {}) }),
  refreshVault: (vaultId, key) => invoke({ op: 'refreshVault', vaultId, key }),
  retrySource: (sourceId, key) => invoke({ op: 'retrySource', sourceId, key }),
  previewAnswerSelection: (answerId,input) => invoke({op:'previewAnswerSelection',answerId,input}),
  saveAnswer: (answerId, input, key) => invoke({ op: 'saveAnswer', answerId, input, key }),
  memories: (vaultId, cursor) => invoke({ op: 'memories', vaultId, ...(cursor === undefined ? {} : { cursor }) }),
  createMemory: (input, key) => invoke({ op: 'createMemory', input, key }),
  updateMemory: (memoryId, input) => invoke({ op: 'updateMemory', memoryId, input }),
  deleteMemory: (memoryId, input) => invoke({ op: 'deleteMemory', memoryId, input }),
  deletionImpact: sessionId => invoke({ op: 'deletionImpact', sessionId }),
  searchHistory: (vaultId, q, cursor, sessionId) => invoke({ op:'searchHistory', vaultId, q,
    ...(cursor === undefined ? {} : { cursor }), ...(sessionId === undefined ? {} : { sessionId }) }),
  deleteSession: (sessionId, expected) => invoke({ op: 'deleteSession', sessionId, expected }),
  sourceText: (sourceId, version) => invoke({ op: 'sourceText', sourceId, version }),
  exportOriginal: (sourceId, version) => invoke({ op: 'exportOriginal', sourceId, version }),
  discoverVaults: () => invoke({ op: 'discoverVaults' }),
  scanVaults: () => invoke({ op: 'scanVaults' }),
  pickVault: () => invoke({ op: 'pickVault' }),
  openExternal: url => invoke({ op: 'openExternal', url }),
  onStatus: callback => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on(channel + ':status', listener);
    return () => ipcRenderer.removeListener(channel + ':status', listener);
  },
});
