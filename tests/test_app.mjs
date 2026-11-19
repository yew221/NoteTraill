import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import test, { before, after } from 'node:test';
import { launchBackend, startupMessage } from './fixtures/backend-process.mjs';
import { createApp } from '../dist/server/app.js';
import { parseStartOptions } from '../dist/server/index.js';
import { isHealthResponse } from '../dist/shared/api.js';
import { newId } from '../dist/server/contracts.js';
import { BrowserSession, sessionCookie } from '../dist/server/session.js';

const root = fileURLToPath(new URL('../', import.meta.url));
let app, origin, port, cookie;
before(async () => {
  const token = randomBytes(32).toString('base64url');
  const session = new BrowserSession(token);
  app = createApp(session);
  app.get('/test-failure', () => { throw new Error('PRIVATE_ERROR_SENTINEL /private/test/key'); });
  origin = await app.listen({ host: '127.0.0.1', port: 0 });
  port = app.server.address().port;
  cookie = sessionCookie(session.exchange(token), port).split(';')[0];
});
after(async () => { await app?.close(); });

function rawGet(route, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: route, headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('Request timed out')));
  });
}

test('health returns the shared envelope, unique server IDs and no user configuration', async () => {
  const a = await rawGet('/api/v1/health', { 'x-request-id': 'CLIENT_ID_SENTINEL' });
  const b = await rawGet('/api/v1/health');
  assert.equal(a.status, 200);
  const first = JSON.parse(a.body), second = JSON.parse(b.body);
  assert(isHealthResponse(first));
  assert.deepEqual(Object.keys(first).sort(), ['data', 'requestId']);
  assert.deepEqual(first.data, { status: 'ok' });
  assert.match(first.requestId, /^req_[0-9a-f-]{36}$/);
  assert.notEqual(first.requestId, second.requestId);
  assert(!a.body.includes('CLIENT_ID_SENTINEL'));
  assert.equal(a.headers['x-request-id'], first.requestId);
});

test('only the actual loopback Host and same origin are accepted', async () => {
  for (const headers of [
    { host: 'attacker.example' }, { host: `localhost:${port}` }, { host: '127.0.0.1:1' },
    { origin: 'https://attacker.example' }, { origin: 'null' }, { origin: `${origin}/` },
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' },
    { host: 'attacker.example', 'x-forwarded-host': `127.0.0.1:${port}` },
  ]) {
    const response = await rawGet('/api/v1/health', headers);
    assert.equal(response.status, 403);
    assert.equal(JSON.parse(response.body).error.code, 'ORIGIN_DENIED');
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  assert.equal((await rawGet('/api/v1/health', { origin, 'sec-fetch-site': 'same-origin' })).status, 200);
  assert.equal((await rawGet('/', { 'sec-fetch-site': 'none' })).status, 401);
});

test('the local API has browser protections and no static pages or bundles', async () => {
  const health = await rawGet('/api/v1/health');
  assert.equal(health.headers['cache-control'], 'no-store');
  assert.equal(health.headers['x-content-type-options'], 'nosniff');
  assert.match(health.headers['content-security-policy'], /frame-ancestors 'none'/);
  for (const route of ['/', '/assets/app.js', '/assets/style.css']) {
    const anonymous = await rawGet(route);
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers['content-type'], /application\/json/);
    assert.equal((await rawGet(route, { cookie })).status, 404);
  }
});

test('unknown APIs, source, hidden files and traversal do not return the application or echo paths', async () => {
  for (const route of ['/api/v1/settings', '/api/v1/bootstrap', '/src/server/app.ts', '/main.tsx', '/.env',
    '/.vite/manifest.json', '/assets/..%2f..%2fpackage.json', '/assets/file.js.map', '/private/PRIVATE_PATH_SENTINEL']) {
    const response = await rawGet(route, { cookie });
    assert.equal(response.status, 404, route);
    const result = JSON.parse(response.body);
    assert.equal(result.error.code, 'NOT_FOUND');
    assert(!response.body.includes(route) && !response.body.includes('PRIVATE_PATH_SENTINEL'));
  }
});

test('internal failures return a safe error envelope', async () => {
  const response = await rawGet('/test-failure', { cookie });
  assert.equal(response.status, 503);
  const data = JSON.parse(response.body);
  assert.equal(data.error.code, 'SERVICE_UNAVAILABLE');
  assert.equal(data.error.retryable, true);
  assert(!response.body.includes('PRIVATE_ERROR_SENTINEL') && !response.body.includes('/private'));
});

