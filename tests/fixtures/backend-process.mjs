import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../../scripts/desktop-backend.mjs', import.meta.url));

export function launchBackend(args, { cwd, env, beforeStart, entryPoint = entry } = {}) {
  const stdio = ['ignore', 'pipe', 'pipe', 'ipc'];
  const child = beforeStart
    ? spawn(process.execPath, ['--input-type=module', '-e', beforeStart +
      '\nprocess.argv.splice(1, 0, ' + JSON.stringify(entryPoint) + '); await import(' + JSON.stringify(entryPoint) + ');', '--', ...args], { cwd, env, stdio })
    : fork(entryPoint, args, { execArgv: [], cwd, env, stdio });
  const exited = once(child, 'exit');
  const output = [];
  child.stdout.on('data', bytes => output.push(bytes));
  child.stderr.on('data', bytes => output.push(bytes));
  return { child, exited, logs: () => Buffer.concat(output).toString('utf8') };
}

export async function startupMessage({ child, exited }) {
  const controller = new AbortController();
  try {
    return await Promise.race([
      once(child, 'message', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) }).then(([message]) => message),
      exited.then(() => { throw new Error('Backend exited before sending its startup status'); }),
    ]);
  } finally { controller.abort(); }
}

export async function connectBackend(backend) {
  const { type, origin, bootstrapToken, code } = await startupMessage(backend);
  assert.equal(type, 'ready', code);
  const response = await fetch(origin + '/api/v1/bootstrap', {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: bootstrapToken }),
  });
  assert.equal(response.status, 200);
  await response.text();
  const cookie = response.headers.get('set-cookie').split(';')[0];
  return { origin, cookie, request: (route, options = {}) => fetch(origin + route, { ...options, headers: { origin, cookie, ...options.headers } }) };
}
