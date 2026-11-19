import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ApiError } from './contracts.js';
import { isId } from '../shared/contracts.js';

export function deleteRunSessionFiles(directory: string, runIds: string[]): void {
  const owned = new Set(runIds);
  if (runIds.some(id => !isId(id, 'run'))) throw new ApiError('SESSION_UNREADABLE');
  const workers = path.join(directory, 'workers');
  try {
    for (const parent of [directory, workers]) {
      let stat;
      try { stat = fs.lstatSync(parent); }
      catch (error) { if (parent === workers && (error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700 || fs.realpathSync(parent) !== parent) throw new Error();
    }
    for (const name of fs.readdirSync(workers)) {
      const match = /^(r_[a-f0-9-]{36})-[1-9][0-9]*$/.exec(name);
      if (!match || !owned.has(match[1])) continue;
      const target = path.join(workers, name), stat = fs.lstatSync(target);
      if (!stat.isDirectory() || stat.uid !== process.getuid?.() || fs.realpathSync(target) !== target) throw new Error();
      // rm removes nested symlinks themselves; it never follows them outside this owned run directory.
      fs.rmSync(target, { recursive: true });
    }
  } catch { throw new ApiError('SESSION_UNREADABLE'); }
}

export function readSessionFile(directory: string, relative: string, expectedHash?: string): { bytes: Buffer; hash: string } {
  if (!/^workers\/r_[a-f0-9-]{36}-[1-9][0-9]*\/sessions\/[A-Za-z0-9._-]{1,200}\.jsonl$/.test(relative)) throw new ApiError('SESSION_UNREADABLE');
  const file = path.join(directory, relative);
  let fd: number | undefined;
  try {
    for (let parent = path.dirname(file); parent !== path.dirname(directory); parent = path.dirname(parent)) {
      const stat = fs.lstatSync(parent);
      if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700 || fs.realpathSync(parent) !== parent) throw new Error();
    }
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 ||
      stat.size <= 0 || stat.size > 8 * 1024 * 1024) throw new Error();
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd), hash = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs ||
      (expectedHash !== undefined && hash !== expectedHash)) throw new Error();
    return { bytes, hash };
  } catch { throw new ApiError('SESSION_UNREADABLE'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
