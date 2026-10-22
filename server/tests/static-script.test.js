import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {buildGetPlan} from '../request-plan.js';
import {inspectSourceWeb} from '../site-evidence.js';
const require=createRequire(import.meta.url);
const {evaluateStaticScript:evaluate,evaluateStaticRequest:request}=require('../../converter/lib/staticScript.js');
const bundle=JSON.parse(fs.readFileSync('docs/downloads/xiangse_latest.json','utf8'));
const origin='https://www.myshu.cc';
const bindings={params:{keyWord:'测试 & 小说',pageIndex:3,queryInfo:{},responseUrl:origin+'/book/1/'},config:{host:origin,httpHeaders:{}},result:'/book/2/'};
const source=()=>({sourceName:'安全表达式',sourceUrl:origin,sourceType:'text',enable:1,weight:'100',
 searchBook:{actionID:'searchBook',parserID:'DOM',responseFormatType:'html',requestInfo:origin+'/search?q=%@keyWord',list:'//div[@class="card"]',bookName:'//h3/a/text()',detailUrl:'//h3/a/@href'},
 bookDetail:{actionID:'bookDetail',parserID:'DOM',responseFormatType:'html',requestInfo:'%@result',bookName:'//h1/text()'},
 chapterList:{actionID:'chapterList',parserID:'DOM',responseFormatType:'html',requestInfo:'%@result',list:'//*[@id="toc"]/a',title:'//text()',url:'//@href'},
 chapterContent:{actionID:'chapterContent',parserID:'DOM',responseFormatType:'html',requestInfo:'%@result',content:'//*[@id="content"]'}});
const text='这是只用于验证确定性解析的测试正文，不是真实小说。需要足够的字符长度来检查匹配、导航和响应配置。';
const html=body=>new Response(body,{headers:{'content-type':'text/html; charset=utf-8'}});
const pages={'/':'<h1>首页</h1>','/search':'<div class="card"><h3><a href="/book/1/">样例书</a></h3></div>',
 '/book/1/':'<h1>样例书</h1><div id="toc"><a href="/read/1">第一章</a></div>','/read/1':'<div id="content">'+text+'</div>'};
async function check(config,respond){const calls=[];const report=await inspectSourceWeb({source:config,keyword:'测试 & 小说'},{dnsChecker:async()=>{},fetcher:async(url,init)=>{calls.push({url,init});return respond?respond(url,init):html(pages[new URL(url).pathname]||'<h1>unknown</h1>');}});return {report,calls};}

