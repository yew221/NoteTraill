// T01-F only. SDK automatic retry is disabled; this wrapper owns the single retry budget.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { streamSimple as providerStream } from '@earendil-works/pi-ai/api/openai-completions';
import { checkPayload, checkResponse, guardedFetch } from './deepseek_checks.mjs';
import { BudgetStop, definitelyUnsentDns } from './model_budget.mjs';

function failedMessage(model, code) {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [],
    usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } },
    stopReason: code === 'cancelled' ? 'aborted' : 'error', errorMessage: code, timestamp: Date.now() };
}

export function budgetedStream(budget, transport, records, { wait = (ms, signal) => delay(ms, undefined, { signal }), retryDelayMs = 250 } = {}) {
  assert(Number.isInteger(retryDelayMs) && retryDelayMs >= 0 && retryDelayMs <= 1000);
  return (model, context, options) => {
    const output = createAssistantMessageEventStream();
    (async () => {
      try {
        for (;;) {
          if (options.signal?.aborted) budget.stop('cancelled');
          const attempt = budget.begin();
          const record = { attempt: attempt.number, sent: false, textDeltas: 0, thinkingDeltas: 0 };
          records.push(record);
          const timeout = AbortSignal.timeout(Math.max(1, Math.floor(attempt.timeoutMs)));
          const signal = AbortSignal.any([timeout, ...(options.signal ? [options.signal] : [])]);
          let preSendDns = false;
          const transportWithEvidence = async (input, init) => {
            try { return await transport(input, init); }
            catch (error) { preSendDns = definitelyUnsentDns(error); throw error; }
          };
          const previous = context.messages.findLast((message) => message.role === 'assistant');
          const previousReasoning = previous?.content.some((c) => c.type === 'toolCall')
            ? previous.content.filter((c) => c.type === 'thinking').map((c) => c.thinking).join('\n') : undefined;
          const inner = providerStream(model, context, { ...options, maxTokens: attempt.outputLimit,
            maxRetries: 0, timeoutMs: attempt.timeoutMs, signal, cacheRetention: 'none', env: {},
            fetch: guardedFetch(transportWithEvidence, record, signal),
            onPayload(payload) {
              checkPayload(payload, !options.reasoning || options.reasoning === 'off' ? 'off' : 'low', previousReasoning,
                { maxOutput: attempt.outputLimit, maxMessages: 16 });
              record.payloadBytes = Buffer.byteLength(JSON.stringify(payload));
              record.outputLimit = payload.max_tokens;
              record.reasoningReplayed = previousReasoning !== undefined;
            },
          });
          let terminal;
          const toolEvents = [];
          for await (const event of inner) {
            if (event.type === 'done' || event.type === 'error') { terminal = event; continue; }
            if (event.type === 'text_delta') record.textDeltas++;
            if (event.type === 'thinking_delta') record.thinkingDeltas++;
            // Do not expose executable tool events until the response and its usage are verified.
            if (event.type.startsWith('toolcall_')) toolEvents.push(event);
            else output.push(event);
          }
          if (preSendDns) {
            budget.notSent(attempt);
            record.failure = 'dns_before_send';
            if (options.signal?.aborted || timeout.aborted) budget.stop(options.signal?.aborted ? 'cancelled' : 'request_timeout');
            budget.planRetry(retryDelayMs);
            try { await wait(retryDelayMs, options.signal); }
            catch { budget.stop('cancelled'); }
            continue;
          }
          if (!record.sent) {
            budget.notSent(attempt);
            budget.stop(options.signal?.aborted ? 'cancelled' : 'invalid_payload');
          }
          const message = terminal?.message ?? terminal?.error;
          try {
            checkResponse(record, message);
            assert(record.usage.completion_tokens <= record.outputLimit, 'response exceeds the actual request output limit');
          }
          catch {
            const code = options.signal?.aborted ? 'cancelled' : timeout.aborted ? 'request_timeout'
              : record.status && record.status !== 200 ? `http_${record.status}` : 'usage_unknown';
            record.failure = code;
            budget.unknown(attempt, code);
          }
          budget.settle(attempt, record.usage);
          for (const event of toolEvents) output.push(event);
          output.push(terminal);
          output.end();
          return;
        }
      } catch (error) {
        const code = error instanceof BudgetStop ? error.code : 'verification_internal_error';
        if (budget.pending) {
          try { budget.unknown(budget.pending, code); } catch { /* preserve the held reservation */ }
        } else if (!budget.stopped) {
          try { budget.stop(code); } catch { /* publish a sanitized terminal event below */ }
        }
        const message = failedMessage(model, code);
        output.push({ type: 'error', reason: message.stopReason, error: message });
        output.end();
      }
    })();
    return output;
  };
}
