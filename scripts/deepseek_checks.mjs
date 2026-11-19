// T01-D verification limits, not the product's billing or provider service.
import assert from 'node:assert/strict';

export const ENDPOINT = 'https://api.deepseek.com/chat/completions';
export const MODEL = 'deepseek-flash';
export const KEYCHAIN = ['-s', 'com.notetrail.t01.deepseek', '-a', 'api.deepseek.com'];
export const LIMITS = Object.freeze({ requestsPerQuestion: 2, maxOutput: 4096, inputAllowance: 32_000,
  payloadBytes: 8192, responseBytes: 2 * 1024 * 1024, requestMs: 60_000, questionMs: 120_000,
  batchReserveMicroYuan: 387_072, pauseMicroYuan: 8_000_000 });
// Official peak rates checked 2026-11-12: input miss ¥2/M, output ¥8/M.
// Charge all input at the miss rate here: a conservative estimate, not the provider's bill.
export function usageCost(usage) {
  assert(usage && ['prompt_tokens', 'completion_tokens', 'total_tokens'].every(
    (key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0), 'missing or invalid usage');
  assert(usage.prompt_tokens > 0 && usage.completion_tokens > 0, 'missing usage');
  assert(usage.total_tokens === usage.prompt_tokens + usage.completion_tokens, 'inconsistent usage');
  assert(usage.prompt_tokens <= LIMITS.inputAllowance && usage.completion_tokens <= LIMITS.maxOutput, 'token limit exceeded');
  return usage.prompt_tokens * 2 + usage.completion_tokens * 8;
}

export function checkResponse(record, message) {
  const usage = message.usage;
  assert(record.status === 200 && record.returnedModel && record.usage, 'response or usage missing');
  usageCost(record.usage);
  assert(usage.input + usage.cacheRead + usage.cacheWrite === record.usage.prompt_tokens
    && usage.output === record.usage.completion_tokens && usage.totalTokens === record.usage.total_tokens,
  'SDK usage mismatch');
  assert(['stop', 'toolUse'].includes(message.stopReason), 'response did not complete');
}

export function checkPayload(payload, mode, previousReasoning, { maxOutput = LIMITS.maxOutput, maxMessages = 8 } = {}) {
  assert(Number.isInteger(maxOutput) && maxOutput > 0 && maxOutput <= LIMITS.maxOutput, 'invalid output bound');
  assert(Number.isInteger(maxMessages) && maxMessages > 0 && maxMessages <= 16, 'invalid history bound');
  assert(payload.model === MODEL && payload.stream === true, 'unexpected model or transport');
  // The installed provider may lower max_tokens to fit its remaining context window.
  assert(Number.isInteger(payload.max_tokens) && payload.max_tokens > 0 && payload.max_tokens <= maxOutput
    && payload.stream_options?.include_usage === true, 'missing output or usage limit');
  assert(payload.thinking?.type === (mode === 'off' ? 'disabled' : 'enabled'), 'thinking mode mismatch');
  if (mode === 'low') assert(payload.reasoning_effort === 'low', 'reasoning effort mismatch');
  assert(payload.tools?.length === 1 && payload.tools[0].function.name === 'read_fixture', 'unexpected tools');
  assert(Array.isArray(payload.messages) && payload.messages.length <= maxMessages, 'unexpected history');
  // shortcut: a small fixed UTF-8 payload envelope, not an exact DeepSeek tokenizer.
  // Check returned token usage too; general user inputs need a separately verified token estimator.
  assert(Buffer.byteLength(JSON.stringify(payload)) <= LIMITS.payloadBytes, 'payload byte limit exceeded');
  if (previousReasoning !== undefined) {
    const assistant = payload.messages.findLast((message) => message.role === 'assistant');
    assert(assistant?.reasoning_content === previousReasoning, 'reasoning replay mismatch');
    assert(assistant.tool_calls?.length === 1 && payload.messages.at(-1)?.role === 'tool', 'tool round trip missing');
    assert(assistant.tool_calls[0].id === payload.messages.at(-1).tool_call_id, 'tool result ID mismatch');
  }
}

export function guardedFetch(transport, record, signal) {
  return async (input, init) => {
    assert(String(input) === ENDPOINT && init?.method === 'POST', 'endpoint rejected');
    assert(!record.sent, 'automatic retry rejected');
    record.sent = true;
    const response = await transport(input, { ...init, redirect: 'error',
      signal: AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]) });
    record.status = response.status;
    if (!response.ok) return response;
    assert(response.body, 'empty response');
    const decoder = new TextDecoder();
    let pending = '';
    let bytes = 0;
    const inspect = (line) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      const chunk = JSON.parse(data);
      if (typeof chunk.model === 'string') {
        assert(!record.returnedModel || record.returnedModel === chunk.model, 'model changed within response');
        record.returnedModel = chunk.model;
      }
      if (chunk.usage) {
        assert(!record.usage, 'duplicate usage');
        record.costUpperMicroYuan = usageCost(chunk.usage);
        record.usage = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens',
          'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens'].filter((key) => Number.isSafeInteger(chunk.usage[key]))
          .map((key) => [key, chunk.usage[key]]));
      }
    };
    return new Response(response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        assert(bytes <= LIMITS.responseBytes, 'response byte limit exceeded');
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const line of lines) inspect(line);
        controller.enqueue(chunk);
      },
      flush() { inspect(pending + decoder.decode()); },
    })), { status: response.status, headers: response.headers });
  };
}
