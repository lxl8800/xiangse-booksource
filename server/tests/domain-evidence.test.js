import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {inspectDomainMove} from '../domain-migration.js';
const require=createRequire(import.meta.url);
const {applyVerifiedDomainMove}=require('../../converter/lib/domainRewrite.js');
const {rewriteStaticGetOrigin,describeStaticGetRequest}=require('../../converter/lib/urlRule.js');
const origin='https://books.example',target='https://www.books.example';
const html=()=>new Response('<html><title>公开小说站测试</title><body>'+('这是域名迁移回归使用的模拟公开网页。'.repeat(8))+'</body></html>',{headers:{'content-type':'text/html; charset=utf-8'}});
const redirect=(url,status=301)=>new Response('',{status,headers:url?{location:url}:{}});
const dns=async()=>{};
async function probe(input,fetcher,extra={}){
 const calls=[],resolved=[];
 const result=await inspectDomainMove(input,{fetcher:async(url,options)=>{calls.push(url);assert.equal(options.method,'GET');assert.equal(options.headers.Cookie,undefined);return fetcher(url,options);},
  dnsChecker:async url=>{resolved.push(url.href);await (extra.dnsChecker||dns)(url);},...('timeoutMs' in extra?{timeoutMs:extra.timeoutMs}:{})});
 return {result,calls,resolved};
}
test('HTTP to HTTPS to www permanent chain records every hop for both home and search',async()=>{
 const {result,calls,resolved}=await probe({sourceUrl:'http://books.example/',searchUrl:'/s?q={{key}}'},url=>{
  const u=new URL(url);
  if(u.protocol==='http:')return redirect('https://books.example'+u.pathname+u.search,308);
  if(u.hostname==='books.example')return redirect(target+u.pathname+u.search);
  return html();
 });
 assert.equal(result.autoApply,true);assert.equal(result.verificationScope,'homepage-search-origins');
 assert.deepEqual(result.home.redirects.map(x=>x.status),[308,301]);assert.equal(result.search.redirects.length,2);
 for(const report of [result.home,result.search]){
  assert.equal(report.requestMethod,'GET');assert.equal(report.httpStatus,200);assert.equal(report.finalDomain,'www.books.example');
  assert.equal(report.kind,'html');assert(report.originalUrl);assert.equal(typeof report.elapsedMs,'number');
  for(const row of report.redirects){assert(row.url&&row.location);assert.equal(typeof row.elapsedMs,'number');}
 }
 assert.deepEqual(calls,resolved);
});
test('HTTPS downgrade in an intermediate hop is not erased by a final HTTPS upgrade',async()=>{
 const {result}=await probe({sourceUrl:origin},url=>{
  const u=new URL(url);
  if(u.protocol==='https:'&&u.hostname==='books.example')return redirect('http://books.example/');
  if(u.protocol==='http:')return redirect(target+'/');
  return html();
 });
 assert.equal(result.home.status,'ok');assert.equal(result.home.redirects[0].protocolDowngrade,true);
 assert.equal(result.autoApply,false);assert.equal(result.status,'needs-confirmation');assert(result.reason.includes('HTTPS 降级'));
});
test('missing Location retains the HTTP response and last redirect rather than disappearing',async()=>{
 const {result,calls}=await probe({sourceUrl:origin},()=>redirect(null,308));
 assert.equal(result.status,'unverified');assert.equal(result.home.status,'unverified');
 assert.equal(result.home.httpStatus,308);assert.equal(result.home.originalUrl,origin+'/');
 assert.equal(result.home.finalDomain,'books.example');assert.equal(result.home.redirects.length,1);
 assert.equal(result.home.redirects[0].location,null);assert(result.home.redirects[0].reason.includes('Location'));assert.equal(calls.length,1);
});
test('the hop-limit redirect is retained and its destination is not requested',async()=>{
 const {result,calls}=await probe({sourceUrl:origin},url=>{
  const n=Number(new URL(url).pathname.slice(1)||0);return redirect(origin+'/'+(n+1),308);
 });
 assert.equal(calls.length,4);assert.equal(result.home.redirects.length,4);
 assert(result.home.redirects[3].reason.includes('超出'));assert.equal(result.home.httpStatus,308);assert.equal(result.autoApply,false);
});
test('redirect loops stop before re-requesting the first URL',async()=>{
 const {result,calls}=await probe({sourceUrl:origin},url=>redirect(new URL(url).hostname==='books.example'?target+'/':origin+'/'));
 assert.equal(calls.length,2);assert.equal(result.home.redirects.length,2);
 assert(result.home.redirects[1].reason.includes('循环'));assert.equal(result.autoApply,false);
});
test('unsafe credentials and query tokens are redacted in recorded Location and never forwarded',async()=>{
 for(const location of ['https://alice:PRIVATE_PASSWORD@new-books.example/','https://new-books.example/?api_key=PRIVATE_API_TOKEN']){
  const {result,calls}=await probe({sourceUrl:origin},()=>redirect(location));
  assert.equal(calls.length,1);assert.equal(result.home.status,'unsafe');assert.equal(result.home.redirects.length,1);
  assert(!JSON.stringify(result).includes('PRIVATE_PASSWORD'));assert(!JSON.stringify(result).includes('PRIVATE_API_TOKEN'));
  assert.equal(result.autoApply,false);
 }
});
test('literal IPv4 and IPv6 redirect destinations are rejected before DNS and HTTP',async()=>{
 for(const location of ['http://127.0.0.1/','http://169.254.169.254/latest/meta-data/','http://[::1]/','https://[2606:4700:4700::1111]/']){
  const {result,calls,resolved}=await probe({sourceUrl:origin},()=>redirect(location));
  assert.equal(calls.length,1);assert.equal(resolved.length,1);assert.equal(result.home.status,'unsafe',location);
  assert.equal(result.home.redirects.length,1);assert(result.home.redirects[0].reason);
 }
});
test('private DNS rejection keeps the previous redirect and does not perform the second HTTP request',async()=>{
 const {result,calls,resolved}=await probe({sourceUrl:origin},()=>redirect('https://unsafe-dns.example/'),{dnsChecker:async url=>{
  if(url.hostname==='unsafe-dns.example')throw Error('接口域名解析包含内网地址');
 }});
 assert.equal(calls.length,1);assert.equal(resolved.length,2);assert.equal(result.home.redirects[0].status,301);
 assert.equal(result.home.url,'https://unsafe-dns.example/');assert(result.home.reason.includes('内网'));
});
test('a stalled DNS check cannot exceed the probe time budget or issue a late HTTP request',async()=>{
 const start=Date.now();const {result,calls}=await probe({sourceUrl:origin},html,{timeoutMs:20,dnsChecker:()=>new Promise(()=>{})});
 assert.equal(calls.length,0);assert(result.home.reason.includes('超时'));assert(Date.now()-start<500);
 assert.equal(typeof result.home.elapsedMs,'number');assert.equal(result.home.originalUrl,origin+'/');
});
test('403 and 404 failures retain response metadata separately from DNS errors',async()=>{
 for(const status of [403,404]){
  const {result}=await probe({sourceUrl:origin},()=>new Response('unavailable',{status,headers:{'content-type':'text/html'}}));
  assert.equal(result.home.httpStatus,status);assert.equal(result.home.kind,'html');assert.equal(result.home.finalDomain,'books.example');
  assert.equal(result.home.contentType,'text/html');assert(result.home.reason.includes('HTTP '+status));
 }
});
test('body read failure keeps its HTTP 200 and response type',async()=>{
 const {result}=await probe({sourceUrl:origin},()=>new Response(new ReadableStream({start(controller){controller.error(Error('body interrupted'));}}),{headers:{'content-type':'text/html'}}));
 assert.equal(result.home.httpStatus,200);assert.equal(result.home.status,'unverified');assert.equal(result.home.kind,'html');
 assert(result.home.reason.includes('body interrupted'));assert.equal(result.autoApply,false);
});
test('same-origin homepage path changes are reported instead of being called unchanged',async()=>{
 const {result}=await probe({sourceUrl:origin},url=>new URL(url).pathname==='/'?redirect(origin+'/new/'):html());
 assert.equal(result.status,'needs-confirmation');assert.equal(result.migrationScope,'homepage');assert.equal(result.autoApply,false);
 assert(result.home.redirects[0].pathChanged);
});
test('same-origin search path changes are reported as search-module evidence',async()=>{
 const {result}=await probe({sourceUrl:origin,searchUrl:'/s?q={{key}}'},url=>new URL(url).pathname==='/s'?redirect(origin+'/search'+new URL(url).search,308):html());
 assert.equal(result.status,'needs-confirmation');assert.equal(result.migrationScope,'searchBook');assert.equal(result.autoApply,false);
 assert.equal(result.search.redirects[0].pathChanged,true);
});
test('homepage unchanged with permanent or temporary search migration never changes the whole source',async()=>{
 for(const status of [301,302,308]){
  const {result}=await probe({sourceUrl:origin,searchUrl:'/s?q={{key}}'},url=>{
   const u=new URL(url);return u.hostname==='books.example'&&u.pathname==='/s'?redirect('https://new-books.example'+u.pathname+u.search,status):html();
  });
  assert.equal(result.status,'needs-confirmation');assert.equal(result.migrationScope,'searchBook');assert.equal(result.newOrigin,'https://new-books.example');
  assert.equal(result.home.url,origin+'/');assert.equal(result.search.redirects[0].status,status);assert.equal(result.autoApply,false);
 }
});
test('failed homepage does not hide independently observable search migration',async()=>{
 const {result}=await probe({sourceUrl:origin,searchUrl:'/s?q={{key}}'},url=>{
  const u=new URL(url);if(u.hostname==='books.example'&&u.pathname==='/')return new Response('',{status:404});
  if(u.hostname==='books.example')return redirect('https://new-books.example'+u.pathname+u.search);
  return html();
 });
 assert.equal(result.home.httpStatus,404);assert.equal(result.search.status,'ok');
 assert.equal(result.status,'needs-confirmation');assert.equal(result.migrationScope,'searchBook');assert.equal(result.autoApply,false);
});
test('reachable homepage with failed search cannot claim both interfaces are unchanged and verified',async()=>{
 const {result}=await probe({sourceUrl:origin,searchUrl:'/s'},url=>new URL(url).pathname==='/s'?new Response('',{status:404}):html());
 assert.equal(result.home.status,'ok');assert.equal(result.search.httpStatus,404);assert.equal(result.status,'unverified');assert(result.reason.includes('搜索'));
});
test('authenticated, dynamic, POST-configured and independently hosted search are not guessed as GET',async()=>{
 for(const searchUrl of ['/s?api_key=PRIVATE_API_TOKEN','@js:globalThis.domainAttackExecuted=true;return "https://books.example/s";','/s,{"method":"POST","body":"keyword=x"}','https://search-books.example/s']){
  delete globalThis.domainAttackExecuted;
  const {result,calls}=await probe({sourceUrl:origin,searchUrl},html);
  assert.equal(calls.length,1,searchUrl);assert.equal(result.search.status,'unsupported');
  assert.equal(result.autoApply,false);assert(!JSON.stringify(result).includes('PRIVATE_API_TOKEN'));assert.equal(globalThis.domainAttackExecuted,undefined);
 }
});
test('frontend skipped-search flags cannot turn a homepage move into verified search evidence',async()=>{
 for(const skipped of ['unsupported-search','sensitive-search']){
  const {result,calls}=await probe({sourceUrl:origin,searchProbeSkipped:skipped},url=>new URL(url).hostname==='books.example'?redirect(target+'/'):html());
  assert.equal(result.home.status,'ok');assert.equal(result.search.status,'unsupported');assert.equal(result.status,'needs-confirmation');assert.equal(result.autoApply,false);assert.equal(calls.length,2);
 }
});
test('origin rewrite preserves query token bytes, nested URLs, text rules and unrelated CDN fields',()=>{
 const old=origin,modern=target;
 const tail='/book?token='+old+'/secret&redirect='+old+'/nested#'+old;
 const source={sourceUrl:old,searchBook:{host:old,requestInfo:old+'/s?q=%@keyWord&token='+old,
  detailUrl:old+tail,bookName:'//*[contains(text(),"'+old+'")]',cover:'https://cdn.example/'+old},
  bookDetail:{chapterListUrl:old+tail},chapterList:{url:old+tail},chapterContent:{nextPageUrl:old+tail},
  bookWorld:{分类:{requestInfo:old+'/list?ref='+old}},httpHeaders:{Referer:old+tail,Origin:old,Cookie:'address='+old,Authorization:'Bearer '+old}};
 const before=JSON.stringify(source),r=applyVerifiedDomainMove(source,{oldOrigin:old,newOrigin:modern,status:'verified',autoApply:true});
 assert(r.applied);
 for(const [module,key] of [['searchBook','detailUrl'],['bookDetail','chapterListUrl'],['chapterList','url'],['chapterContent','nextPageUrl']])assert.equal(r.source[module][key],modern+tail);
 assert.equal(r.source.searchBook.requestInfo,modern+'/s?q=%@keyWord&token='+old);
 assert.equal(r.source.bookWorld['分类'].requestInfo,modern+'/list?ref='+old);
 assert.equal(r.source.httpHeaders.Referer,modern+tail);assert.equal(r.source.httpHeaders.Origin,modern);
 assert.equal(r.source.httpHeaders.Cookie,source.httpHeaders.Cookie);assert.equal(r.source.httpHeaders.Authorization,source.httpHeaders.Authorization);
 assert.equal(r.source.searchBook.bookName,source.searchBook.bookName);assert.equal(r.source.searchBook.cover,source.searchBook.cover);
 assert.equal(JSON.stringify(source),before);
});
test('case and default-port authorities normalize while generated GET cookie intent remains intact',()=>{
 const quote=String.fromCharCode(96),placeholder='$'+'{params.keyWord}';
 const rule='@js:\nvar url = '+quote+'https://BOOKS.example:443/s?q='+placeholder+'&token='+origin+quote+';\nreturn {url: url, forbidCookie: true};';
 const after=rewriteStaticGetOrigin(rule,origin,target),description=describeStaticGetRequest(after);
 assert.equal(description.url,target+'/s?q=%@keyWord&token='+origin);assert.equal(description.forbidCookie,true);
 const r=applyVerifiedDomainMove({sourceUrl:'https://BOOKS.example:443/base',searchBook:{host:'https://BOOKS.example:443',requestInfo:rule}},{oldOrigin:origin,newOrigin:target,status:'verified',autoApply:true});
 assert.equal(r.source.sourceUrl,target+'/base');assert.equal(r.source.searchBook.host,target);assert.equal(r.source.searchBook.requestInfo,after);
});

test('ordinary author search parameter is not mistaken for authentication',async()=>{
 const {result,calls}=await probe({sourceUrl:origin,searchUrl:'/s?author={{key}}'},html);
 assert.equal(calls.length,2);assert.equal(result.search.status,'ok');assert.equal(result.status,'unchanged');
});

test('unknown scripts containing differently cased old authorities keep the original source for review',()=>{
 const source={sourceUrl:origin,chapterList:{requestInfo:'@js:return "https://BOOKS.example:443/catalog";'}};
 const r=applyVerifiedDomainMove(source,{oldOrigin:origin,newOrigin:target,status:'verified',autoApply:true});
 assert.equal(r.applied,false);assert.equal(r.needsReview,true);assert.equal(r.source,source);
});
