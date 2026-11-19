import type { AppError } from './api.js';
import type { Id, RunStage, RunState } from './contracts.js';
import type { SourceState } from './vault.js';
import type { MemoryResult } from './memory.js';

export type RefreshResult = { scanned: number; ready: number; partial: number; failed: number; skipped: number;
  pending: number; unsupported: number; needsReview: number; missing: number; excluded: number };
export type RunResult = RefreshResult | { sourceId: Id<'source'>; sourceState: SourceState } | { answerId: Id<'answer'> } |
  { modelAvailable: true; modelRevision: number } | MemoryResult;
export type Run = {
  id: Id<'run'>; kind: 'refresh' | 'ingest' | 'message' | 'model_probe' | 'answer_update'; state: RunState; sessionId: Id<'session'> | null; vaultId: Id<'vault'>;
  resolvedAction: 'ingest' | 'save_answer' | 'ask' | 'remember' | 'update_memory' | 'forget' | null; stage: RunStage | null; createdAt: string; startedAt: string | null; endedAt: string | null;
  preview?: string;
  attachmentSourceId?: Id<'source'>;
  result: RunResult | null; error: AppError | null;
  usage: { inputTokens: number | null; outputTokens: number | null; modelRequests: number; toolCalls: number; readBytes: number;
    searchRequests?: number;
    cost: { value: number | null; currency: 'CNY'; basis: 'estimate' | 'unknown' } };
  warnings: Array<{ code: string; message: string; sourceId: Id<'source'> | null }>;
};
export type RunEvent = {
  eventId: number; runId: Id<'run'>; type: 'run.state' | 'run.error' | 'run.completed' | 'source.updated' | 'answer.final' | 'answer.preview';
  at: string; payload: object;
};
