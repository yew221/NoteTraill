import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createHash } from 'node:crypto';

const PREFIX = 'NOTETRAIL_CONTROL_V1 ';
const MARKER = 'NoteTrail local control v1\n';
function socketPath(directory: string, create = false): string {
  if (!path.isAbsolute(directory) || fs.realpathSync(directory) !== directory) throw new Error('CONTROL_UNAVAILABLE');
  // macOS Unix sockets have a short path limit; only the directory digest goes in this private namespace.
  const root = path.join(process.platform === 'darwin' ? '/private/tmp' : fs.realpathSync(os.tmpdir()), `notetrail-control-${process.getuid?.()}`);
  try { if (create) fs.mkdirSync(root, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700 || fs.realpathSync(root) !== root) throw new Error('CONTROL_UNAVAILABLE');
  const marker = path.join(root, '.notetrail-control');
  if (create && fs.readdirSync(root).length === 0) {
    try { fs.writeFileSync(marker, MARKER, { mode: 0o600, flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const markerStat = fs.lstatSync(marker);
  if (!markerStat.isFile() || markerStat.nlink !== 1 || markerStat.uid !== process.getuid?.() || (markerStat.mode & 0o777) !== 0o600 || fs.readFileSync(marker, 'utf8') !== MARKER) throw new Error('CONTROL_UNAVAILABLE');
  return path.join(root, createHash('sha256').update(directory).digest('hex').slice(0, 32) + '.sock');
}
export interface ControlStatus { protocol: 1; running: boolean; port?: number }
export async function requestControl(directory: string, command: 'status' | 'stop'): Promise<ControlStatus> {
  let file: string;
  try {
    file = socketPath(directory); const stat = fs.lstatSync(file);
    if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error('CONTROL_UNAVAILABLE');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { protocol: 1, running: false }; throw error; }
  return new Promise((resolve, reject) => {
    const client = net.createConnection(file); let bytes = '';
    client.setTimeout(1500, () => client.destroy(new Error('CONTROL_UNAVAILABLE')));
    client.on('connect', () => client.write(PREFIX + command + '\n'));
    client.on('data', chunk => { bytes += chunk; if (bytes.length > 256) client.destroy(new Error('CONTROL_UNAVAILABLE')); });
    client.on('error', error => {
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') resolve({ protocol: 1, running: false }); else reject(new Error('CONTROL_UNAVAILABLE'));
    });
    client.on('end', () => {
      try {
        const status = JSON.parse(bytes) as ControlStatus;
        if (status.protocol !== 1 || status.running !== true || !Number.isSafeInteger(status.port) || status.port! < 1 || status.port! > 65535) throw new Error();
        resolve(status);
      } catch { reject(new Error('CONTROL_UNAVAILABLE')); }
    });
  });
}
export async function openControl(directory: string, port: number, stop: () => void) {
  const file = socketPath(directory, true);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isSocket() || stat.uid !== process.getuid?.() || (await requestControl(directory, 'status')).running) throw new Error('CONTROL_UNAVAILABLE');
    fs.unlinkSync(file);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const connections = new Set<net.Socket>();
  const server = net.createServer(socket => {
    connections.add(socket); socket.once('close', () => connections.delete(socket));
    socket.on('error', () => {}); socket.setTimeout(1000, () => socket.destroy());
    let bytes = '';
    socket.on('data', chunk => {
      bytes += chunk;
      if (bytes === PREFIX + 'status\n' || bytes === PREFIX + 'stop\n') {
        socket.end(JSON.stringify({ protocol: 1, running: true, port }) + '\n', () => { if (bytes === PREFIX + 'stop\n') setImmediate(stop); });
      } else if (bytes.includes('\n') || bytes.length > 64) socket.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(file, resolve); });
  try { fs.chmodSync(file, 0o600); }
  catch (error) { server.close(); throw error; }
  return { close: () => new Promise<void>((resolve, reject) => {
    for (const socket of connections) socket.destroy();
    server.close(error => error ? reject(error) : resolve());
  }) };
}
