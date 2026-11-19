import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasFields, isPayloadHash } from '../shared/contracts.js';
import type { Source } from '../shared/vault.js';
import { ApiError } from './contracts.js';
import { VaultFiles, type VaultLocation } from './vault-files.js';
import { parseAttachment } from './conversion-sandbox.js';
import { isErrorCode } from '../shared/api.js';

export const MAX_CONVERTED_BYTES = 20 * 1024 * 1024;
const EXTRACTOR = 'markitdown/0.1.9;notetrail/1';
export type ConversionInput = VaultLocation & { vaultId: string; sourceId: string; relativePath: string; expectedVersion: string };
export type Extracted = { state: 'ready' | 'partial'; warningCodes: string[]; hash: string; extractorVersion: string; base64: string };
export type Derived = Omit<Extracted, 'base64'> & { relativePath: string };
export function conversionInput(location: VaultLocation, source: Source): ConversionInput {
  if (!source.version) throw new ApiError('SOURCE_NOT_READY');
  return { root: location.root, identity: location.identity, exclusions: location.exclusions,
    vaultId: source.vaultId, sourceId: source.id, relativePath: source.relativePath, expectedVersion: source.version };
}
function validResult(value: Record<string, unknown>): boolean {
  return ['ready', 'partial'].includes(value.state as string) && isPayloadHash(value.hash) && value.extractorVersion === EXTRACTOR &&
    JSON.stringify(value.warningCodes) === JSON.stringify(value.state === 'partial' ? ['EXTRACTION_PARTIAL'] : []);
}
function bytes(base64: string, hash: string): Buffer {
  const output = Buffer.from(base64, 'base64');
  if (output.length > MAX_CONVERTED_BYTES || output.toString('base64') !== base64 ||
      createHash('sha256').update(output).digest('hex') !== hash) throw new ApiError('SERVICE_UNAVAILABLE');
  try { if (new TextDecoder('utf-8', { fatal: true }).decode(output).includes('\0')) throw new Error(); }
  catch { throw new ApiError('SERVICE_UNAVAILABLE'); }
  return output;
}
export class ConversionFiles extends VaultFiles {
  private readonly originals: VaultFiles;
  private readonly stopped = new AbortController();
  constructor(private readonly parserPython: string, forbiddenRoots: string[]) {
    super(parserPython, forbiddenRoots, fileURLToPath(new URL('./conversion-files.py', import.meta.url)));
    this.originals = new VaultFiles(parserPython, forbiddenRoots);
  }
  override close(): void { this.stopped.abort(); this.originals.close(); super.close(); }
  async extract(input: ConversionInput, signal?: AbortSignal): Promise<Extracted> {
    const combined = signal ? AbortSignal.any([signal, this.stopped.signal]) : this.stopped.signal;
    const location = { root: input.root, identity: input.identity, exclusions: input.exclusions };
    const original = await this.originals.read(location, input.relativePath, input.expectedVersion, combined);
    const response = await parseAttachment(this.parserPython, original, path.extname(input.relativePath).toLowerCase(), combined);
    if (hasFields(response, ['ok','error']) && response.ok === false && isErrorCode(response.error) &&
        ['UNSUPPORTED_FORMAT','FILE_TOO_LARGE','EXTRACTION_EMPTY','CONVERSION_FAILED','BUDGET_EXCEEDED','SERVICE_UNAVAILABLE','URL_FETCH_FAILED'].includes(response.error)) throw new ApiError(response.error);
    if (!hasFields(response, ['ok','value']) || response.ok !== true || !hasFields(response.value, ['state','warningCodes','textBase64']) ||
        typeof response.value.textBase64 !== 'string') throw new ApiError('CONVERSION_FAILED');
    const parsed = response.value, text = Buffer.from(parsed.textBase64 as string, 'base64');
    if (text.toString('base64') !== parsed.textBase64 || text.length > MAX_CONVERTED_BYTES) throw new ApiError('CONVERSION_FAILED');
    const info = { extractorVersion: EXTRACTOR, sourceId: input.sourceId, sourcePathAtExtraction: input.relativePath, sourceVersion: input.expectedVersion };
    const output = Buffer.concat([Buffer.from(`---\nnotetrail: ${JSON.stringify(info)}\n---\n\n`), text]);
    const result = { state: parsed.state, warningCodes: parsed.warningCodes, hash: createHash('sha256').update(output).digest('hex'),
      extractorVersion: EXTRACTOR, base64: output.toString('base64') };
    if (!validResult(result)) throw new ApiError('CONVERSION_FAILED');
    bytes(result.base64, result.hash);
    await this.originals.read(location, input.relativePath, input.expectedVersion, combined);
    return result as Extracted;
  }
  private validate(input: ConversionInput, result: unknown): Derived {
    if (!hasFields(result, ['state', 'warningCodes', 'hash', 'extractorVersion', 'relativePath']) || !validResult(result) ||
        result.relativePath !== `助手资料/提取文本/${input.sourceId}/${input.expectedVersion}.md`) throw new ApiError('SERVICE_UNAVAILABLE');
    return result as Derived;
  }
  async check(input: ConversionInput, expectedHash: string | null = null, signal?: AbortSignal): Promise<Derived | null> {
    const result = await this.execute('derived_check', { ...input, expectedHash }, signal);
    return result === null ? null : this.validate(input, result);
  }
  async publish(input: ConversionInput, extracted: Extracted, signal?: AbortSignal): Promise<Derived> {
    const result = await this.execute('derived_publish', { ...input, expectedHash: extracted.hash,
      base64: extracted.base64, state: extracted.state, warningCodes: extracted.warningCodes }, signal);
    const published = this.validate(input, result);
    if (published.hash !== extracted.hash) throw new ApiError('SERVICE_UNAVAILABLE');
    return published;
  }
  async readDerived(input: ConversionInput, expectedHash: string, signal?: AbortSignal): Promise<Buffer> {
    const result = await this.execute('derived_read', { ...input, expectedHash }, signal);
    if (result === null) throw new ApiError('SOURCE_NOT_READY');
    if (!hasFields(result, ['state', 'warningCodes', 'hash', 'extractorVersion', 'relativePath', 'base64']) ||
        typeof result.base64 !== 'string' || result.hash !== expectedHash) throw new ApiError('SERVICE_UNAVAILABLE');
    const { base64, ...projection } = result;
    this.validate(input, projection);
    return bytes(base64, expectedHash);
  }
}
