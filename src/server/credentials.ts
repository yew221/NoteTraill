import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { hasFields } from '../shared/contracts.js';
import { isApiKey, type ModelConfig } from '../shared/model.js';
import { ApiError } from './contracts.js';

export type CredentialBinding = { service: string; account: string };
export interface CredentialStore {
  write(binding: CredentialBinding, secret: string): Promise<void>;
  read(binding: CredentialBinding): Promise<string>;
  remove(binding: CredentialBinding): Promise<void>;
}
export function credentialBinding(model: ModelConfig, id: string): CredentialBinding {
  const hash = createHash('sha256').update(`${model.provider}\0${model.baseUrl}`).digest('hex');
  return { service: `com.notetrail.model.${hash}`, account: id };
}
export function credentialPython(dataDirectory: string): string {
  if (process.env.NOTETRAIL_PYTHON !== undefined) return process.env.NOTETRAIL_PYTHON;
  const managed = path.join(dataDirectory, 'runtime/python/bin/python3');
  if (fs.existsSync(managed)) return managed;
  // Current development setup; the installer will provide the managed runtime above.
  return path.join(os.homedir(), '.local/share/uv/tools/markitdown/bin/python');
}

export class KeychainCredentials implements CredentialStore {
  constructor(private readonly python: string,
    private readonly helper = fileURLToPath(new URL('./keychain.py', import.meta.url))) {}

  private async execute(op: 'read' | 'write' | 'remove', binding: CredentialBinding, secret?: string): Promise<unknown> {
    if (!path.isAbsolute(this.python) || !path.isAbsolute(this.helper) ||
        !/^com\.notetrail\.model\.[0-9a-f]{64}$/.test(binding.service) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(binding.account) ||
        (op === 'write' && !isApiKey(secret))) throw new ApiError('CREDENTIAL_STORE_UNAVAILABLE');
    const input = JSON.stringify({ op, ...binding, ...(op === 'write' ? { secret } : {}) });
    return new Promise((resolve, reject) => {
      const child = spawn(this.python, ['-I', '-B', this.helper], {
        env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, stdio: ['pipe', 'pipe', 'ignore'],
      });
      let output = Buffer.alloc(0), failed = false;
      const fail = () => { failed = true; child.kill('SIGKILL'); };
      const timer = setTimeout(fail, 5000);
      child.once('error', fail);
      child.stdin.once('error', fail);
      child.stdout.on('data', (chunk: Buffer) => {
        if (output.length + chunk.length > 4096) fail();
        else output = Buffer.concat([output, chunk]);
      });
      child.once('close', code => {
        clearTimeout(timer);
        try {
          if (failed || code !== 0) throw new Error('unavailable');
          const response: unknown = JSON.parse(output.toString('utf8'));
          if (op === 'read' && hasFields(response, ['ok', 'error']) && response.ok === false && response.error === 'missing') {
            throw new ApiError('CONFIG_REQUIRED');
          }
          if (!hasFields(response, op === 'read' ? ['ok', 'value'] : ['ok']) || response.ok !== true ||
              (op === 'read' && !isApiKey(response.value))) throw new Error('unavailable');
          resolve(op === 'read' ? response.value : undefined);
        } catch (error) {
          reject(error instanceof ApiError ? error : new ApiError('CREDENTIAL_STORE_UNAVAILABLE'));
        } finally { output.fill(0); }
      });
      // Credentials are sent only through the child pipe, never argv, environment or a file.
      child.stdin.end(input);
    });
  }
  async write(binding: CredentialBinding, secret: string): Promise<void> { await this.execute('write', binding, secret); }
  async read(binding: CredentialBinding): Promise<string> { return await this.execute('read', binding) as string; }
  async remove(binding: CredentialBinding): Promise<void> { await this.execute('remove', binding); }
}