test('malformed URL errors use the safe API envelope', async () => {
  const response = await rawGet('/%zzPRIVATE_PATH_SENTINEL');
  assert.equal(response.status, 400);
  const result = JSON.parse(response.body);
  assert.equal(result.error.code, 'BAD_REQUEST');
  assert.equal(typeof result.requestId, 'string');
  assert(!response.body.includes('PRIVATE_PATH_SENTINEL'));
});

test('client rejects malformed health payloads', () => {
  const requestId = newId('request');
  for (const value of [null, [], {}, { data: { status: 'ok' } }, { data: { status: 'ok' }, requestId: '' },
    { data: { status: 'down' }, requestId }, { data: { status: 'ok', key: 'extra' }, requestId },
    { data: { status: 'ok' }, requestId, error: {} }, { data: { status: 'ok' }, requestId: 'req_x' }]) assert.equal(isHealthResponse(value), false);
  assert.equal(isHealthResponse({ data: { status: 'ok' }, requestId }), true);
});

test('startup accepts finite ports and rejects ambiguous arguments', () => {
  assert.equal(parseStartOptions([]).port, 4319);
  assert.equal(parseStartOptions(['--port', '0']).port, 0);
  assert.equal(parseStartOptions(['--port', '65535']).port, 65535);
  for (const args of [['--port'], ['--port', '-1'], ['--port', '65536'], ['--port', '1.5'], ['--port', '01'],
    ['--port', '1e3'], ['--host', '0.0.0.0'], ['extra'], ['--port', '4319', 'extra']]) assert.throws(() => parseStartOptions(args));
});

test('missing builds fail clearly and rebuild refuses unknown output directories and symlinks', async t => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-build-')));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(temp, 'scripts'));
  for (const name of ['desktop-backend.mjs', 'build.mjs']) fs.copyFileSync(path.join(root, 'scripts', name), path.join(temp, 'scripts', name));
  fs.copyFileSync(path.join(root, 'package.json'), path.join(temp, 'package.json'));
  const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'en_US.UTF-8' };
  const run = name => spawnSync(process.execPath, [path.join(temp, 'scripts', name)], { env, encoding: 'utf8', timeout: 5000 });
  const entry = path.join(temp, 'scripts/desktop-backend.mjs');
  const direct = run('desktop-backend.mjs');
  assert.equal(direct.status, 1);
  assert.match(direct.stderr, /DESKTOP_PARENT_REQUIRED/);
  const isolated = launchBackend([], { entryPoint: entry, cwd: temp, env });
  assert.deepEqual(await startupMessage(isolated), { type: 'failed', code: 'START_FAILED' });
  assert.deepEqual(await isolated.exited, [1, null]);
  const dist = path.join(temp, 'dist');
  fs.mkdirSync(dist);
  const sentinel = path.join(dist, 'user-file.txt');
  fs.writeFileSync(sentinel, 'PUBLIC_KEEP_SENTINEL');
  assert.equal(run('build.mjs').status, 1);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'PUBLIC_KEEP_SENTINEL');
  fs.renameSync(dist, path.join(temp, 'outside'));
  fs.symlinkSync(path.join(temp, 'outside'), dist);
  assert.equal(run('build.mjs').status, 1);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'PUBLIC_KEEP_SENTINEL');
});

test('real startup reports port conflicts and stops cleanly so the port can be reused', async t => {
  const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'en_US.UTF-8', NODE_ENV: 'production' };
  const dataDirectory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-start-')));
  t.after(() => fs.rmSync(dataDirectory, { recursive: true, force: true }));
  const startAt = requestedPort => launchBackend(['--port', String(requestedPort), '--data-dir', dataDirectory], { cwd: os.tmpdir(), env });
  const conflict = startAt(port);
  t.after(() => conflict.child.kill('SIGTERM'));
  assert.deepEqual(await startupMessage(conflict), { type: 'failed', code: 'START_FAILED' });
  assert.deepEqual(await conflict.exited, [1, null]);
  assert(!conflict.logs().includes(root));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const backend = startAt(0), { child, exited } = backend;
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const { type, origin: address, bootstrapToken } = await startupMessage(backend);
    assert.equal(type, 'ready');
    const response = await fetch(address + '/api/v1/health');
    assert.equal(response.status, 200); await response.text();
    child.kill(signal);
    assert.deepEqual(await Promise.race([exited, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Stop timed out')), 6000); timer.unref();
    })]), [0, null]);
    assert(!backend.logs().includes(bootstrapToken));
    const rebound = http.createServer();
    await new Promise((resolve, reject) => { rebound.once('error', reject); rebound.listen(Number(new URL(address).port), '127.0.0.1', resolve); });
    await new Promise(resolve => rebound.close(resolve));
  }
});
