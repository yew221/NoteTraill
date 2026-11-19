import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createApp } from './app.js';
import { BrowserSession } from './session.js';
import path from 'node:path';
import { defaultDataDirectory, openMaintenanceStorage, openStorage } from './storage.js';
import { ApiError } from './contracts.js';
import { KeychainCredentials, credentialPython } from './credentials.js';
import { ModelSettings } from './model-settings.js';
import { VaultFiles } from './vault-files.js';
import { VaultService } from './vaults.js';
import { RunService } from './runs.js';
import { IngestFiles } from './ingest-files.js';
import { IngestService } from './ingestions.js';
import { ConversionFiles } from './conversion-files.js';
import fs from 'node:fs';
import { Ripgrep } from './ripgrep.js';
import { ModelLedger } from './model-ledger.js';
import { WorkerRunner } from './worker-runner.js';
import { ConversationService } from './conversations.js';
import { AnswerService } from './answers.js';
import { QuestionService } from './questions.js';
import { ModelProbeService } from './model-probes.js';
import { openControl } from './control.js';

export function parseStartOptions(args: string[]): { port: number; dataDirectory: string } {
  const options = { port: 4319, dataDirectory: defaultDataDirectory() };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i], value = args[i + 1];
    if (seen.has(name) || value === undefined) throw new Error('INVALID_START_ARGUMENTS');
    seen.add(name);
    if (name === '--port' && /^(0|[1-9]\d{0,4})$/.test(value) && Number(value) <= 65535) options.port = Number(value);
    else if (name === '--data-dir' && path.isAbsolute(value) && !value.includes('\0')) options.dataDirectory = value;
    else throw new Error('INVALID_START_ARGUMENTS');
  }
  return options;
}

type DesktopStart = {
  modelDirectory?: string; profile?: string; expectedVaultKey?: string; deferMonitoring?: boolean;
  ready: (connection: { origin: string; bootstrapToken: string; vault?: { root: string; key: string } }) => void;
};

export async function start(args: string[], desktop: DesktopStart) {
  const { port, dataDirectory } = parseStartOptions(args);
  const storage = openStorage(dataDirectory);
  const bootstrapToken = randomBytes(32).toString('base64url');
  let app: ReturnType<typeof createApp>;
  let vaults: VaultService;
  let runs: RunService;
  let ingestions: IngestService;
  let modelStorage: ReturnType<typeof openStorage> | undefined;
  let boundVault: { root: string; key: string } | undefined;
  let control: Awaited<ReturnType<typeof openControl>> | undefined;
  try {
    const programRoot = process.env.NOTETRAIL_INSTALL_ROOT ?? fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
    if (!path.isAbsolute(programRoot) || fs.realpathSync(programRoot) !== programRoot) throw new Error('INVALID_PROGRAM_ROOT');
    if (desktop.modelDirectory && path.resolve(desktop.modelDirectory) !== storage.directory) modelStorage = openMaintenanceStorage(desktop.modelDirectory);
    const forbiddenRoots = [storage.directory, programRoot, desktop.profile, modelStorage?.directory]
      .filter((directory): directory is string => directory !== undefined);
    vaults = new VaultService(storage.db, new VaultFiles(credentialPython(storage.directory),
      forbiddenRoots), new ConversionFiles(credentialPython(storage.directory), forbiddenRoots));
    const selected = vaults.list().items[0];
    if (desktop.expectedVaultKey && selected?.locationKey !== desktop.expectedVaultKey) throw new ApiError('VAULT_ACCESS_DENIED');
    if (selected?.locationKey) boundVault = { root: vaults.context(selected.id).root, key: selected.locationKey };
    ingestions = new IngestService(storage.db, vaults, new IngestFiles(credentialPython(storage.directory), storage.directory,
      programRoot, forbiddenRoots));
    const models = new ModelSettings((modelStorage ?? storage).db, new KeychainCredentials(credentialPython(storage.directory)), storage.db);
    const ledger = new ModelLedger(storage.db); ledger.recover(); ledger.batch('notetrail-local');
    const rg = process.env.NOTETRAIL_RG ?? ['/opt/homebrew/bin/rg', '/usr/local/bin/rg', '/usr/bin/rg'].find(file => fs.existsSync(file)) ?? '/opt/homebrew/bin/rg';
    const worker = new WorkerRunner(storage.db, vaults, new Ripgrep(rg), models, ledger, storage.directory);
    const questions = new QuestionService(storage.db, vaults, models, new ConversationService(storage.db, vaults, models),
      new AnswerService(storage.db, vaults), worker, ledger, storage.directory, 'notetrail-local');
    runs = new RunService(storage.db, vaults, ingestions, questions, new ModelProbeService(storage.db, models, ledger, 'notetrail-local'));
    await ingestions.recover();
    app = createApp(new BrowserSession(bootstrapToken), models, vaults, runs, questions); }
  catch (error) { modelStorage?.close(); storage.close(); throw error; }
  app.addHook('onClose', async () => {
    await runs.close(); ingestions.close(); await vaults.close(); modelStorage?.close(); storage.close(); await control?.close();
  });
  try { await app.listen({ host: '127.0.0.1', port }); }
  catch (error) { await app.close(); throw error; }
  function startMonitoring() {
    vaults.startMonitoring();
    runs.watches?.start();
  }
  if (!desktop.deferMonitoring) startMonitoring();
  let stopping: Promise<void> | undefined;
  function stop(): Promise<void> {
    if (stopping) return stopping;
    const timer = setTimeout(() => { console.error('服务未能及时停止。'); process.exit(1); }, 5000);
    timer.unref();
    stopping = app.close().then(() => {
      clearTimeout(timer);
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      console.log('NoteTrail 已停止。');
    }, () => { console.error('停止服务失败。'); process.exit(1); });
    return stopping;
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const address = app.server.address();
  if (!address || typeof address === 'string') { await app.close(); throw new Error('INVALID_LISTENER'); }
  try { control = await openControl(storage.directory, address.port, stop); }
  catch (error) { process.off('SIGINT', stop); process.off('SIGTERM', stop); await app.close(); throw error; }
  const origin = `http://127.0.0.1:${address.port}`;
  // Only the owning parent receives this one-time secret, over its private IPC channel.
  try { desktop.ready({ origin, bootstrapToken, ...(boundVault ? { vault: boundVault } : {}) }); }
  catch (error) { await stop(); throw error; }
  return { stop, startMonitoring, pauseForSwitch: () => runs.pauseForSwitch() };
}
