import { parse as parseQuery } from 'node:querystring';
import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import { ERROR_CATALOG, apiFailure, apiSuccess, isBootstrapRequest,
  type ErrorCode, type ApiSuccess, type Health, type SessionStatus } from '../shared/api.js';
import { BrowserSession, sessionCookie } from './session.js';
import { ApiError, newId } from './contracts.js';
import { isSaveModelProfile, isModelCatalogRequest } from '../shared/model-profiles.js';
import { isExpectedRevision } from '../shared/contracts.js';
import { isModelRequest, isCredentialRequest } from '../shared/model.js';
import type { ModelSettings } from './model-settings.js';
import type { VaultService } from './vaults.js';
import { isVaultInput, isVaultUpdate, isContentQuery } from '../shared/vault.js';
import { isTerminalRunState } from '../shared/contracts.js';
import type { RunService } from './runs.js';
import { isIngestInput } from '../shared/ingest.js';
import { MAX_FILE_BYTES } from '../shared/vault.js';
import type { Upload } from './ingestions.js';
import type { QuestionService } from './questions.js';
import { hasFields } from '../shared/contracts.js';
import { isDeletionImpact } from '../shared/chat.js';

function sendFailure(reply: FastifyReply, code: ErrorCode, requestId: string, details?: unknown) {
  return reply.code(ERROR_CATALOG[code].status).send(apiFailure(code, requestId, details));
}

