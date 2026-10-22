'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');
const tick=()=>new Promise(resolve=>setTimeout(resolve,18));
const html=fs.readFileSync('docs/index.html','utf8');
async function setup(t,{count=5}={}){
 const pending=[],errors=[],blobs=[];const catalog={ok:true,catalogVersion:'version-one',count,defaultKeyword:'斗破苍穹',items:Array.from({length:count},(_,i)=>({id:'id-'+i,name:i===0?'=2+2':'源'+i,sourceUrl:'https://example.com/'+i,enabled:true}))};
 const dom=new JSDOM(html,{url:'http://localhost:4397/',runScripts:'outside-only',pretendToBeVisual:true});t.after(()=>dom.window.close());
 const w=dom.window,d=w.document;w.Blob=Blob;w.AbortController=AbortController;
 w.URL.createObjectURL=blob=>{blobs.push(blob);return 'blob:test';};w.URL.revokeObjectURL=()=>{};w.HTMLAnchorElement.prototype.click=function(){};
 w.addEventListener('error',e=>errors.push(e.message));
 w.fetch=async(url,options)=>{
  if(url==='/api/source/catalog')return {ok:true,json:async()=>catalog};
  return new Promise(resolve=>pending.push({url,options,body:JSON.parse(options.body),resolve}));
 };
 w.eval(fs.readFileSync('docs/batch-check.js','utf8'));await tick();
 assert.equal(d.getElementById('batchSourceCount').textContent,String(count));assert.equal(pending.length,0,'loading catalogue must not probe websites');
 const finish=(request,{state='verified',status=200,name,version,reason}={})=>{
  const data=status===200?{ok:true,sourceId:request.body.sourceId,sourceName:name||request.body.sourceId,catalogVersion:version||catalog.catalogVersion,keyword:request.body.keyword,
   summary:{state,label:state,fullyVerified:state==='verified',reasons:reason?[reason]:[],stages:[],suggestion:'不要修改原始源'},evidence:{steps:[]}}:
   {ok:false,error:status===429?'限流':'合集已更新',retryAfter:2};
  request.resolve({ok:status===200,status,headers:{get:()=>null},json:async()=>data});
 };
 t.after(()=>assert.deepEqual(errors,[]));
 return {w,d,pending,finish,blobs,catalog};
}
test('batch runs at most two calls, progresses per source, and never transmits API credentials',async t=>{
 const {w,d,pending,finish}=await setup(t);w.localStorage.setItem('privateAI','DONT_SEND_SECRET');
 const promise=w.BooksourceBatch.run(false);assert.equal(pending.length,2);
 for(let i=0;i<5;i++){assert(pending.length<=i+2);finish(pending[i],{state:i===1?'partial':'verified'});await tick();}
 await promise;assert.equal(pending.length,5);assert(d.getElementById('batchStop').disabled);
 const report=w.BooksourceBatch.report();assert.equal(report.results.filter(r=>r.state==='verified').length,4);assert.equal(report.aiCalled,false);
 assert.equal(d.getElementById('batchProgress').value,5);
 assert(!JSON.stringify(pending.map(p=>p.body)).includes('DONT_SEND_SECRET'));
 assert(pending.every(p=>Object.keys(p.body).sort().join(',')==='catalogVersion,keyword,sourceId'));
});
test('one failed request does not hide other results, and retry selects only unfinished checks',async t=>{
 const {w,d,pending,finish}=await setup(t,{count:3});let run=w.BooksourceBatch.run(false);
 finish(pending[0]);finish(pending[1],{state:'unreachable'});await tick();finish(pending[2]);await run;
 run=w.BooksourceBatch.run(true);assert.equal(pending.length,4);assert.equal(pending[3].body.sourceId,'id-1');finish(pending[3]);await run;
 assert.equal(w.BooksourceBatch.report().results[1].attempts,2);assert(d.getElementById('batchRetry').disabled);
});
test('stop cancels queued/in-flight work and late replies cannot resurrect results',async t=>{
 const {w,d,pending,finish}=await setup(t);let run=w.BooksourceBatch.run(false);
 d.getElementById('batchStop').click();assert(pending.every(p=>p.options.signal.aborted));
 finish(pending[0]);finish(pending[1]);await run;
 assert.equal(pending.length,2);assert(w.BooksourceBatch.report().results.every(r=>r.state==='cancelled'));
});
test('rate limit stops further scheduling and requires explicit retry after cooldown',async t=>{
 const {w,d,pending,finish}=await setup(t);const run=w.BooksourceBatch.run(false);finish(pending[0],{status:429});await tick();finish(pending[1]);await run;
 assert.equal(pending.length,2);assert(d.getElementById('batchRetry').disabled);assert(d.getElementById('batchCooldown').textContent.includes('不会自动'));
 assert.equal(w.BooksourceBatch.report().results[0].state,'error');
});
test('changed bundle version stops queue instead of mixing different catalogue snapshots',async t=>{
 const {w,d,pending,finish}=await setup(t);const run=w.BooksourceBatch.run(false);finish(pending[0],{status:409});await tick();finish(pending[1]);await run;
 assert.equal(pending.length,2);assert(d.getElementById('batchStatus').textContent.includes('重新载入'));
});
test('response id/version mismatches are errors, not a pass for the wrong source',async t=>{
 const {w,pending,finish}=await setup(t,{count:1});const run=w.BooksourceBatch.run(false);finish(pending[0],{version:'wrong-version'});await run;
 assert.equal(w.BooksourceBatch.report().results[0].state,'error');
});
test('reports escape HTML and CSV formula injection, without modifying the source pack',async t=>{
 const {w,d,pending,finish,blobs}=await setup(t,{count:1});const run=w.BooksourceBatch.run(false);
 finish(pending[0],{state:'rules',reason:'<img src=x onerror=alert(1)>'});await run;
 assert.equal(d.querySelectorAll('#batchRows img').length,0);assert(d.getElementById('batchRows').textContent.includes('<img'));
 d.getElementById('batchExportJson').click();const json=JSON.parse(await blobs[0].text());assert.equal(json.scope,'sampled-static-http-reading-chain');assert.equal(json.appVerified,false);assert.equal(json.results[0].state,'rules');
 d.getElementById('batchExportCsv').click();const csv=await blobs[1].text();assert(csv.includes('"\'=2+2"'));
 d.getElementById('batchFilter').value='verified';d.getElementById('batchFilter').dispatchEvent(new w.Event('change'));assert.equal(d.getElementById('batchRows').children.length,0);
});
test('editing the keyword clears outdated conclusions and does not automatically call websites',async t=>{
 const {w,d,pending,finish}=await setup(t,{count:1});const run=w.BooksourceBatch.run(false);finish(pending[0]);await run;
 d.getElementById('batchKeyword').value='新书名';d.getElementById('batchKeyword').dispatchEvent(new w.Event('input'));
 assert.equal(w.BooksourceBatch.report().results[0].state,'queued');assert.equal(w.BooksourceBatch.report().results[0].result,null);assert.equal(pending.length,1);
});
