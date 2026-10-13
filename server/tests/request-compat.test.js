import {test} from 'node:test';
import assert from 'node:assert/strict';
import iconv from 'iconv-lite';
import {createRequire} from 'node:module';
import {inspectSourceWeb} from '../site-evidence.js';
import {buildGetPlan,encodeKeyword} from '../request-plan.js';
import {inspectDomainMove} from '../domain-migration.js';
import {sanitizeEvidence} from '../evidence-report.js';
const {buildRequestInfo,describeStaticGetRequest,rewriteStaticGetOrigin,rewriteStaticGetUrl}=createRequire(import.meta.url)('../../converter/lib/urlRule.js');
const origin='https://www.myshu.cc';
const body='这是仅用于测试的虚构正文段落，检查配置请求头、字符编码和目录请求一致性，不包含实际小说内容。';
function source(){
 return {sourceName:'请求兼容回归',sourceUrl:origin,sourceType:'text',enable:1,weight:'100',
  searchBook:{actionID:'searchBook',parserID:'DOM',responseFormatType:'html',requestInfo:origin+'/search?q=%@keyWord',list:'//div[@class="card"]',bookName:'//a/text()',detailUrl:'//a/@href'},
  bookDetail:{actionID:'bookDetail',parserID:'DOM',responseFormatType:'html',requestInfo:'%@result',title:'//h1/text()'},
  chapterList:{actionID:'chapterList',parserID:'DOM',responseFormatType:'html',requestInfo:'%@result',list:'//*[@id="toc"]/a',title:'//text()',url:'//@href'},
  chapterContent:{actionID:'chapterContent',parserID:'DOM',responseFormatType:'html',requestInfo:'%@result',content:'//*[@id="content"]'}};
}
const pages={'/':'<html><title>测试首页</title></html>','/search':'<div class="card"><a href="/book/">测试书</a></div>',
 '/book/':'<h1>测试书</h1><div id="toc"><a href="/chapter/">第一章</a></div>','/chapter/':'<div id="content">'+body+'</div>'};
