import { randomUUID } from 'node:crypto';
import { makeError, type AppError, type ErrorCode } from '../shared/api.js';
import { ID_PREFIXES, isId, isIdempotencyKey, isIdempotencyIdentity, isRevision,
  type Id, type IdKind, type IdempotencyIdentity, type Revision } from '../shared/contracts.js';

export const newId = <K extends IdKind>(kind: K): Id<K> => `${ID_PREFIXES[kind]}_${randomUUID()}`;

export class ApiError extends Error {
  readonly publicError: AppError;
  constructor(code: ErrorCode, details?: unknown) {
    const error = makeError(code, details);
    super(error.message);
    this.name = 'ApiError';
    this.publicError = error;
  }
}

export function requireId<K extends IdKind>(value: unknown, kind: K): Id<K> {
  if (!isId(value, kind)) throw new ApiError('BAD_REQUEST');
  return value;
}
export function requireIdempotencyKey(value: unknown): string {
  if (!isIdempotencyKey(value)) throw new ApiError('BAD_REQUEST');
  return value;
}
export function requireRevision(value: unknown): Revision {
  if (!isRevision(value)) throw new ApiError('BAD_REQUEST');
  return value;
}
export function checkRevision(expected: unknown, current: Revision): void {
  const revision = requireRevision(expected);
  if (!isRevision(current)) throw new ApiError('SERVICE_UNAVAILABLE');
  if (revision !== current) throw new ApiError('REVISION_CONFLICT', { currentRevision: current });
}

// This only compares validated identities; persistence and atomic result replay belong to the store.
export function checkIdempotency(existing: IdempotencyIdentity | null, incoming: IdempotencyIdentity): 'new' | 'replay' {
  if (!isIdempotencyIdentity(incoming)) throw new ApiError('BAD_REQUEST');
  if (existing === null) return 'new';
  if (!isIdempotencyIdentity(existing) || existing.key !== incoming.key) throw new ApiError('SERVICE_UNAVAILABLE');
  if (existing.operation !== incoming.operation || existing.scopeId !== incoming.scopeId || existing.payloadHash !== incoming.payloadHash) {
    throw new ApiError('IDEMPOTENCY_CONFLICT');
  }
  return 'replay';
}
