import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function writeOriginalCopy(file, bytes) {
  if (!path.isAbsolute(file) || !(bytes instanceof Uint8Array)) throw Object.assign(new Error('BAD_REQUEST'), { code: 'BAD_REQUEST' });
  const temporary = path.join(path.dirname(file), `.notetrail-export-${randomUUID()}`);
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // Link a complete copy atomically; an existing file or symlink is never replaced.
    fs.linkSync(temporary, file);
  } catch (error) {
    if (error.code === 'EEXIST') throw Object.assign(new Error('EXPORT_EXISTS'), { code: 'EXPORT_EXISTS' });
    throw error;
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function externalUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
