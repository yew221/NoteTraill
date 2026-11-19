import { fileURLToPath } from 'node:url';
import { hasFields } from '../shared/contracts.js';
import { ApiError } from './contracts.js';
import { VaultFiles, type VaultLocation } from './vault-files.js';

export type Publication = VaultLocation & { vaultId: string; sourceId: string; operationId: string; version: string; filename: string };
export class IngestFiles extends VaultFiles {
  constructor(python: string, private readonly storageRoot: string, projectRoot: string, forbiddenRoots = [storageRoot, projectRoot]) {
    super(python, forbiddenRoots, fileURLToPath(new URL('./ingest-files.py', import.meta.url)));
  }
  async stage(operationId: string, version: string, bytes: Buffer, signal?: AbortSignal): Promise<void> {
    const result = await this.execute('stage', { storageRoot: this.storageRoot, operationId, version, base64: bytes.toString('base64') }, signal);
    if (!hasFields(result, ['staged']) || result.staged !== true) throw new ApiError('SERVICE_UNAVAILABLE');
  }
  async discard(operationId: string, version: string): Promise<void> {
    const result = await this.execute('discard', { storageRoot: this.storageRoot, operationId, version });
    if (!hasFields(result, ['discarded']) || result.discarded !== true) throw new ApiError('SERVICE_UNAVAILABLE');
  }
  async publish(publication: Publication, signal?: AbortSignal, recover = false): Promise<boolean> {
    const result = await this.execute(recover ? 'recover' : 'publish', { storageRoot: this.storageRoot, ...publication }, signal);
    if (!hasFields(result, ['saved']) || typeof result.saved !== 'boolean') throw new ApiError('SERVICE_UNAVAILABLE');
    return result.saved;
  }
}
