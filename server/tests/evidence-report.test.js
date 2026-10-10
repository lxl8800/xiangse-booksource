import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectSourceWeb} from '../site-evidence.js';
import {runAutoRepair} from '../auto-repair.js';
import {createRequire} from 'node:module';
const {rewriteStaticGetUrl,describeStaticGetRequest}=createRequire(import.meta.url)('../../converter/lib/urlRule.js');
import {sanitizeEvidence,splitXPathPipeline} from '../evidence-report.js';
const origin='https://www.myshu.cc';
const long='这是模拟测试章节的正文段落，用于检查多个文本节点合并、列表上下文与字段证据，绝不是外部作者的真实作品内容。';
const ok=body=>new Response(body,{headers:{'content-type':'text/html; charset=utf-8'}});
function source(){
  return {sourceName:'证据回归',sourceUrl:origin,sourceType:'text',enable:1,weight:'100',
    searchBook:{actionID:'searchBook',parserID:'DOM',responseFormatType:'html',
      requestInfo:origin+'/search.php?q=%@keyWord',list:'//div[@class="item"]',bookName:'//h3/a/text()',detailUrl:'//h3/a/@href'},
    bookDetail:{actionID:'bookDetail',parserID:'DOM',responseFormatType:'html',requestInfo:'%@result',title:'//h1/text()'},
    chapterList:{actionID:'chapterList',parserID:'DOM',responseFormatType:'html',requestInfo:'%@result',list:'//*[@id="list"]//li',title:'//a/span/text()',url:'//a/@href'},
    chapterContent:{actionID:'chapterContent',parserID:'DOM',responseFormatType:'html',requestInfo:'%@result',content:'//*[@id="content"]//text()'}};
}
const pages={
  '/':'<form action="/search.php" method="get"><input name="q"><input type="hidden" name="type" value="novel"></form>',
  '/search.php':'<a href="/wrong/">导航链接</a>'+[1,2,3,4].map(i=>'<div class="item"><h3><a href="/book/'+i+'/">书名'+i+'</a></h3></div>').join(''),
  '/book/1/':'<h1>书名1</h1><ul id="list">'+[1,2,3].map(i=>'<li>噪声<a href="/book/1/'+i+'.html">前缀<span>第'+i+'章</span></a></li>').join('')+'</ul>',
  '/book/1/1.html':'<div id="content">开头短句。<p>'+long+'</p><p>结尾测试内容。</p></div>'
};
const dns=async()=>{};
const fetcher=async url=>{
  const u=new URL(url);
  if(u.pathname==='/old.php')return new Response('not found',{status:404});
  if(!(u.pathname in pages))throw Error('unexpected '+url);
  return ok(pages[u.pathname]);
};
async function inspect(config=source(),custom=fetcher){
  return inspectSourceWeb({source:{证据回归:config},sourceName:'证据回归',keyword:'测试'},{fetcher:custom,dnsChecker:dns});
}
test('field evidence samples three distinct cards, resolves URLs and honors chapter title rules',async()=>{
  const report=await inspect(),search=report.steps[1],toc=report.steps[3],content=report.steps[4];
  assert.equal(report.fullyVerified,true);
  assert.equal(report.reportVersion,1);assert.equal(report.appVerified,false);
  const field=search.fieldChecks.find(f=>f.field==='detailUrl');
  assert.equal(field.context,'list-node');
  assert.deepEqual(field.contexts.map(x=>x.samples[0]),['/book/1/','/book/2/','/book/3/']);
  assert.deepEqual(field.contexts.map(x=>x.resolvedUrls[0]),[1,2,3].map(i=>origin+'/book/'+i+'/'));
  assert.equal(toc.examples[0].title,'第1章','title must come from configured span, not the full li');
  assert.equal(toc.reusedResponse,true);
  assert(content.contentLength>long.length,'all selected text nodes are combined');
  assert(content.fieldChecks[0].samples.every(x=>x.length<=32));
  assert.equal(search.requestMethod,'GET');assert.equal(search.charset,'utf-8');
  assert.equal(search.contentType,'text/html; charset=utf-8');
  assert(JSON.stringify(report).length<50000);
});
test('missing required fields and partial matches cannot prove a complete source',async()=>{
  const config=source();delete config.chapterList.title;
  const missing=await inspect(config);
  assert.equal(missing.fullyVerified,false);
  assert.equal(missing.steps[3].fieldChecks.find(x=>x.field==='title').status,'missing');
  const partial=await inspect(source(),async url=>{
    const r=await fetcher(url);
    return new URL(url).pathname==='/search.php'?ok((await r.text()).replace('/book/2/','')):r;
  });
  assert.equal(partial.fullyVerified,false);
  assert.equal(partial.steps[1].fieldChecks.find(x=>x.field==='detailUrl').status,'partial-match');
  // Empty attributes retain their node counts but cannot count as extracted data.
  assert.equal(partial.steps[1].fieldChecks.find(x=>x.field==='detailUrl').contexts[1].samples[0],'');
});
test('quoted pipe text is XPath data; only a top-level pipe starts App post-processing',async()=>{
  assert.deepEqual(splitXPathPipeline('//a[contains(@title,"x||y")]/@href'),{xpath:'//a[contains(@title,"x||y")]/@href',postprocess:false});
  assert.equal(splitXPathPipeline('//a[@title="||"]/@href||@js:return result;').xpath,'//a[@title="||"]/@href');
  const config=source();config.searchBook.bookName='//h3/a/text()||@js:globalThis.unsafeRuleExecuted=true; return result;';
  delete globalThis.unsafeRuleExecuted;
  const report=await inspect(config);
  assert.equal(globalThis.unsafeRuleExecuted,undefined);
  assert.equal(report.fullyVerified,false);
  assert.equal(report.steps[1].fieldChecks.find(x=>x.field==='bookName').status,'partially-checked');
});
test('evidence removes sensitive query parameters and source secrets from every early or full report',async()=>{
  const config=source();config.searchBook.requestInfo+='&token=PRIVATE_TOKEN_123';
  config.searchBook.httpHeaders={Authorization:'Bearer VERY_PRIVATE_HEADER'};
  const report=await inspect(config,async url=>{
    if(new URL(url).pathname==='/search.php')
      return ok(pages['/search.php'].replaceAll('/book/1/','/book/1/?token=PRIVATE_TOKEN_123'));
    return fetcher(url);
  });
  assert(!JSON.stringify(report).includes('PRIVATE_TOKEN_123'));
  const early=await inspect(config,async()=>{throw Error('failed '+origin+'/?session=PRIVATE_TOKEN_123');});
  assert(!JSON.stringify(early).includes('PRIVATE_TOKEN_123'));
  const scrubbed=sanitizeEvidence({diagnostics:['VERY_PRIVATE_HEADER '+origin+'/?auth=ABC123&ok=yes'],steps:[]},config);
  assert(!JSON.stringify(scrubbed).includes('VERY_PRIVATE_HEADER'));
  assert(!JSON.stringify(scrubbed).includes('ABC123'));
  assert(JSON.stringify(scrubbed).includes('ok=yes'));
});
test('form recovery preserves public hidden parameters, retests candidate, and leaves originals intact',async()=>{
  const config=source();config.searchBook.requestInfo=origin+'/old.php?q=%@keyWord';
  const before=JSON.stringify(config),seen=[];
  const mock=async url=>{
    const u=new URL(url);seen.push(u.href);
    if(u.pathname==='/search.php'&&u.searchParams.get('type')!=='novel')return new Response('requires type',{status:404});
    return fetcher(url);
  };
  const inspector=input=>inspectSourceWeb(input,{fetcher:mock,dnsChecker:dns});
  const result=await runAutoRepair({source:{证据回归:config},sourceName:'证据回归',keyword:'测试'},{webInspector:inspector});
  assert.equal(result.liveWebEvidence.fullyVerified,false);
  assert.equal(result.liveWebEvidence.steps[1].recoveredRequest,true);
  assert.equal(result.verified,true);
  const candidateUrl=new URL(result.candidate.searchBook.requestInfo);
  assert.equal(candidateUrl.origin,origin);assert.equal(candidateUrl.pathname,'/search.php');
  assert.equal(candidateUrl.searchParams.get('type'),'novel');assert.equal(candidateUrl.searchParams.get('q'),'%@keyWord');
  assert.equal(result.candidate.bookDetail.bookName,config.bookDetail.title);
  assert.equal(JSON.stringify(config),before);
  assert(seen.filter(x=>x.includes('/search.php')).length>=2);
});
test('secret hidden fields do not become unauthenticated repair URLs',async()=>{
  const config=source();config.searchBook.requestInfo=origin+'/old.php';
  const report=await inspect(config,async url=>new URL(url).pathname==='/'?ok('<form action="/search.php"><input name=q><input type=hidden name=csrf_token value=SECRET123></form>'):fetcher(url));
  assert.equal(report.steps[1].httpStatus,404);
  assert.equal(report.steps[1].discoveredSearch,undefined);
});
test('redirect rejection records status and Location without following a forbidden target',async()=>{
  const calls=[];
  const report=await inspect(source(),async url=>{
    calls.push(url);
    return new Response('',{status:308,headers:{location:'http://127.0.0.1/?token=PRIVATE_REDIRECT_TOKEN'}});
  });
  assert.equal(calls.length,2);
  assert.equal(report.steps[1].redirects[0].status,308);
  assert(report.steps[1].redirects[0].location.startsWith('http://127.0.0.1/'));
  assert(!JSON.stringify(report).includes('PRIVATE_REDIRECT_TOKEN'));
  assert.equal(report.fullyVerified,false);
});
test('meta GBK decoding is recorded and unknown charset stays unsupported rather than a network failure',async()=>{
  const raw=Buffer.concat([Buffer.from('<meta charset=gbk><title>'),Buffer.from([0xd6,0xd0,0xce,0xc4]),Buffer.from('</title>')]);
  const gbk=await inspect(source(),async url=>new URL(url).pathname==='/'?new Response(raw,{headers:{'content-type':'text/html'}}):fetcher(url));
  assert.equal(gbk.steps[0].charset,'gbk');assert.equal(gbk.steps[0].charsetSource,'html-meta');
  assert.equal(gbk.steps[0].title,'中文');
  const unknown=await inspect(source(),async()=>new Response('<p>x</p>',{headers:{'content-type':'text/html; charset=bogus-encoding'}}));
  assert.equal(unknown.steps[1].status,'unsupported');
  assert.equal(unknown.steps[1].httpStatus,200);
});
test('ignored custom headers or request encoding cannot produce a complete configuration verdict',async()=>{
  const config=source();config.searchBook.httpHeaders={'X-Custom':'abc'};
  assert.equal((await inspect(config)).fullyVerified,false);
  delete config.searchBook.httpHeaders;config.searchBook.requestParamsEncode='GBK';
  assert.equal((await inspect(config)).fullyVerified,false);
});

