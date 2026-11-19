import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { DesktopService } from '../src/desktop/service.mjs';
import { VaultWorkspaces } from '../src/desktop/vault-workspaces.mjs';
import { DesktopWorkspaceStore } from '../src/desktop/workspace.mjs';
import { emptyDraft, emptyWorkspace } from '../dist/shared/desktop.js';
import { openStorage } from '../dist/server/storage.js';
import { ModelSettings } from '../dist/server/model-settings.js';
import { desktopQuestions } from './fixtures/desktop-questions.mjs';

function temporary(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-workspaces-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('existing data and models are reused while each workspace restores its own chats, drafts and attachments', { timeout: 60000 }, async t => {
  const directory = temporary(t), profile = path.join(directory, 'profile'), dataDirectory = path.join(directory, 'legacy');
  fs.mkdirSync(profile, { mode: 0o700 });
  const a = path.join(directory, 'Example 甲库'), b = path.join(directory, '示例 乙库');
  for (const root of [a, b]) {
    fs.mkdirSync(path.join(root, '.obsidian'), { recursive: true });
    fs.writeFileSync(path.join(root, '同名笔记.md'), path.basename(root));
  }
  const serviceOptions = { root: fs.realpathSync('.'), node: process.execPath, python: process.env.NOTETRAIL_PYTHON, rg: process.env.NOTETRAIL_RG };
  const legacy = new DesktopService({ ...serviceOptions, dataDirectory });
  let libraries;
  t.after(async () => { await libraries?.close(); await legacy.stop(); });
  const legacyDrafts = new DesktopWorkspaceStore(profile, dataDirectory);
  await legacy.start();
  const vaultA = await legacy.request({ op: 'connectVault', input: { absolutePath: a, exclusions: [] } });
  const model = { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' };
  const revision = (await legacy.request({ op: 'settings' })).revision;
  await legacy.request({ op: 'setModel', input: { ...model, expectedRevision: revision } });
  async function seed(service, drafts, vault, label) {
    const session = await service.request({ op: 'createSession', input: { vaultId: vault.id, title: label } });
    const bytes = Buffer.from(label);
    const attachment = drafts.putAttachment({ name: '同名附件.md', bytes, lastModified: 1 });
    drafts.save({ ...emptyWorkspace(), vaultId: vault.id, sessionId: session.id, drafts: {
      [session.id]: { ...emptyDraft(), text: label + '的聊天草稿' },
      ['collect:' + vault.id]: { ...emptyDraft(), mode: 'store', attachment },
    } });
    return { session, bytes, attachment };
  }
  const first = await seed(legacy, legacyDrafts, vaultA, '甲库历史');
  await legacy.stop();
  const options = { profile, dataDirectory, onStatus() {}, createService: (directory, expectedVaultKey) =>
    new DesktopService({ ...serviceOptions, dataDirectory: directory, profile, modelDirectory: dataDirectory, expectedVaultKey }) };
  libraries = new VaultWorkspaces(options);
  await libraries.start();
  assert.deepEqual(libraries.list().items.map(item => item.name), ['Example 甲库']);
  assert.equal(libraries.drafts.load().sessionId, first.session.id);
  const oldToken = libraries.token;
  const firstSelection = libraries.list().active;
  assert.throws(() => libraries.add(path.join(a, '.obsidian')), { code: 'VAULT_ACCESS_DENIED' });
  const aliasChild = path.join(directory, 'example 甲库', '.obsidian');
  if (fs.existsSync(aliasChild)) assert.throws(() => libraries.add(aliasChild), { code: 'VAULT_ACCESS_DENIED' });
  assert.equal(await libraries.add(b), true);
  assert.notEqual(libraries.token, oldToken);
  const secondSelection = libraries.list().active;
  assert.deepEqual((await libraries.service.request({ op: 'settings' })).model, model);
  const vaultB = (await libraries.service.request({ op: 'vaults' })).items[0];
  assert.notEqual(vaultB.id, vaultA.id);
  await assert.rejects(libraries.service.request({ op: 'session', sessionId: first.session.id }), { code: 'NOT_FOUND' });
  const second = await seed(libraries.service, libraries.drafts, vaultB, '乙库历史');
  assert.throws(() => libraries.drafts.getAttachment(first.attachment), { code: 'DRAFT_INVALID' });
  assert.equal(await libraries.add(b), false);
  assert.equal(libraries.list().items.length, 2);
  await libraries.select(firstSelection);
  assert.equal((await libraries.service.request({ op: 'session', sessionId: first.session.id })).title, '甲库历史');
  assert.equal(libraries.drafts.load().drafts[first.session.id].text, '甲库历史的聊天草稿');
  assert.deepEqual(Buffer.from(libraries.drafts.getAttachment(first.attachment)), first.bytes);

  const activeBeforeFailure = libraries.token;
  const blocked = openStorage(path.join(libraries.group, secondSelection));
  try { await assert.rejects(libraries.select(secondSelection), { code: 'DATABASE_BUSY' }); }
  finally { blocked.close(); }
  assert.equal(libraries.token, activeBeforeFailure);
  assert.equal(libraries.list().active, firstSelection);
  assert.equal((await libraries.service.request({ op: 'vaults' })).items[0].id, vaultA.id);
  await libraries.select(secondSelection);
  await libraries.close();
  const wrongVault = options.createService(path.join(libraries.group, secondSelection), vaultA.locationKey);
  try { await assert.rejects(wrongVault.start(), { code: 'VAULT_ACCESS_DENIED' }); }
  finally { await wrongVault.stop(); }
  libraries = new VaultWorkspaces(options);
  await libraries.start();
  assert.equal(libraries.list().active, secondSelection);
  assert.equal((await libraries.service.request({ op: 'session', sessionId: second.session.id })).title, '乙库历史');
  assert.equal(libraries.drafts.load().drafts[second.session.id].text, '乙库历史的聊天草稿');
  assert.equal(libraries.drafts.load().sessionId, second.session.id);
  assert.deepEqual(Buffer.from(libraries.drafts.getAttachment(second.attachment)), second.bytes);
});

test('workspace handoff cannot stop queued work or accept a new task after pausing', { timeout: 30000 }, async t => {
  const f = await desktopQuestions(temporary(t));
  t.after(() => f.stop());
  const config = openStorage(path.join(path.dirname(f.dataDirectory), 'shared-model'));
  try {
    const shared = new ModelSettings(config.db, {}, f.db);
    const probe = f.runs.probe(randomUUID());
    assert.equal(shared.profiles().busy, true);
    f.runs.cancel(probe.runId);
    assert.equal(shared.profiles().busy, false);
  } finally { config.close(); }
  const ref = f.runs.refresh(f.vault.id, randomUUID());
  assert.equal(f.runs.pauseForSwitch(), false);
  const deadline = Date.now() + 10000;
  while (f.runs.get(ref.runId).state !== 'succeeded' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.runs.get(ref.runId).state, 'succeeded');
  assert.equal(f.runs.pauseForSwitch(), true);
  assert.throws(() => f.runs.refresh(f.vault.id, randomUUID()), error => error.publicError?.code === 'SERVICE_UNAVAILABLE');
});
