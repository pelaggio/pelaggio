import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
const [metadataFile, outputDirectory] = process.argv.slice(2);
if(!metadataFile||!outputDirectory)throw new Error('Usage: node capture.mjs <execution.json> <new-output-directory>');
const execution=JSON.parse(readFileSync(metadataFile,'utf8'));
const out=resolve(outputDirectory);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
mkdirSync(out,{recursive:true});
const report={capturedAt:new Date().toISOString(),harnessSha:execution.harnessSha,shippingMode:'direct-push to local bare repositories; no GitHub PR',operatorInterventions:['Changed the initial single-provider configuration to use a distinct review provider after preflight refusal.','Changed coordination from Codex to Claude after Codex pick refused prohibited mutations.','Claude subscription access was disabled; claimed both local items through the roadmap CLI and resumed at plan.','The user authorized Codex/Grok-only supervised execution with Grok unsandboxed fallback; configuration changes are committed in both local repos.'],scenarios:{}};
for(const [name,info] of Object.entries(execution.scenarios)) {
 const candidate=existsSync(info.repo+'-item-1') ? info.repo+'-item-1' : info.repo;
 const directory=join(out,name);mkdirSync(directory,{recursive:true});
 const records=readFileSync(join(info.repo,'.dev/pelaggio-log.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
 const attempts=records.filter(record=>record.steps?.some(step=>step.provider));
 const summary=attempts.map(record=>({at:record.ts,outcome:record.outcome,reason:record.reason??record.error,revision:record.provenance?.git?.headSha,steps:record.steps.map(step=>({name:step.name,provider:step.provider,model:step.model,ok:step.ok,subtype:step.subtype,detail:step.errorDetail??(!step.ok?step.outputTail:undefined),outputTail:step.outputTail,decisions:step.decisions,executionReceipt:step.executionReceipt}))}));
 const baseline=join(execution.root,`${name}-baseline.json`);
 const sourceRefs={};
 for(const [path,to] of [['docs/charter.md','charter.md'],['docs/plans/item-1.md','plan.md'],['docs/decision-log/ITEM-1.md','decisions.md']]) {
  let bytes, revision;
  if(existsSync(join(candidate,path))) {bytes=readFileSync(join(candidate,path));revision=git(candidate,'rev-parse','HEAD');}
  else {
   for(const sha of git(info.repo,'log','--all','--format=%H','--',path).split('\n')) {
    try{bytes=execFileSync('git',['show',`${sha}:${path}`],{cwd:info.repo,stdio:['ignore','pipe','ignore']});revision=sha;break;}catch{}
   }
  }
  if(!bytes)throw new Error(`No retained ${path}`);
  writeFileSync(join(directory,to),bytes,{flag:'wx'});sourceRefs[to]={path,revision};
 }
 cpSync(baseline,join(directory,'baseline-checks.json'),{errorOnExist:true,force:false});
 writeFileSync(join(directory,'attempts.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
 const inputCharter=execFileSync('git',['show',`${info.baseline}:docs/charter.md`],{cwd:info.repo});
 writeFileSync(join(directory,'charter-input.md'),inputCharter,{flag:'wx'});
 sourceRefs['charter-input.md']={path:'docs/charter.md',revision:info.baseline};
 const paths=['charter-input.md','charter.md','plan.md','decisions.md','baseline-checks.json','attempts.json'];
 const checks=join(execution.root,`${name}-candidate.json`);
 if(existsSync(checks)){cpSync(checks,join(directory,'candidate-checks.json'),{errorOnExist:true,force:false});paths.push('candidate-checks.json');}
 const diff=execFileSync('git',['diff',info.baseline,'HEAD','--','src','public','test','package.json'],{cwd:candidate});
 writeFileSync(join(directory,'change.diff'),diff,{flag:'wx'});paths.push('change.diff');
 const trees=Object.fromEntries(['src','public','test'].map(path=>[path,{baseline:git(info.repo,'rev-parse',`${info.baseline}:${path}`),candidate:git(candidate,'rev-parse',`HEAD:${path}`)}]));
 report.scenarios[name]={sourceRefs,candidateRevision:git(candidate,'rev-parse','HEAD'),gitStatus:git(candidate,'status','--porcelain'),applicationTrees:trees,latestOutcome:summary.at(-1),artifacts:paths.map(path=>({path:`${name}/${path}`,sha256:digest(readFileSync(join(directory,path)))}))};
}
writeFileSync(join(out,'manifest.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output:out,scenarios:Object.fromEntries(Object.entries(report.scenarios).map(([name,r])=>[name,{revision:r.candidateRevision,outcome:r.latestOutcome.outcome,applicationUnchanged:Object.values(r.applicationTrees).every(tree=>tree.baseline===tree.candidate)}]))},null,2));