test('bounded expressions preserve encoding, arithmetic, branches and template semantics',()=>{
 const script='@js:var k=encodeURIComponent(String(params&&params.keyWord||" ").trim());var p=Math.max(1,parseInt(params.pageIndex||1,10)||1);return {url:config.host+"/s?q="+k+"&p="+p};';
 const r=request(script,bindings);assert(r.ok,r.reason);
 assert.equal(r.request.url,origin+'/s?q='+encodeURIComponent('测试 & 小说')+'&p=3');
 assert.equal(request('@js:let path=`${config.host}/s?p=${params.pageIndex-1}`;return {url:path};',bindings).request.url,origin+'/s?p=2');
 const b={...bindings,params:{...bindings.params,pageIndex:-3}};
 assert.equal(request(script,b).request.url,origin+'/s?q='+encodeURIComponent('测试 & 小说')+'&p=1');
});
test('existing real-source simple GET and form request wrappers are recognized generically',()=>{
 for(const name of ['🎉起点中文网','思路客','全本小说网','魔丸小说','小原文学网','文桑小说','抖音小说']){
  const raw=bundle[name].searchBook.requestInfo;
  const r=request(raw,{...bindings,config:{host:bundle[name].sourceUrl,httpHeaders:{}}});
  assert(r.ok,name+': '+r.reason);assert(/^https?:/.test(r.request.url));
 }
});
test('unselected branches and trailing code must satisfy the whole-program allowlist',()=>{
 delete globalThis.staticScriptAttack;
 for(const code of [
  '@js:if(false){globalThis.staticScriptAttack=true;}return "ok";',
  '@js:return "ok";fetch("http://localhost/");',
  '@js:var a=String.constructor("return process")();return a;',
  '@js:var a=result["constructor"];return a;',
  '@js:var a=result["con"+"structor"];return a;',
  '@js:var a={get url(){return "test";}};return a;',
  '@js:var a={__proto__:{attack:1}};return a;',
  '@js:var a={url:"https://safe",url:"https://evil"};return a;',
  '@js:for(;;){}return "ok";', '@js:while(true){}return "ok";',
  '@js:function f(){return "ok";}return f();', '@js:return (()=>"ok")();',
  '@js:return eval("1+1");','@js:return require("fs");','@js:return import("node:fs");',
  '@js:var String="evil";return String;', '@js:return params.nativeTool.getCache("secret");',
  '@js:return /^(a+)+$/.test(result);','@js:return new RegExp(result);',
  '@js:return result.replace("x",function(){return "y";});'
 ]){const r=evaluate(code,bindings);assert.equal(r.ok,false,code);}
 assert.equal(globalThis.staticScriptAttack,undefined);
});
test('data properties cannot invoke getters, prototypes, callbacks or coercion hooks',()=>{
 let calls=0;const bad={};Object.defineProperty(bad,'x',{enumerable:true,get(){calls++;return 1;}});
 assert(!evaluate('@js:return result.x;',{result:bad}).ok);assert.equal(calls,0);
 const coercion={toString(){calls++;return 'evil';}};
 assert(!evaluate('@js:return String(result);',{result:coercion}).ok);assert.equal(calls,0);
 assert(!evaluate('@js:return result.constructor;',{result:{constructor:'evil'}}).ok);
 assert(!evaluate('@js:return result.trim();',{result:{trim:'not a function'}}).ok);
});
test('bounded inputs, operations, output size and cache eviction do not change results',()=>{
 assert(!evaluate('@js:return result;',{result:'x'.repeat(24001)}).ok);
 assert(!evaluate('@js:var x=result+result;return x+x;',{result:'x'.repeat(12000)}).ok);
 assert(!evaluate('@js:return result;', {result:Array.from({length:121},()=>1)}).ok);
 assert(!evaluate('@js:'+';'.repeat(10001)+'return "x";',{}).ok);
 assert(!evaluate('@js:'+Array.from({length:160},(_,i)=>'var x'+i+'=1;').join('')+'return "x";',{}).ok);
 for(let n=0;n<110;n++)assert.equal(evaluate('@js:return "v'+n+'";',{}).value,'v'+n);
 assert.equal(evaluate('@js:return "ok";',{}).value,'ok');
});
test('URL normalizers in existing sources preserve relative and protocol-relative semantics',()=>{
 for(const name of ['思路客','全本小说网','得奇小说网']){
  const rule=bundle[name].searchBook.detailUrl,script=rule.slice(rule.indexOf('||')+2);
  for(const [value,expected] of [['/book/1/',bundle[name].sourceUrl+'/book/1/'],['https://public.example/a','https://public.example/a'],['//cdn.example/a','https://cdn.example/a'],['','']]){
   const out=evaluate(script,{...bindings,result:value});assert(out.ok,out.reason);assert.equal(out.value,expected);
  }
 }
});
test('numeric ID and UUID URL rewriting is bounded and preserves exact request fallbacks',()=>{
 const q=bundle['🎉起点中文网'].chapterList.requestInfo;
 const r=request(q,{...bindings,result:'https://m.qidian.com/book/12345/'});assert(r.ok,r.reason);assert.equal(r.request.url,'https://m.qidian.com/book/12345/catalog/');
 const uuid='123e4567-e89b-12d3-a456-426614174000';
 const c=request(bundle['错层小说'].chapterList.requestInfo,{...bindings,result:'https://m.cuoceng.com/book/'+uuid+'.html',config:{host:'https://m.cuoceng.com'},params:{queryInfo:{},lastResponse:{}}});
 assert(c.ok,c.reason);assert.equal(c.request.url,'https://m.cuoceng.com/book/chapter/'+uuid+'.html');
});
test('request objects reject unknown fields, duplicate keys and wrong method types',()=>{
 for(const raw of ['@js:return {url:"https://a",method:"DELETE"};','@js:return {url:"https://a",POST:"true"};','@js:return {url:"https://a",forbidCookie:1};','@js:return {url:"https://a",url:"https://b"};'])assert(!request(raw,{}).ok);
});
test('old simple templates still encode keywords once and complex templates do not double-encode',()=>{
 const raw=bundle['速读谷'].searchBook.requestInfo;
 const a=buildGetPlan({source:bundle['速读谷'],action:bundle['速读谷'].searchBook,origin:'https://www.suduguu.com',keyword:'a&书'});
 assert(a.url.endsWith('key=a%26%E4%B9%A6'));assert(!a.url.includes('%2526'));
 const s=bundle['思路客'];const b=buildGetPlan({source:s,action:s.searchBook,origin:s.sourceUrl,keyword:'a&书',role:'searchBook'});
 assert(b.url.includes('q=a%26%E4%B9%A6&p=1'));assert.equal(b.staticRequest,'bounded-data-expression');
});
test('same-site ordinary POST search has exact form bytes and no credentials',async()=>{
 const s=source();s.searchBook.requestInfo='@js:var k=String(params.keyWord).trim();return {url:config.host+"/search",POST:true,httpParams:{searchkey:k,Submit:""}};';
 const {report,calls}=await check(s);assert(report.httpChainVerified);
 const search=calls.find(c=>new URL(c.url).pathname==='/search');assert.equal(search.init.method,'POST');
 assert.equal(search.init.body,'searchkey=%E6%B5%8B%E8%AF%95%20%26%20%E5%B0%8F%E8%AF%B4&Submit=');
 assert.equal(search.init.headers['Content-Type'],'application/x-www-form-urlencoded');
 assert.equal(report.steps[1].requestMethod,'POST');assert.deepEqual(report.steps[1].requestCapabilities.formFields,['searchkey','Submit']);
 assert(!JSON.stringify(report).includes('searchkey=%E6'));assert(!search.init.headers.Cookie);
});
test('POST is forbidden for non-search actions, non-search paths, fixed queries and tokens',()=>{
 for(const [raw,role] of [
  ['@js:return {url:config.host+"/delete",POST:true,httpParams:{q:params.keyWord}};','searchBook'],
  ['@js:return {url:config.host+"/search",POST:true,httpParams:{q:params.keyWord}};','chapterContent'],
  ['@js:return {url:config.host+"/search",POST:true,httpParams:{q:"different"}};','searchBook'],
  ['@js:return {url:config.host+"/search",POST:true,httpParams:{q:params.keyWord,_t:"secret"}};','searchBook'],
  ['@js:return {url:config.host+"/search",POST:true,httpParams:{q:params.keyWord,action:"login"}};','searchBook'],
  ['@js:return {url:"https://external.example/search",POST:true,httpParams:{q:params.keyWord}};','searchBook']
 ])assert(buildGetPlan({source:source(),action:{requestInfo:raw},origin,keyword:'demo',role}).reason,raw);
});
test('plain declared POST and raw Legado input still cannot be silently changed into GET',()=>{
 for(const data of [{POST:true},{method:'POST'},{httpParams:{q:'test'}}])assert(buildGetPlan({source:source(),action:{requestInfo:'/search',...data},origin,keyword:'test',role:'searchBook'}).reason);
});
test('GBK form encoding is explicit and does not lose Chinese keyword bytes',()=>{
 const action={requestInfo:'@js:return {url:config.host+"/search",POST:true,httpParams:{q:params.keyWord}};',requestParamsEncode:'gbk'};
 const plan=buildGetPlan({source:source(),action,origin,keyword:'中文',role:'searchBook'});
 assert.equal(plan.body,'q=%D6%D0%CE%C4');assert.equal(plan.method,'POST');
 const no=buildGetPlan({source:source(),action,origin,keyword:'😀',role:'searchBook'});assert(no.reason);
});
test('POST redirect 303 drops the form; 307 may not resend it to another operation',async()=>{
 const s=source();s.searchBook.requestInfo='@js:return {url:config.host+"/search",POST:true,httpParams:{q:params.keyWord}};';
 const a=await check(s,(url,init)=>new URL(url).pathname==='/search'&&init.method==='POST'
  ?new Response('',{status:303,headers:{Location:'/search?done=yes'}}):html(pages[new URL(url).pathname]));
 const seq=a.calls.filter(c=>new URL(c.url).pathname==='/search');assert.equal(seq.length,2);assert.equal(seq[1].init.method,'GET');assert.equal(seq[1].init.body,undefined);assert.equal(seq[1].init.headers['Content-Type'],undefined);
 const b=await check(s,url=>new URL(url).pathname==='/search'?new Response('',{status:307,headers:{Location:'/delete'}}):html(pages[new URL(url).pathname]));
 assert(!b.calls.some(c=>new URL(c.url).pathname==='/delete'));assert.equal(b.report.fullyVerified,false);
});
test('raw POST body cannot cross a canonical host by 307 nor leak into a private target',async()=>{
 const s=source();s.searchBook.requestInfo='@js:return {url:config.host+"/search",POST:true,httpParams:{q:params.keyWord}};';
 for(const dest of ['https://myshu.cc/search','http://169.254.169.254/search']){
  const r=await check(s,url=>new URL(url).pathname==='/search'?new Response('',{status:307,headers:{Location:dest}}):html(pages[new URL(url).pathname]));
  assert(!r.calls.some(c=>c.url===dest));assert(!r.report.fullyVerified);
 }
});
test('unrecognized WebView code or response overrides never obtain a false full pass',()=>{
 const base={source:source(),origin,keyword:'demo',role:'searchBook'};
 assert(buildGetPlan({...base,action:{requestInfo:'@js:return {url:config.host+"/search",responseFormatType:"json"};'}}).reason);
 const x=buildGetPlan({...base,action:{requestInfo:'@js:return {url:config.host+"/search",webView:true};'}});
 assert(x.requestCapabilities.unchecked.some(f=>f.field==='webView'));
 assert(buildGetPlan({...base,action:{requestInfo:bundle['菠萝猫'].searchBook.requestInfo}}).reason);
});
test('Siluke-style URL pipeline is interpreted on each list node without changing the public source',async()=>{
 const s=source();s.searchBook.detailUrl=bundle['思路客'].searchBook.detailUrl.replaceAll('https://www.sluke.org',origin);
 const before=JSON.stringify(s);const {report,calls}=await check(s);
 assert(report.httpChainVerified);assert(calls.some(c=>c.url===origin+'/book/1/'));
 const field=report.steps[1].fieldChecks.find(f=>f.field==='detailUrl');assert.equal(field.status,'ok');assert.equal(field.contexts[0].normalization,'bounded-data-expression');
 assert.equal(JSON.stringify(s),before);
});
test('ambiguous link inputs never become successful just because a safe postprocessor exists',async()=>{
 const s=source();s.searchBook.detailUrl='//a/@href||@js:return result.trim();';
 const {report,calls}=await check(s,url=>new URL(url).pathname==='/search'?html('<div class="card"><h3><a href="/book/1/">A</a><a href="/book/2/">B</a></h3></div>'):html(pages[new URL(url).pathname]));
 assert.equal(report.fullyVerified,false);assert.equal(calls.length,2);
});
test('JSON object URL builder obtains data only from the selected record and encodes fields',async()=>{
 const s=source();s.searchBook.responseFormatType='json';s.searchBook.list='$.data.items';s.searchBook.bookName='$.name';
 s.searchBook.detailUrl='@js:var b=result||{};if(!b.id)return "";return config.host+"/book/"+encodeURIComponent(b.id)+"/";';
 const {report,calls}=await check(s,url=>new URL(url).pathname==='/search'?new Response(JSON.stringify({data:{items:[{id:'1',name:'样例书'}]}}),{headers:{'content-type':'application/json'}}):html(pages[new URL(url).pathname]));
 assert(report.httpChainVerified);assert(calls.some(c=>c.url===origin+'/book/1/'));
 assert.equal(report.steps[1].fieldChecks.find(f=>f.field==='detailUrl').status,'ok');
});
test('search methods and field code never execute malicious trailing operations',async()=>{
 delete globalThis.probeAttack;const s=source();s.searchBook.requestInfo='@js:return {url:config.host+"/search"};globalThis.probeAttack=1;';
 const {calls,report}=await check(s);assert.equal(globalThis.probeAttack,undefined);assert.equal(report.steps[1].status,'unsupported');assert.equal(calls.length,1);
});

