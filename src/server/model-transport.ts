import { completionEndpoint, completionLimitField, supportedModel } from '../shared/model-profiles.js';
import type { ModelConfig } from '../shared/model.js';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { hasFields } from '../shared/contracts.js';
import { isRawUsage, MODEL_LIMITS, type RawUsage } from '../shared/model-run.js';
import type { ErrorCode } from '../shared/api.js';
import { TOOL_NAMES } from '../shared/tools.js';
import { ApiError } from './contracts.js';
import { ModelLedger } from './model-ledger.js';
import { ModelSettings } from './model-settings.js';
import { estimatedInputTokens, MODEL_CONTEXT_INPUT, MODEL_CONTEXT_WINDOW, packModelContext } from '../shared/model-context.js';
export { packModelContext } from '../shared/model-context.js';
import { answerPreview } from '../shared/answer-preview.js';

export const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
export type ObservedToolCall = { id: string; name: string; arguments: unknown };
export type ModelResponse = { attemptId: string; body: string; usage: RawUsage; returnedModel: string; outputLimit: number; calls: ObservedToolCall[] };
function fail(code: ErrorCode = 'MODEL_PROTOCOL_ERROR'): never { throw new ApiError(code); }
const text = (value: unknown): value is string => typeof value === 'string';
const textContent = (value: unknown): boolean => text(value) || (Array.isArray(value) && value.length <= 64 &&
  value.every(block => hasFields(block, ['type','text']) && block.type === 'text' && text(block.text)));
