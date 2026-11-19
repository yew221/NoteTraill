// Invoked by verify_pi.mjs inside a fresh, offline, file-restricted process.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOT, FIXTURE, MANIFEST, readJson, writeJson, readFixture } from './verify_pi.mjs';

const [phase, runDir] = process.argv.slice(2);
assert(['create', 'resume', 'boundaries'].includes(phase));
assert(process.permission?.has('fs.write', runDir), 'use the restricted verification launcher');
assert.equal(process.env.PI_OFFLINE, '1');
const result = { passed: false, checks: [], requests: [], events: [], toolReads: 0, modelAborts: 0, toolAborts: 0 };
const check = (name, condition) => { assert(condition, name); result.checks.push(name); };
const fixture = readJson(path.join(ROOT, MANIFEST)).files.find((f) => f.id === 'F06');
const cwd = path.join(runDir, 'cwd');
const sessions = new Set();

try {
  assert.throws(() => fs.readFileSync(path.join(runDir, '../not-allowed')), { code: 'ERR_ACCESS_DENIED' });
  assert.throws(() => fs.writeFileSync(path.join(runDir, '../not-allowed'), 'x'), { code: 'ERR_ACCESS_DENIED' });
  assert.throws(() => spawnSync(process.execPath, ['--version']), { code: 'ERR_ACCESS_DENIED' });
  const networkError = await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: 9 });
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('network guard probe timed out')); });
    socket.once('connect', () => { socket.destroy(); reject(new Error('network guard missing')); });
    socket.once('error', (error) => { socket.destroy(); resolve(error.code); });
  });
  check('进程限制拒绝网络、范围外文件和子进程', networkError === 'EPERM');

  const { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager } =
    await import('@earendil-works/pi-coding-agent');
  const { createAssistantMessageEventStream, InMemoryCredentialStore, getCurrentTools, getCurrentSystemPrompt } =
    await import('@earendil-works/pi-ai');
  let mode = 'read';
  let signalStarted;
  const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const credentials = new InMemoryCredentialStore();
  const runtime = await ModelRuntime.create({
    credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  });
  const streamSimple = (model, context, options) => {
    assert(result.requests.length < 16, 'unexpected model loop');
    const request = structuredClone({ mode, systemPrompt: getCurrentSystemPrompt(context.messages), messages: context.messages,
      tools: getCurrentTools(context.messages).map((t) => t.name) });
    result.requests.push(request);
    const stream = createAssistantMessageEventStream();
    const message = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { ...zeroCost, totalTokens: 0, cost: { ...zeroCost, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
    const emit = (event) => stream.push(structuredClone(event));
    // The stream buffers events until the real SDK consumes them.
    {
      emit({ type: 'start', partial: message });
      if (mode === 'cancel-model') {
        const abort = () => {
          result.modelAborts++;
          message.stopReason = 'aborted';
          message.errorMessage = 'offline test cancelled';
          emit({ type: 'error', reason: 'aborted', error: message });
          stream.end();
        };
        if (options.signal.aborted) abort();
        else options.signal.addEventListener('abort', abort, { once: true });
        signalStarted?.();
        return stream;
      }
      const last = context.messages.at(-1);
      if (last?.role === 'user' && mode !== 'followup') {
        const tool = { type: 'toolCall', id: `fixture-${result.requests.length}`, name: mode === 'unknown-tool' ? 'bash' : 'read_fixture',
          arguments: { id: mode === 'invalid-id' ? '../private' : 'F06' } };
        message.content = [tool];
        message.stopReason = 'toolUse';
        emit({ type: 'toolcall_start', contentIndex: 0, partial: message });
        emit({ type: 'toolcall_end', contentIndex: 0, toolCall: tool, partial: message });
      } else {
        const evidence = context.messages.findLast((m) => m.role === 'toolResult' && !m.isError);
        const text = ['invalid-id', 'unknown-tool'].includes(mode) ? '工具请求已被拒绝。' :
          evidence?.content.find((c) => c.type === 'text')?.text.split('\n').find((line) => line.includes(mode === 'followup' ? '09:12' : '09:10'));
        // shortcut: deterministic extraction tests plumbing only; real model quality is a later T01 check.
        assert(text, 'test model did not receive the required tool evidence');
        message.content = [{ type: 'text', text: '' }];
        emit({ type: 'text_start', contentIndex: 0, partial: message });
        for (const chunk of [text.slice(0, 8), text.slice(8)]) {
          message.content[0].text += chunk;
          emit({ type: 'text_delta', contentIndex: 0, delta: chunk, partial: message });
        }
        emit({ type: 'text_end', contentIndex: 0, content: text, partial: message });
      }
      emit({ type: 'done', reason: message.stopReason, message });
      stream.end();
    }
    return stream;
  };
  runtime.registerProvider('notetrail-offline', {
    api: 'openai-completions', apiKey: 'offline-placeholder-not-a-credential', baseUrl: 'https://offline.invalid', streamSimple,
    models: [{ id: 'fixture', name: 'Deterministic offline fixture', input: ['text'], reasoning: false,
      cost: zeroCost, contextWindow: 32_000, maxTokens: 4096 }],
  });
  const model = runtime.getModel('notetrail-offline', 'fixture');
  assert(model);
  const resources = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => 'NoteTrail offline SDK verification. Read only the declared public fixture.',
    getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => {}, reload: async () => {},
  };
  async function openSession(manager) {
    const { session } = await createAgentSession({ cwd, agentDir: path.join(runDir, 'agent'), model, modelRuntime: runtime,
      resourceLoader: resources, sessionManager: manager, thinkingLevel: 'off', tools: ['read_fixture'],
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' }),
      customTools: [{ name: 'read_fixture', label: 'Read public fixture', description: 'Read public fixture F06 only.',
        parameters: { type: 'object', properties: { id: { type: 'string', const: 'F06' } }, required: ['id'], additionalProperties: false },
        execute: async (_toolCallId, args, signal) => {
          assert.equal(args.id, 'F06');
          if (mode === 'cancel-tool') {
            signalStarted?.();
            try { await delay(60_000, undefined, { signal }); }
            catch (error) { if (signal.aborted) result.toolAborts++; throw error; }
          }
          signal?.throwIfAborted();
          const text = readFixture(path.join(ROOT, FIXTURE), fixture);
          result.toolReads++;
          return { content: [{ type: 'text', text }], details: { id: 'F06', sha256: fixture.sha256 } };
        } }],
    });
    sessions.add(session);
    assert.deepEqual(session.getActiveToolNames(), ['read_fixture']);
    assert.deepEqual(session.getCallableToolNames(), ['read_fixture']);
    assert(!session.systemPrompt.includes('NOTETRAIL_UNEXPECTED_RESOURCE'));
    session.subscribe((event) => result.events.push({ type: event.type, toolName: event.toolName,
      isError: event.isError, role: event.message?.role, stopReason: event.message?.stopReason,
      delta: event.assistantMessageEvent?.type === 'text_delta' ? event.assistantMessageEvent.delta : undefined }));
    return session;
  }
  async function ask(session, text) {
    const settledBefore = result.events.filter((e) => e.type === 'agent_settled').length;
    await session.prompt(text, { expandPromptTemplates: false });
    await session.waitForIdle();
    assert(session.isIdle && !session.isStreaming);
    assert.equal(result.events.filter((e) => e.type === 'agent_settled').length, settledBefore + 1);
  }
  if (phase === 'create') {
    const session = await openSession(SessionManager.create(cwd, path.join(runDir, 'sessions')));
    check('启动时只启用受控工具，未加载配置诱饵', true);
    await ask(session, '蓝色工具箱放在哪里？');
    const toolMessage = session.messages.find((m) => m.role === 'toolResult');
    check('真实文件经工具返回，位置和内容指纹保留', result.toolReads === 1 && toolMessage?.details?.sha256 === fixture.sha256
      && session.getLastAssistantText()?.includes('北柜第二层'));
    check('工具循环和文本流式事件完成', result.requests.length === 2
      && result.events.some((e) => e.type === 'tool_execution_end' && !e.isError)
      && result.events.filter((e) => e.delta).map((e) => e.delta).join('') === session.getLastAssistantText());
    const sessionFile = session.sessionFile;
    const messages = structuredClone(session.messages);
    session.dispose(); sessions.delete(session);
    assert(fs.existsSync(sessionFile));
    writeJson(path.join(runDir, 'saved.json'), { sessionFile: path.relative(runDir, sessionFile), messages });
    check('使用 Pi 原生会话格式保存到指定目录', path.dirname(sessionFile) === path.join(runDir, 'sessions'));
  } else if (phase === 'resume') {
    const saved = readJson(path.join(runDir, 'saved.json'));
    const sessionFile = path.resolve(runDir, saved.sessionFile);
    assert.equal(path.dirname(sessionFile), path.join(runDir, 'sessions'));
    assert.equal(fs.realpathSync(sessionFile), sessionFile);
    const session = await openSession(SessionManager.open(sessionFile, path.join(runDir, 'sessions')));
    assert.deepEqual(session.messages, saved.messages);
    check('新进程通过原生 SessionManager 完整恢复历史', true);
    mode = 'followup';
    await ask(session, '交接的时间要求是什么？');
    check('恢复后的追问收到前轮真实工具依据', result.toolReads === 0 && result.requests.length === 1
      && result.requests[0].messages.some((m) => m.role === 'toolResult' && m.details?.sha256 === fixture.sha256)
      && session.getLastAssistantText()?.includes('周五 15:00'));
  } else {
    for (const negative of ['invalid-id', 'unknown-tool']) {
      mode = negative;
      const session = await openSession(SessionManager.inMemory(cwd));
      await ask(session, '执行边界测试。');
      check(negative === 'invalid-id' ? '越界资料 ID 被拒绝，未读取文件' : '未授权 bash 工具调用被拒绝',
        result.toolReads === 0 && session.messages.some((m) => m.role === 'toolResult' && m.isError
          && m.toolName === (negative === 'invalid-id' ? 'read_fixture' : 'bash')));
      session.dispose(); sessions.delete(session);
    }
    for (const cancellation of ['cancel-model', 'cancel-tool']) {
      mode = cancellation;
      const session = await openSession(SessionManager.inMemory(cwd));
      const readsAtStart = result.toolReads;
      const requestsAtStart = result.requests.length;
      const started = new Promise((resolve) => { signalStarted = resolve; });
      const pending = ask(session, '执行取消测试。');
      await Promise.race([started, pending.then(() => { throw new Error('run ended before cancellation point'); })]);
      await session.abort();
      await pending;
      const requestCount = result.requests.length;
      const eventCount = result.events.length;
      await delay(30);
      check(cancellation === 'cancel-model' ? '模型流收到取消，停止并进入空闲' : '工具收到取消，未发布成功读取',
        session.isIdle && result.toolReads === readsAtStart && result.requests.length === requestCount && result.events.length === eventCount
        && requestCount === requestsAtStart + 1
        && (cancellation === 'cancel-model' ? result.modelAborts === 1 : result.toolAborts === 1));
      mode = 'read'; signalStarted = undefined;
      const readsBefore = result.toolReads;
      await ask(session, '取消后重新读取蓝色工具箱位置。');
      assert.equal(result.toolReads, readsBefore + 1);
      assert(session.getLastAssistantText()?.includes('北柜第二层'));
      session.dispose(); sessions.delete(session);
    }
    check('两种取消后均可重新提问', true);
  }
  check('实际模型上下文未混入配置诱饵或其他工具', result.requests.every((r) =>
    !JSON.stringify(r).includes('NOTETRAIL_UNEXPECTED_RESOURCE') && JSON.stringify(r.tools) === '["read_fixture"]'));
  assert.deepEqual(await credentials.list(), []);
  result.passed = true;
} catch (error) {
  result.error = `${error.name}: ${error.message}`;
  process.exitCode = 1;
} finally {
  for (const session of sessions) session.dispose();
  writeJson(path.join(runDir, `${phase}.json`), result);
}
