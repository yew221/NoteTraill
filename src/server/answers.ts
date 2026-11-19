import { retrospectiveValidationErrors, retrospectiveLabel, type RetrospectiveDraft } from '../shared/retrospective.js';
import { experienceErrors, experienceLabel, type Experiences } from '../shared/experiences.js';
import { createHash } from 'node:crypto';
import { selectableMarkdown, selectedAnswerText } from '../shared/presentation.js';
import { hasFields, isId, isPayloadHash, type Id } from '../shared/contracts.js';
import { isAnswerDraft, isAnswerSelection, type AnswerBlock, type Answer, type AnswerDraft, type AnswerView, type CitationStatus } from '../shared/answer.js';
import { evidenceExcerpt, type Evidence, type Scope, type WebEvidence } from '../shared/tools.js';
import { isExcluded } from '../shared/vault.js';
import { ApiError, checkRevision, newId, requireId } from './contracts.js';
import type { SqliteDatabase } from './storage.js';
import type { VaultService } from './vaults.js';
import { inScope, scopedSources, checkSources, answerDependencyRuns } from './context-sources.js';
import { webUrl } from './web-fetch.js';
import { issueMarkdown, type AnswerIssue, type CheckStatus } from '../shared/evidence-check.js';
import { resumeValidationErrors, resumeLabel, plainMarkdown, resumeBases, type ResumeContext, type ResumeDraft } from '../shared/continuation.js';

type AnswerContext = { experienceComparison?:boolean; runId: Id<'run'>; sessionId: Id<'session'>; vaultId: Id<'vault'>; scope: Scope;
  signal: AbortSignal; check: () => void; conversation?:ResumeContext };
function invalid(): never { throw new ApiError('CITATION_INVALID'); }
const positive = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
function isEvidence(value: unknown): value is Evidence {
  if (!hasFields(value, ['id','runId','sourceId','sourceVersion','representationHash','excerpt','location','originalLocator','origin','warnings']) ||
    !isId(value.id, 'evidence') || !isId(value.runId, 'run') || !isId(value.sourceId, 'source') ||
    !isPayloadHash(value.sourceVersion) || !isPayloadHash(value.representationHash) || typeof value.excerpt !== 'string' ||
    !value.excerpt || Buffer.byteLength(value.excerpt) > 16384 || value.originalLocator !== null || !Array.isArray(value.warnings)) return false;
  const loc = value.location;
  return hasFields(loc, ['kind','startLine','endLine','heading','refersTo'], ['startOffset','endOffset']) && loc.kind === 'markdown_lines' &&
    positive(loc.startLine) && positive(loc.endLine) && loc.endLine >= loc.startLine &&
    (loc.startOffset === undefined || (Number.isSafeInteger(loc.startOffset) && (loc.startOffset as number) >= 0)) &&
    (loc.endOffset === undefined || (Number.isSafeInteger(loc.endOffset) && (loc.endOffset as number) > 0)) &&
    loc.heading === null && (loc.refersTo === 'original' || loc.refersTo === 'extracted');
}
function excerptAt(bytes: Buffer, evidence: Evidence): string {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  return evidenceExcerpt(text, evidence.location) ?? invalid();
}
const sourceUrl = (evidence: Evidence): string => `/api/v1/sources/${evidence.sourceId}/content?view=text&expectedVersion=${evidence.sourceVersion}`;
const fragmentLabel = (e: Evidence): string => e.location.startOffset !== undefined || e.location.endOffset !== undefined ? '，行内片段' : '';
const referenceMarkdown = (e: Evidence, index: number, legacy = false): string =>
  `资料 ${index + 1}（${e.location.refersTo === 'extracted' ? '提取文本' : '原文'}第 ${e.location.startLine}–${e.location.endLine} 行${legacy ? '' : fragmentLabel(e)}）：[查看已核对版本](${sourceUrl(e)})`;
