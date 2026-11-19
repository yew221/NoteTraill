// T01-C verification helpers, not the product's dependency registry or invalidation service.
import assert from 'node:assert/strict';

export function extractTestSchedule(text) {
  return text.match(/例行巡检安排在每周[一二三四五六日天]\s+\d{2}:\d{2}。/)?.[0];
}

export function contextDecision(previous, current) {
  if (previous?.complete !== true || current?.complete !== true ||
      !Array.isArray(previous.sources) || !Array.isArray(current.sources) ||
      ![previous.scopeRevision, current.scopeRevision, previous.memoryGeneration, current.memoryGeneration]
        .every((n) => Number.isInteger(n) && n >= 0)) {
    return { rebuild: true, reasons: ['unknown_dependencies'] };
  }
  const reasons = [];
  if (previous.scopeRevision !== current.scopeRevision) reasons.push('scope_changed');
  if (previous.memoryGeneration !== current.memoryGeneration) reasons.push('memory_changed');
  for (const dependency of previous.sources) {
    const source = current.sources.find((s) => s.id === dependency.id);
    if (!source || !['ready', 'partial'].includes(source.status)) reasons.push('source_unavailable');
    else if (!dependency.version || dependency.version !== source.version) reasons.push('source_version_changed');
  }
  return { rebuild: reasons.length > 0, reasons: [...new Set(reasons)] };
}

export function assertContext(request, forbidden, required = []) {
  const text = JSON.stringify(request);
  for (const value of forbidden) assert(!text.includes(value), `stale context: ${value}`);
  for (const value of required) assert(text.includes(value), `missing current context: ${value}`);
}

export function assertToolPairs(messages) {
  const pending = new Map();
  const seen = new Set();
  for (const message of messages) {
    if (message.role === 'assistant' || message.role === 'user') {
      assert.equal(pending.size, 0, 'tool result missing before next message');
    }
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type !== 'toolCall') continue;
        assert(!seen.has(block.id), 'duplicate tool call ID');
        seen.add(block.id);
        pending.set(block.id, block.name);
      }
    }
    if (message.role === 'toolResult') {
      assert(pending.has(message.toolCallId), 'orphan tool result');
      assert.equal(pending.get(message.toolCallId), message.toolName, 'tool name mismatch');
      pending.delete(message.toolCallId);
    }
  }
  assert.equal(pending.size, 0, 'unresolved tool calls');
}
