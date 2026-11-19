import path from 'node:path';
import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { isHealthResponse, isSessionResponse } from '../../dist/shared/api.js';
import { readRoute } from './bridge.mjs';
import { DesktopClient } from './client.mjs';

const failure = code => Object.assign(new Error(code), { code });
export class DesktopService extends EventEmitter {
  #child;
  #origin;
  #cookie;
  #client;
  #starting;
  #stopping;
  #closed;
  #state = { phase: 'stopped' };

  constructor({ root, node, dataDirectory, python, rg, modelDirectory, profile, expectedVaultKey }) {
    super();
    for (const file of [root, node, dataDirectory, ...[python, rg, modelDirectory, profile].filter(value => value !== undefined)]) {
      if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) throw failure('BAD_REQUEST');
    }
    this.options = { root, node, dataDirectory, python, rg, modelDirectory, profile };
    this.expectVault(expectedVaultKey);
  }
  expectVault(key) {
    if (key !== undefined && (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key))) throw failure('BAD_REQUEST');
    this.expectedVaultKey = key;
  }
  status() { return { ...this.#state }; }
  #set(phase, code) {
    this.#state = { phase, ...(code ? { code } : {}) };
    this.emit('status', this.status());
  }
  async start({ deferMonitoring = false } = {}) {
    if (this.#stopping) await this.#stopping;
    if (this.#starting) return this.#starting;
    if (this.#state.phase === 'ready') return;
    this.#starting = this.#launch(deferMonitoring);
    try { await this.#starting; } finally { this.#starting = undefined; }
  }
  async restart() { await this.stop(); await this.start(); }
  async #launch(deferMonitoring) {
    this.#set('starting');
    const { root, node, dataDirectory, python, rg, modelDirectory, profile } = this.options;
    const child = fork(path.join(root, 'scripts/desktop-backend.mjs'), ['--port', '0', '--data-dir', dataDirectory], {
      execPath: node, execArgv: [], cwd: root,
      env: { PATH: `${path.dirname(node)}:/usr/bin:/bin`, LANG: 'en_US.UTF-8',
        NOTETRAIL_INSTALL_ROOT: root, ...(python ? { NOTETRAIL_PYTHON: python } : {}), ...(rg ? { NOTETRAIL_RG: rg } : {}),
        ...(modelDirectory ? { NOTETRAIL_MODEL_DATA_DIR: modelDirectory } : {}), ...(profile ? { NOTETRAIL_DESKTOP_PROFILE: profile } : {}),
        ...(this.expectedVaultKey ? { NOTETRAIL_EXPECTED_VAULT: this.expectedVaultKey } : {}),
        ...(deferMonitoring ? { NOTETRAIL_DEFER_MONITORING: '1' } : {}) },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    this.#child = child;
    this.#closed = new Promise(resolve => child.once('close', () => {
      this.#cookie = undefined; this.#origin = undefined; this.#child = undefined;
      this.#client = undefined; this.vault = undefined;
      if (this.#state.phase === 'ready') this.#set('failed', 'SERVICE_UNAVAILABLE');
      resolve();
    }));
    try {
      const connection = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(failure('START_FAILED')), 20_000);
        const onError = () => finish(failure('START_FAILED'));
        const onMessage = message => {
          if (message?.type === 'failed') return finish(failure(message.code));
          if (message?.type !== 'ready') return;
          if (message.protocol !== 1 || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(message.origin) ||
              Number(new URL(message.origin).port) > 65535 || !/^[A-Za-z0-9_-]{43}$/.test(message.bootstrapToken)) {
            return finish(failure('START_FAILED'));
          }
          finish(null, message);
        };
        function finish(error, value) {
          clearTimeout(timer); child.off('message', onMessage); child.off('error', onError); child.off('exit', onError);
          error ? reject(error) : resolve(value);
        }
        child.once('error', onError); child.once('exit', onError); child.on('message', onMessage);
      });
      this.#origin = connection.origin;
      const health = await fetch(`${this.#origin}/api/v1/health`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!health.ok || !isHealthResponse(await health.json())) throw failure('START_FAILED');
      const response = await fetch(`${this.#origin}/api/v1/bootstrap`, { method: 'POST', redirect: 'error',
        headers: { origin: this.#origin, 'content-type': 'application/json' },
        body: JSON.stringify({ token: connection.bootstrapToken }), signal: AbortSignal.timeout(5000) });
      connection.bootstrapToken = '';
      const cookie = response.headers.get('set-cookie')?.split(';')[0];
      const name = `notetrail_session_${new URL(this.#origin).port}=`;
      if (!response.ok || !isSessionResponse(await response.json()) || !cookie?.startsWith(name) ||
          !/^[A-Za-z0-9_-]{43}$/.test(cookie.slice(name.length)) || this.#child !== child) throw failure('START_FAILED');
      this.#cookie = cookie;
      this.#client = new DesktopClient(this.#origin, cookie);
      if (connection.vault !== undefined && (!path.isAbsolute(connection.vault?.root ?? '') ||
        connection.vault.root.includes('\0') || !/^[a-f0-9]{64}$/.test(connection.vault.key))) throw failure('START_FAILED');
      this.vault = connection.vault;
      this.#set('ready');
    } catch (error) {
      await this.#terminate();
      this.#set('failed', error.code ?? 'START_FAILED');
      throw failure(error.code ?? 'START_FAILED');
    }
  }
  async read(request) {
    readRoute(request);
    return this.request(request);
  }
  startMonitoring() {
    const child = this.#child;
    if (!child?.connected) { this.#set('failed', 'SERVICE_UNAVAILABLE'); return; }
    child.send({ type: 'startMonitoring' }, error => { if (error) this.#set('failed', 'SERVICE_UNAVAILABLE'); });
  }
  async pauseForSwitch() {
    const child = this.#child;
    if (!child) return true;
    if (this.#state.phase !== 'ready' || !child.connected) throw failure('SERVICE_UNAVAILABLE');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      let waiting = true;
      const finish = (error, ok) => {
        if (!waiting) return;
        waiting = false;
        clearTimeout(timer); child.off('message', receive); child.off('close', closed);
        if (error) { this.#set('failed', error.code); reject(error); }
        else resolve(ok);
      };
      const closed = () => finish(failure('SERVICE_UNAVAILABLE'));
      const receive = message => { if (message?.type === 'switchStatus' && message.id === id) finish(null, message.ok === true); };
      const timer = setTimeout(closed, 5000);
      child.on('message', receive); child.once('close', closed);
      child.send({ type: 'pauseForSwitch', id }, error => { if (error) closed(); });
    });
  }
  async request(request) {
    if (this.#state.phase !== 'ready' || !this.#client) throw failure('SERVICE_UNAVAILABLE');
    try { return await this.#client.request(request); }
    catch (error) {
      if (error.code === 'UNAUTHORIZED' && this.#state.phase === 'ready') this.#set('failed', 'UNAUTHORIZED');
      throw error;
    }
  }
  async #terminate() {
    const child = this.#child;
    if (!child) return;
    if (child.connected) child.send({ type: 'stop' }, () => {});
    // Only the child we created may be terminated; never look up or kill another instance's PID.
    const timer = setTimeout(() => child.kill('SIGKILL'), 6500);
    try { await this.#closed; } finally { clearTimeout(timer); }
  }
  async stop() {
    if (this.#stopping) return this.#stopping;
    this.#stopping = (async () => {
      if (this.#starting) await this.#starting.catch(() => {});
      this.#set('stopping');
      await this.#terminate();
      this.#set('stopped');
    })();
    try { await this.#stopping; } finally { this.#stopping = undefined; }
  }
}