test('legacy generated resolver is identified by full AST, never by a loose substring',()=>{
 const {describeLinkRule,resolveRecognizedLink}=require('../../converter/lib/linkRule.js');
 const raw=bundle['抖音小说'].chapterList.url,known=describeLinkRule(raw);
 assert.equal(known.normalization,'legacy-response-url');
 assert.equal(resolveRecognizedLink('../chapter/2.html','https://www.douyinxs.com/book/1.html',known),'https://www.douyinxs.com/chapter/2.html');
 assert.equal(resolveRecognizedLink('//example.com/x','https://www.douyinxs.com/book/1.html',known),'https://example.com/x');
 for(const changed of [raw+'\nglobalThis.legacyAttack=true;',raw.replace('stack.push(parts[i]);','stack.push("changed");'),raw.replace('stack=[]','stack=fetch("https://evil.example")')])assert.equal(describeLinkRule(changed),null);
 const spaced=raw.replace('var u=','var /* allowed formatting */ u = ');assert(describeLinkRule(spaced));
});
test('unknown loops remain rejected even when copied from a legitimate-looking resolver',()=>{
 const raw=bundle['抖音小说'].chapterList.url.split('||@js:')[1];
 assert.equal(evaluate(raw,bindings).ok,false);
});
test('legacy resolver advances a real fixture reading chain and still blocks unsafe targets',async()=>{
 const s=source();s.chapterList.url=bundle['抖音小说'].chapterList.url;
 const checked=await check(s);assert(checked.report.httpChainVerified);
 assert.equal(checked.report.steps[3].fieldChecks.find(f=>f.field==='url').normalization,'legacy-response-url');
 const bad=await check(s,url=>new URL(url).pathname==='/book/1/'?html('<h1>Book</h1><div id="toc"><a href="http://169.254.169.254/latest">Bad</a></div>'):html(pages[new URL(url).pathname]));
 assert(!bad.calls.some(x=>x.url.includes('169.254')));assert(!bad.report.fullyVerified);
});
test('same-chapter page guards support reviewed numeric captures without widening arbitrary regex support',()=>{
 const raw=bundle['思路客'].chapterContent.nextPageUrl.split('||@js:')[1];
 const ctx={params:{responseUrl:'https://www.sluke.org/1/2/456.html'},result:'/1/2/456_2.html'};
 assert.equal(evaluate(raw,ctx).value,'https://www.sluke.org/1/2/456_2.html');
 assert.equal(evaluate(raw,{...ctx,result:'/1/2/457.html'}).value,'');
 const catalog=bundle['思路客'].chapterList.nextPageUrl.split('||@js:')[1];
 assert.equal(evaluate(catalog,{params:{responseUrl:'https://www.sluke.org/book/index_2.html'},result:'/book/index_1.html'}).value,'');
});
test('POST routes reject action-changing query strings and no credential token is forwarded',()=>{
 const action={requestInfo:'@js:return {url:config.host+"/search?action=delete",POST:true,httpParams:{q:params.keyWord}};'};
 assert(buildGetPlan({source:source(),action,origin,keyword:'demo',role:'searchBook'}).reason);
});
test('page-index dependency is retained in capability evidence for interpreted templates',()=>{
 const s=bundle['思路客'];const p=buildGetPlan({source:s,action:s.searchBook,origin:s.sourceUrl,keyword:'demo',role:'searchBook'});
 assert(p.requestCapabilities.unchecked.some(x=>x.field==='requestInfo.pageIndex'));assert(!p.capabilitiesChecked);
});
test('even unreachable assignments cannot mutate input bindings or constants',()=>{
 for(const code of ['@js:if(false)result="x";return "ok";','@js:const x=1;if(false)x=2;return x;'])assert(!evaluate(code,bindings).ok);
 let used=0;const input=[];Object.defineProperty(input,'0',{get(){used++;return 'bad';},enumerable:true});
 assert(!evaluate('@js:return result[0];',{result:input}).ok);assert.equal(used,0);
});
test('content length is calculated after recognized postprocessing, not the original long HTML',async()=>{
 const s=source();s.chapterContent.content='//*[@id="content"]||@js:return "short";';
 const r=await check(s);assert.equal(r.report.steps[4].contentLength,5);assert.equal(r.report.steps[4].status,'no-results');assert.equal(r.report.fullyVerified,false);
});
test('CSRF/token-like URL parameters stop before search requests even in interpreted GET',async()=>{
 for(const key of ['_t','csrf','csrf_token','sign','nonce']){
  const s=source();s.searchBook.requestInfo='@js:return {url:config.host+"/search?'+key+'=PRIVATE_QUERY_VALUE&q="+encodeURIComponent(params.keyWord)};';
  const r=await check(s);assert.equal(r.calls.length,1);assert.equal(r.report.steps[1].status,'unsupported');
 }
});
test('new request syntax participates in evidence secret redaction without executing unknown code',async()=>{
 const {sanitizeEvidence}=await import('../evidence-report.js');
 const raw='@js:var key=String(params.keyWord||"");return {url:config.host+"/search",POST:true,httpParams:{keyword:key,_t:"PRIVATE_FORM_TOKEN"},httpHeaders:{Authorization:"Bearer PRIVATE_MODEL_HEADER"}};';
 const sanitized=sanitizeEvidence({diagnostics:['PRIVATE_FORM_TOKEN PRIVATE_MODEL_HEADER'],steps:[]},{searchBook:{requestInfo:raw}});
 assert(!JSON.stringify(sanitized).includes('PRIVATE_FORM_TOKEN'));assert(!JSON.stringify(sanitized).includes('PRIVATE_MODEL_HEADER'));
});
test('a forged actionID cannot enable POST outside the real search phase',async()=>{
 const s=source();s.bookDetail.actionID='searchBook';s.bookDetail.requestInfo='@js:return {url:config.host+"/search",POST:true,httpParams:{q:params.keyWord}};';
 const r=await check(s);assert.equal(r.report.steps[2].status,'unsupported');assert(!r.calls.some(c=>c.init.method==='POST'));
});
test('config headers exposed to expression parsing exclude private values and remain diagnosed',()=>{
 const s=source();s.httpHeaders={Cookie:'SESSION_PRIVATE_VALUE',Authorization:'Bearer AUTH_PRIVATE_VALUE','User-Agent':'Public UA'};
 s.searchBook.requestInfo='@js:return {url:config.host+"/search?q="+String(config.httpHeaders.Cookie),httpHeaders:config.httpHeaders};';
 const plan=buildGetPlan({source:s,action:s.searchBook,origin,keyword:'test',role:'searchBook'});
 assert(!JSON.stringify(plan).includes('SESSION_PRIVATE_VALUE'));assert(!JSON.stringify(plan).includes('AUTH_PRIVATE_VALUE'));
 assert.equal(plan.headers['User-Agent'],'Public UA');assert(!plan.capabilitiesChecked);
});
test('zero-argument scalar constructors retain their native data semantics',()=>{
 assert.equal(evaluate('@js:return String();',{}).value,'');
 assert.equal(evaluate('@js:return Number();',{}).value,0);
});
