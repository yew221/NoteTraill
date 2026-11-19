import type { Experiences } from './experiences.js';
import { hasFields, isRevision, type Id } from './contracts.js';
import type { Scope } from './tools.js';
import type { AnswerBlock } from './answer.js';
import type { AnswerIssue } from './evidence-check.js';
import { questionTooLong } from './chat.js';

export type AnswerReview = {
  kind: 'changed' | 'evidence_updated' | 'unchanged' | 'uncertain';
  summary: string;
  changes: Array<{ before: string[]; after: string[]; explanation: string }>;
};
export type ReviewContext = { previous: Array<Pick<AnswerBlock, 'id' | 'kind' | 'markdown'>>; comparisonAvailable: boolean;
  experienceComparison?:true;
  previousExperiences?:Experiences;
  previousChecks?: Array<Pick<AnswerIssue, 'id' | 'kind' | 'blockIds' | 'summary' | 'impact' | 'nextStep'>>;
  changedSources: Array<{ sourceId: string; relativePath: string; state: string }> };
export type WatchInput = { question: string; expectedAnswerRevision: number };
export type WatchPatch = { expectedRevision: number; enabled: boolean; question?: string; retry?: boolean };
export type AnswerWatch = { id: Id<'watch'>; rootAnswerId: Id<'answer'>; latestAnswerId: Id<'answer'>; sessionId: Id<'session'>;
  question: string; scope: Scope; revision: number; enabled: boolean; checkedAt: string | null;
  state: 'paused' | 'pending' | 'updating' | 'checked' | 'failed'; runId: Id<'run'> | null; error: string | null;
  latestReview: AnswerReview | null };
export type WatchVersion = { answerId: Id<'answer'>; previousAnswerId: Id<'answer'> | null; createdAt: string; review: AnswerReview | null; runId: Id<'run'> };
export type WatchDetail = { watch: AnswerWatch; versions: WatchVersion[]; nextCursor: string | null };
export const isWatchQuestion = (s: unknown): s is string => typeof s === 'string' && !!s.trim() && !questionTooLong(s) && !/[\x00\ud800-\udfff]/u.test(s);
export const isWatchInput = (v: unknown): v is WatchInput => hasFields(v, ['question','expectedAnswerRevision']) &&
  isWatchQuestion(v.question) && isRevision(v.expectedAnswerRevision);
export const isWatchPatch = (v: unknown): v is WatchPatch => hasFields(v, ['expectedRevision','enabled'], ['question','retry']) &&
  isRevision(v.expectedRevision) && typeof v.enabled === 'boolean' && (v.question === undefined || isWatchQuestion(v.question)) &&
  (v.retry === undefined || (typeof v.retry === 'boolean' && (!v.retry || v.enabled === true)));
export function isAnswerReview(v: unknown): v is AnswerReview {
  const text = (s: unknown, n: number) => typeof s === 'string' && !!s.trim() && s.length <= n;
  const ids = (s: unknown) => Array.isArray(s) && s.length <= 32 && s.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id));
  return hasFields(v, ['kind','summary','changes']) && ['changed','evidence_updated','unchanged','uncertain'].includes(String(v.kind)) &&
    text(v.summary, 2000) && Array.isArray(v.changes) && v.changes.length <= 32 && v.changes.every(c =>
      hasFields(c, ['before','after','explanation']) && ids(c.before) && ids(c.after) && text(c.explanation, 1000));
}