test('verified GET replacement preserves cookie wrappers, paging and rejects code injection or unknown placeholders',async()=>{
  const wrapped='@js:\nlet url = '+String.fromCharCode(96)+origin+'/old.php?q=$'+'{params.keyWord}'+String.fromCharCode(96)+';\nreturn {url: url, forbidCookie: true};';
  const next=origin+'/search.php?q=%@keyWord&page=%@pageIndex&type=novel';
  const rewritten=rewriteStaticGetUrl(wrapped,next);
  assert.deepEqual(describeStaticGetRequest(rewritten),{url:next,method:'GET',forbidCookie:true,generated:true});
  assert.equal(rewriteStaticGetUrl(wrapped,origin+'/?q=$'+'{globalThis.injected=true}'),null);
  assert.equal(rewriteStaticGetUrl(wrapped,origin+'/?q=%@unknown'),null);
  assert.equal(rewriteStaticGetUrl('@js:return executeUnknownRequest();',next),null);
  const config=source();config.searchBook.requestInfo=wrapped;
  const result=await runAutoRepair({source:{证据回归:config},sourceName:'证据回归',keyword:'测试'},
    {webInspector:input=>inspectSourceWeb(input,{fetcher,dnsChecker:dns})});
  assert.equal(result.verified,true);
  assert.equal(describeStaticGetRequest(result.candidate.searchBook.requestInfo).forbidCookie,true);
});

test('response body disconnect preserves the received HTTP status and stops the later chain',async()=>{
  const report=await inspect(source(),async()=>({
    status:200,headers:new Headers({'content-type':'text/html'}),
    body:{getReader(){return {async read(){throw Error('body connection reset');},releaseLock(){}};}}
  }));
  assert.equal(report.steps[1].httpStatus,200);
  assert.equal(report.steps[1].status,'network-error');
  assert.equal(report.steps[1].kind,'html');
  assert.equal(report.steps[1].requestMethod,'GET');
  assert.equal(report.fullyVerified,false);
  assert(report.steps.slice(2).every(x=>x.status==='skipped'));
});
