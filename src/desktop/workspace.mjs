import { MAX_FILE_BYTES } from '../../dist/shared/vault.js';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { emptyWorkspace, isDesktopWorkspace, isDesktopDraft, isDraftKey, isDraftFile, pruneEmptyDrafts } from '../../dist/shared/desktop.js';
import { isPayloadHash, hasFields } from '../../dist/shared/contracts.js';

const fail = code => Object.assign(new Error(code), { code });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const LIMIT = 8 * 1024 * 1024;
export function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || fs.realpathSync(directory) !== directory || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw fail('DRAFT_INVALID');
}
export function read(file, maximum) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > maximum) throw fail('DRAFT_INVALID');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
export function atomic(file, bytes) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally { fs.rmSync(temporary, { force: true }); }
}

// UI drafts only. Conversations, credentials and model accounting remain owned by the backend.
export class DesktopWorkspaceStore {
  constructor(profile, dataDirectory) {
    this.directory = path.join(profile, 'workspaces', hash(path.resolve(dataDirectory)));
    privateDirectory(path.join(profile, 'workspaces')); privateDirectory(this.directory);
    this.attachments = path.join(this.directory, 'attachments'); privateDirectory(this.attachments);
    this.file = path.join(this.directory, 'state.json');
    try { this.state = JSON.parse(read(this.file, LIMIT).toString('utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw fail('DRAFT_INVALID'); this.state = emptyWorkspace(); }
    this.state = this.compact(this.state);
    if (!isDesktopWorkspace(this.state)) throw fail('DRAFT_INVALID');
  }
  load() { return structuredClone(this.state); }
  compact(state) {
    // Validate entries before pruning so malformed data is never silently discarded.
    if (!state || !state.drafts || typeof state.drafts !== 'object' || Array.isArray(state.drafts) ||
      !Object.entries(state.drafts).every(([key, draft]) => isDraftKey(key) && isDesktopDraft(draft))) throw fail('DRAFT_INVALID');
    return pruneEmptyDrafts(state);
  }
  save(state) {
    try { state = this.compact(state); } catch { throw fail('BAD_REQUEST'); }
    if (!isDesktopWorkspace(state)) throw fail('BAD_REQUEST');
    const bytes = JSON.stringify(state);
    if (Buffer.byteLength(bytes) > LIMIT) throw fail('DRAFT_LIMIT');
    for (const draft of Object.values(state.drafts)) if (draft.attachment) {
      try { const stat = fs.lstatSync(path.join(this.attachments, draft.attachment.id));
        if (!stat.isFile() || stat.size !== draft.attachment.size || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw fail('DRAFT_INVALID');
      } catch { throw fail('DRAFT_INVALID'); }
    }
    const oldFiles = new Set(Object.values(this.state.drafts).flatMap(draft => draft.attachment ? [draft.attachment.id] : []));
    const newFiles = new Set(Object.values(state.drafts).flatMap(draft => draft.attachment ? [draft.attachment.id] : []));
    try { atomic(this.file, bytes); this.state = structuredClone(state); }
    catch { throw fail('DRAFT_STORAGE_FAILED'); }
    for (const id of oldFiles) if (!newFiles.has(id)) { try { fs.unlinkSync(path.join(this.attachments, id)); } catch { /* Retain on failure; collect on the next launch. */ } }
    return { saved: true };
  }
  putAttachment(input) {
    if (!hasFields(input, ['name', 'bytes', 'lastModified']) || !(input.bytes instanceof Uint8Array) || input.bytes.byteLength > MAX_FILE_BYTES) throw fail('BAD_REQUEST');
    const meta = { id: hash(input.bytes), name: input.name, size: input.bytes.byteLength, lastModified: input.lastModified };
    if (!isDraftFile(meta)) throw fail('BAD_REQUEST');
    const file = path.join(this.attachments, meta.id);
    if (fs.existsSync(file)) { this.getAttachment(meta); return meta; }
    const used = fs.readdirSync(this.attachments).filter(isPayloadHash).reduce((total, id) => total + fs.lstatSync(path.join(this.attachments, id)).size, 0);
    if (used + meta.size > 500 * 1024 * 1024) throw fail('DRAFT_LIMIT');
    try { atomic(file, input.bytes); } catch { throw fail('DRAFT_STORAGE_FAILED'); }
    return meta;
  }
  getAttachment(meta) {
    if (!isDraftFile(meta)) throw fail('BAD_REQUEST');
    let bytes;
    try { bytes = read(path.join(this.attachments, meta.id), MAX_FILE_BYTES); }
    catch { throw fail('DRAFT_INVALID'); }
    if (bytes.byteLength !== meta.size || hash(bytes) !== meta.id) throw fail('DRAFT_INVALID');
    return new Uint8Array(bytes);
  }
  collectAttachments() {
    const live = new Set(Object.values(this.state.drafts).flatMap(draft => draft.attachment ? [draft.attachment.id] : []));
    for (const id of fs.readdirSync(this.attachments)) if (isPayloadHash(id) && !live.has(id)) fs.unlinkSync(path.join(this.attachments, id));
  }
}