const whole = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
export function modelInputEnvelope(value: Record<string, unknown>): number {
  const messages = value.messages as Array<{ tool_calls?: unknown[] }>;
  const calls = messages.reduce((count, message) => count + (message.tool_calls?.length ?? 0), 0);
  return Buffer.byteLength(JSON.stringify(value)) + 2048 + messages.length * 32 + calls * 128;
}
export function checkModelPayload(value: unknown, inputLimit: number = MODEL_LIMITS.requestInputTokens, closing = false, config: ModelConfig = { provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' }): Record<string, unknown> {
  const allowedTools: readonly string[] = TOOL_NAMES;
  const deepseek = config.provider === 'deepseek', limitField = completionLimitField(config);
  if (!hasFields(value, ['model','messages','stream','stream_options',limitField, ...(deepseek ? ['thinking'] : [])], ['tools', ...(deepseek ? ['reasoning_effort'] : []),'temperature','tool_choice']) ||
    value.model !== config.model || value.stream !== true || !hasFields(value.stream_options, ['include_usage']) || value.stream_options.include_usage !== true ||
    !whole(value[limitField]) || (value[limitField] as number) < 1 || (value[limitField] as number) > MODEL_LIMITS.requestOutputTokens ||
    (deepseek && (!hasFields(value.thinking, ['type']) || !['disabled','enabled'].includes(String(value.thinking.type)) ||
      (value.thinking.type === 'enabled' ? value.reasoning_effort !== 'low' : value.reasoning_effort !== undefined))) ||
    (value.temperature !== undefined && (typeof value.temperature !== 'number' || !Number.isFinite(value.temperature) || value.temperature < 0 || value.temperature > 2)) ||
    (value.tool_choice !== undefined && !['auto', 'none'].includes(String(value.tool_choice)))) fail();
  if (!(closing && value.tool_choice === 'none' && value.tools === undefined) && (!Array.isArray(value.tools) || value.tools.length !== allowedTools.length || value.tools.some(tool => !hasFields(tool, ['type','function']) ||
    tool.type !== 'function' || !hasFields(tool.function, ['name','description','parameters'], ['strict']) ||
    !allowedTools.includes(tool.function.name as string) || !text(tool.function.description) ||
    !hasFields(tool.function.parameters, ['type','properties'], ['required','additionalProperties']) || tool.function.parameters.type !== 'object') ||
    new Set(value.tools.map(tool => tool.function.name)).size !== allowedTools.length)) fail();
  if (!Array.isArray(value.messages) || value.messages.length < 1) fail();
  let calls = 0;
  for (const message of value.messages) {
    if (!hasFields(message, ['role','content'], ['tool_calls','tool_call_id','reasoning_content','name']) ||
      !['system','developer','user','assistant','tool'].includes(String(message.role)) || !(message.content === null || textContent(message.content)) ||
      (message.role !== 'assistant' && message.content === null) ||
      (message.reasoning_content !== undefined && (message.role !== 'assistant' || !text(message.reasoning_content))) ||
      (message.name !== undefined && !text(message.name))) fail();
    if (message.role === 'tool' ? !text(message.tool_call_id) : message.tool_call_id !== undefined) fail();
    if (message.tool_calls !== undefined) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || message.tool_calls.length > 20) fail();
      for (const call of message.tool_calls) {
        if (!hasFields(call, ['id','type','function']) || !text(call.id) || call.type !== 'function' ||
          !hasFields(call.function, ['name','arguments']) || !text(call.function.name) || !text(call.function.arguments)) fail();
        calls++;
      }
    }
  }
  // A separate conservative byte envelope reserves money; estimates only guide context packing.
  const allowance = modelInputEnvelope(value);
  if (allowance > inputLimit) fail('BUDGET_EXCEEDED');
  return structuredClone(value);
}
export function definitelyUnsentDns(error: unknown, hostname = 'api.deepseek.com'): boolean {
  const cause = error instanceof Error ? error.cause as { code?: unknown; syscall?: unknown; hostname?: unknown } | undefined : undefined;
  return cause?.code === 'EAI_AGAIN' && cause.syscall === 'getaddrinfo' && cause.hostname === hostname;
}
function probePayload(inputLimit: number, config: ModelConfig): Record<string, unknown> {
  const payload = { model: config.model, stream: true, stream_options: { include_usage: true },
    [completionLimitField(config)]: 32, ...(config.provider === 'deepseek' ? { thinking: { type: 'disabled' } } : {}), tool_choice: 'none',
    messages: [{ role: 'system', content: 'This is a connection test. Reply only OK.' }, { role: 'user', content: 'OK' }] };
  if (modelInputEnvelope(payload) > inputLimit) fail('BUDGET_EXCEEDED');
  return payload;
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ApiError('RUN_INTERRUPTED'));
    if (signal.aborted) { promise.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function inspectResponse(response: Response, signal: AbortSignal, contentChanged?: (content: string) => void): Promise<Omit<ModelResponse, 'attemptId' | 'outputLimit'>> {
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => {});
    fail(response.status === 401 || response.status === 403 ? 'MODEL_AUTH_FAILED' : response.status === 429 ? 'MODEL_RATE_LIMITED' : 'MODEL_UNAVAILABLE');
  }
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') || !response.body) fail();
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, body = '', buffer = '', content = '';
  let usage: RawUsage | undefined, returnedModel = '', done = false, finished = false;
  const toolFragments = new Map<number, { id: string; name: string; arguments: string }>();
  const lineReceived = (line: string) => {
    if (!line || line.startsWith(':')) return;
    if (!line.startsWith('data:') || done) fail();
    const data = line.slice(5).trim();
    if (data === '[DONE]') { done = true; return; }
    let chunk: Record<string, unknown>;
    try { chunk = JSON.parse(data) as Record<string, unknown>; } catch { fail(); }
    if (!chunk || typeof chunk !== 'object' || !text(chunk.model) || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(chunk.model) ||
      (returnedModel && chunk.model !== returnedModel) || !Array.isArray(chunk.choices) || chunk.choices.length > 1) fail();
    returnedModel = chunk.model;
    for (const choice of chunk.choices) {
      if (!choice || choice.index !== 0 || !choice.delta || typeof choice.delta !== 'object' ||
        (choice.finish_reason !== null && choice.finish_reason !== undefined && !['stop','length','tool_calls','content_filter'].includes(choice.finish_reason))) fail();
      if (finished && (choice.delta.content || choice.delta.tool_calls)) fail();
      if (choice.delta.content !== undefined && choice.delta.content !== null) {
        if (!text(choice.delta.content)) fail();
        content += choice.delta.content;
        contentChanged?.(content);
      }
      if (choice.finish_reason) { if (finished) fail(); finished = true; }
      if (choice.delta.tool_calls !== undefined && choice.delta.tool_calls !== null) {
        if (!Array.isArray(choice.delta.tool_calls)) fail();
        for (const fragment of choice.delta.tool_calls) {
          if (!fragment || !whole(fragment.index) || fragment.index > 999 ||
            (fragment.type !== undefined && fragment.type !== 'function') ||
            (fragment.id !== undefined && !text(fragment.id)) ||
            (fragment.function !== undefined && (!fragment.function || typeof fragment.function !== 'object'))) fail();
          const current = toolFragments.get(fragment.index) ?? { id: '', name: '', arguments: '' };
          if (fragment.id) { if (current.id && current.id !== fragment.id) fail(); current.id = fragment.id; }
          for (const key of ['name','arguments'] as const) {
            if (fragment.function?.[key] !== undefined) {
              if (!text(fragment.function[key])) fail(); current[key] += fragment.function[key];
            }
          }
          toolFragments.set(fragment.index, current);
        }
      }
    }
    if (chunk.usage !== undefined && chunk.usage !== null) {
      if (usage || !finished || !chunk.usage || typeof chunk.usage !== 'object') fail();
      const raw = chunk.usage as Record<string, unknown>;
      const projected = Object.fromEntries(['prompt_tokens','completion_tokens','total_tokens','prompt_cache_hit_tokens','prompt_cache_miss_tokens']
        .filter(key => Object.hasOwn(raw, key)).map(key => [key, raw[key]]));
      if (!isRawUsage(projected)) fail();
      const details = raw.completion_tokens_details as { reasoning_tokens?: unknown } | undefined;
      if (details?.reasoning_tokens !== undefined && (!whole(details.reasoning_tokens) || details.reasoning_tokens > projected.completion_tokens)) fail();
      usage = projected;
    }
  }
  try {
    for (;;) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength; if (bytes > 8 * 1024 * 1024) fail();
      const decoded = decoder.decode(chunk.value, { stream: true }); body += decoded; buffer += decoded;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        lineReceived(buffer.slice(0, newline).replace(/\r$/, '')); buffer = buffer.slice(newline + 1);
      }
    }
    const last = decoder.decode(); body += last; buffer += last;
    if (buffer) lineReceived(buffer.replace(/\r$/, ''));
  } finally { void reader.cancel().catch(() => {}); }
  if (!done || !finished || !usage || !returnedModel) fail();
  const calls = [...toolFragments].sort(([a], [b]) => a - b).map(([index, call], position) => {
    if (index !== position) fail();
    let args: unknown = call.arguments;
    try { args = JSON.parse(call.arguments); } catch { /* The SDK must not repair malformed arguments into an executable call. */ }
    return { id: call.id, name: call.name, arguments: args };
  });
  return { body, usage, returnedModel, calls };
}

