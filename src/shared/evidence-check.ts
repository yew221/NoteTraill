import { hasFields, isId, type Id } from './contracts.js';

export type IssueEvidence = { kind: 'local' | 'web'; evidenceId: Id<'evidence'>; quote: string };
export type AnswerIssue = { id: string; kind: 'conflict' | 'gap' | 'coverage'; blockIds: string[];
  summary: string; impact: string; nextStep: string; evidence: IssueEvidence[] };
export type CheckStatus = 'not_checked' | 'reviewed' | 'partial' | 'not_applicable';
export const issueLabels = { conflict: '资料存在分歧', gap: '结论缺少证据', coverage: '本轮核查不完整' };
const text = (s: unknown, n: number) => typeof s === 'string' && !!s.trim() && s.length <= n && !/[\x00\ud800-\udfff]/u.test(s);
export function isAnswerChecks(value: unknown): value is AnswerIssue[] {
  return Array.isArray(value) && value.length <= 12 && value.every(issue =>
    hasFields(issue, ['id','kind','blockIds','summary','impact','nextStep','evidence']) &&
    typeof issue.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(issue.id) && !issue.id.startsWith('coverage_') &&
    typeof issue.kind==='string' && ['conflict','gap'].includes(issue.kind) && Array.isArray(issue.blockIds) && issue.blockIds.length > 0 && issue.blockIds.length <= 32 &&
    issue.blockIds.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)) && new Set(issue.blockIds).size === issue.blockIds.length &&
    text(issue.summary, 600) && text(issue.impact, 600) && text(issue.nextStep, 600) && Array.isArray(issue.evidence) && issue.evidence.length <= 8 &&
    issue.evidence.every(ref => hasFields(ref, ['kind','evidenceId','quote']) && typeof ref.kind==='string' && ['local','web'].includes(ref.kind) &&
      isId(ref.evidenceId, 'evidence') && text(ref.quote, 1200)) &&
    (issue.kind !== 'conflict' || new Set(issue.evidence.map(ref => ref.quote.trim())).size >= 2)) &&
    new Set(value.map(issue => issue.id)).size === value.length;
}
export function issueMarkdown(issue: AnswerIssue): string {
  // These fields are plain prose, never model-authored citation links or Markdown instructions.
  const plain = (s: string) => s.replace(/[\\`*_{}\[\]()#<>!|]/g, '\\$&');
  return `**${issueLabels[issue.kind]}：${plain(issue.summary)}**\n\n影响：${plain(issue.impact)}\n\n建议核对：${plain(issue.nextStep)}` +
    issue.evidence.map(ref => `\n\n原文片段：\n\n> ${plain(ref.quote).replace(/\n/g, '\n> ')}`).join('');
}
