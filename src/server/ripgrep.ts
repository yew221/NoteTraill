import path from 'node:path';
import { spawn } from 'node:child_process';
import { ApiError } from './contracts.js';

// Rank literal hits, keeping every candidate for subsequent pages. Nearby hits
// move behind other passages so one introduction cannot occupy the whole page.
export function rankSearchLines(text: string, found: number[], terms: readonly string[]): Array<{ line: number; score: number }> {
  const lines = text.toLocaleLowerCase('en-US').split('\n'), words = [...new Set(terms.map(term => term.toLocaleLowerCase('en-US')))];
  const ranked = found.map(line => {
    const nearby = lines.slice(Math.max(0, line - 5), line + 4).join('\n');
    const counts = words.map(word => Math.min(3, nearby.split(word).length - 1));
    return { line, score: counts.filter(Boolean).length * 10 + counts.reduce((a, b) => a + b, 0) };
  }).sort((a, b) => b.score - a.score || a.line - b.line);
  const distinct: typeof ranked = [], adjacent: typeof ranked = [], covered = new Set<number>();
  for (const hit of ranked) {
    if (covered.has(hit.line)) adjacent.push(hit);
    else { distinct.push(hit); for (let line = hit.line - 5; line <= hit.line + 5; line++) covered.add(line); }
  }
  return [...distinct, ...adjacent];
}

export function searchOutline(text: string, terms: readonly string[]) {
  let parent: string | null = null, fence = '';
  const headings: Array<{ line: number; heading: string; parent: string | null; score: number }> = [];
  text.split('\n').forEach((line, index) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = ''; return; }
    if (fence) return;
    const match = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) return;
    if (match[1].length === 2) parent = null;
    const heading = match[2], own = heading.toLocaleLowerCase('en-US'), above = (parent ?? '').toLocaleLowerCase('en-US');
    const score = terms.reduce((n, term) => n + (own.includes(term.toLocaleLowerCase('en-US')) ? term.length * 2 : above.includes(term.toLocaleLowerCase('en-US')) ? term.length : 0), 0);
    headings.push({ line: index + 1, heading, parent, score });
    if (match[1].length === 2) parent = heading;
  });
  const ranked = headings.sort((a, b) => b.score - a.score || a.line - b.line);
  const specific = ranked.filter(item => item.parent !== null && terms.some(term => item.heading.toLocaleLowerCase('en-US').includes(term.toLocaleLowerCase('en-US')))).slice(0, 2);
  const selected = [...specific, ...ranked.filter(item => item.parent === null), ...ranked.filter(item => item.parent !== null && !specific.includes(item))];
  const items: Array<{ line: number; heading: string; parent: string | null }> = [];
  for (const { score: _score, ...heading } of selected) {
    if (items.length === 20 || Buffer.byteLength(JSON.stringify([...items, heading])) > 2400) break;
    items.push(heading);
  }
  return { items, truncated: items.length < headings.length };
}

export class Ripgrep {
  constructor(private readonly executable: string) {
    if (!path.isAbsolute(executable) || executable.includes('\0')) throw new ApiError('CONFIG_REQUIRED');
  }
  async lines(text: string, terms: readonly string[], maximum: number, signal: AbortSignal): Promise<number[]> {
    if (signal.aborted) throw new ApiError('RUN_INTERRUPTED');
    return new Promise((resolve, reject) => {
      // Only stdin is searched. A one-column preview bounds output even for a huge matching line.
      const child = spawn(this.executable, ['--no-config', '--line-number', '--no-heading', '--no-filename',
        '--fixed-strings', '--ignore-case', '--max-count', String(maximum), '--max-columns', '1',
        '--color', 'never', '--text', ...terms.flatMap(term => ['-e', term]), '-'], {
        cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, stdio: ['pipe', 'pipe', 'ignore'],
      });
      const chunks: Buffer[] = []; let size = 0, failed = false;
      const abort = () => { child.kill('SIGKILL'); };
      const fail = () => { failed = true; abort(); };
      signal.addEventListener('abort', abort, { once: true });
      child.once('error', fail);
      child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') fail(); });
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 512 * 1024) fail(); else chunks.push(chunk);
      });
      child.once('close', code => {
        signal.removeEventListener('abort', abort);
        try {
          if (signal.aborted) throw new ApiError('RUN_INTERRUPTED');
          if (failed || (code !== 0 && code !== 1)) throw new ApiError('SERVICE_UNAVAILABLE');
          const output = Buffer.concat(chunks).toString('utf8');
          const rows = output ? output.trimEnd().split('\n') : [];
          const lines = rows.map(row => Number(/^([1-9]\d*):/.exec(row)?.[1]));
          if (lines.length > maximum || lines.some((line, index) => !Number.isSafeInteger(line) || line < 1 ||
              (index > 0 && line <= lines[index - 1])) || (code === 1 && lines.length > 0)) throw new ApiError('SERVICE_UNAVAILABLE');
          resolve(lines);
        } catch (error) { reject(error); }
      });
      child.stdin.end(text);
    });
  }
}