export class ModelTransport {
  private readonly abort = new AbortController();
  private readonly signal: AbortSignal;
  private readonly unsubscribe: () => void;
  private busy = false;
  private previousInputTokens: number | undefined;
  private largestInputGrowth = 1000; // + 1000 below preserves the original 2k minimum.
  constructor(private readonly ledger: ModelLedger, private readonly settings: ModelSettings, private readonly runId: string,
    private readonly revision: number, signal: AbortSignal, private readonly transport: typeof fetch = fetch,
    private readonly beforeSend?: () => Promise<void>) {
    this.signal = AbortSignal.any([signal, this.abort.signal]);
    this.unsubscribe = settings.onChange(() => this.abort.abort());
  }
  close(): void { this.abort.abort(); this.unsubscribe(); }
  private check(): void {
    if (this.settings.view().revision !== this.revision) fail('CONTEXT_CHANGED');
    if (this.signal.aborted) fail('RUN_INTERRUPTED');
  }
  async request(value: unknown, preview?: (text: string) => void, finish = false): Promise<ModelResponse> {
    return this.perform(value, false, preview, finish);
  }
  async probe(): Promise<void> {
    const result = await this.perform(undefined, true);
    let content = '', stopped = false;
    for (const line of result.body.split(/\r?\n/)) {
      if (!line.startsWith('data:') || line.slice(5).trim() === '[DONE]') continue;
      const chunk = JSON.parse(line.slice(5));
      for (const choice of chunk.choices) {
        if (choice.delta.content !== undefined && choice.delta.content !== null) {
          if (typeof choice.delta.content !== 'string') fail();
          content += choice.delta.content;
        }
        if (choice.finish_reason) { if (choice.finish_reason !== 'stop') fail(); stopped = true; }
      }
    }
    if (result.calls.length || !stopped || !content.trim()) fail();
  }
  private async perform(value: unknown, probe: boolean, preview?: (text: string) => void, finish = false): Promise<ModelResponse> {
    if (this.busy) fail('MODEL_PROTOCOL_ERROR');
    this.busy = true;
    try {
      this.check();
      // Validate shape first; closing removes only unused tool definitions, never evidence.
      // Check the actual outbound envelope before reserving or accessing credentials.
      const selected = this.settings.view().model;
      if (!selected || !supportedModel(selected)) fail('CONFIG_REQUIRED');
      const limitField = completionLimitField(selected);
      const payload = probe ? probePayload(MODEL_LIMITS.requestInputTokens, selected) : packModelContext(checkModelPayload(value, Number.MAX_SAFE_INTEGER, false, selected));
      let closing = false;
      const closeTools = () => {
        if (closing) return;
        closing = true; payload.tool_choice = 'none'; delete payload.tools;
        if (selected.provider === 'deepseek') payload.thinking = { type: 'disabled' };
        delete payload.reasoning_effort;
        (payload.messages as Array<{ role: string; content: unknown }>).push({ role: 'system',
          content: '检索已到本轮运行边界，工具已关闭。本次只输出最终答案 JSON，不得输出工具调用代码或标记。逐项回答已读证据支持的部分；关键依据未读到就说明未完成，不能用概括段落冒充完整核验。' });
      };
      if (!probe) {
        const inputTokens = estimatedInputTokens(payload);
        // Another batch of tool results can be much larger than the old fixed 2k margin.
        // Use this run's observed growth to stop before reading another similar batch;
        // never trim evidence already read to make a final answer fit.
        if (this.previousInputTokens !== undefined) this.largestInputGrowth = Math.max(this.largestInputGrowth, inputTokens - this.previousInputTokens);
        this.previousInputTokens = inputTokens;
        // A single unusually large passage must still leave room to read a short
        // continuation. Reserve at most a quarter of the input window for growth.
        const headroom = Math.min(MODEL_CONTEXT_INPUT / 4, this.largestInputGrowth + 1000);
        if (finish || inputTokens > MODEL_CONTEXT_INPUT - headroom) closeTools();
        if (estimatedInputTokens(payload) > MODEL_CONTEXT_INPUT) fail('CONTEXT_LIMIT');
        checkModelPayload(payload, MODEL_LIMITS.requestInputTokens, closing, selected);
      }
      for (;;) {
        const config = await abortable(this.settings.forRequest(), this.signal); this.check();
        if (!supportedModel(config) || config.revision !== this.revision) fail('CONFIG_REQUIRED');
        if (!config.pricing) fail('MODEL_PRICING_REQUIRED');
        if (!probe && this.ledger.shouldCloseTools(this.runId)) closeTools();
        // Longer answers must not reduce the input space already available to evidence.
        if (!probe) payload[limitField] = Math.min(payload[limitField] as number,
          Math.max(1, MODEL_CONTEXT_WINDOW - estimatedInputTokens(payload)));
        const reserved = this.ledger.reserve(this.runId, config.pricing, selected, modelInputEnvelope(payload));
        let released = false;
        const timeout = AbortSignal.timeout(Math.max(1, reserved.timeoutMs)), signal = AbortSignal.any([this.signal, timeout]);
        try {
          if (probe) probePayload(reserved.inputReserved, selected);
          else checkModelPayload(payload, reserved.inputReserved, closing, selected);
          payload[limitField] = Math.min(payload[limitField] as number, reserved.outputLimit);
          const body = JSON.stringify(payload);
          // Includes internal confirmed-unsent DNS retries; every actual attempt rechecks revoked context.
          await this.beforeSend?.();
          this.check();
          this.ledger.sent(reserved.id, Buffer.byteLength(body), createHash('sha256').update(body).digest('hex'), payload[limitField] as number);
          let response: Response;
          try {
            const pending = this.transport(completionEndpoint(config), { method: 'POST', redirect: 'error', signal,
              headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` }, body });
            pending.then(value => { if (signal.aborted) void value.body?.cancel().catch(() => {}); }, () => {});
            response = await abortable(pending, signal);
          } catch (error) {
            if (definitelyUnsentDns(error, new URL(config.baseUrl).hostname)) { this.ledger.notSent(reserved.id); released = true; }
            throw error;
          }
          let lastPreview = '', pendingContent = '', publishedAt = 0;
          const publish = (force = false) => {
            if (!preview || signal.aborted || (!force && Date.now() - publishedAt < 100)) return;
            // Never forward a credential, including an unfinished prefix split across chunks.
            if (pendingContent.includes(config.apiKey)) fail();
            let safe = pendingContent;
            for (let n = Math.min(config.apiKey.length - 1, safe.length); n > 0; n--) {
              if (safe.endsWith(config.apiKey.slice(0, n))) { safe = safe.slice(0, -n); break; }
            }
            let next = answerPreview(safe);
            if (next.includes(config.apiKey)) fail();
            for (let n = Math.min(config.apiKey.length - 1, next.length); n > 0; n--) {
              if (next.endsWith(config.apiKey.slice(0, n))) { next = next.slice(0, -n); break; }
            }
            if (next !== lastPreview) { this.check(); preview(next); lastPreview = next; publishedAt = Date.now(); }
          };
          preview?.('');
          const result = await inspectResponse(response, signal, content => { pendingContent = content; publish(); });
          publish(true);
          this.ledger.settle(reserved.id, result.usage, result.returnedModel);
          if (payload.tool_choice === 'none' && result.calls.length) fail();
          this.check();
          if (result.body.includes(config.apiKey)) fail();
          return { ...result, attemptId: reserved.id, outputLimit: payload[limitField] as number };
        } catch (error) {
          const code = this.settings.view().revision !== this.revision ? 'CONTEXT_CHANGED' : this.signal.aborted ? 'RUN_INTERRUPTED' :
            timeout.aborted ? 'DEADLINE_EXCEEDED' : error instanceof ApiError ? error.publicError.code : 'MODEL_UNAVAILABLE';
          // Settled over-limit charges and already-unknown usage keep their recorded state.
          if (!released) this.ledger.abandon(this.runId, code);
          if (released && !signal.aborted) {
            this.ledger.retry(this.runId);
            await delay(250, undefined, { signal: this.signal });
            continue;
          }
          throw new ApiError(code);
        }
      }
    } finally { this.busy = false; }
  }
}
