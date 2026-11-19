import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { conversionProfile, parseAttachment } from '../dist/server/conversion-sandbox.js';

const python = process.env.NOTETRAIL_PYTHON;
const options = { skip: process.platform !== 'darwin', timeout: 20000 };
test('the OS blocks parser file access, metadata, writes, network and subprocesses outside its scratch directory', options, async t => {
  assert(python);
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-converter-test-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const scratch = path.join(directory, 'scratch'); fs.mkdirSync(scratch, { mode: 0o700 });
  const outside = path.join(directory, 'outside.txt'); fs.writeFileSync(outside, 'SYNTHETIC_CANARY_ONLY');
  const config = JSON.parse(spawnSync(python, ['-I','-B','-c','import sys,json;print(json.dumps([sys.executable,sys.prefix,sys.base_prefix]))'], { encoding: 'utf8' }).stdout);
  let connections = 0;
  const server = net.createServer(socket => { connections++; socket.destroy(); }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const code = `import os,json,socket,subprocess\nresults={}\nchecks={\n'read':lambda:open(${JSON.stringify(outside)}).read(),\n'stat':lambda:os.stat(${JSON.stringify(outside)}),\n'write':lambda:open(${JSON.stringify(outside)},'w').write('BAD'),\n'list':lambda:os.listdir(${JSON.stringify(directory)}),\n'network':lambda:socket.create_connection(('127.0.0.1',${server.address().port}),timeout=1),\n'spawn':lambda:subprocess.run(['/usr/bin/true'])}\nfor name,operation in checks.items():\n    try: operation();results[name]='ALLOWED'\n    except PermissionError: results[name]='DENIED'\nopen(${JSON.stringify(path.join(scratch, 'owned'))},'w').write('OK')\nprint(json.dumps(results))`;
  const child = spawn('/usr/bin/sandbox-exec', ['-p', conversionProfile(fs.realpathSync(config[0]), config.slice(1).map(p => fs.realpathSync(p)), scratch), python, '-I', '-B', '-c', code],
    { cwd: scratch, env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, stdio: ['ignore','pipe','pipe'] });
  let out = '', err = ''; child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
  const [status] = await once(child, 'close'); assert.equal(status, 0, err);
  assert.deepEqual(JSON.parse(out), Object.fromEntries(['read','stat','write','list','network','spawn'].map(k => [k, 'DENIED'])));
  assert.equal(connections, 0); assert.equal(fs.readFileSync(outside, 'utf8'), 'SYNTHETIC_CANARY_ONLY');
  assert.equal(fs.readFileSync(path.join(scratch, 'owned'), 'utf8'), 'OK');
});
test('actual parsing stops on cancellation and excessive resident memory, then removes its scratch files', { ...options, timeout: 30000 }, async t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notetrail-resource-test-'))), previous = process.env.TMPDIR;
  process.env.TMPDIR = directory;
  t.after(() => { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; fs.rmSync(directory, { recursive: true, force: true }); });
  const scratch = () => fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('notetrail-parser-')).sort();
  const before = scratch(), input = Buffer.from('<html><body>' + '<p>public text</p>'.repeat(400000) + '</body></html>');
  const abort = new AbortController();
  const pending = parseAttachment(python, input, '.html', abort.signal);
  const timer = setTimeout(() => abort.abort(), 250);
  await assert.rejects(pending, e => e.publicError?.code === 'RUN_INTERRUPTED'); clearTimeout(timer);
  assert.deepEqual(scratch(), before);
  await assert.rejects(parseAttachment(python, input, '.html', new AbortController().signal), e => e.publicError?.code === 'FILE_TOO_LARGE');
  assert.deepEqual(scratch(), before);
});
