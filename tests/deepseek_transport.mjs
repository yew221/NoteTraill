// Synthetic HTTP/SSE responses exercise the installed Pi provider, with no network.
export function syntheticFetch(input, init, { alwaysTool = false, toolId = 'fixture-read', omitUsage = false,
  inputTokens = 240, outputTokens = 40 } = {}) {
  const body = JSON.parse(init.body);
  const hasResult = !alwaysTool && body.messages.at(-1).role === 'tool';
  const thinking = body.thinking.type === 'enabled';
  const chunk = (delta, finish_reason = null) => ({ id: 'synthetic-request', object: 'chat.completion.chunk',
    created: 1, model: 'deepseek-flash-SYNTHETIC', choices: [{ index: 0, delta, finish_reason }] });
  const chunks = [];
  if (thinking) chunks.push(chunk({ reasoning_content: '合成协议测试占位。' }));
  if (hasResult) {
    chunks.push(chunk({ content: '蓝色工具箱在北柜' }), chunk({ content: '第二层。[F06]' }, 'stop'));
  } else {
    chunks.push(chunk({ tool_calls: [{ index: 0, id: toolId, type: 'function',
      function: { name: 'read_fixture', arguments: '{"id":' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"F06"}' } }] }, 'tool_calls'));
  }
  if (!omitUsage) chunks.push({ ...chunk({}), choices: [], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: inputTokens - 40,
    completion_tokens_details: { reasoning_tokens: thinking ? 10 : 0 } } });
  const bytes = new TextEncoder().encode(chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n');
  return new Response(new ReadableStream({ start(controller) {
    // Deliberately split both UTF-8 characters and SSE lines across chunks.
    for (let i = 0; i < bytes.length; i += 17) controller.enqueue(bytes.slice(i, i + 17));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
