import type { ResumeContext } from '../shared/continuation.js';
import type { Answer } from '../shared/answer.js';
import type { Scope } from '../shared/tools.js';
import { isExcluded } from '../shared/vault.js';
import type { SqliteDatabase } from './storage.js';
import type { VaultService } from './vaults.js';
import type { MessageRow, AcceptedQuestion } from './conversations.js';
import { answerDependencyRuns, checkSources, inScope, normalizeScope, recordSource } from './context-sources.js';
import { ApiError } from './contracts.js';

// Read business messages from SQLite, never Pi's synthetic user/compaction entries.
export async function resumeContext(db:SqliteDatabase,vaults:VaultService,current:MessageRow,vaultId:string,scope:Scope,signal:AbortSignal,check:()=>void) {
  await vaults.scan(vaultId,signal);check();
  const business="(json_extract(input_json,'$.workflow') IS NULL OR length(trim(COALESCE(json_extract(input_json,'$.workflowNote'),'')))>0)";
  const rows=db.prepare(`SELECT * FROM messages WHERE session_id=? AND ordinal<=? AND ${business} ORDER BY ordinal DESC LIMIT 200`).all(current.session_id,current.ordinal) as MessageRow[];
  const total=(db.prepare(`SELECT count(*) AS n FROM messages WHERE session_id=? AND ordinal<=? AND ${business}`).get(current.session_id,current.ordinal) as {n:number}).n;
  const messages:ResumeContext['messages']=[],runs=new Set<string>();let bytes=0,omittedForAccess=0,omittedAnswers=0;
  // This cache exists only while constructing this snapshot. Every outbound request still performs a fresh scan/check.
  const verified=new Map<string,string>();
  for(const row of rows){
    check();const input=JSON.parse(row.input_json) as AcceptedQuestion & {attachment?:{sourceId:string}};
    const text=input.workflow ? input.workflowNote!.trim() : row.text;
    if(bytes+Buffer.byteLength(text)>64000)continue;
    // This explicit new report is independent of an unavailable historical answer it asks to review.
    const dependencies=row.id===current.id&&input.workflow?[row.run_id]:answerDependencyRuns(db,row.run_id);
    try{
      if(row.scope_revision!==current.scope_revision || row.memory_generation!==current.memory_generation ||
        JSON.stringify(normalizeScope(input.scope))!==JSON.stringify(normalizeScope(scope)))throw new ApiError('CONTEXT_CHANGED');
      await checkSources(db,vaults,dependencies,vaultId,scope,signal,verified);check();
      if(input.attachment){const source=vaults.source(input.attachment.sourceId);
        if(source.vaultId!==vaultId || !inScope(scope,source.relativePath) || isExcluded(source.relativePath,vaults.get(vaultId).exclusions) ||
          !['ready','partial'].includes(source.state))throw new ApiError('CONTEXT_CHANGED');
      }
    }catch(error){check();if(!(error instanceof ApiError)||!['CONTEXT_CHANGED','SOURCE_CHANGED','SOURCE_EXCLUDED','SOURCE_MISSING','SOURCE_NOT_READY','DERIVED_MODIFIED','NOT_FOUND'].includes(error.publicError.code))throw error;
      omittedForAccess++;continue;}
    const stored=input.workflow ? undefined : db.prepare('SELECT body_json FROM answers WHERE run_id=?').get(row.run_id) as {body_json:string}|undefined;
    const answer:Answer|undefined=stored?JSON.parse(stored.body_json):undefined;
    const entry:ResumeContext['messages'][number]={id:row.id,ordinal:row.ordinal,createdAt:row.created_at,text,
      ...(answer ? {answer:{id:answer.id,blocks:answer.blocks.map(({id,kind,markdown})=>({id,kind,markdown}))}} : {})};
    let size=Buffer.byteLength(JSON.stringify(entry));
    // Keep a complete user message even when its historical model answer is too long.
    if(bytes+size>64000 && entry.answer){delete entry.answer;omittedAnswers++;size=Buffer.byteLength(JSON.stringify(entry));}
    if(bytes+size>64000)continue;
    bytes+=size;messages.unshift(entry);dependencies.forEach(id=>runs.add(id));
    if(input.attachment)recordSource(db,current.run_id,vaults.source(input.attachment.sourceId));
  }
  const context:ResumeContext={messages,coverage:{firstOrdinal:messages[0]?.ordinal??null,lastOrdinal:messages.at(-1)?.ordinal??null,
    totalMessages:total,includedMessages:messages.length,omittedMessages:total-messages.length,omittedForAccess,omittedAnswers,through:messages.at(-1)?.createdAt??null,generatedAt:current.created_at}};
  return{context,runs:[...runs]};
}
