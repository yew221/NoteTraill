import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import { createApp } from '../dist/server/app.js';
import { BrowserSession, BOOTSTRAP_TTL_MS, SESSION_TTL_MS, cookieName } from '../dist/server/session.js';
import { isBootstrapRequest, isSessionResponse } from '../dist/shared/api.js';
import { newId } from '../dist/server/contracts.js';

const newToken = () => randomBytes(32).toString('base64url');
async function fixture(t, now = () => performance.now()) {
  const token = newToken(), session = new BrowserSession(token, now);
  const app = createApp(session);
  // Future routes must be protected without each handler remembering an auth check.
  app.get('/api/v1/test-private', () => ({ secret: 'SYNTHETIC_PRIVATE_SENTINEL' }));
  app.post('/api/v1/test-write', () => ({ written: true }));
  t.after(() => app.close());
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const port = app.server.address().port;
  const post = (body = { token }, headers = { origin, 'content-type': 'application/json' }, route = '/api/v1/bootstrap') =>
    new Promise((resolve, reject) => {
      // Raw HTTP preserves adversarial Host headers that fetch normalizes.
      const request = http.request(`${origin}${route}`, { method: 'POST', headers }, response => {
        let text = ''; response.setEncoding('utf8');
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => resolve(new Response(text, { status: response.statusCode, headers: response.headers })));
      });
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('Request timed out')));
      request.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
  async function establish() {
    const response = await post();
    assert.equal(response.status, 200);
    assert(isSessionResponse(await response.json()));
    const setCookie = response.headers.get('set-cookie');
    assert(setCookie);
    return { setCookie, cookie: setCookie.split(';')[0] };
  }
  return { app, token, port, origin, post, establish };
}

test('bootstrap grants a separate HttpOnly Strict cookie, then replay is rejected without revoking it', async t => {
  const f = await fixture(t);
  const unauthenticated = await fetch(`${f.origin}/api/v1/session`);
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json()).error.code, 'UNAUTHORIZED');
  const { cookie, setCookie } = await f.establish();
  assert.match(setCookie, /; HttpOnly; SameSite=Strict; Max-Age=28800$/);
  assert(setCookie.includes('; Path=/api/v1;') && !setCookie.includes('Domain='));
  assert(!cookie.includes(f.token));
  const response = await fetch(`${f.origin}/api/v1/session`, { headers: { cookie } });
  assert(isSessionResponse(await response.json()));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const replay = await f.post();
  assert.equal(replay.status, 401);
  assert.equal(replay.headers.get('set-cookie'), null);
  assert(!(await replay.text()).includes(f.token));
  assert.equal((await fetch(`${f.origin}/api/v1/session`, { headers: { cookie } })).status, 200);
});

test('bootstrap requires same Origin, exact Host, JSON and a valid body; failed attempts do not consume it', async t => {
  const f = await fixture(t);
  for (const headers of [
    { 'content-type': 'application/json' },
    { origin: 'null', 'content-type': 'application/json' },
    { origin: 'https://attacker.example', 'content-type': 'application/json' },
    { origin: f.origin, 'content-type': 'application/json', host: 'attacker.example' },
    { origin: f.origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-site' },
  ]) {
    const response = await f.post({ token: f.token }, headers);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('set-cookie'), null);
    assert(!(await response.text()).includes(f.token));
  }
  for (const type of ['text/plain', 'application/x-www-form-urlencoded']) {
    assert.equal((await f.post({ token: f.token }, { origin: f.origin, 'content-type': type })).status, 400);
  }
  for (const body of [null, [], {}, { token: 1 }, { token: '' }, { token: f.token, extra: 'PRIVATE_INPUT_SENTINEL' },
    '{"token":']) {
    const response = await f.post(body);
    assert.equal(response.status, 400);
    const text = await response.text();
    assert(!text.includes(f.token) && !text.includes('PRIVATE_INPUT_SENTINEL'));
    assert.equal(JSON.parse(text).error.code, 'BAD_REQUEST');
  }
  const oversized = await f.post({ token: 'PRIVATE_INPUT_SENTINEL'.repeat(100) });
  assert.equal(oversized.status, 413);
  const oversizedText = await oversized.text();
  assert.equal(JSON.parse(oversizedText).error.code, 'FILE_TOO_LARGE');
  assert(!oversizedText.includes('PRIVATE_INPUT_SENTINEL'));
  assert.equal((await f.post({ token: f.token }, undefined, '/api/v1/bootstrap?token=PUBLIC_SENTINEL')).status, 400);
  assert.equal((await f.post({ token: newToken() })).status, 401);
  await f.establish();
});

test('two simultaneous exchanges yield exactly one session', async t => {
  const f = await fixture(t);
  const responses = await Promise.all([f.post(), f.post()]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 401]);
  assert.equal(responses.filter(r => r.headers.has('set-cookie')).length, 1);
  await Promise.all(responses.map(r => r.text()));
});

