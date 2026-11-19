export const ID_PREFIXES = {
  request: 'req', vault: 'v', source: 's', run: 'r', session: 'c', memory: 'm',
  evidence: 'e', answer: 'a', message: 'msg', segment: 'seg', operation: 'op', call: 'call', block: 'b', watch: 'w',
} as const;
export type IdKind = keyof typeof ID_PREFIXES;
export type Id<K extends IdKind = IdKind> = `${typeof ID_PREFIXES[K]}_${string}`;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isId<K extends IdKind>(value: unknown, kind: K): value is Id<K> {
  if (!Object.hasOwn(ID_PREFIXES, kind)) return false;
  const prefix = `${ID_PREFIXES[kind]}_`;
  return typeof value === 'string' && value.startsWith(prefix) && UUID_V4.test(value.slice(prefix.length));
}

export function hasFields(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

export type Revision = number;
export type ExpectedRevision = { expectedRevision: Revision };
export const isRevision = (value: unknown): value is Revision => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
export const isExpectedRevision = (value: unknown): value is ExpectedRevision =>
  hasFields(value, ['expectedRevision']) && isRevision(value.expectedRevision);

export type IdempotencyKey = string;
export const isIdempotencyKey = (value: unknown): value is IdempotencyKey =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);
export const isPayloadHash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

export const IDEMPOTENT_OPERATIONS = {
  'session.create': 'vault', 'message.create': 'session', 'ingest.create': 'vault', 'vault.refresh': 'vault',
  'source.retry': 'source', 'answer.save': 'answer', 'memory.create': 'vault', 'model.probe': 'vault', 'answer.update': 'watch',
} as const;
export type IdempotentOperation = keyof typeof IDEMPOTENT_OPERATIONS;
export type IdempotencyIdentity = { [O in IdempotentOperation]: {
  key: IdempotencyKey; operation: O; scopeId: Id<typeof IDEMPOTENT_OPERATIONS[O]>; payloadHash: string;
} }[IdempotentOperation];
export type IdempotencyRecord<T> = { identity: IdempotencyIdentity; result: T };
export function isIdempotencyIdentity(value: unknown): value is IdempotencyIdentity {
  return hasFields(value, ['key', 'operation', 'scopeId', 'payloadHash']) && isIdempotencyKey(value.key) &&
    typeof value.operation === 'string' && Object.hasOwn(IDEMPOTENT_OPERATIONS, value.operation) &&
    isId(value.scopeId, IDEMPOTENT_OPERATIONS[value.operation as IdempotentOperation]) && isPayloadHash(value.payloadHash);
}

export const RUN_STATES = ['queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const;
export type RunState = typeof RUN_STATES[number];
export const RUN_KINDS = ['message', 'ingest', 'refresh', 'save_answer', 'model_probe', 'answer_update'] as const;
export type RunKind = typeof RUN_KINDS[number];
export const RUN_STAGES = ['preparing', 'searching', 'reading', 'generating', 'validating', 'fetching',
  'saving', 'converting', 'checking', 'publishing', 'scanning'] as const;
export type RunStage = typeof RUN_STAGES[number];
export const isRunState = (value: unknown): value is RunState => typeof value === 'string' && RUN_STATES.some(state => state === value);
export const isRunKind = (value: unknown): value is RunKind => typeof value === 'string' && RUN_KINDS.some(kind => kind === value);
export const isRunStage = (value: unknown): value is RunStage => typeof value === 'string' && RUN_STAGES.some(stage => stage === value);
export const TERMINAL_RUN_STATES = ['succeeded', 'failed', 'cancelled', 'interrupted'] as const;
export type TerminalRunState = typeof TERMINAL_RUN_STATES[number];
export const isTerminalRunState = (value: unknown): value is TerminalRunState =>
  typeof value === 'string' && TERMINAL_RUN_STATES.some(state => state === value);
export const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  queued: ['running', 'cancelled', 'failed', 'interrupted'],
  running: ['cancelling', 'succeeded', 'failed', 'interrupted'],
  cancelling: ['cancelled', 'failed', 'interrupted'],
  succeeded: [], failed: [], cancelled: [], interrupted: [],
};
export const canTransitionRun = (from: unknown, to: unknown): boolean =>
  isRunState(from) && isRunState(to) && RUN_TRANSITIONS[from].includes(to);

export type RunRef = { runId: Id<'run'>; state: RunState; eventsUrl: string };
export function isRunRef(value: unknown): value is RunRef {
  return hasFields(value, ['runId', 'state', 'eventsUrl']) && isId(value.runId, 'run') && isRunState(value.state) &&
    value.eventsUrl === `/api/v1/runs/${value.runId}/events`;
}