const ok=(text,headers={'content-type':'text/html; charset=utf-8'})=>new Response(text,{headers});
async function inspect(s=source(),options={}){
 const calls=[];const response=options.respond||((url)=>ok(pages[new URL(url).pathname]));
 const report=await inspectSourceWeb({source:{回归:s},sourceName:'回归',keyword:options.keyword||'中文 & 书'},
  {dnsChecker:options.dnsChecker|| (async()=>{}),timeoutMs:options.timeoutMs||7800,fetcher:async(url,init)=>{calls.push({url,init});return response(url,init,calls.length);}});
 return {report,calls};
}
test('generated GET with literal JSON headers is recognized without any code evaluation',()=>{
 const r=buildRequestInfo('/search?q={{key}},{ "headers":{"User-Agent":"Example; Mobile","Accept-Language":"zh-CN"} }',{src:{bookSourceUrl:origin,enabledCookieJar:false},host:origin},'search');
 const d=describeStaticGetRequest(r.requestInfo);assert.equal(d.url,origin+'/search?q=%@keyWord');assert.equal(d.forbidCookie,true);
 assert.deepEqual(d.httpHeaders,{'User-Agent':'Example; Mobile','Accept-Language':'zh-CN'});
 assert.equal(describeStaticGetRequest(r.requestInfo+'\nglobalThis.requestAttack=true;'),null);
});
test('header declarations cannot hide expressions, POST, functions, duplicate keys or extra return fields',()=>{
 delete globalThis.requestAttack;
 const r=buildRequestInfo('/search?q={{key}},{ "headers":{"User-Agent":"Example"} }',{src:{bookSourceUrl:origin,enabledCookieJar:false},host:origin},'search').requestInfo;
 for(const changed of [r.replace('{"User-Agent":"Example"}','{ "User-Agent": (globalThis.requestAttack=true) }'),r.replace('httpHeaders: httpHeaders','httpHeaders: httpHeaders, POST: true'),
  r.replace('forbidCookie: true','forbidCookie: true, forbidCookie: false'),r.replace('httpHeaders: httpHeaders','httpHeaders: httpHeaders, url: "https://evil.example"')]){
  assert.equal(describeStaticGetRequest(changed),null);
 }
 assert.equal(globalThis.requestAttack,undefined);
});
test('verified URL rewriting retains every static header, paging and forbidCookie byte',()=>{
 const rule=buildRequestInfo('/old?q={{key}},{ "headers":{"User-Agent":"Example","Referer":"'+origin+'/page"} }',{src:{bookSourceUrl:origin,enabledCookieJar:false},host:origin},'search').requestInfo;
 const rewritten=rewriteStaticGetUrl(rule,origin+'/new?q=%@keyWord&page=%@pageIndex');const d=describeStaticGetRequest(rewritten);
 assert.equal(d.httpHeaders.Referer,origin+'/page');assert(d.forbidCookie);
 const moved=rewriteStaticGetOrigin(rewritten,origin,'https://myshu.cc');const after=describeStaticGetRequest(moved);
 assert.equal(after.url,'https://myshu.cc/new?q=%@keyWord&page=%@pageIndex');
 assert.deepEqual(after.httpHeaders,d.httpHeaders,'header URL text is not rewritten as the request URL');
});
test('case-insensitive source, action and request headers merge with request-level precedence',async()=>{
 const s=source();s.httpHeaders={'user-agent':'Source UA','accept-language':'zh-CN'};s.searchBook.httpHeaders={'USER-AGENT':'Action UA'};
 s.searchBook.requestInfo=buildRequestInfo('/search?q={{key}},{ "headers":{"User-Agent":"Request UA"} }',{src:{bookSourceUrl:origin},host:origin},'search').requestInfo;
 const {report,calls}=await inspect(s);
 assert.equal(report.fullyVerified,true);assert.equal(calls.find(c=>new URL(c.url).pathname==='/search').init.headers['User-Agent'],'Request UA');
 assert.equal(calls.find(c=>new URL(c.url).pathname==='/chapter/').init.headers['User-Agent'],'Source UA');
 assert(calls.every(c=>c.init.headers['Accept-Language']==='zh-CN'));
 assert.deepEqual(report.steps[1].requestCapabilities.headersApplied,['User-Agent','Accept-Language']);
 assert(!JSON.stringify(report).includes('Request UA'),'evidence records header names only');
});
test('safe header JSON strings work and action false overrides a source WebView flag',async()=>{
 const s=source();s.httpHeaders='{"User-Agent":"Static UA"}';s.webView=true;
 for(const action of ['searchBook','bookDetail','chapterList','chapterContent'])s[action].webView=false;
 const {report,calls}=await inspect(s);assert(report.fullyVerified);assert(calls.every(c=>c.init.headers['User-Agent']==='Static UA'));
});
test('Cookie, authorization, host and custom headers never reach the network or prove full verification',async()=>{
 const s=source();s.httpHeaders={Cookie:'session=PRIVATE_COOKIE_VALUE',Authorization:'Bearer PRIVATE_HEADER_VALUE',Host:'169.254.169.254','X-Custom':'custom'};
 const {report,calls}=await inspect(s);assert.equal(report.httpChainVerified,true);assert.equal(report.fullyVerified,false);
 for(const c of calls)for(const key of ['Cookie','Authorization','Host','X-Custom'])assert.equal(c.init.headers[key],undefined,key);
 assert(report.steps[1].requestCapabilities.headersSkipped.includes('Authorization'));
 assert(!JSON.stringify(report).includes('PRIVATE_COOKIE_VALUE'));assert(!JSON.stringify(report).includes('PRIVATE_HEADER_VALUE'));
});
test('invalid, non-object and oversized header configuration cannot disappear from the verdict',async()=>{
 for(const headers of ['@js:return steal();',[],{'User-Agent':123},Object.fromEntries(Array.from({length:25},(_,i)=>['X-'+i,'value']))]){
  const s=source();s.httpHeaders=headers;const {report}=await inspect(s);assert.equal(report.fullyVerified,false);
  assert(report.diagnostics.some(x=>x.includes('httpHeaders')));
 }
});
test('dynamic header values and CRLF are rejected without executing uploaded expressions',async()=>{
 delete globalThis.requestAttack;
 for(const ua of ['@js:globalThis.requestAttack=true;return "UA";','User\r\nHost: localhost',''+String.fromCharCode(0)+'bad']){
  const s=source();s.searchBook.httpHeaders={'User-Agent':ua};const {report,calls}=await inspect(s);
  assert.equal(report.fullyVerified,false);assert(!calls.some(c=>c.init.headers['User-Agent']===ua));
 }
 assert.equal(globalThis.requestAttack,undefined);
});
test('Referer and Origin permit same-site canonical URLs and refuse credential or cross-site values',async()=>{
 const s=source();s.searchBook.httpHeaders={Referer:origin+'/books/?public=yes',Origin:origin};
 assert((await inspect(s)).report.fullyVerified);
 for(const headers of [{Referer:'https://other.example/private'},{Origin:origin+'/not-an-origin'},{Referer:origin+'/?token=PRIVATE_REFERER_VALUE'},{Origin:'http://www.myshu.cc'}]){
  s.searchBook.httpHeaders=headers;const {report,calls}=await inspect(s);assert.equal(report.fullyVerified,false);
  const request=calls.find(c=>new URL(c.url).pathname==='/search');assert.equal(request.init.headers[Object.keys(headers)[0]],undefined);
 }
});
test('configured GBK response bytes override an incorrect UTF-8 HTTP header',async()=>{
 const s=source();s.responseEncode='2147485234';
 const {report}=await inspect(s,{respond:url=>ok(iconv.encode(pages[new URL(url).pathname],'gbk'))});
 assert.equal(report.fullyVerified,true);assert.equal(report.steps[1].examples[0].title,'测试书');
 assert.equal(report.steps[4].contentLength,body.length);
 for(const step of report.steps)assert.equal(step.charsetSource,'source-config');
});
test('action response charset takes precedence over source response charset',async()=>{
 const s=source();s.responseEncode='gbk';s.chapterContent.responseEncode='utf8';
 const {report}=await inspect(s,{respond:url=>ok(iconv.encode(pages[new URL(url).pathname],new URL(url).pathname==='/chapter/'?'utf8':'gbk'))});
 assert(report.fullyVerified);assert.equal(report.steps[1].charset,'gbk');assert.equal(report.steps[4].charset,'utf-8');
});
test('unknown configured response charset fails before a fallback decoder or network request',async()=>{
 const s=source();s.searchBook.responseEncode='9999999';const {report,calls}=await inspect(s);
 assert.equal(report.steps[1].status,'unsupported');assert(report.steps[1].reason.includes('responseEncode'));
 assert(!calls.some(c=>new URL(c.url).pathname==='/search'));
});
test('numeric GBK and GB2312 GET encodings produce the exact expected percent-encoded keyword bytes',async()=>{
 for(const encoding of ['2147485234','2147485232','GBK','gb2312']){
  const s=source();s.searchBook.requestParamsEncode=encoding;
  const {report,calls}=await inspect(s,{keyword:'中文 & 书'});
  assert(report.fullyVerified);assert(calls.some(c=>c.url===origin+'/search?q=%D6%D0%CE%C4%20%26%20%CA%E9'));
  assert(['gbk','gb2312'].includes(report.steps[1].requestCapabilities.requestEncoding));
 }
 assert.equal(encodeKeyword('中文','gbk'),'%D6%D0%CE%C4');
});
test('unrepresentable search characters and unknown request charset stop before search DNS/fetch',async()=>{
 for(const [charset,keyword] of [['gbk','中文😀'],['BOGUS','中文']]){
  const s=source();s.searchBook.requestParamsEncode=charset;
  const {report,calls}=await inspect(s,{keyword});assert.equal(report.steps[1].status,'unsupported');
  assert(report.steps[1].reason.includes('字符')||report.steps[1].reason.includes('requestParamsEncode'));
  assert(!calls.some(c=>new URL(c.url).pathname==='/search'));
 }
});
test('UTF-8 keyword expansion remains byte-compatible and keeps static encoded URL parts unchanged',()=>{
 const s=source();s.searchBook.requestInfo=origin+'/search?fixed=%2F&q=%@keyWord';
 const p=buildGetPlan({source:s,action:s.searchBook,origin,keyword:'中文 & 书'});
 assert.equal(p.url,origin+'/search?fixed=%2F&q=%E4%B8%AD%E6%96%87%20%26%20%E4%B9%A6');
});
test('per-action headers or decoder changes require fetching a same-URL catalog independently',async()=>{
 for(const change of [{httpHeaders:{'User-Agent':'Catalog UA'}},{responseEncode:'gbk'}]){
  const s=source();Object.assign(s.chapterList,change);
  const {report,calls}=await inspect(s);assert.equal(calls.filter(c=>new URL(c.url).pathname==='/book/').length,2);
  assert.equal(report.steps[3].reusedResponse,false);
  assert(report.steps[3].requestCapabilities.headersApplied.includes('User-Agent')||report.steps[3].requestCapabilities.responseEncoding==='gbk');
 }
});
test('same-URL catalog response is reused when effective headers and decoder are equivalent',async()=>{
 const s=source();s.httpHeaders={'User-Agent':'Shared UA'};s.chapterList.httpHeaders={'user-agent':'Shared UA'};
 const {report,calls}=await inspect(s);assert(report.fullyVerified);assert.equal(calls.filter(c=>new URL(c.url).pathname==='/book/').length,1);
 assert.equal(report.steps[3].reusedResponse,true);
});
test('declared POST and httpParams are stopped rather than silently validated as plain GET',async()=>{
 for(const change of [{POST:true},{method:'POST'},{httpParams:{q:'中文'}}]){
  const s=source();Object.assign(s.searchBook,change);const {report,calls}=await inspect(s);
  assert.equal(report.steps[1].status,'unsupported');assert(!calls.some(c=>new URL(c.url).pathname==='/search'));
  assert.equal(report.fullyVerified,false);
 }
});
test('raw Legado POST requests cannot bypass the safe GET planner through original-source fallback',async()=>{
 const s={bookSourceName:'原始请求',bookSourceUrl:origin,searchUrl:'/search,{"method":"POST","body":"q={{key}}"}',ruleSearch:{bookList:'.card'}};
 const calls=[];const r=await inspectSourceWeb({legado:s,keyword:'中文'},{dnsChecker:async()=>{},fetcher:async url=>{calls.push(url);return ok(pages['/']);}});
 assert.equal(r.steps[1].status,'unsupported');assert.equal(calls.length,1);assert.equal(r.fullyVerified,false);
});
test('empty-string WebView flags, source hooks and decryption are never treated as fully executed',async()=>{
 for(const [target,key,value] of [['action','webView',''],['source','requestFunction','@js:return result;'],['action','responseDecryptType','encryptType1']]){
  const s=source();(target==='action'?s.searchBook:s)[key]=value;
  const {report}=await inspect(s);assert.equal(report.fullyVerified,false,key);assert(report.diagnostics.some(x=>x.includes(key)));
 }
});
test('nextPageUrl and page-index templates explicitly remain incomplete after a first-page HTTP chain',async()=>{
 for(const module of ['searchBook','chapterList','chapterContent']){
  const s=source();s[module].nextPageUrl='//a[@rel="next"]/@href';const {report}=await inspect(s);
  assert(report.httpChainVerified);assert.equal(report.fullyVerified,false);
  const step=report.steps.find(x=>x.step===({searchBook:'search',chapterList:'chapterList',chapterContent:'chapterContent'}[module]));
  assert(step.requestCapabilities.unchecked.some(x=>x.field==='nextPageUrl'));
 }
 const s=source();s.chapterList.requestInfo=origin+'/book/?p=%@pageIndex';
 const {report}=await inspect(s);assert.equal(report.fullyVerified,false);assert(report.steps[3].requestCapabilities.unchecked.some(x=>x.field==='requestInfo.pageIndex'));
});
test('unexecuted skipCount survives a reused response and cannot be hidden by catalog caching',async()=>{
 const s=source();s.chapterList.moreKeys={skipCount:1};
 const {report}=await inspect(s);assert(report.steps[3].reusedResponse);assert.equal(report.fullyVerified,false);
 assert(report.steps[3].requestCapabilities.unchecked.some(x=>x.field==='moreKeys.skipCount'));
});
test('DNS and body waits respect the same timeout even when the injected resolver or reader never settles',async()=>{
 const s=source();const never=()=>new Promise(()=>{});
 const start=Date.now();const dns=await inspect(s,{timeoutMs:25,dnsChecker:never});assert(Date.now()-start<700);
 assert(dns.report.steps.slice(0,2).every(x=>x.status==='timeout'));assert.equal(dns.calls.length,0);
 const stalled=await inspect(s,{timeoutMs:25,respond:()=>({status:200,headers:new Headers({'content-type':'text/html'}),body:{getReader(){return {read:never,releaseLock(){}};}}})});
 assert(stalled.report.steps.slice(0,2).every(x=>x.status==='timeout'));assert.equal(stalled.report.steps[1].httpStatus,200);
});
test('authenticated query parameters and private URLs are never requested with any configured header',async()=>{
 const s=source();s.searchBook.requestInfo+='&api_key=PRIVATE_QUERY_VALUE';const {report,calls}=await inspect(s);
 assert.equal(report.steps[1].status,'unsupported');assert(!calls.some(c=>c.url.includes('PRIVATE_QUERY_VALUE')));
 s.searchBook.requestInfo='http://169.254.169.254/latest/meta-data';const blocked=await inspect(s);assert.equal(blocked.report.steps[1].status,'unsupported');
 assert(!blocked.calls.some(c=>c.url.includes('169.254')));
});
test('domain-only probe does not pretend to execute newly recognized literal header requests',async()=>{
 const template=buildRequestInfo('/search?q={{key}},{ "headers":{"User-Agent":"Configured UA"} }',{src:{bookSourceUrl:origin},host:origin},'search').requestInfo;
 const calls=[];const r=await inspectDomainMove({sourceUrl:origin,searchUrl:template},{dnsChecker:async()=>{},fetcher:async(url,opts)=>{calls.push({url,opts});return ok('<html><title>Home</title>'+body+'</html>');}});
 assert.equal(calls.length,1);assert.equal(r.search.status,'unsupported');assert.equal(r.autoApply,false);
});
test('evidence scrubber also removes credentials embedded in recognized literal header wrappers',()=>{
 const rule=buildRequestInfo('/search?q={{key}},{ "headers":{"Authorization":"Bearer INLINE_PRIVATE_TOKEN","Cookie":"session=INLINE_PRIVATE_COOKIE"} }',{src:{bookSourceUrl:origin},host:origin},'search').requestInfo;
 const cleaned=sanitizeEvidence({diagnostics:['INLINE_PRIVATE_TOKEN INLINE_PRIVATE_COOKIE'],steps:[]},{searchBook:{requestInfo:rule}});
 assert(!JSON.stringify(cleaned).includes('INLINE_PRIVATE_TOKEN'));assert(!JSON.stringify(cleaned).includes('INLINE_PRIVATE_COOKIE'));
});
