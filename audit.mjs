import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';

const ID=/^[A-Za-z0-9_-]{1,80}$/;
const assessments=['VERIFIED','LIKELY','DESIGN','FALSE_POSITIVE'];
const priorities=['P0','P1','P2','P3'];
const categories=['requirement_miss','logic_bug','api_error','hallucinated_api','security','regression','edge_case','test_gap','overengineering','performance','other'];
const statuses=['open','fixed','not_fixed','regression'];
const strings=['task_name','task_type','delegation_reason'];
const arrays=['scope','acceptance_criteria','validation_plan','high_risk_operations'];
const observations=['good_performance','exposed_problems','model_observations','agent_observations','product_observations','mcp_observations','requirement_observations','zhipu_feedback'];
const check=(v,m)=>{if(!v)throw new Error(m);};
const nonempty=v=>typeof v==='string'&&v.trim().length>0;
const hash=v=>createHash('sha256').update(v).digest('hex');
export function projectHash(p){return hash(path.resolve(p).toLowerCase()).slice(0,16);}
export function baseRoot(){
 if(process.env.ZCODE_BRIDGE_RUNTIME_ROOT)return process.env.ZCODE_BRIDGE_RUNTIME_ROOT;
 const base=path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'zcode-mcp-bridge');
 const locator=path.join(base,'authority-location.json');
 if(!fs.existsSync(locator))return base;
 const value=JSON.parse(fs.readFileSync(locator,'utf8'));
 check(typeof value.root==='string'&&path.isAbsolute(value.root),'authority-location.root 必须为绝对路径');return value.root;
}
function real(p){let q=path.resolve(p),tail=[];while(!fs.existsSync(q)){tail.unshift(path.basename(q));const n=path.dirname(q);check(n!==q,'路径不存在');q=n;}return path.join(fs.realpathSync(q),...tail);}
export function auditRoot(project){
 const p=real(project),root=path.join(baseRoot(),'audits',projectHash(project)),r=real(root);
 check(r!==p&&!r.startsWith(p+path.sep),'审计区必须位于项目外');return root;
}
function directory(project,id){check(ID.test(id||''),'无效 task_id');const root=auditRoot(project),d=path.join(root,id);check(real(d)===path.join(real(root),id),'审计目录链接越界');return d;}
function safeFile(d,name){const p=path.join(d,name);check(real(p)===path.join(real(d),name),'审计文件链接越界');return p;}
function atomic(p,v){const tmp=p+'.'+randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(v,null,2)+'\n',{flag:'wx'});try{fs.renameSync(tmp,p);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}}
function exclusive(p,v){const fd=fs.openSync(p,'wx');try{fs.writeFileSync(fd,JSON.stringify(v,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function locked(d,fn){
 fs.mkdirSync(d,{recursive:true});const lock=safeFile(d,'.lock');let fd;
 for(let i=0;i<100;i++){try{fd=fs.openSync(lock,'wx');break;}catch(e){if(e.code!=='EEXIST')throw e;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}}
 check(fd!==undefined,'审计锁被占用；若进程已崩溃，请核实后人工移除 .lock');
 try{return fn();}finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
export function validateMetadata(a){
 check(a&&typeof a==='object'&&!Array.isArray(a),'缺少必填 audit 对象');
 for(const k of strings)check(nonempty(a[k]),'audit.'+k+' 必填');
 for(const k of arrays)check(Array.isArray(a[k])&&a[k].every(nonempty)&&(k==='high_risk_operations'||a[k].length>0),'audit.'+k+' 必须为字符串数组');
 check(['low','medium','high'].includes(a.risk_level),'audit.risk_level 非法');
 return Object.fromEntries([...strings,...arrays,'risk_level'].map(k=>[k,a[k]]));
}
export function readAudit(project,id){
 const d=directory(project,id);const text=fs.readFileSync(safeFile(d,'events.jsonl'),'utf8');
 check(text.endsWith('\n'),'审计末尾不完整，拒绝使用');
 const events=text.trim().split('\n').map(JSON.parse);
 let previous=null;
 events.forEach((e,i)=>{const {digest,...body}=e;check(e.seq===i+1&&e.previous===previous&&digest===hash(JSON.stringify(body)),'审计事件完整性失败');previous=digest;});
 check(events[0]?.type==='task_created','缺少 task_created');return {directory:d,events,task:events[0].data};
}
function append(d,events,type,data){
 const body={seq:events.length+1,at:new Date().toISOString(),type,previous:events.at(-1)?.digest||null,data};
 const event={...body,digest:hash(JSON.stringify(body))};
 const fd=fs.openSync(safeFile(d,'events.jsonl'),'a');try{fs.writeFileSync(fd,JSON.stringify(event)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 events.push(event);return event;
}
export function exists(project,id){return fs.existsSync(path.join(directory(project,id),'events.jsonl'));}
const runPhase=r=>r.phase||1;
const runs=e=>e.filter(x=>['run_started','followup_started'].includes(x.type));
const reviews=e=>e.filter(x=>x.type==='review_recorded');
const ended=(e,id)=>e.some(x=>['run_returned','run_failed','run_stopped','run_timed_out'].includes(x.type)&&x.data.run_id===id);
const latestFindings=e=>{const m=new Map();for(const r of reviews(e))for(const f of r.data.findings)m.set(f.finding_key,f);return [...m.values()];};
const blockers=e=>latestFindings(e).filter(f=>f.assessment==='VERIFIED'&&['P0','P1'].includes(f.priority)&&f.status!=='fixed');
export function statistics(events){
 const rs=reviews(events),all=latestFindings(events),counts=Object.fromEntries([...assessments,...priorities].map(k=>[k,0]));
 for(const f of all){counts[f.assessment]++;if(f.assessment==='VERIFIED')counts[f.priority]++;}
 let fixed=0,regressions=0;
 for(const f of all){const history=rs.flatMap(r=>r.data.findings.filter(x=>x.finding_key===f.finding_key).map(x=>({...x,executor:r.data.executor})));
  const hadOpen=history.slice(0,-1).some(x=>x.assessment==='VERIFIED'&&x.status!=='fixed');
  if(hadOpen&&f.assessment==='VERIFIED'&&f.status==='fixed'&&history.at(-1).executor==='zcode')fixed++;
  if(history.some(x=>x.assessment==='VERIFIED'&&x.status==='regression'))regressions++;
 }
 const legacy=events[0]?.data.historical===true||events[0]?.data.migrated===true;
 return {review_rounds:rs.length,first_pass:legacy?null:rs.length?rs[0].data.verdict==='PASS':null,...counts,
  autonomous_fixes:legacy?null:fixed,fix_failures:all.filter(f=>f.assessment==='VERIFIED'&&f.status==='not_fixed').length,
  regressions,manual_interventions:events.filter(e=>e.type==='manual_intervention').length,
  unresolved_verified:all.filter(f=>f.assessment==='VERIFIED'&&f.status!=='fixed').length};
}
export function begin(project,id,request,metadata,prompt,{migration=false,historical=false}={}){
 const d=directory(project,id);
 return locked(d,()=>{
  let events=[];
  if(exists(project,id)) events=readAudit(project,id).events;
  else {
   const task={task_id:id,project_dir:project,audit:validateMetadata(metadata),prompt,model:request.model,mode:request.mode,created_at:new Date().toISOString(),historical,migrated:migration,unknown_history:migration||historical};
   append(d,events,'task_created',task);exclusive(safeFile(d,'task.json'),task);
  }
  check(!events.some(e=>e.type==='task_finalized'),'任务已 finalize');
  const round=runs(events).length+1;
  check(!runs(events).some(e=>e.data.run_id===request.run_id),'重复 run_id');
  const previous=runs(events).at(-1);
  const fixes=request.followup_kind==='repair';
  if(previous){
   check(['repair','phase'].includes(request.followup_kind),'followup_kind 非法');
   const expected=preflight(project,id,request.followup_kind,request.override_authorization);
   check(runPhase(request)===expected,'phase 不匹配');
   check(ended(events,previous.data.run_id),'上一轮尚未终态');
   check(reviews(events).some(e=>e.data.run_id===previous.data.run_id),'上一轮必须先记录 Review');
   const count=runs(events).filter(e=>e.data.phase===(request.phase||1)&&e.data.kind==='repair').length;
   if(fixes&&count>=3){check(nonempty(request.override_authorization),'修复已达三轮，需要明确 override_authorization');append(d,events,'repair_limit_overridden',{authorization:request.override_authorization,run_id:request.run_id});}
  }
  const run={run_id:request.run_id,round,phase:request.phase||1,kind:request.followup_kind||'initial',model:request.model,mode:request.mode,
    requested_finding_keys:previous&&fixes?latestFindings(events).filter(f=>f.status!=='fixed'&&f.assessment!=='FALSE_POSITIVE').map(f=>f.finding_key):[],previous_review:reviews(events).at(-1)?.seq||null};
  append(d,events,previous?'followup_started':'run_started',run);
  fs.mkdirSync(safeFile(d,'rounds'),{recursive:true});exclusive(safeFile(d,path.join('rounds',`round-${String(round).padStart(2,'0')}.json`)),run);
  return run;
 });
}
export function preflight(project,id,kind='repair',override){
 const a=readAudit(project,id),e=a.events,previous=runs(e).at(-1);
 check(!e.some(x=>x.type==='task_finalized'),'任务已 finalize');
 check(previous&&ended(e,previous.data.run_id),'上一轮尚未终态');
 const review=reviews(e).find(x=>x.data.run_id===previous.data.run_id);check(review,'上一轮必须先记录 Review');
 check(['repair','phase'].includes(kind),'followup_kind 必须为 repair 或 phase');
 if(kind==='phase')check(review.data.verdict==='PASS'&&!blockers(e).length,'阶段切换要求上一阶段 PASS');
 const phase=previous.data.phase+(kind==='phase'?1:0);
 const n=runs(e).filter(x=>x.data.phase===phase&&x.data.kind==='repair').length;
 if(kind==='repair'&&n>=3)check(nonempty(override),'修复已达三轮，需要明确 override_authorization');
 return phase;
}
export function fileEvidence(project,files){
 return files.map(file=>{
  check(nonempty(file)&&path.isAbsolute(file),'证据必须为绝对路径');const p=real(file),root=real(project);
  check(p===root||p.startsWith(root+path.sep),'证据路径越界');
  const st=fs.statSync(p);check(st.isFile(),'证据不是文件');const data=fs.readFileSync(p);
  return {path:file,bytes:data.length,sha256:hash(data)};
 });
}
export function terminal(project,id,runId,status,files=[]){
 if(!exists(project,id))return;
 const d=directory(project,id);return locked(d,()=>{
  const {events}=readAudit(project,id);if(ended(events,runId))return;
  if(!runs(events).some(e=>e.data.run_id===runId))return;
  const type={returned:'run_returned',failed:'run_failed',stopped:'run_stopped',timed_out:'run_timed_out'}[status];check(type,'非法终态');
  let evidence=[],evidence_error=null;try{evidence=fileEvidence(project,files.filter(f=>fs.existsSync(f)));}catch(e){evidence_error=e.message;}
  append(d,events,type,{run_id:runId,evidence,evidence_error});
 });
}
export function review(project,a){
 const d=directory(project,a.task_id);return locked(d,()=>{
  const {events}=readAudit(project,a.task_id),run=runs(events).at(-1);
  check(!events.some(e=>e.type==='task_finalized'),'任务已 finalize');
  check(run&&run.data.run_id===a.run_id&&run.data.round===a.round,'Review run_id/round 不匹配');
  check(ended(events,a.run_id),'运行尚未终态');
  check(!reviews(events).some(e=>e.data.run_id===a.run_id),'Review 不可覆盖；后续轮次追加');
  check(['PASS','NEEDS_FIX','BLOCKED'].includes(a.verdict),'verdict 非法');
  check(['zcode','codex','human','unknown'].includes(a.executor),'executor 必填');
  check(Array.isArray(a.findings),'findings 必须为数组');
  const keys=new Set();
  const findings=a.findings.map(f=>{
   check(ID.test(f.finding_key||'')&&!keys.has(f.finding_key),'finding_key 非法或重复');keys.add(f.finding_key);
   check(nonempty(f.title)&&assessments.includes(f.assessment)&&priorities.includes(f.priority)&&categories.includes(f.category)&&statuses.includes(f.status),'finding 字段非法');
   let evidence=f.evidence||null;
   if(f.assessment==='VERIFIED') {check(evidence&&nonempty(evidence.description)&&Array.isArray(evidence.files)&&evidence.files.length,'VERIFIED 必须有描述和文件证据');evidence={description:evidence.description,files:fileEvidence(project,evidence.files)};}
   return {...f,evidence};
  });
  const validation=Array.isArray(a.validation_files)?fileEvidence(project,a.validation_files):[];
  const data={run_id:a.run_id,round:a.round,verdict:a.verdict,executor:a.executor,findings,validation};
  const prospective=[...events,{type:'review_recorded',data}];
  if(a.verdict==='PASS')check(!blockers(prospective).length,'PASS 存在未解决 VERIFIED P0/P1');
  append(d,events,'review_recorded',data);
  exclusive(safeFile(d,path.join('rounds',`review-${String(a.round).padStart(2,'0')}.json`)),data);
  if(a.executor==='codex'||a.executor==='human')append(d,events,'manual_intervention',{run_id:a.run_id,description:'实现/修复由 '+a.executor+' 接手'});
  const requested=run.data.requested_finding_keys;
  const current=new Map(latestFindings(events).map(f=>[f.finding_key,f]));
  return {recorded:true,statistics:statistics(events),repair_outcome:{requested,
   fixed:requested.filter(k=>current.get(k)?.status==='fixed'),
   not_fixed:requested.filter(k=>current.get(k)?.status!=='fixed'),
   regression:findings.filter(f=>f.assessment==='VERIFIED'&&f.status==='regression').map(f=>f.finding_key),
   needs_human:run.data.kind==='repair'&&runs(events).filter(e=>e.data.phase===run.data.phase&&e.data.kind==='repair').length>=3&&blockers(events).length>0}};
 });
}
export function finalize(project,a){
 const d=directory(project,a.task_id);return locked(d,()=>{
  const {events}=readAudit(project,a.task_id),run=runs(events).at(-1),lastReview=reviews(events).at(-1);
  check(!events.some(e=>e.type==='task_finalized'),'已 finalize，不可覆盖');
  check(['PASS','PARTIAL','FAIL'].includes(a.final_status)&&typeof a.acceptance_met==='boolean','final 字段非法');
  for(const k of observations)check(Array.isArray(a[k])&&a[k].every(nonempty),k+' 必须为字符串数组');
  for(const k of ['build_result','test_result','runtime_result'])check(a[k]&&nonempty(a[k].status)&&nonempty(a[k].summary),k+' 必须包含 status/summary');
  check(Array.isArray(a.manual_interventions)&&a.manual_interventions.every(nonempty),'manual_interventions 必须为事件描述数组');
  check(!run||ended(events,run.data.run_id),'运行尚未终态');
  const validation=fileEvidence(project,a.validation_files||[]);
  if(a.final_status==='PASS'){
   check(lastReview&&lastReview.data.run_id===run?.data.run_id&&lastReview.data.verdict==='PASS','PASS 需要最近运行的 PASS Review');
   check(!blockers(events).length,'PASS 存在未解决 VERIFIED P0/P1');
   check(a.acceptance_met===true,'PASS 需要 acceptance_met=true');
   check(validation.length||lastReview.data.validation.length,'PASS 必须有客观验证文件');
  }
  for(const description of a.manual_interventions)append(d,events,'manual_intervention',{description});
  const final={task_id:a.task_id,final_status:a.final_status,acceptance_met:a.acceptance_met,statistics:statistics(events),validation,
   ...Object.fromEntries([...observations,'build_result','test_result','runtime_result'].map(k=>[k,a[k]]))};
  append(d,events,'task_finalized',final);atomic(safeFile(d,'final.json'),final);return final;
 });
}
export function report(project,month){
 if(month!==undefined)check(/^\d{4}-(0[1-9]|1[0-2])$/.test(month),'月份格式 YYYY-MM');
 const root=auditRoot(project),items=[],corrupted=[];
 const ids=fs.existsSync(root)?fs.readdirSync(root).filter(x=>ID.test(x)).sort():[];
 for(const id of ids){try{
  const a=readAudit(project,id);if(month&&!a.task.created_at.startsWith(month))continue;
  const final=a.events.find(e=>e.type==='task_finalized')?.data;
  const evidence=a.events.flatMap(e=>e.data.evidence||[]).concat(reviews(a.events).flatMap(e=>[...e.data.validation,...e.data.findings.flatMap(f=>f.assessment==='VERIFIED'?f.evidence.files:[])]),final?.validation||[]);
  const changed=[...new Set(evidence.filter(e=>{try{return fileEvidence(project,[e.path])[0].sha256!==e.sha256;}catch{return true;}}).map(e=>e.path))].sort();
  items.push({task_id:id,task_name:a.task.audit.task_name,historical:a.task.historical||a.task.migrated,created_at:a.task.created_at,final_status:final?.final_status||'OPEN',statistics:statistics(a.events),changed_evidence:changed,observations:final?Object.fromEntries(observations.map(k=>[k,final[k]])):null});
 }catch{corrupted.push(id);}}
 const live=items.filter(x=>!x.historical),reviewed=live.filter(x=>x.statistics.first_pass!==null);
 const fixed=live.reduce((n,x)=>n+(x.statistics.autonomous_fixes||0),0),verified=live.reduce((n,x)=>n+x.statistics.VERIFIED,0);
 const totals={tasks:live.length,historical_tasks:items.length-live.length,first_pass:reviewed.filter(x=>x.statistics.first_pass).length,needs_fix_tasks:reviewed.filter(x=>!x.statistics.first_pass).length,
  average_review_rounds:live.length?live.reduce((n,x)=>n+x.statistics.review_rounds,0)/live.length:null,
  VERIFIED:verified,FALSE_POSITIVE:live.reduce((n,x)=>n+x.statistics.FALSE_POSITIVE,0),autonomous_fix_rate:verified?fixed/verified:null,
  regressions:live.reduce((n,x)=>n+x.statistics.regressions,0),manual_interventions:live.reduce((n,x)=>n+x.statistics.manual_interventions,0),
  distribution:Object.fromEntries(['PASS','PARTIAL','FAIL','OPEN'].map(k=>[k,live.filter(x=>x.final_status===k).length]))};
 return {schema_version:1,month:month||null,totals,items,corrupted};
}
export function markdown(data){return '# ZCode 委派体验报告\n\n由权威事件生成；历史补录不进入自主表现比率。\n\n```json\n'+JSON.stringify(data,null,2)+'\n```\n';}

const str={type:'string',minLength:1},list={type:'array',items:str};
export const metadataSchema={type:'object',properties:{...Object.fromEntries(strings.map(k=>[k,str])),...Object.fromEntries(arrays.map(k=>[k,{...list,...(k==='high_risk_operations'?{}:{minItems:1})}])),risk_level:{type:'string',enum:['low','medium','high']}},required:[...strings,...arrays,'risk_level'],additionalProperties:false};
const evidenceSchema={type:'object',properties:{description:str,files:{...list,minItems:1}},required:['description','files'],additionalProperties:false};
export const reviewSchema={type:'object',properties:{project_dir:str,task_id:str,run_id:str,round:{type:'integer',minimum:1},verdict:{type:'string',enum:['PASS','NEEDS_FIX','BLOCKED']},executor:{type:'string',enum:['zcode','codex','human','unknown']},validation_files:list,findings:{type:'array',items:{type:'object',properties:{finding_key:str,title:str,assessment:{type:'string',enum:assessments},priority:{type:'string',enum:priorities},category:{type:'string',enum:categories},evidence:evidenceSchema,status:{type:'string',enum:statuses}},required:['finding_key','title','assessment','priority','category','status'],additionalProperties:false}}},required:['project_dir','task_id','run_id','round','verdict','executor','findings'],additionalProperties:false};
const resultSchema={type:'object',properties:{status:str,summary:str},required:['status','summary'],additionalProperties:false};
export const finalSchema={type:'object',properties:{project_dir:str,task_id:str,final_status:{type:'string',enum:['PASS','PARTIAL','FAIL']},acceptance_met:{type:'boolean'},build_result:resultSchema,test_result:resultSchema,runtime_result:resultSchema,manual_interventions:list,validation_files:list,...Object.fromEntries(observations.map(k=>[k,list]))},required:['project_dir','task_id','final_status','acceptance_met','build_result','test_result','runtime_result','manual_interventions',...observations],additionalProperties:false};

export function writeReport(project,month){
 const data=report(project,month),docs=path.join(project,'docs'),r=real(project);
 check(real(docs)===path.join(r,'docs'),'报告目录链接越界');fs.mkdirSync(docs,{recursive:true});
 atomic(safeFile(docs,'ZCODE_EXPERIENCE_STATS.json'),data);
 const file=safeFile(docs,'ZCODE_EXPERIENCE_LOG.md'),tmp=file+'.'+randomUUID()+'.tmp';
 fs.writeFileSync(tmp,markdown(data));try{fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
 return data;
}
