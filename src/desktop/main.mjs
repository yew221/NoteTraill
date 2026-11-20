import { app, BrowserWindow, ipcMain, Menu, protocol, session, dialog, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DesktopService } from './service.mjs';
import { CHANNEL, DESKTOP_URL, publicFailure, trustedSender } from './bridge.mjs';
import { assetPath, CONTENT_SECURITY_POLICY } from './assets.mjs';
import { hasFields, isId, isPayloadHash } from '../../dist/shared/contracts.js';
import { writeOriginalCopy, externalUrl } from './files.mjs';
import { VaultWorkspaces } from './vault-workspaces.mjs';
import { discoverVaults } from './vault-discovery.mjs';
import { desktopPaths } from './paths.mjs';

const root = fs.realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const { profile, node, dataDirectory, python, rg } = desktopPaths({ packaged: app.isPackaged,
  resources: process.resourcesPath, home: os.homedir(), args: process.argv.slice(1), env: process.env });
fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
const profileStat = fs.lstatSync(profile);
if (!profileStat.isDirectory() || fs.realpathSync(profile) !== profile || profileStat.uid !== process.getuid?.() ||
    (profileStat.mode & 0o077) !== 0) throw new Error('INVALID_DESKTOP_PROFILE');
app.setName('NoteTrail');
app.setPath('userData', profile);
protocol.registerSchemesAsPrivileged([{ scheme: 'notetrail', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let window, libraries, quitting = false, pending = 0;
const sendStatus = status => {
  if (window && !window.isDestroyed()) window.webContents.send(CHANNEL + ':status', status);
};
const focus = () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } };
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', focus);
  app.on('activate', focus);
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault(); quitting = true;
    void (libraries?.close() ?? Promise.resolve()).finally(() => app.quit());
  });
  process.on('SIGTERM', () => app.quit());
  process.on('SIGINT', () => app.quit());
  // Do not hold ESM module evaluation open while waiting for Electron's ready event.
  void app.whenReady().then(async () => {
    if (!app.isPackaged) app.dock?.setIcon(path.join(root, 'desktop/notetrail-dock.png'));
    const renderer = path.join(root, 'dist/desktop');
    protocol.handle('notetrail', request => {
      const file = assetPath(request.url, renderer);
      if (request.method !== 'GET' || !file) return new Response('Not found', { status: 404 });
      const contentType = file.endsWith('.html') ? 'text/html; charset=utf-8' :
        file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8';
      return new Response(fs.readFileSync(file), { headers: {
        'content-type': contentType, 'content-security-policy': CONTENT_SECURITY_POLICY,
        'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      } });
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !assetPath(details.url, renderer) });
    });
    session.defaultSession.on('will-download', event => event.preventDefault());
    libraries = new VaultWorkspaces({ profile, dataDirectory, onStatus: sendStatus,
      createService: (directory, expectedVaultKey) => new DesktopService({
        root, node, dataDirectory: directory, modelDirectory: dataDirectory, profile, python, rg, expectedVaultKey,
      }) });
    window = new BrowserWindow({ width: 1180, height: 780, minWidth: 760, minHeight: 560,
      title: 'NoteTrail', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 },
      backgroundColor: '#fbfbfa', show: false,
      webPreferences: { preload: path.join(root, 'src/desktop/preload.cjs'), nodeIntegration: false,
        contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-frame-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.once('ready-to-show', () => window.show());
    window.on('closed', () => { window = undefined; });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'NoteTrail', submenu: [{ role: 'about', label: '关于 NoteTrail' }, { type: 'separator' }, { role: 'quit', label: '退出 NoteTrail' }] },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
    ]));
    app.setAboutPanelOptions({ applicationName: 'NoteTrail', applicationVersion: app.getVersion(),
      copyright: 'NoteTrail · MIT. Includes pi-gui UI portions © 2026 Matthew Lam (MIT).' });
    ipcMain.handle(CHANNEL, async (event, request, token) => {
      if (!trustedSender(event, window) || token !== libraries.token) return publicFailure('BAD_REQUEST');
      if (libraries.switching || quitting) return publicFailure('SESSION_BUSY');
      try {
        if (hasFields(request, ['op']) && request.op === 'vaultWorkspaces') return { data: libraries.list() };
        if ((hasFields(request, ['op', 'id']) && request.op === 'selectWorkspace') ||
            (hasFields(request, ['op', 'directory']) && request.op === 'addWorkspace')) {
          if (pending) return publicFailure('SESSION_BUSY');
          const changed = request.op === 'selectWorkspace'
            ? await libraries.select(request.id) : await libraries.add(request.directory);
          if (changed && window && !window.isDestroyed()) window.webContents.reload();
          return { data: { changed } };
        }
      } catch (error) { return publicFailure(error.code); }
      pending++;
      const service = libraries.service;
      try {
        if (hasFields(request, ['op']) && request.op === 'status') return { data: service.status() };
        if (hasFields(request, ['op']) && request.op === 'retry') { await service.stop(); await libraries.start(); return { data: service.status() }; }
        if (hasFields(request, ['op', 'input']) && request.op === 'putDraftFile') return { data: libraries.drafts.putAttachment(request.input) };
        if (hasFields(request, ['op', 'file']) && request.op === 'getDraftFile') return { data: libraries.drafts.getAttachment(request.file) };
        if (hasFields(request, ['op']) && ['discoverVaults', 'scanVaults'].includes(request.op)) {
          let scanRoot;
          if (request.op === 'scanVaults') {
            const selected = await dialog.showOpenDialog(window, { title: '选择要扫描的位置（最多 4 层目录）', properties: ['openDirectory'] });
            if (selected.canceled) return { data: null };
            scanRoot = selected.filePaths[0];
          }
          return { data: await discoverVaults({ registry: path.join(app.getPath('appData'), 'obsidian', 'obsidian.json'), scanRoot }) };
        }
        if (hasFields(request, ['op']) && request.op === 'pickVault') {
          const result = await dialog.showOpenDialog(window, { title: '选择 Obsidian 知识库', properties: ['openDirectory'] });
          return { data: result.canceled ? null : result.filePaths[0] };
        }
        if (hasFields(request, ['op', 'sourceId', 'version']) && request.op === 'exportOriginal' &&
            isId(request.sourceId, 'source') && isPayloadHash(request.version)) {
          const original = await service.request({ op: 'sourceOriginal', sourceId: request.sourceId, version: request.version });
          const result = await dialog.showSaveDialog(window, { title: '保存原件副本', defaultPath: path.basename(original.filename), buttonLabel: '保存副本' });
          if (result.canceled || !result.filePath) return { data: { saved: false } };
          writeOriginalCopy(result.filePath, original.bytes);
          return { data: { saved: true } };
        }
        if (hasFields(request, ['op', 'url']) && request.op === 'openExternal' && typeof request.url === 'string' && request.url.length <= 2048) {
          const url = externalUrl(request.url);
          if (!url) return publicFailure('BAD_REQUEST');
          await shell.openExternal(url); return { data: { opened: true } };
        }
        const result = await service.request(request);
        if (request.op === 'connectVault') {
          libraries.remember({ root: request.input.absolutePath, key: result.locationKey });
        }
        return { data: result };
      } catch (error) { return publicFailure(error.code); }
      finally { pending--; }
    });
    ipcMain.on(CHANNEL + ':workspace', (event, request, token) => {
      if (!trustedSender(event, window)) { event.returnValue = publicFailure('BAD_REQUEST'); return; }
      if (libraries.switching || quitting) { event.returnValue = publicFailure('SESSION_BUSY'); return; }
      try {
        if (hasFields(request, ['op']) && request.op === 'load' && (token === undefined || token === libraries.token)) {
          event.returnValue = { data: libraries.drafts.load(), token: libraries.token };
        } else if (hasFields(request, ['op', 'state']) && request.op === 'save' && token === libraries.token) {
          event.returnValue = { data: libraries.drafts.save(request.state) };
        }
        else event.returnValue = publicFailure('BAD_REQUEST');
      } catch (error) { event.returnValue = publicFailure(error.code); }
    });
    await window.loadURL(DESKTOP_URL);
    void libraries.start().catch(error => sendStatus({ phase: 'failed', code: error.code }));
  }).catch(() => { console.error('桌面窗口未能启动，请重新构建后重试。'); app.quit(); });
}
