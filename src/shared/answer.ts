import { isRetrospectiveDraft, retrospectiveSections, type RetrospectiveDraft } from './retrospective.js';
import { isExperiences, experienceSections, type Experiences } from './experiences.js';
import { hasFields, isId, isRevision, type Id } from './contracts.js';
import type { Evidence, WebEvidence } from './tools.js';
import { isAnswerReview, type AnswerReview } from './watch.js';
import { isAnswerChecks, type AnswerIssue, type CheckStatus } from './evidence-check.js';
import { isResumeDraft, resumeSections, type ResumeDraft, type ResumeCoverage } from './continuation.js';

export const ANSWER_LIMITS = Object.freeze({ blockChars: 48000, draftChars: 96000, serializedChars: 100000 });

export type AnswerBlock = { id: string; kind: 'grounded' | 'inference' | 'general' | 'notice' | 'web'; markdown: string; evidenceIds: Id<'evidence'>[];
  sourceQuote?: { evidenceId: Id<'evidence'>; quote: string } };
export type AnswerDraft = { outcome: 'answered' | 'insufficient_evidence'; blocks: AnswerBlock[]; limitations: string[]; review?: AnswerReview; checks?: AnswerIssue[]; resume?:ResumeDraft; retrospective?:RetrospectiveDraft; experiences?:Experiences };
export type Answer = AnswerDraft & { id: Id<'answer'>; runId: Id<'run'>; sessionId: Id<'session'>;
  createdAt: string; revision: number; markdown: string; citations: Evidence[]; webCitations?: WebEvidence[]; checkedAt: string; checkStatus?: CheckStatus; resumeCoverage?:ResumeCoverage; retrospectiveBase?:{answerId:Id<'answer'>;createdAt:string;available:boolean} };
export type CitationStatus = { evidenceId: Id<'evidence'>; status: 'current' | 'changed' | 'missing' | 'excluded' | 'unavailable';
  contentUrl: string | null };
