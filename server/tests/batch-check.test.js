import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {summarizeEvidence,summarizeCheckError} from '../check-summary.js';
import {createSourceCatalog} from '../source-catalog.js';
import {createApp} from '../index.js';
const chain=()=>({fullyVerified:true,verifiedAt:'2026-10-22T00:00:00Z',steps:['search','detail','chapterList','chapterContent'].map(step=>({step,status:'ok',httpStatus:200,fieldChecks:[{field:'test',status:'ok'}]})),diagnostics:[]});
test('HTTP success alone is not full verification, and absence of stages cannot pass',()=>{
 const e=chain();e.fullyVerified=false;assert.equal(summarizeEvidence(e).state,'partial');
 assert.equal(summarizeEvidence({fullyVerified:true,steps:[]}).state,'error');
 assert.equal(summarizeEvidence(chain()).state,'verified');
 assert.equal(summarizeEvidence(chain()).appVerified,false);
});
test('incomplete pagination downgrades even a contradictory fullyVerified flag',()=>{
 const e=chain();e.steps[3].pagination={pagesRequested:3,complete:false,reason:'page budget'};
 const s=summarizeEvidence(e);assert.equal(s.state,'partial');assert(!s.fullyVerified);assert(s.reasons.some(r=>r.includes('page budget')));
});
test('a recovered search endpoint is not proof that original rules work',()=>{
 const e=chain();e.steps[0].recoveredRequest=true;assert.equal(summarizeEvidence(e).state,'rules');
});
test('search no results is distinct from a broken content XPath',()=>{
 const a=chain();a.steps[0].status='no-results';a.steps[0].reason='没有匹配';assert.equal(summarizeEvidence(a).state,'no_results');
 const b=chain();b.steps[3].status='no-results';assert.equal(summarizeEvidence(b).state,'rules');
});
test('a nonempty search list with broken detail links is a rule error, not an empty search',()=>{
 const e=chain();e.steps[0]={step:'search',status:'no-results',count:3,reason:'找到列表但没有有效详情链接'};assert.equal(summarizeEvidence(e).state,'rules');
});
test('timeouts, HTTP denial and unsupported runtime have distinct diagnosis',()=>{
 for(const [status,http,expected] of [['timeout',null,'unreachable'],['network-error',null,'unreachable'],['http-error',404,'unreachable'],['http-error',403,'restricted'],['http-error',429,'restricted'],['unsupported',null,'unsupported']]){
   const e=chain();e.steps[0]={step:'search',status,httpStatus:http,reason:'test'};const s=summarizeEvidence(e);assert.equal(s.state,expected);assert.equal(s.failureStage,'search');
 }
});
test('a failed homepage does not hide an independently verified reading chain',()=>{
 const e=chain();e.steps.unshift({step:'homepage',status:'blocked',httpStatus:403});assert.equal(summarizeEvidence(e).state,'verified');
});
test('field and JavaScript limitations cannot be silently ignored',()=>{
 const a=chain();a.steps[1].fieldChecks=[{field:'author',status:'not-checked',note:'JS'}];assert.equal(summarizeEvidence(a).state,'partial');
 const b=chain();b.steps[0].fieldChecks=[{field:'detailUrl',status:'multiple-values'}];assert.equal(summarizeEvidence(b).state,'rules');
 const c=chain();c.steps[0].requestCapabilities={unchecked:[{field:'webView',reason:'not run'}]};assert.equal(summarizeEvidence(c).state,'partial');
});
test('summary reasons are bounded and redact URL query tokens',()=>{
 const e=chain();e.diagnostics=Array.from({length:40},(_,i)=>'https://example.com/?api_key=PRIVATE_VALUE&x='+i+'a'.repeat(500));
 const summary=summarizeEvidence(e);assert(summary.reasons.length<=16);assert(summary.reasons.every(r=>r.length<=400));assert(!JSON.stringify(summary).includes('PRIVATE_VALUE'));
 assert.equal(summarizeCheckError(Error('该域名不在白名单')).state,'unsupported');
});
test('catalog metadata is read-only, versioned, and excludes complete rule data and credentials',()=>{
 const catalog=createSourceCatalog();const meta=catalog.metadata();assert.equal(meta.count,15);assert.equal(new Set(meta.items.map(x=>x.id)).size,15);assert.match(meta.catalogVersion,/^[a-f0-9]{64}$/);
 assert.equal(meta.concurrency,2);for(const item of meta.items){assert(!Object.hasOwn(item,'source'));assert(!Object.hasOwn(item,'httpHeaders'));}
});
test('catalog check only uses known server records, not injected URLs or keys',async()=>{
 let seen;
 const catalog=createSourceCatalog({inspector:async input=>{seen=input;return chain();}}),meta=catalog.metadata(),item=meta.items[0];
 const result=await catalog.check({sourceId:item.id,catalogVersion:meta.catalogVersion,sourceUrl:'http://127.0.0.1/admin',config:{apiKey:'ignored'}});
 assert.equal(result.summary.state,'verified');assert.equal(result.keyword,'斗破苍穹');assert.equal(seen.sourceName,item.name);assert.equal(Object.values(seen.source)[0].sourceUrl,item.sourceUrl);assert.equal(seen.legado,undefined);assert.equal(seen.config,undefined);
});
test('a changed catalogue, invalid ID and bad keywords are rejected before network',async()=>{
 let count=0;const catalog=createSourceCatalog({inspector:async()=>{count++;return chain();}}),m=catalog.metadata();
 const base={sourceId:m.items[0].id,catalogVersion:m.catalogVersion};
 await assert.rejects(catalog.check({...base,catalogVersion:'old'}),e=>e.statusCode===409);
 for(const id of ['__proto__','constructor','unknown',null])await assert.rejects(catalog.check({...base,sourceId:id}));
 for(const keyword of [[],{},'x'.repeat(51),'a\nb','   '])await assert.rejects(catalog.check({...base,keyword}));
 assert.equal(count,0);
});
test('source data mutations in a checker cannot affect the frozen bundle or next run',async()=>{
 const before=fs.readFileSync('docs/downloads/xiangse_latest.json');let count=0;
 const c=createSourceCatalog({inspector:async request=>{const s=Object.values(request.source)[0];assert.notEqual(s.sourceName,'MUTATED');s.sourceName='MUTATED';count++;return chain();}}),m=c.metadata();
 const request={catalogVersion:m.catalogVersion,sourceId:m.items[0].id};await c.check(request);await c.check(request);
 assert.equal(count,2);assert(before.equals(fs.readFileSync('docs/downloads/xiangse_latest.json')));
});
test('inspector exceptions become per-source diagnostics instead of aborting a batch',async()=>{
 const c=createSourceCatalog({inspector:async()=>{throw Error('不允许此跨域请求');}}),m=c.metadata();
 const r=await c.check({sourceId:m.items[0].id,catalogVersion:m.catalogVersion});assert.equal(r.summary.state,'unsupported');assert.equal(r.evidence,null);
});
test('catalog HTTP routes run without AI key, enforce version and advertise rate-limit retry',async t=>{
 const app=createApp({checkWebsite:async()=>chain()});const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base='http://127.0.0.1:'+server.address().port;let r=await fetch(base+'/api/source/catalog');const m=await r.json();assert(m.ok);assert.equal(m.count,15);
 const request={sourceId:m.items[0].id,catalogVersion:m.catalogVersion};
 const send=x=>fetch(base+'/api/source/catalog-check',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(x)});
 r=await send(request);assert.equal(r.status,200);assert.equal((await r.json()).summary.state,'verified');
 r=await send({...request,catalogVersion:'stale'});assert.equal(r.status,409);
 let limited=false;
 for(let i=0;i<31;i++){r=await send(request);await r.text();if(r.status===429){limited=true;assert(Number(r.headers.get('retry-after'))>0);break;}}
 assert(limited,'bounded catalogue requests must be rate-limited');
});
