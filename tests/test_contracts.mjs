import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ERROR_CATALOG, apiSuccess, apiFailure, isApiSuccess, isApiFailure, isAppError,
  isBootstrapRequest, isHealthResponse, isSessionResponse, makeError } from '../dist/shared/api.js';
import { ID_PREFIXES, isId, hasFields, isRevision, isExpectedRevision, isIdempotencyKey, isPayloadHash,
  isIdempotencyIdentity, RUN_STATES, RUN_KINDS, RUN_STAGES, isRunState, isRunKind, isRunStage,
  isTerminalRunState, canTransitionRun, isRunRef } from '../dist/shared/contracts.js';
import { ApiError, newId, requireId, requireIdempotencyKey, requireRevision,
  checkRevision, checkIdempotency } from '../dist/server/contracts.js';
import { createApp } from '../dist/server/app.js';
import { BrowserSession, sessionCookie } from '../dist/server/session.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const publicHash = 'a'.repeat(64);
const failsWith = code => error => error instanceof ApiError && error.publicError.code === code;

test('shared TypeScript contracts reject mismatched IDs, states, revisions and operation scopes', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'),
    '--noEmit', '--strict', '--skipLibCheck', 'false', '--target', 'ES2022', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', '--types', 'node', path.join(root, 'tests/contracts.types.ts')], {
    cwd: root, encoding: 'utf8', timeout: 15000, env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('all error codes and HTTP statuses agree with the approved API error table', () => {
  const spec = fs.readFileSync(path.join(root, 'API_SPEC.md'), 'utf8').split('## 7. 错误约定')[1].split('## 8.')[0];
  const expected = {};
  for (const row of spec.split('\n').filter(line => /^\| [A-Z][A-Z_]+/.test(line))) {
    const [, names, statuses] = row.split('|');
    const codes = names.split('/').map(name => name.trim());
    assert(codes.every(code => /^[A-Z_]+$/.test(code)));
    const http = statuses.match(/\d{3}/g).map(Number);
    assert(http.length === 1 || http.length === codes.length);
    codes.forEach((code, index) => { expected[code] = http.length === 1 ? http[0] : http[index]; });
  }
  assert(Object.keys(expected).length > 0);
  assert.deepEqual(Object.fromEntries(Object.entries(ERROR_CATALOG).map(([code, entry]) => [code, entry.status])), expected);
});

test('server IDs are unique and typed; runtime guards reject ambiguous IDs and prototype fields', () => {
  const seen = new Set();
  for (const kind of Object.keys(ID_PREFIXES)) {
    for (let i = 0; i < 3; i++) {
      const id = newId(kind);
      assert(isId(id, kind)); assert.equal(requireId(id, kind), id); assert(!seen.has(id)); seen.add(id);
      for (const invalid of [id.toUpperCase(), `${id}/../secret`, `${id}?x=1`, ` ${id}`, `${id}\n`,
        `${ID_PREFIXES[kind]}_00000000-0000-1000-8000-000000000000`]) {
        assert.equal(isId(invalid, kind), false);
      }
    }
  }
  assert.equal(isId(newId('source'), 'run'), false);
  for (const value of [null, 1, true, [], {}, 'r_demo', 'req_x']) assert.throws(() => requireId(value, 'run'), failsWith('BAD_REQUEST'));
  assert.equal(isId(`undefined_${newId('run').slice(2)}`, 'not_a_kind'), false);
  const token = randomBytes(32).toString('base64url');
  assert(isBootstrapRequest({ token }));
  assert.equal(isBootstrapRequest(Object.create({ token })), false);
  assert.equal(isBootstrapRequest({ token, privateField: 'PUBLIC_SENTINEL' }), false);
  assert.equal(hasFields(new Date(), []), false);
});

test('success and failure envelopes reject mixed shapes and malformed IDs without coercion', () => {
  const requestId = newId('request');
  const good = apiSuccess({ status: 'ok' }, requestId);
  assert(isHealthResponse(good));
  assert(isSessionResponse(apiSuccess({ authenticated: true }, requestId)));
  const failure = apiFailure('BAD_REQUEST', requestId);
  assert(isApiFailure(failure));
  for (const value of [null, [], { ...good, error: failure.error }, { ...good, requestId: newId('source') },
    { ...good, data: { status: 'ok', extra: 'PRIVATE_SENTINEL' } }, Object.create(good)]) assert.equal(isHealthResponse(value), false);
  for (const value of [{ ...failure, data: {} }, { ...failure, requestId: 'req_demo' },
    { ...failure, error: { ...failure.error, retryable: 'false' } },
    { ...failure, error: { ...failure.error, code: 'UNKNOWN' } }]) assert.equal(isApiFailure(value), false);
  assert.throws(() => apiSuccess({}, 'req_demo'), TypeError);
  assert.throws(() => apiFailure('BAD_REQUEST', 'req_demo'), TypeError);
});

test('error details only expose valid allowed fields and never invoke getters or copy raw messages', () => {
  const sourceId = newId('source'), runId = newId('run');
  const dirty = { sourceId, runId, currentRevision: 4, apiKey: 'PRIVATE_KEY_SENTINEL', path: '/private/file',
    message: 'PRIVATE_MESSAGE_SENTINEL', nested: { text: 'PRIVATE_DOCUMENT_SENTINEL' } };
  const error = makeError('REVISION_CONFLICT', dirty);
  assert.deepEqual(error.details, { sourceId, runId, currentRevision: 4 });
  assert(isAppError(error));
  assert(!JSON.stringify(error).includes('PRIVATE_'));
  assert.equal(isAppError({ ...error, details: dirty }), false);
  assert.equal(isAppError({ ...error, message: dirty.message }), false);
  const getter = Object.defineProperty({}, 'sourceId', { enumerable: true, get() { throw new Error('PRIVATE_GETTER_SENTINEL'); } });
  assert.equal(makeError('BAD_REQUEST', getter).details, undefined);
  assert.equal(makeError('BAD_REQUEST', Object.create({ sourceId })).details, undefined);
  assert.equal(makeError('BAD_REQUEST', { sourceId: '/private/file', runId: newId('vault'), currentRevision: '4' }).details, undefined);
});

test('revision checks reject invalid numbers and report only the current revision on conflict', () => {
  for (const value of [1, 2, Number.MAX_SAFE_INTEGER]) {
    assert(isRevision(value)); assert.equal(requireRevision(value), value); assert(isExpectedRevision({ expectedRevision: value }));
    checkRevision(value, value);
  }
  for (const value of [undefined, null, '1', true, [], 0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(isRevision(value), false); assert.throws(() => requireRevision(value), failsWith('BAD_REQUEST'));
  }
  assert.equal(isExpectedRevision({ expectedRevision: 1, unknown: true }), false);
  assert.throws(() => checkRevision(1, 2), error => failsWith('REVISION_CONFLICT')(error) && error.publicError.details.currentRevision === 2);
  assert.throws(() => checkRevision(1, 0), failsWith('SERVICE_UNAVAILABLE'));
});

test('idempotency identities bind a key to operation, scope and validated payload digest', () => {
  for (const value of ['x'.repeat(16), 'x'.repeat(128), 'public-test-key_01']) {
    assert(isIdempotencyKey(value)); assert.equal(requireIdempotencyKey(value), value);
  }
  for (const value of [null, [], 'x'.repeat(15), 'x'.repeat(129), 'two,joined-keys-001', '/private/test/key', 'x'.repeat(16)+'\n', '测试'.repeat(16)]) {
    assert.equal(isIdempotencyKey(value), false); assert.throws(() => requireIdempotencyKey(value), failsWith('BAD_REQUEST'));
  }
  assert(isPayloadHash(publicHash)); assert.equal(isPayloadHash(publicHash.toUpperCase()), false);
  const original = { key: 'public-test-key-001', operation: 'memory.create', scopeId: newId('vault'), payloadHash: publicHash };
  assert(isIdempotencyIdentity(original));
  assert.equal(checkIdempotency(null, original), 'new');
  assert.equal(checkIdempotency(original, { ...original }), 'replay');
  for (const changed of [{ ...original, scopeId: newId('vault') }, { ...original, operation: 'ingest.create' },
    { ...original, payloadHash: 'b'.repeat(64) }]) assert.throws(() => checkIdempotency(original, changed), failsWith('IDEMPOTENCY_CONFLICT'));
  assert.equal(isIdempotencyIdentity({ ...original, operation: 'toString' }), false);
  assert.equal(isIdempotencyIdentity({ ...original, scopeId: newId('answer') }), false);
  assert.throws(() => checkIdempotency(original, { ...original, payloadHash: 'not-a-hash' }), failsWith('BAD_REQUEST'));
  assert.throws(() => checkIdempotency({ ...original, key: 'different-key-0001' }, original), failsWith('SERVICE_UNAVAILABLE'));
});

test('run states, kinds and stages stay distinct; terminal or cancelling work cannot later succeed', () => {
  for (const state of RUN_STATES) assert(isRunState(state));
  for (const kind of RUN_KINDS) assert(isRunKind(kind));
  for (const stage of RUN_STAGES) { assert(isRunStage(stage)); assert.equal(isRunState(stage), false); }
  assert.equal(isRunState('saved'), false); assert.equal(isRunState('ready'), false);
  for (const state of ['succeeded', 'failed', 'cancelled', 'interrupted']) {
    assert(isTerminalRunState(state));
    for (const next of RUN_STATES) assert.equal(canTransitionRun(state, next), false);
  }
  assert(canTransitionRun('queued', 'cancelled'));
  assert(canTransitionRun('running', 'cancelling'));
  assert(canTransitionRun('running', 'succeeded'));
  assert(canTransitionRun('cancelling', 'cancelled'));
  assert.equal(canTransitionRun('cancelling', 'succeeded'), false);
  assert.equal(canTransitionRun('queued', 'succeeded'), false);
  for (const state of ['queued', 'running', 'cancelling']) assert(canTransitionRun(state, 'interrupted'));
  assert.equal(canTransitionRun('unknown', 'succeeded'), false);
  const runId = newId('run'), ref = { runId, state: 'queued', eventsUrl: `/api/v1/runs/${runId}/events` };
  assert(isRunRef(ref)); assert(isApiSuccess(apiSuccess(ref, newId('request')), isRunRef));
  for (const invalid of [{ ...ref, runId: newId('source') }, { ...ref, eventsUrl: 'https://attacker.example/' },
    { ...ref, eventsUrl: '/api/v1/runs/r_demo/events' }, { ...ref, state: 'ready' }, { ...ref, extra: true }]) assert.equal(isRunRef(invalid), false);
});

async function fixture(t, register) {
  const token = randomBytes(32).toString('base64url'), session = new BrowserSession(token);
  const app = createApp(session);
  register(app);
  t.after(() => app.close());
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const cookie = sessionCookie(session.exchange(token), app.server.address().port).split(';')[0];
  return { app, origin, cookie };
}

test('real HTTP uses every catalog status, sanitizes details and does not trust SDK-shaped errors', async t => {
  const runId = newId('run');
  const f = await fixture(t, app => {
    app.get('/api/v1/test-errors/:code', request => {
      const code = request.params.code;
      assert(Object.hasOwn(ERROR_CATALOG, code));
      throw new ApiError(code, { runId, currentRevision: 2, apiKey: 'PRIVATE_KEY_SENTINEL', request: { body: 'PRIVATE_DOCUMENT_SENTINEL' } });
    });
    app.get('/api/v1/test-raw-error', () => {
      throw Object.assign(new Error('PRIVATE_SDK_SENTINEL /private/key'), {
        code: 'REVISION_CONFLICT', details: { currentRevision: 123, apiKey: 'PRIVATE_KEY_SENTINEL' },
      });
    });
  });
  for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
    const response = await fetch(`${f.origin}/api/v1/test-errors/${code}`, { headers: { cookie: f.cookie } });
    assert.equal(response.status, entry.status, code);
    const text = await response.text(), body = JSON.parse(text);
    assert(isApiFailure(body)); assert.equal(body.error.code, code);
    assert.deepEqual(body.error.details, { runId, currentRevision: 2 });
    assert.equal(body.requestId, response.headers.get('x-request-id'));
    assert(!text.includes('PRIVATE_') && !text.includes('/private/'));
  }
  const response = await fetch(`${f.origin}/api/v1/test-raw-error`, { headers: { cookie: f.cookie } });
  assert.equal(response.status, 503);
  const body = await response.json(); assert(isApiFailure(body));
  assert.equal(body.error.code, 'SERVICE_UNAVAILABLE'); assert.equal(body.error.details, undefined);
});

test('isolated HTTP slice validates inputs, replays one result and rejects conflicting or stale writes', async t => {
  const vaultId = newId('vault'); let revision = 3, accepted = 0;
  const records = new Map();
  const f = await fixture(t, app => {
    // Test-only route/storage: no production business API, task, model or database is created.
    app.post('/api/v1/test-contract/:id', (request, reply) => {
      const scopeId = requireId(request.params.id, 'vault');
      const key = requireIdempotencyKey(request.headers['idempotency-key']);
      if (!hasFields(request.body, ['expectedRevision', 'text']) || typeof request.body.text !== 'string' || !request.body.text.length) throw new ApiError('BAD_REQUEST');
      const expectedRevision = requireRevision(request.body.expectedRevision);
      const payloadHash = createHash('sha256').update(JSON.stringify({ expectedRevision, text: request.body.text })).digest('hex');
      const identity = { key, operation: 'memory.create', scopeId, payloadHash };
      const previous = records.get(key);
      if (checkIdempotency(previous?.identity ?? null, identity) === 'replay') return reply.code(202).send(apiSuccess(previous.result, request.id));
      checkRevision(expectedRevision, revision);
      const runId = newId('run'), result = { runId, state: 'queued', eventsUrl: `/api/v1/runs/${runId}/events` };
      records.set(key, { identity, result }); accepted++; revision++;
      return reply.code(202).send(apiSuccess(result, request.id));
    });
  });
  const post = (body, key = 'public-contract-key-01', id = vaultId) => fetch(`${f.origin}/api/v1/test-contract/${id}`, {
    method: 'POST', headers: { origin: f.origin, cookie: f.cookie, 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body),
  });
  for (const [body, key, id] of [[{ expectedRevision: '3', text: 'test' }], [{ expectedRevision: 3, text: 'test', extra: 'PRIVATE_SENTINEL' }],
    [{ expectedRevision: 3, text: 'test' }, 'short'], [{ expectedRevision: 3, text: 'test' }, undefined, 'v_demo']]) {
    const response = await post(body, key, id); assert.equal(response.status, 400); assert(isApiFailure(await response.json()));
  }
  assert.equal(accepted, 0);
  const input = { expectedRevision: 3, text: '公开合成输入' };
  const first = await post(input); assert.equal(first.status, 202); const original = await first.json(); assert(isApiSuccess(original, isRunRef));
  const replay = await post(input); assert.equal(replay.status, 202); const repeated = await replay.json();
  assert.deepEqual(repeated.data, original.data); assert.notEqual(repeated.requestId, original.requestId); assert.equal(accepted, 1);
  for (const [body, key, id] of [[{ ...input, text: '不同内容' }], [input, undefined, newId('vault')]]) {
    const response = await post(body, key, id); assert.equal(response.status, 409);
    const conflict = await response.json(); assert(isApiFailure(conflict)); assert.equal(conflict.error.code, 'IDEMPOTENCY_CONFLICT');
  }
  const stale = await post(input, 'public-contract-key-02'); assert.equal(stale.status, 409);
  const body = await stale.json(); assert(isApiFailure(body));
  assert.equal(body.error.code, 'REVISION_CONFLICT'); assert.deepEqual(body.error.details, { currentRevision: 4 });
  assert.equal(accepted, 1);
});

test('unimplemented business routes and test-only routes remain unavailable', async t => {
  const f = await fixture(t, () => {});
  for (const route of ['/api/v1/test-contract/test', '/api/v1/runs/r_demo', '/api/v1/memories']) {
    const response = await fetch(`${f.origin}${route}`, { headers: { cookie: f.cookie } });
    assert.equal(response.status, 404); assert(isApiFailure(await response.json()));
  }
});