test('external navigation cannot open a page or access the local API', async t => {
  const f = await fixture(t);
  const headers = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  // fetch rewrites Sec-Fetch-Mode; use raw HTTP to reproduce the browser navigation exactly.
  const get = route => new Promise((resolve, reject) => {
    const request = http.get(`${f.origin}${route}`, { headers }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.setTimeout(3000, () => request.destroy(new Error('Request timed out')));
  });
  assert.equal(await get('/'), 403);
  assert.equal(await get('/api/v1/health'), 403);
  assert.equal(await get('/api/v1/session'), 403);
  headers['sec-fetch-dest'] = 'iframe';
  assert.equal(await get('/'), 403);
  headers['sec-fetch-dest'] = 'document'; headers.origin = 'https://attacker.example';
  assert.equal(await get('/'), 403);
});

test('bootstrap and server-side session expire at their deadlines, without sliding renewal', async t => {
  let clock = 100;
  const expired = await fixture(t, () => clock);
  clock += BOOTSTRAP_TTL_MS;
  assert.equal((await expired.post()).status, 401);
  const f = await fixture(t, () => clock);
  clock += BOOTSTRAP_TTL_MS - 1;
  const { cookie } = await f.establish();
  clock += SESSION_TTL_MS - 1;
  assert.equal((await fetch(`${f.origin}/api/v1/session`, { headers: { cookie } })).status, 200);
  clock += 1;
  assert.equal((await fetch(`${f.origin}/api/v1/session`, { headers: { cookie } })).status, 401);
});

test('new routes, forged or duplicate Cookies and cross-origin requests stay protected', async t => {
  const f = await fixture(t);
  const { cookie } = await f.establish();
  for (const candidate of ['', `${cookieName(f.port)}=${f.token}`, `${cookieName(f.port)}=${newToken()}`,
    `${cookie}; ${cookie}`, `${cookieName(f.port)}="${cookie.split('=')[1]}"`, `notetrail_session_1=${cookie.split('=')[1]}`]) {
    const response = await fetch(`${f.origin}/api/v1/test-private`, { headers: { cookie: candidate } });
    assert.equal(response.status, 401);
    assert(!(await response.text()).includes('SYNTHETIC_PRIVATE_SENTINEL'));
  }
  assert.equal((await fetch(`${f.origin}/api/v1/test-private`, { headers: { cookie: `other=1; ${cookie}; last=2` } })).status, 200);
  for (const headers of [{ cookie, origin: 'https://attacker.example' }, { cookie, 'sec-fetch-site': 'cross-site' },
    { cookie, 'sec-fetch-site': 'same-site' }]) {
    const response = await fetch(`${f.origin}/api/v1/session`, { headers });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  assert.equal((await f.post({}, { cookie, 'content-type': 'application/json' }, '/api/v1/test-write')).status, 403);
  assert.equal((await f.post({}, { cookie, origin: f.origin, 'content-type': 'application/json' }, '/api/v1/test-write')).status, 200);
  const preflight = await fetch(`${f.origin}/api/v1/bootstrap`, { method: 'OPTIONS', headers: {
    origin: 'https://attacker.example', 'access-control-request-method': 'POST' } });
  assert.equal(preflight.status, 403);
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);
});

test('restart on the same port rejects the old Cookie and bootstrap token', async t => {
  const f = await fixture(t);
  const { cookie } = await f.establish();
  await f.app.close();
  const token = newToken(), restarted = createApp(new BrowserSession(token));
  t.after(() => restarted.close());
  await restarted.listen({ host: '127.0.0.1', port: f.port });
  assert.equal((await fetch(`${f.origin}/api/v1/session`, { headers: { cookie } })).status, 401);
  assert.equal((await f.post()).status, 401);
  const response = await f.post({ token });
  assert.equal(response.status, 200);
  assert(response.headers.get('set-cookie').split(';')[0] !== cookie);
});

test('shared input and session response guards reject malformed or secret-bearing payloads', () => {
  const token = newToken();
  assert(isBootstrapRequest({ token }));
  for (const input of [null, {}, [], { token: [token] }, { token, extra: true }, { token: `${token}=` }]) {
    assert.equal(isBootstrapRequest(input), false);
  }
  const requestId = newId('request');
  assert(isSessionResponse({ data: { authenticated: true }, requestId }));
  for (const value of [null, {}, { data: { authenticated: true } }, { data: { authenticated: false }, requestId },
    { data: { authenticated: true }, requestId: '' }, { data: { authenticated: true, token }, requestId },
    { data: { authenticated: true }, requestId, token }, { data: { authenticated: true }, requestId: 'req_test' }]) assert.equal(isSessionResponse(value), false);
});
