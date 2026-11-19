import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { ApiError } from './contracts.js';

const execute = promisify(execFile);
const helper = fileURLToPath(new URL('./conversion-parser.py', import.meta.url));
const lock = fileURLToPath(new URL('./conversion-requirements.lock', import.meta.url));
export const CONVERSION_RESOURCES = Object.freeze({ timeoutMs: 180000, rssBytes: 768 * 1024 * 1024, pollMs: 200, outputBytes: 28 * 1024 * 1024 });
const runtimes = new Map<string, Promise<{ executable: string; roots: string[] }>>();
async function runtime(python: string): Promise<{ executable: string; roots: string[] }> {
  if (!runtimes.has(python)) runtimes.set(python, (async () => {
    if (!path.isAbsolute(python) || process.platform !== 'darwin') throw new ApiError('SERVICE_UNAVAILABLE');
    const { stdout } = await execute(python, ['-I', '-B', '-c', 'import json,sys;print(json.dumps({"executable":sys.executable,"roots":[sys.prefix,sys.base_prefix]}))'],
      { env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, timeout: 10000, maxBuffer: 4096 });
    const value = JSON.parse(stdout);
    const executable = fs.realpathSync(value.executable), roots = [...new Set<string>(value.roots.map((p: string) => fs.realpathSync(p)))];
    if (!roots.length || roots.some(p => p === '/' || p === os.homedir() || !path.isAbsolute(p))) throw new ApiError('SERVICE_UNAVAILABLE');
    return { executable, roots };
  })().catch(error => { runtimes.delete(python); throw error; }));
  return runtimes.get(python)!;
}
export function conversionProfile(executable: string, roots: string[], directory: string): string {
  const literal = (p: string) => `(literal ${JSON.stringify(p)})`;
  const subpath = (p: string) => `(subpath ${JSON.stringify(p)})`;
  const parents = new Set<string>();
  for (const location of [executable, ...roots, helper, lock, directory]) {
    for (let parent = path.dirname(location); ; parent = path.dirname(parent)) {
      parents.add(parent); if (parent === '/') break;
    }
  }
  return `(version 1)(deny default)
    (allow process-exec ${literal(executable)})
    (deny process-fork)(deny network*)
    (allow sysctl-read)
    (allow file-read* ${[...roots, directory, '/System/Library', '/usr/lib', '/Library/Apple/System/Library', '/usr/share/zoneinfo', '/usr/share/zoneinfo.default'].map(subpath).join(' ')}
      ${['/', helper, lock, '/dev/urandom', '/dev/random', '/dev/null', '/private/etc/localtime'].map(literal).join(' ')})
    (allow file-read-metadata ${[...parents].map(literal).join(' ')})
    (allow file-write* ${subpath(directory)} ${literal('/dev/null')})`;
}
export async function parseAttachment(python: string, content: Buffer, extension: string, signal: AbortSignal): Promise<unknown> {
  if (!['.pdf','.docx','.xlsx','.xls','.html','.htm'].includes(extension)) throw new ApiError('UNSUPPORTED_FORMAT');
  if (signal.aborted) throw new ApiError('RUN_INTERRUPTED');
  const selected = await runtime(python);
  if (signal.aborted) throw new ApiError('RUN_INTERRUPTED');
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-parser-')));
  fs.chmodSync(directory, 0o700);
  try {
    const input = path.join(directory, 'input' + extension);
    fs.writeFileSync(input, content, { mode: 0o600, flag: 'wx' });
    return await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/sandbox-exec', ['-p', conversionProfile(selected.executable, selected.roots, directory),
        python, '-I', '-B', helper, input, extension], { cwd: directory,
        env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TMPDIR: directory }, stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks: Buffer[] = []; let bytes = 0, failure: ApiError | undefined, checking = false, closed = false, missingSamples = 0;
      const fail = (code: 'RUN_INTERRUPTED' | 'FILE_TOO_LARGE' | 'DEADLINE_EXCEEDED' | 'CONVERSION_FAILED') => {
        failure ??= new ApiError(code); child.kill('SIGKILL');
      };
      const abort = () => fail('RUN_INTERRUPTED');
      const noSample = () => {
        // ps can observe a process exit before Node receives close. Persistent monitor failure still stops parsing.
        if (!closed && child.exitCode === null && child.signalCode === null && ++missingSamples >= 3) fail('CONVERSION_FAILED');
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const deadline = setTimeout(() => fail('DEADLINE_EXCEEDED'), CONVERSION_RESOURCES.timeoutMs);
      const memory = setInterval(() => {
        if (checking || closed || !child.pid) return;
        checking = true;
        void execute('/bin/ps', ['-o', 'rss=', '-p', String(child.pid)], { timeout: 1000, maxBuffer: 4096 }).then(({ stdout }) => {
          if (closed || child.exitCode !== null || child.signalCode !== null) return;
          const kib = Number(stdout.trim());
          if (!Number.isFinite(kib) || kib <= 0) noSample();
          else { missingSamples = 0; if (kib * 1024 > CONVERSION_RESOURCES.rssBytes) fail('FILE_TOO_LARGE'); }
        }).catch(noSample)
          .finally(() => { checking = false; });
      }, CONVERSION_RESOURCES.pollMs);
      child.once('error', () => fail('CONVERSION_FAILED'));
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > CONVERSION_RESOURCES.outputBytes) fail('FILE_TOO_LARGE'); else chunks.push(chunk);
      });
      child.once('close', code => {
        closed = true; clearTimeout(deadline); clearInterval(memory); signal.removeEventListener('abort', abort);
        if (failure || code !== 0) { reject(failure ?? new ApiError('CONVERSION_FAILED')); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new ApiError('CONVERSION_FAILED')); }
      });
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
