import fs from 'node:fs';

// This entry point is owned by the desktop parent; it cannot grant a browser a launch token.
if (!process.send || !process.connected) throw new Error('DESKTOP_PARENT_REQUIRED');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
let service, closing = false;
async function close() {
  closing = true;
  await service?.stop();
  if (service && process.connected) process.disconnect();
}
process.once('disconnect', () => { void close(); });
process.on('message', message => {
  if (message?.type === 'stop') void close();
  if (message?.type === 'startMonitoring' && !closing) service?.startMonitoring?.();
  if (message?.type === 'pauseForSwitch' && process.connected) {
    process.send({ type: 'switchStatus', id: message.id, ok: !closing && service?.pauseForSwitch?.() === true });
  }
});
// The listening service owns the child lifetime, including shutdown through the control socket.
process.channel?.unref();
try {
  if (process.version !== `v${pkg.engines.node}`) throw Object.assign(new Error(), { code: 'RUNTIME_MISMATCH' });
  const { start } = await import('../dist/server/index.js');
  service = await start(process.argv.slice(2), {
    modelDirectory: process.env.NOTETRAIL_MODEL_DATA_DIR,
    profile: process.env.NOTETRAIL_DESKTOP_PROFILE,
    expectedVaultKey: process.env.NOTETRAIL_EXPECTED_VAULT,
    deferMonitoring: process.env.NOTETRAIL_DEFER_MONITORING === '1',
    ready: connection => {
      if (process.connected && !closing) process.send({ type: 'ready', protocol: 1, ...connection });
    },
  });
  if (closing) await close();
} catch (error) {
  const allowed = ['DATA_DIRECTORY_INVALID', 'DATA_DIRECTORY_UNRECOGNIZED', 'DATABASE_INVALID',
    'DATABASE_TOO_NEW', 'DATABASE_BUSY', 'RUNTIME_MISMATCH', 'VAULT_ACCESS_DENIED'];
  const code = error.publicError?.code ?? error.code;
  if (process.connected) {
    process.send({ type: 'failed', code: allowed.includes(code) ? code : 'START_FAILED' }, () => process.disconnect());
  }
  process.exitCode = 1;
}