export function createApp(session = new BrowserSession(randomBytes(32).toString('base64url')), models?: ModelSettings,
  vaults?: VaultService, runs?: RunService, questions?: QuestionService) {
  const app = Fastify({ logger: false, requestIdHeader: false, genReqId: () => newId('request'),
    routerOptions: { querystringParser: query => parseQuery(query, '&', '=', { maxKeys: 0 }) },
    trustProxy: false, forceCloseConnections: true, bodyLimit: 1024, requestTimeout: 10_000,
    frameworkErrors: (_error, request: FastifyRequest, reply: FastifyReply) => {
      reply.headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-request-id': request.id });
      return sendFailure(reply, 'BAD_REQUEST', request.id);
    },
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.headers({
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      'x-request-id': request.id,
    });
    const address = app.server.address();
    const host = address && typeof address !== 'string' ? `127.0.0.1:${address.port}` : null;
    const origin = request.headers.origin;
    const site = request.headers['sec-fetch-site'];
    const route = request.routeOptions.url;
    const safeMethod = ['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (!host || request.headers.host !== host || ((!safeMethod || origin !== undefined) && origin !== `http://${host}`) ||
        (site !== undefined && site !== 'same-origin' && site !== 'none')) {
      return sendFailure(reply, 'ORIGIN_DENIED', request.id);
    }
    const publicRead = ['GET', 'HEAD'].includes(request.method) && route === '/api/v1/health';
    const bootstrap = request.method === 'POST' && route === '/api/v1/bootstrap';
    if (!publicRead && !bootstrap && !session.accepts(request.headers.cookie, (address as { port: number }).port)) {
      return sendFailure(reply, 'UNAUTHORIZED', request.id);
    }
    if (bootstrap && request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      return sendFailure(reply, 'BAD_REQUEST', request.id);
    }
  });
  app.setNotFoundHandler((request, reply) => sendFailure(reply, 'NOT_FOUND', request.id));
  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, request, reply) => {
    if (error instanceof ApiError) return sendFailure(reply, error.publicError.code, request.id, error.publicError.details);
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return sendFailure(reply, 'FILE_TOO_LARGE', request.id);
    if (error.statusCode === 404) return sendFailure(reply, 'NOT_FOUND', request.id);
    if (error.statusCode && error.statusCode < 500) return sendFailure(reply, 'BAD_REQUEST', request.id);
    return sendFailure(reply, 'SERVICE_UNAVAILABLE', request.id);
  });
  app.get('/api/v1/health', {
    schema: { response: { 200: { type: 'object', required: ['data', 'requestId'], additionalProperties: false,
      properties: { data: { type: 'object', required: ['status'], additionalProperties: false,
        properties: { status: { type: 'string', const: 'ok' } } }, requestId: { type: 'string' } } } } },
  }, async (request): Promise<ApiSuccess<Health>> => apiSuccess({ status: 'ok' }, request.id));
  app.post('/api/v1/bootstrap', async (request, reply) => {
    if (!isBootstrapRequest(request.body) || request.url.includes('?')) {
      return sendFailure(reply, 'BAD_REQUEST', request.id);
    }
    const token = session.exchange(request.body.token);
    if (!token) return sendFailure(reply, 'UNAUTHORIZED', request.id);
    const address = app.server.address() as { port: number };
    reply.header('set-cookie', sessionCookie(token, address.port));
    return apiSuccess<SessionStatus>({ authenticated: true }, request.id);
  });
  app.get('/api/v1/session', async (request): Promise<ApiSuccess<SessionStatus>> =>
    apiSuccess({ authenticated: true }, request.id));
  if (models) {
    app.get('/api/v1/settings', (request, reply) => {
      if (request.url.includes('?')) return sendFailure(reply, 'BAD_REQUEST', request.id);
      return apiSuccess(models.view(), request.id);
    });
    app.get('/api/v1/model/profiles', (request, reply) => {
      if (request.url.includes('?')) return sendFailure(reply, 'BAD_REQUEST', request.id);
      return apiSuccess(models.profiles(), request.id);
    });
    app.put('/api/v1/model/profiles', { bodyLimit: 32768 }, async (request, reply) => {
      if (request.url.includes('?') || !isSaveModelProfile(request.body)) return sendFailure(reply, 'BAD_REQUEST', request.id);
      const body = request.body;
      try { return apiSuccess(await models.saveProfile(body), request.id); } finally { if (body.apiKey) body.apiKey = ''; }
    });
    app.post<{ Params: { id: string } }>('/api/v1/model/profiles/:id/activate', async (request, reply) => {
      if (request.url.includes('?') || !isExpectedRevision(request.body)) return sendFailure(reply, 'BAD_REQUEST', request.id);
      return apiSuccess(models.activateProfile(request.params.id, request.body.expectedRevision), request.id);
    });
    app.delete<{ Params: { id: string } }>('/api/v1/model/profiles/:id', async (request, reply) => {
      const query = request.query as { expectedRevision?: string };
      if (!hasFields(query, ['expectedRevision']) || typeof query.expectedRevision !== 'string' || !/^[1-9]\d{0,15}$/.test(query.expectedRevision) ||
        !isExpectedRevision({ expectedRevision: Number(query.expectedRevision) }) || request.body !== undefined) return sendFailure(reply, 'BAD_REQUEST', request.id);
      return apiSuccess(await models.deleteProfile(request.params.id, Number(query.expectedRevision)), request.id);
    });
    app.post('/api/v1/model/catalog', { bodyLimit: 4096 }, async (request, reply) => {
      if (request.url.includes('?') || !isModelCatalogRequest(request.body)) return sendFailure(reply, 'BAD_REQUEST', request.id);
      const body = request.body;
      try { return apiSuccess(await models.catalog(body), request.id); } finally { if (body.apiKey) body.apiKey = ''; }
    });
    app.put('/api/v1/model', { bodyLimit: 4096 }, async (request, reply) => {
      if (request.url.includes('?') || !isModelRequest(request.body)) return sendFailure(reply, 'BAD_REQUEST', request.id);
      const { provider, model, baseUrl, expectedRevision } = request.body;
      return apiSuccess(await models.setModel({ provider, model, baseUrl }, expectedRevision), request.id);
    });
    app.put('/api/v1/model/credential', async (request, reply) => {
      if (request.url.includes('?') || !isCredentialRequest(request.body)) return sendFailure(reply, 'BAD_REQUEST', request.id);
      const body = request.body;
      try { return apiSuccess(await models.setCredential(body.apiKey, body.expectedRevision), request.id); }
      finally { body.apiKey = ''; }
    });
  }
  if (vaults) {
    app.post('/api/v1/vaults', { bodyLimit: 64 * 1024 }, async (request, reply) => {
      if (request.url.includes('?') || !isVaultInput(request.body)) return sendFailure(reply, 'BAD_REQUEST', request.id);
      const vault = await vaults.connect(request.body);
      return reply.code(201).send(apiSuccess(vault, request.id));
    });
    app.get('/api/v1/vaults', (request, reply) => {
      if (request.url.includes('?')) return sendFailure(reply, 'BAD_REQUEST', request.id);
      return apiSuccess(vaults.list(), request.id);
    });
    app.patch<{ Params: { id: string } }>('/api/v1/vaults/:id', { bodyLimit: 64 * 1024 }, (request, reply) => {
      if (request.url.includes('?') || !isVaultUpdate(request.body)) return sendFailure(reply, 'BAD_REQUEST', request.id);
      return apiSuccess(vaults.update(request.params.id, request.body), request.id);
    });
    app.get<{ Params: { id: string } }>('/api/v1/vaults/:id/catalog-revision', (request, reply) => {
      if (request.url.includes('?')) return sendFailure(reply, 'BAD_REQUEST', request.id);
      return apiSuccess(vaults.catalogRevision(request.params.id), request.id);
    });
    app.get<{ Params: { id: string } }>('/api/v1/vaults/:id/sources', (request) =>
      apiSuccess(vaults.sources(request.params.id, request.query), request.id));
    app.get<{ Params: { id: string } }>('/api/v1/sources/:id', (request, reply) => {
      if (request.url.includes('?')) return sendFailure(reply, 'BAD_REQUEST', request.id);
      return apiSuccess(vaults.source(request.params.id), request.id);
    });
    app.get<{ Params: { id: string } }>('/api/v1/sources/:id/content', async (request, reply) => {
      if (!isContentQuery(request.query)) return sendFailure(reply, 'BAD_REQUEST', request.id);
      const { bytes, source } = await vaults.content(request.params.id, request.query.view, request.query.expectedVersion);
      const filename = encodeURIComponent(source.title).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
      reply.type(request.query.view === 'text' ? 'text/plain; charset=utf-8' : 'application/octet-stream');
      reply.header('content-disposition', `${request.query.view === 'text' ? 'inline' : 'attachment'}; filename="source"; filename*=UTF-8''${filename}`);
      return reply.send(bytes);
    });
  }
  if (questions && runs) {
    app.get<{ Params: { id: string } }>('/api/v1/vaults/:id/memories', request =>
      apiSuccess(questions.memories.list(request.params.id, request.query), request.id));
    app.post('/api/v1/memories', { bodyLimit: 16 * 1024 }, (request, reply) => {
      if (request.url.includes('?')) return sendFailure(reply, 'BAD_REQUEST', request.id);
      return reply.code(201).send(apiSuccess(questions.memories.create(request.body, request.headers['idempotency-key']), request.id));
    });
    app.patch<{ Params: { id: string } }>('/api/v1/memories/:id', { bodyLimit: 16 * 1024 }, (request, reply) => {
      if (request.url.includes('?')) return sendFailure(reply, 'BAD_REQUEST', request.id);
      return apiSuccess(questions.memories.update(request.params.id, request.body), request.id);
    });
    app.delete<{ Params: { id: string } }>('/api/v1/memories/:id', (request, reply) => {
      if (request.body !== undefined || !hasFields(request.query, ['expectedRevision']) || typeof request.query.expectedRevision !== 'string' ||
        !/^[1-9]\d{0,15}$/.test(request.query.expectedRevision)) return sendFailure(reply, 'BAD_REQUEST', request.id);
      return apiSuccess(questions.memories.delete(request.params.id, Number(request.query.expectedRevision)), request.id);
    });
    app.post('/api/v1/sessions', { bodyLimit: 2048 }, (request, reply) => {
      if (request.url.includes('?')) return sendFailure(reply, 'BAD_REQUEST', request.id);
      return reply.code(201).send(apiSuccess(questions.conversations.create(request.body, request.headers['idempotency-key']), request.id));
    });
    app.get('/api/v1/sessions', request => apiSuccess(questions.conversations.list(request.query), request.id));
    app.get('/api/v1/sessions/search', async request => apiSuccess(await questions.conversations.search(request.query), request.id));
    app.get<{ Params: { id: string } }>('/api/v1/sessions/:id/deletion-impact', (request, reply) => {
      if (request.url.includes('?')) return sendFailure(reply, 'BAD_REQUEST', request.id);
      return apiSuccess(questions.conversations.deletionImpact(request.params.id), request.id);
    });
    app.delete<{ Params: { id: string } }>('/api/v1/sessions/:id', { bodyLimit: 1024 }, async (request, reply) => {
      if (request.url.includes('?') || (request.body !== undefined && !isDeletionImpact(request.body))) return sendFailure(reply, 'BAD_REQUEST', request.id);
      return apiSuccess(await runs.deleteSession(request.params.id, request.body), request.id);
    });
    app.get<{ Params: { id: string } }>('/api/v1/sessions/:id', (request, reply) => {
      if (request.url.includes('?')) return sendFailure(reply, 'BAD_REQUEST', request.id);
      return apiSuccess(questions.conversations.get(request.params.id), request.id);
    });
    app.get<{ Params: { id: string } }>('/api/v1/sessions/:id/messages', request =>
      apiSuccess(questions.conversations.messages(request.params.id, request.query), request.id));
    app.get<{Params:{id:string;messageId:string}}>('/api/v1/sessions/:id/messages/:messageId',request=>
      apiSuccess(questions.conversations.reference(request.params.id,request.params.messageId),request.id));
    app.post<{ Params: { id: string } }>('/api/v1/sessions/:id/messages', { bodyLimit: 32 * 1024 }, (request, reply) => {
      if (request.url.includes('?')) return sendFailure(reply, 'BAD_REQUEST', request.id);
      return reply.code(202).send(apiSuccess(runs.message(request.params.id, request.body, request.headers['idempotency-key']), request.id));
    });
    app.get<{ Params: { id: string } }>('/api/v1/answers/:id', async (request, reply) => {
      if (request.url.includes('?')) return sendFailure(reply, 'BAD_REQUEST', request.id);
      return apiSuccess(await questions.answers.get(request.params.id), request.id);
    });
    app.get<{ Params: { id: string } }>('/api/v1/vaults/:id/watches', (request,reply) => {
      if (!hasFields(request.query, [], ['cursor']) || (request.query.cursor !== undefined && typeof request.query.cursor !== 'string')) return sendFailure(reply,'BAD_REQUEST',request.id);
      return apiSuccess(runs.watches!.list(request.params.id,request.query.cursor as string | undefined),request.id);
    });
    app.put<{ Params: { id: string } }>('/api/v1/answers/:id/watch', { bodyLimit: 32768 }, (request,reply) => {
      if (request.url.includes('?')) return sendFailure(reply,'BAD_REQUEST',request.id);
      return apiSuccess(runs.watches!.create(request.params.id,request.body),request.id);
    });
    app.get<{ Params: { id: string } }>('/api/v1/watches/:id', (request,reply) => {
      if (!hasFields(request.query, [], ['cursor']) || (request.query.cursor !== undefined && typeof request.query.cursor !== 'string')) return sendFailure(reply,'BAD_REQUEST',request.id);
      return apiSuccess(runs.watches!.detail(request.params.id,request.query.cursor as string | undefined),request.id);
    });
    app.patch<{ Params: { id: string } }>('/api/v1/watches/:id', { bodyLimit: 32768 }, (request,reply) => {
      if (request.url.includes('?')) return sendFailure(reply,'BAD_REQUEST',request.id);
      return apiSuccess(runs.watches!.patch(request.params.id,request.body),request.id);
    });
    app.post<{ Params: { id: string } }>('/api/v1/answers/:id/selection-preview', { bodyLimit: 256 * 1024 }, async (request, reply) => {
      if(request.url.includes('?'))return sendFailure(reply,'BAD_REQUEST',request.id);
      return apiSuccess(await questions.answers.selection(request.params.id,request.body),request.id);
    });
    app.post<{ Params: { id: string } }>('/api/v1/answers/:id/save', { bodyLimit: 256 * 1024 }, async (request, reply) => {
      if (request.url.includes('?')) return sendFailure(reply, 'BAD_REQUEST', request.id);
      return reply.code(202).send(apiSuccess(await runs.saveAnswer(request.params.id, request.body, request.headers['idempotency-key']), request.id));
    });
  }
  if (runs) {
    app.post('/api/v1/model/probe', (request, reply) => {
      if (request.body !== undefined || request.url.includes('?')) return sendFailure(reply, 'BAD_REQUEST', request.id);
      return reply.code(202).send(apiSuccess(runs.probe(request.headers['idempotency-key']), request.id));
    });
    app.addContentTypeParser(/^multipart\/form-data(?:;|$)/i, { parseAs: 'buffer', bodyLimit: MAX_FILE_BYTES + 64 * 1024 },
      (_request, body, done) => done(null, body));
    app.post('/api/v1/ingestions', { bodyLimit: MAX_FILE_BYTES + 64 * 1024 }, async (request, reply) => {
      if (request.url.includes('?')) return sendFailure(reply, 'BAD_REQUEST', request.id);
      let input: unknown = request.body, upload: Upload | undefined;
      if (Buffer.isBuffer(request.body)) {
        try {
          const form = await new Request('http://127.0.0.1/', { method: 'POST',
            headers: { 'content-type': request.headers['content-type']! }, body: new Uint8Array(request.body) }).formData();
          const meta = form.get('meta'), file = form.get('file');
          if ([...form.keys()].length !== 2 || typeof meta !== 'string' || Buffer.byteLength(meta) > 4096 || !(file instanceof File)) {
            return sendFailure(reply, 'BAD_REQUEST', request.id);
          }
          input = JSON.parse(meta) as unknown;
          if (file.size > MAX_FILE_BYTES) return sendFailure(reply, 'FILE_TOO_LARGE', request.id);
          upload = { filename: file.name, bytes: Buffer.from(await file.arrayBuffer()) };
        } catch { return sendFailure(reply, 'BAD_REQUEST', request.id); }
      }
      if (!isIngestInput(input)) return sendFailure(reply, 'BAD_REQUEST', request.id);
      return reply.code(202).send(apiSuccess(await runs.ingest(input, request.headers['idempotency-key'], upload), request.id));
    });
    app.post<{ Params: { id: string } }>('/api/v1/vaults/:id/refresh', (request, reply) => {
      if (request.url.includes('?') || request.body !== undefined) return sendFailure(reply, 'BAD_REQUEST', request.id);
      return reply.code(202).send(apiSuccess(runs.refresh(request.params.id, request.headers['idempotency-key']), request.id));
    });
    app.post<{ Params: { id: string } }>('/api/v1/sources/:id/retry', (request, reply) => {
      if (request.url.includes('?') || request.body !== undefined) return sendFailure(reply, 'BAD_REQUEST', request.id);
      return reply.code(202).send(apiSuccess(runs.retry(request.params.id, request.headers['idempotency-key']), request.id));
    });
    app.get<{ Params: { id: string } }>('/api/v1/runs/:id', (request, reply) => {
      if (request.url.includes('?')) return sendFailure(reply, 'BAD_REQUEST', request.id);
      return apiSuccess(runs.get(request.params.id), request.id);
    });
    app.post<{ Params: { id: string } }>('/api/v1/runs/:id/cancel', (request, reply) => {
      if (request.url.includes('?') || request.body !== undefined) return sendFailure(reply, 'BAD_REQUEST', request.id);
      return apiSuccess(runs.cancel(request.params.id), request.id);
    });
    app.get<{ Params: { id: string } }>('/api/v1/runs/:id/events', (request, reply) => {
      const value = request.headers['last-event-id'] ?? '0';
      if (request.url.includes('?') || typeof value !== 'string' || !/^(0|[1-9]\d{0,15})$/.test(value) ||
          !Number.isSafeInteger(Number(value))) return sendFailure(reply, 'BAD_REQUEST', request.id);
      const id = request.params.id;
      runs.get(id);
      let after = Number(value), unsubscribe = () => {};
      reply.hijack();
      for (const [name, header] of Object.entries(reply.getHeaders())) if (header !== undefined) reply.raw.setHeader(name, header);
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store', 'connection': 'keep-alive' });
      const heartbeat = setInterval(() => { reply.raw.write(': keep-alive\n\n'); }, 15000);
      heartbeat.unref();
      reply.raw.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
      const send = () => {
        if (reply.raw.destroyed || reply.raw.writableEnded) return;
        try {
          const events = runs.events(id, after);
          if (events.reset) {
            reply.raw.end(`event: stream.reset\ndata: ${JSON.stringify({ eventId: events.lastEventId, runId: id,
              type: 'stream.reset', at: new Date().toISOString(), payload: {
                snapshotUrl: `/api/v1/runs/${id}`, lastEventId: events.lastEventId } })}\n\n`);
            return;
          }
          for (const event of events.items) {
            reply.raw.write(`id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            after = event.eventId;
          }
          if (isTerminalRunState(runs.get(id).state)) reply.raw.end();
        } catch { reply.raw.destroy(); }
      };
      unsubscribe = runs.subscribe(id, send);
      send();
    });
  }
  return app;
}