export type AnswerView = { answer: Answer; citationStatus: CitationStatus[]; checkedAt: string };
export type AnswerSelection = { expectedAnswerRevision: number; selection: { start: number; end: number; expectedText: string }; title?: string };
export function isAnswerSelection(value: unknown): value is AnswerSelection {
  if (!hasFields(value, ['expectedAnswerRevision','selection'], ['title']) || !isRevision(value.expectedAnswerRevision) ||
    !hasFields(value.selection, ['start','end','expectedText'])) return false;
  const s = value.selection;
  return typeof s.start === 'number' && Number.isSafeInteger(s.start) && s.start >= 0 &&
    typeof s.end === 'number' && Number.isSafeInteger(s.end) && s.end > s.start &&
    typeof s.expectedText === 'string' && s.expectedText.trim().length > 0 && s.expectedText.length <= 64000 &&
    !/[\x00\ud800-\udfff]/u.test(s.expectedText) &&
    (value.title === undefined || (typeof value.title === 'string' && value.title.trim().length > 0 && value.title.length <= 200 &&
      !/[\x00-\x1f\x7f\ud800-\udfff]/u.test(value.title)));
}
export function isAnswerDraft(value: unknown): value is AnswerDraft {
  if (!hasFields(value, ['outcome','blocks','limitations'], ['review','checks','resume','experiences','retrospective']) || [value.resume,value.experiences,value.retrospective].filter(v=>v!==undefined).length>1 || (value.retrospective!==undefined && !isRetrospectiveDraft(value.retrospective)) || (value.resume !== undefined && !isResumeDraft(value.resume)) || (value.experiences!==undefined && !isExperiences(value.experiences)) || (value.review !== undefined && !isAnswerReview(value.review)) ||
    (value.checks !== undefined && !isAnswerChecks(value.checks)) || (typeof value.outcome!=='string' || !['answered','insufficient_evidence'].includes(value.outcome)) ||
    !Array.isArray(value.blocks) || value.blocks.length < 1 || value.blocks.length > 32 || !Array.isArray(value.limitations) ||
    value.limitations.length > 20 || value.limitations.some(item => typeof item !== 'string' || !item.trim() || item.length > 1000)) return false;
  return value.blocks.every(block => hasFields(block, ['id','kind','markdown','evidenceIds'], ['sourceQuote']) && typeof block.id === 'string' &&
    /^[A-Za-z0-9_-]{1,64}$/.test(block.id) && typeof block.kind==='string' && ['grounded','inference','general','notice','web'].includes(block.kind) &&
    typeof block.markdown === 'string' && block.markdown.trim().length > 0 && block.markdown.length <= ANSWER_LIMITS.blockChars &&
    Array.isArray(block.evidenceIds) && block.evidenceIds.length <= 20 && block.evidenceIds.every(id => isId(id, 'evidence')) &&
    new Set(block.evidenceIds).size === block.evidenceIds.length &&
    (block.sourceQuote === undefined || (block.kind === 'grounded' && hasFields(block.sourceQuote, ['evidenceId','quote']) &&
      isId(block.sourceQuote.evidenceId, 'evidence') && block.evidenceIds.includes(block.sourceQuote.evidenceId) &&
      typeof block.sourceQuote.quote === 'string' && !!block.sourceQuote.quote.trim() && block.sourceQuote.quote.length <= 1200))) &&
    new Set(value.blocks.map(block => block.id)).size === value.blocks.length && JSON.stringify(value).length <= ANSWER_LIMITS.draftChars;
}
export function parseAnswerDraft(text: string): AnswerDraft | null {
  if (text.length > ANSWER_LIMITS.serializedChars) return null;
  const body = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1');
  try {
    const value: unknown = JSON.parse(body);
    if (hasFields(value, ['outcome','blocks','limitations'], ['review','checks','resume','experiences','retrospective']) && Array.isArray(value.blocks)) {
      for(const block of value.blocks)if(hasFields(block,['id','kind','markdown'],['resume','experience','retrospective']) && ['general','notice'].includes(String(block.kind)))block.evidenceIds=[];
      // Inline metadata avoids asking the model to maintain a second set of block IDs.
      // Only shape is transformed; text, references and classifications still pass the same validator.
      if (value.resume===undefined && value.blocks.some(block=>hasFields(block,['id','kind','markdown','evidenceIds','resume'],['sourceQuote']))) {
        const sections=Object.keys(resumeSections).map(kind=>({kind,items:[] as unknown[]}));
        const normalized=[];
        for(const block of value.blocks){
          if(hasFields(block,['id','kind','markdown','evidenceIds','resume'],['sourceQuote']) && hasFields(block.resume,['section','basis','messages'])){
            const metadata=block.resume;const section=sections.find(s=>s.kind===metadata.section);if(!section)return null;
            section.items.push({blockId:block.id,basis:block.resume.basis,messages:block.resume.messages});
            const {resume:_metadata,...content}=block;normalized.push(content);
          }else normalized.push(block);
        }
        value.blocks=normalized;value.resume={sections};
      }
      if(value.retrospective===undefined && (value.blocks as unknown[]).some(block=>hasFields(block,['id','kind','markdown','evidenceIds','retrospective'],['sourceQuote']))){
        const sections=Object.keys(retrospectiveSections).map(kind=>({kind,items:[] as unknown[]})),normalized=[];
        for(const block of value.blocks as unknown[]){
          if(hasFields(block,['id','kind','markdown','evidenceIds','retrospective'],['sourceQuote']) && hasFields(block.retrospective,['section','basis','messages'])){
            const meta=block.retrospective,section=sections.find(s=>s.kind===meta.section);if(!section)return null;
            section.items.push({blockId:block.id,basis:meta.basis,messages:meta.messages});
            const {retrospective:_meta,...content}=block;normalized.push(content);
          }else normalized.push(block);
        }
        value.blocks=normalized;value.retrospective={sections};
      }
      if(value.experiences===undefined && (value.blocks as unknown[]).some(block=>hasFields(block,['id','kind','markdown','evidenceIds','experience'],['sourceQuote']))){
        const cases:Experiences['cases']=[],normalized=[];
        for(const block of value.blocks as unknown[]){
          if(hasFields(block,['id','kind','markdown','evidenceIds','experience'],['sourceQuote'])&&hasFields(block.experience,['caseTitle','section'])&&typeof block.experience.caseTitle==='string'){
            const meta=block.experience;
            let c=cases.find(c=>c.title===meta.caseTitle);
            if(!c){c={title:meta.caseTitle as string,sections:Object.keys(experienceSections).map(kind=>({kind:kind as keyof typeof experienceSections,blockIds:[]}))};cases.push(c);}
            const section=c.sections.find(s=>s.kind===meta.section);if(!section||typeof block.id!=='string')return null;section.blockIds.push(block.id);
            const {experience:_meta,...content}=block;normalized.push(content);
          }else normalized.push(block);
        }
        value.blocks=normalized;value.experiences={cases};
      }
      // A missing gap-evidence list means no supporting excerpt; never repair conflict evidence.
      if (Array.isArray(value.checks)) for (const issue of value.checks) {
        if (hasFields(issue,['id','kind','blockIds','summary','impact','nextStep']) && issue.kind==='gap') issue.evidence=[];
      }
      // Source-free model blocks may omit an empty list; never infer or repair actual citations.
      for (const block of value.blocks as unknown[]) {
        if (hasFields(block, ['id','kind','markdown']) && ['general','notice'].includes(String(block.kind))) block.evidenceIds = [];
      }
    }
    return isAnswerDraft(value) ? value : null;
  } catch { return null; }
}
