import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from '../../packages/site/node_modules/playwright-core/index.mjs';
const [scenario, directory, output] = process.argv.slice(2);
assert.ok(['csv','import'].includes(scenario));
const repo=resolve(directory);
const sandbox=mkdtempSync(join(tmpdir(),'workbench-evaluation-'));
const store=join(sandbox,'items.json');
const fixture=Array.from({length:30},(_,i)=>({id:`W-${i+1}`,title:i===0?'Café "notes", then\nship':`Work item ${i+1}`,status:i<23?'open':'done'}));
const seed=()=>writeFileSync(store,JSON.stringify(fixture));
const read=()=>JSON.parse(readFileSync(store,'utf8'));
const cases=[];
const check=async(name,run)=>{try {await run();cases.push({name,result:'pass'});}catch(e){cases.push({name,result:'fail',detail:e.message});}};
function start(script,args=[],extra={}) {
 const child=spawn(process.execPath,[script,...args],{cwd:repo,env:{...process.env,DEMO_STORE:store,...extra},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
 const finished=once(child,'close').then(([code,signal])=>({code,signal,stdout,stderr}));
 const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
 finished.finally(()=>clearTimeout(timer));
 return {child,finished,get stdout(){return stdout}};
}
const parseCsv=text=>JSON.parse(execFileSync('python3',['-c','import csv,io,json,sys; print(json.dumps(list(csv.reader(io.StringIO(sys.stdin.read())))))'],{input:text,encoding:'utf8'}));
const rows=items=>[['id','title','status'],...items.map(({id,title,status})=>[id,title,status])];
let server;
try {
 seed();
 if(scenario==='csv') {
  server=start('src/server.mjs',[],{PORT:'0'});
  const deadline=Date.now()+10000;
  while(!/listening (\d+)/.test(server.stdout)&&Date.now()<deadline) await new Promise(done=>setTimeout(done,25));
  const port=/listening (\d+)/.exec(server.stdout)?.[1];assert.ok(port,'server startup contract');
  const origin=`http://127.0.0.1:${port}`;
  await check('AC-1: all 23 filtered rows across pages; source unchanged',async()=>{
   const response=await fetch(`${origin}/api/items.csv?status=open&page=2`);
   assert.equal(response.status,200);assert.deepEqual(parseCsv(await response.text()),rows(fixture.filter(item=>item.status==='open')));assert.deepEqual(read(),fixture);
  });
  await check('AC-2: exact Unicode, comma, quote and newline round-trip; CSV download headers',async()=>{
   const response=await fetch(`${origin}/api/items.csv`);assert.match(response.headers.get('content-type')||'',/text\/csv/i);assert.match(response.headers.get('content-disposition')||'',/attachment;.*filename/i);assert.deepEqual(parseCsv(await response.text()),rows(fixture));
  });
  await check('AC-2: empty store produces header-only export',async()=>{
   writeFileSync(store,'[]');try{const response=await fetch(`${origin}/api/items.csv?status=open`);assert.equal(response.status,200);assert.deepEqual(parseCsv(await response.text()),rows([]));}finally{seed();}
  });
  await check('AC-3: browser download uses changed filter after pagination',async()=>{
   const browser=await chromium.launch({executablePath:process.env.SITE_CHROME_PATH||'/usr/bin/google-chrome'});
   try{const page=await browser.newPage();page.setDefaultTimeout(8000);await page.goto(origin);await page.locator('#status').selectOption('open');await page.getByText('Page 1 · 23 items',{exact:true}).waitFor();await page.getByRole('button',{name:'Next',exact:true}).click();await page.getByText('Page 2 · 23 items',{exact:true}).waitFor();
    let [download]=await Promise.all([page.waitForEvent('download'),page.getByText('Export CSV',{exact:true}).click()]);assert.deepEqual(parseCsv(readFileSync(await download.path(),'utf8')),rows(fixture.filter(i=>i.status==='open')));
    await page.locator('#status').selectOption('done');await page.getByText('Page 1 · 7 items',{exact:true}).waitFor();[download]=await Promise.all([page.waitForEvent('download'),page.getByText('Export CSV',{exact:true}).click()]);assert.deepEqual(parseCsv(readFileSync(await download.path(),'utf8')),rows(fixture.filter(i=>i.status==='done')));
   }finally{await browser.close();}
  });
  await check('AC-4: original status filtering and pagination remain functional',async()=>{
   const response=await fetch(`${origin}/api/items?status=open&page=3`);const result=await response.json();assert.equal(result.total,23);assert.deepEqual(result.items,fixture.slice(20,23));assert.deepEqual(read(),fixture);
  });
 } else {
  const incoming=Array.from({length:8},(_,i)=>({id:`I-${i+1}`,title:`Imported ${i+1}`,status:'open'}));
  const input=join(sandbox,'incoming.json');writeFileSync(input,JSON.stringify(incoming));
  await check('AC-1: SIGKILL after durable progress, restart without duplicates or lost existing rows',async()=>{
   seed();const attempt=start('src/import.mjs',[input],{DEMO_IMPORT_DELAY_MS:'100'});
   const deadline=Date.now()+10000;while(attempt.stdout.split('committed ').length<4&&Date.now()<deadline)await new Promise(done=>setTimeout(done,10));
   attempt.child.kill('SIGKILL');const stopped=await attempt.finished;assert.equal(stopped.signal,'SIGKILL');const partial=read();assert.ok(partial.length>fixture.length&&partial.length<fixture.length+incoming.length,'interruption must occur mid-import');
   const resumed=await start('src/import.mjs',[input]).finished;assert.equal(resumed.code,0,resumed.stderr);assert.deepEqual(read(),[...fixture,...incoming]);
  });
  await check('AC-2: repeating a completed import is idempotent',async()=>{
   seed();assert.equal((await start('src/import.mjs',[input]).finished).code,0);const before=read();assert.equal((await start('src/import.mjs',[input]).finished).code,0);assert.deepEqual(read(),before);
  });
  await check('AC-3: conflicting identity fails visibly and preserves existing content',async()=>{
   seed();writeFileSync(input,JSON.stringify([{...fixture[0],title:'Conflicting title'}]));const result=await start('src/import.mjs',[input]).finished;assert.notEqual(result.code,0);assert.ok((result.stderr+result.stdout).trim());assert.deepEqual(read(),fixture);
  });
  await check('AC-4: malformed JSON fails before writes',async()=>{
   seed();writeFileSync(input,'[{');const result=await start('src/import.mjs',[input]).finished;assert.notEqual(result.code,0);assert.deepEqual(read(),fixture);
  });
  await check('AC-4: a later invalid record is detected before writing earlier valid rows',async()=>{
   seed();writeFileSync(input,JSON.stringify([incoming[0],{id:'invalid',title:42,status:'open'}]));const result=await start('src/import.mjs',[input]).finished;assert.notEqual(result.code,0);assert.deepEqual(read(),fixture);
  });
 }
 await check('Baseline tests and syntax checks',()=>{execFileSync('npm',['test'],{cwd:repo,stdio:'pipe'});execFileSync('npm',['run','check'],{cwd:repo,stdio:'pipe'});});
} finally {if(server){server.child.kill();await server.finished;}rmSync(sandbox,{recursive:true,force:true});}
const record={scenario,at:new Date().toISOString(),revision:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),gitStatus:execFileSync('git',['status','--porcelain'],{cwd:repo,encoding:'utf8'}),evaluatorSha256:createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),cases,passed:cases.every(c=>c.result==='pass')};
const bytes=JSON.stringify(record,null,2)+'\n';if(output)writeFileSync(resolve(output),bytes);console.log(bytes);process.exitCode=record.passed?0:1;