const webLink = (e: WebEvidence) => e.url.replace(/[()]/g, c => c === '(' ? '%28' : '%29');
const webReferenceMarkdown = (e: WebEvidence, index: number): string =>
  `网页 ${index + 1}：[${e.title.replace(/[\\[\]*_`<>]/g, '\\$&')}](${webLink(e)})；获取于 ${e.retrievedAt}；${e.contentKind === 'summary' ? '搜索摘要' : '网页摘录'}（非全文核查）`;
const legacyGeneralLabel = '**通用补充（非资料结论）：** ';
function blockMarkdown(block: AnswerBlock, citations: Evidence[], webCitations: WebEvidence[] = [], legacyGeneral = false, resume?:ResumeDraft, experiences?:Experiences, retrospective?:RetrospectiveDraft): string {
  const labels = { grounded: '', inference: '**推断：** ', general: legacyGeneral ? legacyGeneralLabel : '**模型回答：** ', notice: '**说明：** ', web: '**网页补充：** ' };
  const label=retrospectiveLabel(retrospective,block.id)||resumeLabel(resume,block.id)||experienceLabel(experiences,block.id,block.kind);
  return (label ? `**${plainMarkdown(label)}：**\n\n` : labels[block.kind]) + block.markdown.trim() + block.evidenceIds.map(id => {
    if (block.kind === 'web') { const i = webCitations.findIndex(e => e.id === id); return ` [网页 ${i + 1}](${webLink(webCitations[i])})`; }
    const index = citations.findIndex(item => item.id === id); return ` [资料 ${index + 1}](${sourceUrl(citations[index])})`;
  }).join('');
}
function markdown(draft: AnswerDraft, citations: Evidence[], webCitations: WebEvidence[]): string {
  const blocks = draft.blocks.map(block => blockMarkdown(block, citations, webCitations, false, draft.resume,draft.experiences,draft.retrospective));
  if (citations.length) blocks.push(citations.map((e, index) => referenceMarkdown(e, index)).join('\n\n'));
  if (webCitations.length) blocks.push(webCitations.map(webReferenceMarkdown).join('\n\n'));
  if (draft.checks?.length) blocks.push('## 待核对事项\n\n' + draft.checks.map(issueMarkdown).join('\n\n'));
  if (draft.limitations.length) blocks.push('**资料与检索限制：**\n\n' + draft.limitations.map(text => `- ${text}`).join('\n'));
  return blocks.join('\n\n');
}

export class AnswerService {
  constructor(private readonly db: SqliteDatabase, private readonly vaults: VaultService) {}
  async selection(id: string, input: unknown): Promise<{ vaultId: Id<'vault'>; sessionId: Id<'session'>; text: string; title: string }> {
    if (!isAnswerSelection(input)) throw new ApiError('BAD_REQUEST');
    const answer = this.stored(id); checkRevision(input.expectedAnswerRevision, answer.revision);
    const { start, end, expectedText } = input.selection;
    if (end > answer.markdown.length || answer.markdown.slice(start, end) !== expectedText) throw new ApiError('REVISION_CONFLICT');
    const selectedText = selectedAnswerText(answer.markdown, start, end);
    if (!selectedText.trim()) throw new ApiError('BAD_REQUEST');
    const session = this.db.prepare('SELECT vault_id FROM conversations WHERE id=? AND deletion_state IS NULL').get(answer.sessionId) as { vault_id: Id<'vault'> } | undefined;
    if (!session) throw new ApiError('NOT_FOUND');
    const ids = new Set<string>(), kinds = new Set<AnswerBlock['kind']>(), selectedBlocks = new Set<string>();
    let offset = 0;
    for (const block of answer.blocks) {
      // Historical Markdown and its selection offsets stay unchanged when the displayed label evolves.
      const text = blockMarkdown(block, answer.citations, answer.webCitations, block.kind === 'general' && answer.markdown.startsWith(legacyGeneralLabel, offset), answer.resume,answer.experiences,answer.retrospective);
      if (answer.markdown.slice(offset, offset + text.length) !== text) throw new ApiError('SERVICE_UNAVAILABLE');
      if (start < offset + text.length && end > offset) { block.evidenceIds.forEach(id => ids.add(id)); kinds.add(block.kind); selectedBlocks.add(block.id); }
      offset += text.length + 2;
    }
    for (const [index, e] of answer.citations.entries()) {
      let text = referenceMarkdown(e, index);
      if (answer.markdown.slice(offset, offset + text.length) !== text) text = referenceMarkdown(e, index, true);
      if (answer.markdown.slice(offset, offset + text.length) !== text) throw new ApiError('SERVICE_UNAVAILABLE');
      if (start < offset + text.length && end > offset) ids.add(e.id);
      offset += text.length + 2;
    }
    for (const [index, e] of (answer.webCitations ?? []).entries()) {
      const text = webReferenceMarkdown(e, index);
      if (answer.markdown.slice(offset, offset + text.length) !== text) throw new ApiError('SERVICE_UNAVAILABLE');
      if (start < offset + text.length && end > offset) ids.add(e.id);
      offset += text.length + 2;
    }
    const caseContext:string[]=[];
    for(const c of answer.experiences?.cases??[])if(c.sections.some(s=>s.blockIds.some(id=>selectedBlocks.has(id)))){
      caseContext.push(`### ${plainMarkdown(c.title)}`);
      for(const section of c.sections)for(const id of section.blockIds){
        const block=answer.blocks.find(b=>b.id===id)!;selectedBlocks.add(id);kinds.add(block.kind);block.evidenceIds.forEach(id=>ids.add(id));
        const prose=blockMarkdown(block,answer.citations,answer.webCitations,false,undefined,answer.experiences);
        caseContext.push(selectedAnswerText(prose,0,prose.length));
      }
    }
    const retrospectiveContext:string[]=[];
    if(answer.retrospective && selectedBlocks.size){
      for(const item of answer.retrospective.sections.flatMap(s=>s.items)){
        const block=answer.blocks.find(b=>b.id===item.blockId)!;selectedBlocks.add(block.id);kinds.add(block.kind);block.evidenceIds.forEach(id=>ids.add(id));
        const prose=blockMarkdown(block,answer.citations,answer.webCitations,false,undefined,undefined,answer.retrospective);
        retrospectiveContext.push(selectedAnswerText(prose,0,prose.length));
      }
    }
    let issueOffset = offset + '## 待核对事项\n\n'.length;
    const checks = (answer.checks ?? []).filter(issue => {
      const text = issueMarkdown(issue), at = issueOffset;
      if (answer.markdown.slice(at, at + text.length) !== text) throw new ApiError('SERVICE_UNAVAILABLE');
      issueOffset += text.length + 2;
      return issue.blockIds.some(id => selectedBlocks.has(id)) || (issue.kind === 'coverage' && selectedBlocks.size > 0) ||
        (start < at + text.length && end > at);
    });
    for (const issue of checks) for (const ref of issue.evidence) ids.add(ref.evidenceId);
    const citations = answer.citations.filter(e => ids.has(e.id));
    const references: string[] = [];
    for (const e of citations) {
      const source = this.vaults.source(e.sourceId);
      if (source.vaultId !== session.vault_id) throw new ApiError('CITATION_INVALID');
      const read = await this.vaults.content(source.id, 'text', e.sourceVersion);
      if (read.source.readableRepresentation?.hash !== e.representationHash) throw new ApiError('SOURCE_CHANGED');
      const relative = source.relativePath.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
      references.push(`- 资料 ${answer.citations.findIndex(c=>c.id===e.id)+1}：[原资料](../../../${relative})；${e.location.refersTo === 'extracted' ? '提取文本' : '原文'}第 ${e.location.startLine}–${e.location.endLine} 行${fragmentLabel(e)}；版本 ${e.sourceVersion}`);
    }
    for (const [index, e] of (answer.webCitations ?? []).entries()) if (ids.has(e.id)) references.push(`- ${webReferenceMarkdown(e, index)}`);
    const labels = { grounded: '基于资料的整理', inference: '推断', general: '模型回答（未引用来源）', notice: '说明', web: '网页补充' };
    const resumeItems=(answer.resume??answer.retrospective)?.sections.flatMap(s=>s.items).filter(i=>selectedBlocks.has(i.blockId))??[];
    const conversationProof:string[]=[];
    if(resumeItems.length){
      const original=this.db.prepare('SELECT input_json,scope_revision,memory_generation FROM messages WHERE run_id=?').get(answer.runId) as {input_json:string;scope_revision:number;memory_generation:number}|undefined;
      const generation=(this.db.prepare('SELECT generation FROM memory_state WHERE vault_id=?').get(session.vault_id) as {generation:number}|undefined)?.generation??1;
      if(!original || original.scope_revision!==this.vaults.get(session.vault_id).revision || original.memory_generation!==generation)throw new ApiError('CONTEXT_CHANGED');
      await checkSources(this.db,this.vaults,answerDependencyRuns(this.db,answer.runId),session.vault_id,JSON.parse(original.input_json).scope,new AbortController().signal);
      for(const item of resumeItems){conversationProof.push(`- 性质：${resumeBases[item.basis]}`);
        for(const ref of item.messages)conversationProof.push(`- ${ref.role==='user'?'用户原话':'历史模型表述（非现实结果证据）'}，${ref.answerId?'答案版本 '+ref.answerId:'消息 '+ref.messageId}：${plainMarkdown(ref.quote)}`);}
    }
    const warnings = checks.length ? '\n\n## 与选段有关的待核对事项\n\n' + checks.map(issueMarkdown).join('\n\n') : '';
    const proof=conversationProof.length?'\n\n## 对话依据与性质\n\n'+conversationProof.join('\n'):'';
    const text = `> AI 整理：用户显式保存的回答选段。${[...kinds].map(k => labels[k]).join('、')}。\n\n${selectedText}${caseContext.length?'\n\n## 相关案例背景与适用边界\n\n'+caseContext.join('\n\n'):''}${retrospectiveContext.length?'\n\n## 复盘背景、实际结果与适用条件\n\n'+retrospectiveContext.join('\n\n'):''}${warnings}${proof}\n\n## 选段来源\n\n` +
      (references.join('\n') || '此选段没有关联的知识库依据，不能作为原始资料结论。') + `\n\n保存自回答 ${answer.id}，修订 ${answer.revision}。\n`;
    return { vaultId: session.vault_id, sessionId: answer.sessionId, text, title: input.title?.trim() ?? 'AI 整理选段' };
  }
  private evidence(id: string, runId: string): Evidence {
    const row = this.db.prepare('SELECT * FROM evidence WHERE id=?').get(id) as
      { id: string; run_id: string; source_id: string; source_version: string; representation_hash: string; body_json: string } | undefined;
    if (!row || row.run_id !== runId) invalid();
    const value: unknown = JSON.parse(row.body_json);
    if (!isEvidence(value) || value.id !== row.id || value.runId !== row.run_id || value.sourceId !== row.source_id ||
      value.sourceVersion !== row.source_version || value.representationHash !== row.representation_hash) invalid();
    return value;
  }
  async prepare(draft: AnswerDraft, context: AnswerContext): Promise<Answer> {
    context.check();
    if (!isAnswerDraft(draft)) invalid();
    if(context.experienceComparison&&!draft.experiences)invalid();
    if(experienceErrors(draft.blocks,draft.experiences).length)invalid();
    if(resumeValidationErrors(draft.blocks,draft.resume,context.conversation?.purpose==='retrospective'?undefined:context.conversation).length)invalid();
    if(retrospectiveValidationErrors(draft.blocks,draft.retrospective,context.conversation?.purpose==='retrospective'?context.conversation:undefined).length)invalid();
    for (const block of draft.blocks) {
      if ((['grounded','inference','web'].includes(block.kind) && !block.evidenceIds.length) ||
        (['general','notice'].includes(block.kind) && block.evidenceIds.length)) invalid();
      // Formatting and examples are content, not evidence. Only evidenceIds create verified citations.
      // The renderer escapes HTML and limits link protocols; model links cannot impersonate local evidence.
      const prose = block.markdown.replace(/```[\s\S]*?```|`[^`\n]*`/g, '');
      if (/\]\s*\(\s*(?:\/api\/|notetrail:|file:)|\[(?:资料|网页)\s*\d+\]\s*\(/i.test(prose)) invalid();
    }
    if (draft.outcome === 'answered' && draft.blocks.every(block => block.kind === 'notice')) invalid();
    const issueRefs = (draft.checks ?? []).flatMap(issue => issue.evidence);
    if (draft.checks?.some(issue => issue.blockIds.some(id => !draft.blocks.some(block => block.id === id)))) invalid();
    const citations = [...new Set([...draft.blocks.filter(block => block.kind !== 'web').flatMap(block => block.evidenceIds),
      ...issueRefs.filter(ref => ref.kind === 'local').map(ref => ref.evidenceId)])].map(id => this.evidence(id, context.runId));
    const byEvidence = new Map(citations.map(evidence => [evidence.id, evidence]));
    const grounded = draft.blocks.filter(block => block.kind === 'grounded');
    // If the displayed statement reproduces a passage verbatim, its link must include that passage.
    const passages = new Map(grounded.length ? (this.db.prepare("SELECT id,json_extract(body_json,'$.excerpt') AS text FROM evidence WHERE run_id=?")
      .all(context.runId) as {id: string; text: string}[]).map(row => [row.id, selectableMarkdown(row.text).text.trim()] as const) : []);
    for (const block of grounded) {
      const refs = block.evidenceIds.map(id => byEvidence.get(id)!);
      // A factual block attributes its wording to one source. A separate inference can compare several.
      if (new Set(refs.map(e => e.sourceId)).size !== 1) invalid();
      if (block.sourceQuote && !byEvidence.get(block.sourceQuote.evidenceId)?.excerpt.includes(block.sourceQuote.quote)) invalid();
      const literal = selectableMarkdown(block.markdown).text.trim();
      if (literal && !refs.some(e => passages.get(e.id)?.includes(literal)) &&
          [...passages.values()].some(text => text.includes(literal))) invalid();
    }
    const tools = this.db.prepare('SELECT result_json FROM tool_results WHERE run_id=?').all(context.runId) as { result_json: string }[];
    const webResults = tools.flatMap(row => { const r = JSON.parse(row.result_json); return r.ok && r.data?.kind === 'web_search' && Array.isArray(r.data.results) ? r.data.results as WebEvidence[] : []; });
    const webCitations = [...new Set([...draft.blocks.filter(block => block.kind === 'web').flatMap(block => block.evidenceIds),
      ...issueRefs.filter(ref => ref.kind === 'web').map(ref => ref.evidenceId)])].map(id => {
      const e = webResults.find(e => e.id === id);
      if (!e || e.runId !== context.runId || e.provider !== 'deepseek' || !e.title || !e.excerpt || !Number.isFinite(Date.parse(e.retrievedAt)) ||
        !['content','summary'].includes(e.contentKind)) invalid();
      try { if (webUrl(e.url).href !== e.url) invalid(); } catch { invalid(); }
      return e;
    });
    for (const ref of issueRefs) {
      const evidence = (ref.kind === 'local' ? citations : webCitations).find(e => e.id === ref.evidenceId);
      if (!evidence || !evidence.excerpt.includes(ref.quote)) invalid();
    }
    const checked = new Map<string, Awaited<ReturnType<VaultService['content']>>>();
    for (const evidence of citations) {
      context.check();
      const source = this.vaults.source(evidence.sourceId);
      if (source.vaultId !== context.vaultId || !inScope(context.scope, source.relativePath) ||
        isExcluded(source.relativePath, this.vaults.get(context.vaultId).exclusions)) invalid();
      if (source.version !== evidence.sourceVersion || source.readableRepresentation?.hash !== evidence.representationHash) throw new ApiError('SOURCE_CHANGED');
      const key = `${source.id}:${source.version}`;
      let read = checked.get(key);
      if (!read) { read = await this.vaults.content(source.id, 'text', evidence.sourceVersion, context.signal); checked.set(key, read); }
      context.check();
      const representation = read.source.readableRepresentation!;
      if (createHash('sha256').update(read.bytes).digest('hex') !== evidence.representationHash || evidence.origin !== read.source.origin ||
        evidence.location.refersTo !== (representation.kind === 'original_text' ? 'original' : 'extracted') ||
        JSON.stringify(evidence.warnings) !== JSON.stringify(read.source.warnings) || excerptAt(read.bytes, evidence) !== evidence.excerpt) invalid();
    }
    const limitations = [...draft.limitations], runtimeCoverage: string[] = [];
    const coverageContext=context.conversation?.coverage;
    if(context.conversation?.selectedAnswerUnavailable)runtimeCoverage.push('所选历史答案的依据、范围或背景已变化，未带入该版本正文；不能据此还原当时判断，需重新提供可核对记录。');
    if(coverageContext && (coverageContext.omittedMessages || coverageContext.omittedAnswers))runtimeCoverage.push(`对话整理仅纳入 ${coverageContext.includedMessages}/${coverageContext.totalMessages} 条用户消息；另有 ${coverageContext.omittedAnswers} 份历史模型回答未纳入。容量或当前来源权限不允许完整读取，未纳入不等于没有发生。`);
    if (citations.some(e => e.origin === 'ai_saved')) limitations.push('本次依据包含此前保存的 AI 整理；它是派生内容，不是原始资料。');
    for (const evidence of citations) for (const warning of evidence.warnings) runtimeCoverage.push(warning.message);
    const usedLocal = citations.length > 0 || tools.some(row => {
      const result = JSON.parse(row.result_json); return result.ok && result.data?.kind !== 'web_search';
    });
    if (usedLocal) {
      const unavailable = scopedSources(this.vaults, context.vaultId, context.scope).filter(s => !['ready','excluded'].includes(s.state));
      if (unavailable.length || this.vaults.get(context.vaultId).discovery.state !== 'ready') {
        runtimeCoverage.push('范围内仍有未完整读取或尚未就绪的资料；本次答案不能代表已核查全部资料。');
      }
    }
    for (const row of tools) { const r = JSON.parse(row.result_json);
      if (!r.ok && String(r.error?.code).startsWith('SEARCH_')) runtimeCoverage.push(r.error.message);
      if (r.ok) for (const w of r.warnings ?? []) if (w.code === 'SEARCH_EMPTY') runtimeCoverage.push(w.message);
    }
    if (tools.some(row => { const r = JSON.parse(row.result_json); return !r.ok || r.truncated || r.warnings?.length; })) {
      runtimeCoverage.push('本轮工具报告过读取失败、截断或覆盖限制；未返回的内容不能视为不存在。');
    }
    const checks: AnswerIssue[] = structuredClone(draft.checks ?? []);
    const coverage = [...new Set(runtimeCoverage)];
    limitations.push(...coverage);
    if (coverage.length) checks.push({ id: 'coverage_tools', kind: 'coverage', blockIds: [], summary: '本轮有未完整核查的内容',
      impact: coverage.join(' '), nextStep: '核对资料状态或补充相关材料后，再继续核对；未返回不等于不存在。', evidence: [] });
    const checkStatus: CheckStatus = coverage.length ? 'partial' : draft.checks === undefined ? 'not_checked' :
      !usedLocal && !webCitations.length && !checks.length ? 'not_applicable' : 'reviewed';
    const normalized: AnswerDraft = { ...structuredClone(draft), limitations: [...new Set(limitations)],
      ...(checks.length || draft.checks !== undefined ? { checks } : {}) };
    const now = new Date().toISOString(); context.check();
    return { ...normalized, id: newId('answer'), runId: context.runId, sessionId: context.sessionId,
      createdAt: now, revision: 1, markdown: markdown(normalized, citations, webCitations), citations,
      ...(webCitations.length ? { webCitations } : {}), checkedAt: now, checkStatus,
      ...(coverageContext ? {resumeCoverage:structuredClone(coverageContext)} : {}),
      ...(context.conversation?.requestedAnswer?{retrospectiveBase:{answerId:context.conversation.requestedAnswer.id,createdAt:context.conversation.requestedAnswer.createdAt,available:!!context.conversation.selectedAnswer}}:{}) };
  }
  // Called only inside the run's final transaction, after cancellation and context checks.
  commit(answer: Answer): void {
    if (!this.db.inTransaction) throw new ApiError('SERVICE_UNAVAILABLE');
    this.db.prepare('INSERT INTO answers(id,run_id,session_id,body_json) VALUES (?,?,?,?)')
      .run(answer.id, answer.runId, answer.sessionId, JSON.stringify(answer));
  }
  stored(id: string): Answer {
    requireId(id, 'answer');
    const row = this.db.prepare(`SELECT a.body_json FROM answers a JOIN conversations c ON c.id=a.session_id
      WHERE a.id=? AND c.deletion_state IS NULL`).get(id) as { body_json: string } | undefined;
    if (!row) throw new ApiError('NOT_FOUND');
    return JSON.parse(row.body_json) as Answer;
  }
  async get(id: string, signal = new AbortController().signal): Promise<AnswerView> {
    const answer = this.stored(id), citationStatus: CitationStatus[] = [];
    for (const evidence of answer.citations) {
      let status: CitationStatus['status'] = 'unavailable';
      try {
        const source = this.vaults.source(evidence.sourceId);
        if (source.state === 'excluded' || isExcluded(source.relativePath, this.vaults.get(source.vaultId).exclusions)) status = 'excluded';
        else if (source.state === 'missing') status = 'missing';
        else if (source.version !== evidence.sourceVersion || source.readableRepresentation?.hash !== evidence.representationHash) status = 'changed';
        else {
          await this.vaults.content(source.id, 'text', evidence.sourceVersion, signal); status = 'current';
        }
      } catch (error) {
        const code = error instanceof ApiError ? error.publicError.code : 'SERVICE_UNAVAILABLE';
        if (code === 'SOURCE_MISSING' || code === 'NOT_FOUND') status = 'missing';
        else if (code === 'SOURCE_EXCLUDED' || code === 'PATH_OUTSIDE_SCOPE') status = 'excluded';
        else if (code === 'SOURCE_CHANGED' || code === 'DERIVED_MODIFIED') status = 'changed';
        if (signal.aborted) throw new ApiError('RUN_INTERRUPTED');
      }
      citationStatus.push({ evidenceId: evidence.id, status, contentUrl: status === 'current' ? sourceUrl(evidence) : null });
    }
    return { answer, citationStatus, checkedAt: new Date().toISOString() };
  }
}
