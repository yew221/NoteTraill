import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hasFields } from '../../dist/shared/contracts.js';
import { DesktopWorkspaceStore, atomic, privateDirectory, read } from './workspace.mjs';

const first = 'default';
const fail = code => Object.assign(new Error(code), { code });
const hash = value => createHash('sha256').update(value).digest('hex');
const isId = value => value === first || (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value));
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0') && value.length <= 4096;
const inside = (file, root) => file === root || file.startsWith(root.endsWith('/') ? root : root + '/');
const locationKey = stat => hash(`${stat.dev}:${stat.ino}`);

function inspect(directory) {
  if (!absolute(directory)) throw fail('BAD_REQUEST');
  try {
    const root = fs.realpathSync(directory);
    const stat = fs.statSync(root, { bigint: true });
    if (!stat.isDirectory()) throw fail('VAULT_ACCESS_DENIED');
    return { root, key: locationKey(stat) };
  } catch { throw fail('VAULT_ACCESS_DENIED'); }
}

function hasAncestor(root, key) {
  for (let directory = root;; directory = path.dirname(directory)) {
    try { if (locationKey(fs.statSync(directory, { bigint: true })) === key) return true; }
    catch (error) { if (error.code !== 'ENOENT') throw fail('VAULT_ACCESS_DENIED'); }
    if (path.dirname(directory) === directory) return false;
  }
}

function load(file) {
  let data;
  try { data = JSON.parse(read(file, 1024 * 1024).toString('utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { active: first, items: [] };
    throw fail('DRAFT_INVALID');
  }
  if (!hasFields(data, ['active', 'items']) || !isId(data.active) || !Array.isArray(data.items) ||
    !data.items.every(item => hasFields(item, ['id', 'root', 'key']) && isId(item.id) && absolute(item.root) &&
      typeof item.key === 'string' && /^[a-f0-9]{64}$/.test(item.key)) ||
    new Set(data.items.map(item => item.id)).size !== data.items.length ||
    new Set(data.items.map(item => item.key)).size !== data.items.length ||
    (data.active !== first && !data.items.some(item => item.id === data.active))) throw fail('DRAFT_INVALID');
  return data;
}

export class VaultWorkspaces {
  #state;
  #drafts;
  #operation;
  #closing = false;

  constructor({ profile, dataDirectory, createService, onStatus }) {
    const managed = path.join(profile, 'libraries');
    privateDirectory(managed);
    this.group = path.join(managed, hash(dataDirectory));
    privateDirectory(this.group);
    this.file = path.join(this.group, 'libraries.json');
    this.#state = load(this.file);
    this.profile = profile;
    this.dataDirectory = dataDirectory;
    this.createService = createService;
    this.onStatus = onStatus;
    this.token = randomUUID();
    this.service = this.#newService(this.#state.active, this.#state.items.find(item => item.id === this.#state.active)?.key);
  }

  #directory(id) { return id === first ? this.dataDirectory : path.join(this.group, id); }
  #newService(id, key) {
    const service = this.createService(this.#directory(id), key);
    service.on('status', status => { if (service === this.service && !this.switching) this.onStatus(status); });
    return service;
  }
  #store(state) {
    const bytes = JSON.stringify(state);
    try { atomic(this.file, bytes); }
    catch (error) {
      // A directory sync can fail after rename. Keep the current selection aligned with the published file.
      if (JSON.stringify(load(this.file)) !== bytes) throw error;
    }
    this.#state = state;
  }
  get drafts() {
    if (!this.#drafts) {
      this.#drafts = new DesktopWorkspaceStore(this.profile, this.#directory(this.#state.active));
      this.#drafts.collectAttachments();
    }
    return this.#drafts;
  }
  get switching() { return this.#operation !== undefined; }
  list() {
    return { active: this.#state.active, items: this.#state.items.map(({ id, root, key }) => ({ id, name: path.basename(root), key })) };
  }
  remember(vault) {
    const known = this.#state.items.find(item => item.id === this.#state.active);
    if (known?.key === vault?.key) return;
    if (known || !vault || this.#state.active !== first || !absolute(vault.root) || !/^[a-f0-9]{64}$/.test(vault.key)) {
      throw fail('VAULT_ACCESS_DENIED');
    }
    this.#store({ active: first, items: [...this.#state.items, { id: first, ...vault }] });
    this.service.expectVault(vault.key);
  }
  async start() {
    if (this.#state.items.some(item => item.id === this.#state.active) &&
        !fs.existsSync(path.join(this.#directory(this.#state.active), '.notetrail-data'))) {
      throw fail('VAULT_ACCESS_DENIED');
    }
    await this.service.start();
    try { this.remember(this.service.vault); }
    catch (error) { await this.service.stop(); throw error; }
  }

  select(id) {
    const item = this.#state.items.find(entry => entry.id === id);
    if (!item) throw fail('NOT_FOUND');
    return this.#change(item, false);
  }
  add(directory) {
    const vault = inspect(directory);
    const known = this.#state.items.find(item => item.key === vault.key);
    if (known) return this.#change(known, false);
    if (this.#state.items.some(item => inside(vault.root, item.root) || inside(item.root, vault.root) ||
        hasAncestor(vault.root, item.key) || hasAncestor(item.root, vault.key))) throw fail('VAULT_ACCESS_DENIED');
    return this.#change({ id: randomUUID(), ...vault }, true);
  }
  async #change(item, adding) {
    if (this.switching || this.#closing) throw fail('SESSION_BUSY');
    if (item.id === this.#state.active) return false;
    if (inspect(item.root).key !== item.key) throw fail('VAULT_ACCESS_DENIED');
    if (!adding && !fs.existsSync(path.join(this.#directory(item.id), '.notetrail-data'))) throw fail('VAULT_ACCESS_DENIED');
    this.#operation = this.#switch(item, adding);
    try { return await this.#operation; }
    finally { this.#operation = undefined; this.onStatus(this.service.status()); }
  }
  async #switch(item, adding) {
    const previous = this.service;
    if (!await previous.pauseForSwitch()) throw fail('SESSION_BUSY');
    let next;
    try {
      await previous.stop();
      if (this.#closing) throw fail('SERVICE_UNAVAILABLE');
      next = this.#newService(item.id, adding ? undefined : item.key);
      await next.start({ deferMonitoring: true });
      const key = adding
        ? (await next.request({ op: 'connectVault', input: { absolutePath: item.root, exclusions: [] } })).locationKey
        : next.vault?.key;
      if (key !== item.key || this.#closing) throw fail('VAULT_ACCESS_DENIED');
      next.expectVault(item.key);
      const drafts = new DesktopWorkspaceStore(this.profile, this.#directory(item.id));
      drafts.collectAttachments();
      this.#store({ active: item.id, items: adding ? [...this.#state.items, item] : this.#state.items });
      this.#drafts = drafts;
      this.service = next;
      this.token = randomUUID();
      next.startMonitoring();
      return true;
    } catch (error) {
      await next?.stop();
      if (!this.#closing) await previous.start().catch(() => {});
      throw error;
    }
  }
  async close() {
    this.#closing = true;
    await this.#operation?.catch(() => {});
    await this.service.stop();
  }
}
