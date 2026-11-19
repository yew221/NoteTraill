// Run only through verify_pi_context.mjs. All mutated documents are disposable public-fixture copies.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, MANIFEST, hash, readJson, writeJson, readFixture } from './verify_pi.mjs';
import { contextDecision, assertContext, assertToolPairs, extractTestSchedule } from './context_checks.mjs';

const [phase, runDir] = process.argv.slice(2);
const config = readJson(path.join(ROOT, 'tests/pi_context_cases.json'));
assert(['seed', 'summary-failure', ...config.cases.map((c) => c.id)].includes(phase));
assert(process.permission?.has('fs.write', runDir), 'use the restricted launcher');
assert.equal(process.env.PI_OFFLINE, '1');
const base = path.join(runDir, phase);
const activeFile = path.join(base, 'schedule.md');
const manifest = readJson(path.join(ROOT, MANIFEST));
const oldRecord = manifest.files.find((f) => f.id === config.oldFixture);
const newRecord = manifest.files.find((f) => f.id === config.newFixture);
const result = { passed: false, checks: [], requests: [], events: [], toolReads: 0, toolDenials: 0 };
const check = (label, condition) => { assert(condition, label); result.checks.push(label); };
const liveSessions = new Set();

try {
  assert.throws(() => fs.readFileSync(path.join(runDir, '../not-allowed')), { code: 'ERR_ACCESS_DENIED' });
  assert.throws(() => spawnSync(process.execPath, ['--version']), { code: 'ERR_ACCESS_DENIED' });
  const deniedNetwork = await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: 9 });
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('network check timed out')); });
    socket.once('connect', () => { socket.destroy(); reject(new Error('network not blocked')); });
    socket.once('error', (error) => { socket.destroy(); resolve(error.code === 'EPERM'); });
  });
  check('离线与文件/子进程边界生效', deniedNetwork);
  const { createAgentSession, createExtensionRuntime, ModelRuntime, SettingsManager, SessionManager } =
    await import('@earendil-works/pi-coding-agent');
  const { InMemoryCredentialStore, createAssistantMessageEventStream, getCurrentTools, getCurrentSystemPrompt } =
    await import('@earendil-works/pi-ai');
  const oldText = readFixture(path.join(ROOT, 'tests/fixtures/public/t00', oldRecord.path), oldRecord);
  fs.writeFileSync(activeFile, oldText, { flag: 'wx' });
  fs.writeFileSync(path.join(base, 'derived.md'), oldText, { flag: 'wx' });
  let mode = 'old';
  let scopeRevision = 1;
  let memoryGeneration = 1;
  let memories = [config.keepMemory, config.removeMemory];
  const sessionsDir = path.join(base, 'sessions');
  fs.mkdirSync(sessionsDir);

  function snapshot() {
    const exists = fs.existsSync(activeFile);
    const status = scopeRevision === 2 ? 'excluded' : exists ? 'ready' : 'missing';
    return { complete: true, scopeRevision, memoryGeneration, sources: [{ id: config.sourceId,
      version: status === 'ready' ? `sha256:${hash(fs.readFileSync(activeFile))}` : null, status }] };
  }
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false });
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  runtime.registerProvider('notetrail-offline', {
    api: 'openai-completions', apiKey: 'offline-placeholder-not-a-credential', baseUrl: 'https://offline.invalid',
    models: [{ id: 'context-fixture', name: 'Offline context fixture', input: ['text'], reasoning: false,
      cost, contextWindow: 32_000, maxTokens: 4096 }],
    streamSimple: (model, context) => {
      assert(result.requests.length < 16, 'unexpected model loop');
      const request = structuredClone({ mode, messages: context.messages,
        systemPrompt: getCurrentSystemPrompt(context.messages), tools: getCurrentTools(context.messages).map((t) => t.name) });
      assertToolPairs(request.messages);
      result.requests.push(request);
      const stream = createAssistantMessageEventStream();
      const message = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { ...cost, totalTokens: 0, cost: { ...cost, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
      const emit = (e) => stream.push(structuredClone(e));
      emit({ type: 'start', partial: message });
      if (mode === 'fail-summary') {
        message.stopReason = 'error'; message.errorMessage = 'T01C injected summary failure';
        emit({ type: 'error', reason: 'error', error: message }); stream.end(); return stream;
      }
      const last = context.messages.at(-1);
      let text;
      if (mode === 'summary') {
        // shortcut: copy facts seen by the real summary request; real summarization quality requires DeepSeek testing.
        const serialized = JSON.stringify(context.messages);
        const fact = extractTestSchedule(serialized) ?? '继续围绕例行巡检主题。';
        const preference = serialized.includes(config.removedMemoryMarker) ? config.removeMemory : '';
        text = `${config.summaryMarker}\n${fact}\n${preference}`;
      } else if (mode === 'control') text = '对照请求已记录；不把本地固定回复作为问答质量证据。';
      else if (mode === 'padding') text = '保留例行巡检这个主题。';
      else if (last?.role === 'user') {
        const call = { type: 'toolCall', id: `read-${result.requests.length}`, name: 'read_schedule', arguments: { id: config.sourceId } };
        message.content = [call]; message.stopReason = 'toolUse';
        emit({ type: 'toolcall_start', contentIndex: 0, partial: message });
        emit({ type: 'toolcall_end', contentIndex: 0, toolCall: call, partial: message });
      } else {
        assert.equal(last?.role, 'toolResult');
        const fact = extractTestSchedule(last.content.find((c) => c.type === 'text')?.text ?? '');
        assert(last.isError || fact, 'no actual tool evidence');
        text = last.isError ? config.noEvidenceAnswer :
          `${mode === 'old' ? `${config.oldAnswerMarker} ` : ''}${request.systemPrompt.includes(config.removedMemoryMarker) ? `${config.removedMemoryMarker}，` : ''}${fact}`;
      }
      if (text !== undefined) {
        message.content = [{ type: 'text', text: '' }];
        emit({ type: 'text_start', contentIndex: 0, partial: message });
        message.content[0].text = text;
        emit({ type: 'text_delta', contentIndex: 0, delta: text, partial: message });
        emit({ type: 'text_end', contentIndex: 0, content: text, partial: message });
      }
      emit({ type: 'done', reason: message.stopReason, message }); stream.end(); return stream;
    },
  });
  const model = runtime.getModel('notetrail-offline', 'context-fixture');
  async function open(manager) {
    const { session } = await createAgentSession({ cwd: base, agentDir: path.join(base, 'agent'), model,
      modelRuntime: runtime, thinkingLevel: 'off', sessionManager: manager, tools: ['read_schedule'],
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 512 },
        retry: { enabled: false }, cacheWarming: 'off' }),
      resourceLoader: {
        getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
        getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => `NoteTrail offline context test. Scenario date: ${config.asOf}.\n当前有效偏好：\n${memories.join('\n')}`,
        getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
        extendResources: () => {}, reload: async () => {},
      },
      customTools: [{ name: 'read_schedule', label: 'Read current schedule', description: 'Read only the current allowed schedule.',
        parameters: { type: 'object', properties: { id: { type: 'string', const: config.sourceId } }, required: ['id'], additionalProperties: false },
        execute: async (_id, args, signal) => {
          assert.equal(args.id, config.sourceId); signal?.throwIfAborted();
          const before = snapshot().sources[0];
          if (before.status !== 'ready') { result.toolDenials++; throw new Error(`SOURCE_${before.status.toUpperCase()}`); }
          const record = phase === 'changed' ? newRecord : oldRecord;
          const text = readFixture(activeFile, record);
          assert.equal(snapshot().sources[0].version, before.version, 'source changed during read');
          result.toolReads++;
          return { content: [{ type: 'text', text }], details: { sourceId: config.sourceId, sourceVersion: before.version } };
        } }],
    });
    liveSessions.add(session);
    assert.deepEqual(session.getActiveToolNames(), ['read_schedule']);
    assert.deepEqual(session.getCallableToolNames(), ['read_schedule']);
    session.subscribe((event) => result.events.push({ mode, type: event.type, errorMessage: event.errorMessage,
      aborted: event.aborted, toolName: event.toolName, isError: event.isError }));
    return session;
  }
  const close = (session) => { session.dispose(); liveSessions.delete(session); };
  async function ask(session, text) {
    await session.prompt(text, { expandPromptTemplates: false }); await session.waitForIdle();
    assert(session.isIdle && !session.isStreaming);
    assert(session.messages.at(-1)?.stopReason === 'stop', 'prompt failed');
  }

  if (phase === 'seed' || phase === 'summary-failure') {
    const session = await open(SessionManager.create(base, sessionsDir));
    await ask(session, config.question);
    assert(session.getLastAssistantText().includes(config.oldFact));
    mode = 'padding';
    await ask(session, '请保留这个问题的主题，稍后继续。');
    // Compare the JSONL representation: JSON omits optional fields whose value is undefined.
    const originalMessages = JSON.parse(JSON.stringify(session.messages));
    const beforeHash = hash(fs.readFileSync(session.sessionFile));
    if (phase === 'summary-failure') {
      mode = 'fail-summary';
      const requestsBefore = result.requests.length;
      await assert.rejects(session.compact(), /T01C injected summary failure/);
      assert.deepEqual(JSON.parse(JSON.stringify(session.messages)), originalMessages);
      assert.equal(session.sessionManager.getEntries().filter((e) => e.type === 'compaction').length, 0);
      check('压缩失败明确报错，没有写入成功摘要或自动续跑', result.requests.length === requestsBefore + 1
        && result.events.some((e) => e.type === 'compaction_end' && e.errorMessage));
      const file = session.sessionFile; close(session);
      const restored = await open(SessionManager.open(file, sessionsDir));
      assert.deepEqual(JSON.parse(JSON.stringify(restored.messages)), originalMessages);
      check('失败前的原始历史可恢复且文件未改写', hash(fs.readFileSync(file)) === beforeHash);
    } else {
      mode = 'summary';
      const compacted = await session.compact();
      const entry = session.sessionManager.getEntries().find((e) => e.type === 'compaction');
      check('通过真实compact调用生成原生摘要条目', entry && !entry.fromHook && compacted.summary === entry.summary
        && result.requests.some((r) => r.mode === 'summary' && JSON.stringify(r).includes(config.oldFact)));
      check('旧资料事实和待撤销偏好确实进入摘要', compacted.summary.includes(config.oldFact)
        && compacted.summary.includes(config.removedMemoryMarker));
      check('旧工具正文和旧回答已退出当前投影，摘要仍含旧事实',
        !session.messages.some((m) => m.role === 'toolResult') && !JSON.stringify(session.messages).includes(config.oldAnswerMarker));
      result.compaction = compacted;
      const saved = { sessionFile: path.relative(runDir, session.sessionFile), sessionId: session.sessionId,
        stamp: snapshot(), summary: compacted.summary };
      close(session);
      saved.sha256 = hash(fs.readFileSync(path.join(runDir, saved.sessionFile)));
      writeJson(path.join(runDir, 'seed-state.json'), saved);
      check('压缩后的JSONL保留原始工具正文和旧回答', fs.readFileSync(path.join(runDir, saved.sessionFile), 'utf8').includes(config.oldAnswerMarker));
    }
  } else {
    const scenario = config.cases.find((c) => c.id === phase);
    const saved = readJson(path.join(runDir, 'seed-state.json'));
    const seedFile = path.resolve(runDir, saved.sessionFile);
    assert(seedFile.startsWith(`${path.join(runDir, 'seed/sessions')}${path.sep}`));
    assert.equal(hash(fs.readFileSync(seedFile)), saved.sha256);
    if (phase === 'changed') {
      fs.writeFileSync(activeFile, readFixture(path.join(ROOT, 'tests/fixtures/public/t00', newRecord.path), newRecord));
    } else if (phase === 'missing') fs.unlinkSync(activeFile);
    else if (phase === 'excluded') scopeRevision = 2;
    else { memoryGeneration = 2; memories = [config.keepMemory]; }
    const current = snapshot();
    const decision = contextDecision(saved.stamp, current);
    result.transition = { previous: saved.stamp, current, decision, staleDerivedCopyExists: fs.existsSync(path.join(base, 'derived.md')) };
    check('从当前来源版本/状态和修订号发现失效', decision.rebuild && decision.reasons.includes(scenario.reason));

    const controlDir = path.join(base, 'control'); fs.mkdirSync(controlDir);
    const controlFile = path.join(controlDir, 'history.jsonl'); fs.copyFileSync(seedFile, controlFile);
    mode = 'control';
    const control = await open(SessionManager.open(controlFile, controlDir));
    await ask(control, config.followup); close(control);
    const controlRequest = result.requests.find((r) => r.mode === 'control');
    check('对照：直接续用确实把旧摘要带入下一次请求', JSON.stringify(controlRequest).includes(config.summaryMarker)
      && JSON.stringify(controlRequest).includes(config.oldFact)
      && JSON.stringify(controlRequest).includes(config.removedMemoryMarker)
      && !controlRequest.messages.some((m) => m.role === 'toolResult')
      && !JSON.stringify(controlRequest).includes(config.oldAnswerMarker));
    result.summaryTransportRoles = controlRequest.messages.filter((m) => JSON.stringify(m).includes(config.summaryMarker)).map((m) => m.role);

    const forbidden = [config.summaryMarker, config.oldAnswerMarker];
    if (phase === 'memory-removed') forbidden.push(config.removedMemoryMarker);
    else forbidden.push(config.oldFact, oldRecord.sha256);
    const required = [config.question, config.keepMemory];
    const manager = decision.rebuild ? SessionManager.create(base, sessionsDir) : SessionManager.open(controlFile, controlDir);
    if (decision.rebuild) {
      // Only the canonical UI question is retained. Never filter Pi messages by role: summaries can be user messages too.
      manager.appendMessage({ role: 'user', content: config.question, timestamp: Date.now() });
    }
    mode = 'rebuilt';
    const rebuilt = await open(manager);
    assert.notEqual(rebuilt.sessionId, saved.sessionId);
    await ask(rebuilt, config.followup);
    const answer = rebuilt.getLastAssistantText();
    check('新会话段重新读取当前依据或明确拒绝不可用来源', scenario.expectedFact ? answer.includes(scenario.expectedFact) : answer === config.noEvidenceAnswer);
    const newFile = rebuilt.sessionFile; close(rebuilt);
    const expectedReads = scenario.expectedFact ? 1 : 0;
    assert.equal(result.toolReads, expectedReads);

    mode = 'resumed';
    const resumed = await open(SessionManager.open(newFile, sessionsDir));
    await ask(resumed, config.followup); close(resumed);
    const safeRequests = result.requests.filter((r) => ['rebuilt', 'resumed'].includes(r.mode));
    assert.equal(safeRequests.length, 4);
    for (const request of safeRequests) { assertContext(request, forbidden, required); assertToolPairs(request.messages); }
    check('重建及重开后的全部请求均无失效摘要/正文/结论', true);
    if (phase === 'memory-removed') check('被删偏好不回流，当前有效偏好仍保留', true);
    else check('旧摘要无法靠重开会话重新进入模型', true);
    check('本轮工具调用与结果配对完整', safeRequests.every((r) => JSON.stringify(r.tools) === '["read_schedule"]'));
    check('旧历史原件保留，剩余派生文件未被误用', hash(fs.readFileSync(seedFile)) === saved.sha256
      && hash(fs.readFileSync(path.join(base, 'derived.md'))) === oldRecord.sha256
      && result.toolReads === expectedReads * 2 && (scenario.expectedFact || result.toolDenials === 2));
    result.answer = answer;
    result.rebuiltSessionFile = path.relative(runDir, newFile);
    result.forbidden = forbidden;
  }
  result.passed = true;
} catch (error) {
  result.error = `${error.name}: ${error.message}`;
  process.exitCode = 1;
} finally {
  for (const session of liveSessions) session.dispose();
  writeJson(path.join(runDir, `${phase}.json`), result);
}
