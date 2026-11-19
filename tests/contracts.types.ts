import type { ApiResponse, ErrorCode } from '../src/shared/api.js';
import type { Id, IdempotencyIdentity, IdempotencyRecord, RunRef, RunState, ExpectedRevision } from '../src/shared/contracts.js';
import { newId } from '../src/server/contracts.js';

const requestId = newId('request');
const runId = newId('run');
const run: RunRef = { runId, state: 'queued', eventsUrl: `/api/v1/runs/${runId}/events` };
const response: ApiResponse<RunRef> = { data: run, requestId };
const identity: IdempotencyIdentity = { key: 'public-test-key-0001', operation: 'memory.create', scopeId: newId('vault'), payloadHash: 'a'.repeat(64) };
const record: IdempotencyRecord<RunRef> = { identity, result: run };
const revision: ExpectedRevision = { expectedRevision: 1 };
// @ts-expect-error A source ID is not a run ID.
const wrongId: Id<'run'> = newId('source');
// @ts-expect-error Progress stages cannot be used as lifecycle states.
const wrongState: RunState = 'searching';
// @ts-expect-error Unknown error codes cannot leave the backend.
const wrongError: ErrorCode = 'SDK_RAW_ERROR';
// @ts-expect-error JSON strings are not silently converted to revisions.
const wrongRevision: ExpectedRevision = { expectedRevision: '1' };
// @ts-expect-error Memory creation belongs to a vault, not an answer.
const wrongScope: IdempotencyIdentity = { key: 'public-test-key-0002', operation: 'memory.create', scopeId: newId('answer'), payloadHash: 'b'.repeat(64) };
void [response, record, revision, wrongId, wrongState, wrongError, wrongRevision, wrongScope];
