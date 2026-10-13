import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {JSDOM} from 'jsdom';
import {inspectSourceWeb} from '../site-evidence.js';
import {runAutoRepair} from '../auto-repair.js';
const require=createRequire(import.meta.url),converter=require('../../converter/lib/index.js');
const {resolveHref,compileLinkRule,describeLinkRule}=require('../../converter/lib/linkRule.js');
const origin='https://www.myshu.cc';
const raw={bookSourceName:'独立目录回归',bookSourceUrl:origin,enabled:true,enabledCookieJar:false,
  searchUrl:'/search/results?kw={{key}}',
  ruleSearch:{bookList:'#results@tag.li',name:'a@text',bookUrl:'a@href'},
  ruleBookInfo:{name:'h1@text',tocUrl:'@css:a.toc@href'},
  ruleToc:{chapterList:'#chapters@tag.li',chapterName:'a@text',chapterUrl:'a@href'},
  ruleContent:{content:'#content@text'}};
const converted=()=>converter.convert(raw).output;
const ok=body=>new Response(body,{headers:{'content-type':'text/html; charset=utf-8'}});
const detailBody='<h1>测试书</h1><a class="toc" href="../toc/index.html">全部章节</a>';
const tocBody='<ul id="chapters"><li><a href="pages/ch1.html">第一章</a></li><li><a href="pages/ch2.html">第二章</a></li></ul>';
const chapterBody='<div id="content">这是用于目录地址传递测试的模拟正文段落。检查真实响应页上下文、独立目录页面和相对章节链接，内容不来自第三方作品。</div>';
function fixtures(url){
  const path=new URL(url).pathname;
  if(path==='/')return ok('<title>测试主页</title>');
  if(path==='/search/results')return ok('<a href="/wrong/">导航</a><ul id="results"><li><a href="../books/42/detail.html">测试书</a></li></ul>');
  if(path==='/books/42/detail.html')return new Response('',{status:301,headers:{location:'/catalog/book42/summary.html'}});
  if(path==='/catalog/book42/summary.html')return ok(detailBody);
  if(path==='/catalog/toc/index.html')return ok(tocBody);
  if(path==='/catalog/toc/pages/ch1.html')return ok(chapterBody);
  throw Error('Unexpected fixture URL '+url);
}
async function inspect(source=converted(),fetcher=fixtures){
  const calls=[],dns=[];
  const report=await inspectSourceWeb({source,keyword:'测试'},{fetcher:async(url,opts)=>{
    calls.push(url);assert.equal(opts.method,'GET');return fetcher(url,opts);
  },dnsChecker:async url=>{dns.push(url.href);}});
  return {report,calls,dns};
}
test('converted independent catalog follows detail redirects and each actual response URL',async()=>{
  const {report,calls,dns}=await inspect(),detail=report.steps[2],toc=report.steps[3],content=report.steps[4];
  assert.equal(report.fullyVerified,true);assert.equal(report.appVerified,false);
  assert.equal(detail.url,origin+'/catalog/book42/summary.html');
  assert.equal(detail.redirects[0].status,301);
  assert.equal(toc.url,origin+'/catalog/toc/index.html');assert.equal(toc.reusedResponse,false);
  assert.equal(toc.handoff.from,'bookDetail.chapterListUrl');
  assert.equal(toc.handoff.value,toc.url);
  assert.equal(content.url,origin+'/catalog/toc/pages/ch1.html');
  assert.equal(content.handoff.from,'chapterList.url');
  assert.equal(report.steps[1].fieldChecks.find(x=>x.field==='detailUrl').samples[0],origin+'/books/42/detail.html');
  assert.equal(detail.fieldChecks.find(x=>x.field==='chapterListUrl').normalization,'response-url');
  assert.deepEqual(calls.map(url=>new URL(url).pathname),['/','/search/results','/books/42/detail.html','/catalog/book42/summary.html','/catalog/toc/index.html','/catalog/toc/pages/ch1.html']);
  assert.deepEqual(dns,calls,'every request and redirect undergo DNS checking');
});
test('no separate catalog rule reuses the detail response and avoids an invented request',async()=>{
  const source=converted();delete source['独立目录回归'].bookDetail.chapterListUrl;
  const {report,calls}=await inspect(source,url=>{
    const path=new URL(url).pathname;
    if(path==='/catalog/book42/summary.html')return ok('<h1>测试书</h1>'+tocBody.replaceAll('pages/','../toc/pages/'));
    return fixtures(url);
  });
  assert.equal(report.fullyVerified,true);
  assert.equal(report.steps[3].reusedResponse,true);
  assert.equal(report.steps[3].handoff.from,'bookDetail.responseUrl');
  assert(!calls.some(url=>new URL(url).pathname==='/catalog/toc/index.html'));
});
test('missing catalog field results do not borrow decoy chapter links from the detail page',async()=>{
  const {report,calls}=await inspect(converted(),url=>new URL(url).pathname==='/catalog/book42/summary.html'?ok('<h1>测试书</h1>'+tocBody):fixtures(url));
  assert.equal(report.fullyVerified,false);assert.equal(report.steps[3].status,'no-results');
  assert.equal(report.steps[4].status,'skipped');
  assert(!calls.some(url=>new URL(url).pathname.includes('/toc/')));
});
test('ambiguous catalog URLs stop the chain instead of selecting or concatenating them',async()=>{
  const source=converted();source['独立目录回归'].bookDetail.chapterListUrl='//a[@class="toc"]/@href';
  const {report,calls}=await inspect(source,url=>new URL(url).pathname==='/catalog/book42/summary.html'?ok(detailBody+'<a class="toc" href="/another-toc/">另一个目录</a>'):fixtures(url));
  assert.equal(report.steps[2].fieldChecks.find(x=>x.field==='chapterListUrl').status,'multiple-values');
  assert.equal(report.steps[3].status,'no-results');assert.equal(report.fullyVerified,false);
  assert.equal(calls.length,4);
});
test('unknown URL postprocessing is never executed or treated as the selector value',async()=>{
  const source=converted();source['独立目录回归'].bookDetail.chapterListUrl+='\nglobalThis.handoffAttackExecuted=true;';
  delete globalThis.handoffAttackExecuted;
  const {report,calls}=await inspect(source);
  assert.equal(globalThis.handoffAttackExecuted,undefined);
  assert.equal(report.steps[3].status,'unsupported');
  assert.equal(report.steps[4].status,'skipped');assert.equal(calls.length,4);
});
test('private, metadata and unapproved cross-site catalog links are stopped before DNS or fetch',async()=>{
  for(const target of ['http://127.0.0.1/','http://169.254.169.254/latest/meta-data/','https://www.suduguu.com/toc/']){
    const {report,calls,dns}=await inspect(converted(),url=>new URL(url).pathname==='/catalog/book42/summary.html'?ok('<h1>测试书</h1><a class="toc" href="'+target+'">目录</a>'):fixtures(url));
    assert.equal(report.steps[3].status,'unsupported',target);
    assert.equal(report.steps[4].status,'skipped');assert.equal(report.fullyVerified,false);
    assert(!calls.includes(target));assert(!dns.includes(target));
  }
});
test('catalog HTTP failure stays separate from XPath failure and skips chapter requests',async()=>{
  for(const status of [403,404]){
    const {report,calls}=await inspect(converted(),url=>new URL(url).pathname==='/catalog/toc/index.html'?new Response('blocked',{status}):fixtures(url));
    assert.equal(report.steps[3].httpStatus,status);
    assert.equal(report.steps[3].status,status===403?'blocked':'http-error');
    assert.equal(report.steps[4].status,'skipped');
    assert(!calls.some(url=>new URL(url).pathname.endsWith('ch1.html')));
  }
});
test('all three actions use their configured static GET requests instead of fallback links',async()=>{
  const source=converted(),s=source['独立目录回归'];
  s.bookDetail.requestInfo='/static/detail.html';
  s.chapterList.requestInfo=origin+'/static/list.html?page=%@pageIndex';
  s.chapterContent.requestInfo=origin+'/static/body.html?kw=%@keyWord';
  const {report,calls}=await inspect(source,url=>{
    const path=new URL(url).pathname;
    if(path==='/static/detail.html')return ok(detailBody);
    if(path==='/static/list.html')return ok(tocBody);
    if(path==='/static/body.html')return ok(chapterBody);
    return fixtures(url);
  });
  assert.equal(report.httpChainVerified,true);
  assert.equal(report.fullyVerified,false,'page-index template is only tested on page one');
  assert(report.steps[3].requestCapabilities.unchecked.some(x=>x.field==='requestInfo.pageIndex'));
  for(const step of report.steps.slice(2))assert.equal(step.handoff.value,step.originalUrl);
  for(const step of report.steps.slice(2))assert.equal(step.handoff.from,{detail:'bookDetail',chapterList:'chapterList',chapterContent:'chapterContent'}[step.step]+'.requestInfo');
  assert(calls.includes(origin+'/static/list.html?page=1'));
  assert(calls.some(url=>new URL(url).pathname==='/static/body.html'&&new URL(url).searchParams.get('kw')==='测试'));
  assert(!calls.some(url=>url.includes('/books/42/')));
});
test('unknown action scripts stop at their own action and cannot fetch the fallback address',async()=>{
  for(const [module,step,index] of [['bookDetail','detail',2],['chapterList','chapterList',3],['chapterContent','chapterContent',4]]){
    const source=converted();source['独立目录回归'][module].requestInfo='@js:globalThis.handoffAttackExecuted=true;return result;';
    delete globalThis.handoffAttackExecuted;
    const {report}=await inspect(source);
    assert.equal(report.steps[index].step,step);assert.equal(report.steps[index].status,'unsupported');
    assert.equal(report.fullyVerified,false);assert.equal(globalThis.handoffAttackExecuted,undefined);
  }
});
test('relative static requestInfo uses the action host while chapter href uses the catalog response',async()=>{
  const source=converted(),s=source['独立目录回归'];
  s.chapterList.host=origin+'/module-base/';s.chapterList.requestInfo='directory.html';
  const {report,calls}=await inspect(source,url=>{
    const path=new URL(url).pathname;
    if(path==='/module-base/directory.html')return ok(tocBody);
    if(path==='/module-base/pages/ch1.html')return ok(chapterBody);
    return fixtures(url);
  });
  assert.equal(report.fullyVerified,true);
  assert(calls.includes(origin+'/module-base/directory.html'));
  assert.equal(report.steps[4].url,origin+'/module-base/pages/ch1.html');
});
test('portable resolver preserves URL path semantics and needs no global URL constructor in generated code',()=>{
  const rule=compileLinkRule('//@href'),script=rule.split('||@js:\n')[1];
  const run=new Function('config','params','result','var URL=undefined;\n'+script);
  for(const [value,base] of [
    ['child.html',origin],['../chapter/',origin+'/book/1/'],['./',origin+'/book/1/'],
    ['../../../../chapter/',origin+'/book/1/'],['a//b/../c',origin+'/book/'],
    ['%2e%2e/chapter',origin+'/book/1/'],['?',origin+'/book/1/?old=x'],
    ['?page=2',origin+'/book/1/?old=x'],['#toc',origin+'/book/1/?old=x#old'],
    ['//cdn.example/path','http://books.example/a'],['/book/.',origin],['/book/..',origin]
  ]){
    const expected=new URL(value,base).href;
    assert.equal(resolveHref(value,base),expected,value);
    assert.equal(run({host:origin},{responseUrl:base},value),expected,value);
  }
  assert.equal(resolveHref('javascript:alert(1)',origin),'');
  assert.equal(resolveHref('data:text/plain,hi',origin),'');
  assert(describeLinkRule(compileLinkRule('//a[contains(@title,"||")]/@href')));
  assert.equal(describeLinkRule(rule+'\nreturn "tampered";'),null);
});
test('two actual corpus tocUrl patterns are converted without hardcoded site rules',()=>{
  const samples=JSON.parse(fs.readFileSync('test-data/1298-original.json','utf8'));
  for(const source of samples.filter(x=>['错层小说','全本小说网'].includes(x.bookSourceName))){
    const r=converter.convert(source),s=Object.values(r.output)[0],description=describeLinkRule(s.bookDetail.chapterListUrl);
    assert(description,source.bookSourceName);assert.equal(s.chapterList.requestInfo,'%@result');
    const doc=new JSDOM('<a href="/toc/actual.html">查看全部章节 &gt;&gt;</a><a href="/toc/actual.html">章节列表</a>').window.document;
    const node=doc.evaluate(description.selector,doc,null,9,null).singleNodeValue;
    assert.equal(node?.nodeValue,'/toc/actual.html',source.bookSourceName);
    assert(!r.warnings.some(x=>x.level==='unsupported'&&x.msg.includes('独立目录 tocUrl')));
  }
});

test('legacy site adapter remains available only when there is no explicit catalog link',()=>{
  const adapters=require('../../converter/lib/siteAdapters');
  const source={sourceUrl:'https://m.cuoceng.com',bookDetail:{},chapterList:{requestInfo:'%@result',list:"//div[@id='allchapter']//dd/a",title:'original'}};
  const warnings=[];adapters.apply(source,warnings);
  assert(source.chapterList.requestInfo.startsWith('@js:'));assert.equal(warnings.length,1);
  const native={sourceUrl:source.sourceUrl,bookDetail:{chapterListUrl:compileLinkRule('//a[@id="toc"]/@href')},chapterList:{requestInfo:'%@result',list:"//div[@id='allchapter']//dd/a",title:'original'}};
  adapters.apply(native,[]);assert.equal(native.chapterList.requestInfo,'%@result');assert.equal(native.chapterList.title,'original');
});

test('HTML actions receiving JSON keep HTTP success separate from unsupported parsing',async()=>{
  for(const [path,index] of [['/catalog/book42/summary.html',2],['/catalog/toc/index.html',3],['/catalog/toc/pages/ch1.html',4]]){
    const {report}=await inspect(converted(),url=>new URL(url).pathname===path?new Response(JSON.stringify({data:'sample'}),{headers:{'content-type':'application/json'}}):fixtures(url));
    assert.equal(report.steps[index].httpStatus,200);assert.equal(report.steps[index].status,'unsupported');assert.equal(report.steps[index].kind,'json');assert.equal(report.fullyVerified,false);
    for(const step of report.steps.slice(index+1))assert.equal(step.status,'skipped');
  }
});

test('independent catalog repair is rechecked using the candidate and its own catalog response',async()=>{
  const source=converted(),original=structuredClone(source);source['独立目录回归'].chapterList.list='//section[@id="old"]';
  const before=structuredClone(source),requests=[],catalogRequests=[];
  const webInspector=async input=>{requests.push(input);return inspectSourceWeb(input,{dnsChecker:async()=>{},fetcher:async url=>{
    if(new URL(url).pathname==='/catalog/toc/index.html'){catalogRequests.push(url);return ok('<div class="book_list book_list2"><ul><li><a href="/catalog/toc/pages/ch1.html">第一章</a></li></ul></div>');}
    return fixtures(url);
  }});};
  const result=await runAutoRepair({source,sourceName:'独立目录回归',keyword:'测试'},{webInspector});
  assert.equal(result.liveWebEvidence.fullyVerified,false);assert.equal(result.verified,true);
  assert.equal(result.verification.steps[3].url,origin+'/catalog/toc/index.html');
  assert.equal(catalogRequests.length,2);assert.equal(requests.length,2);assert.equal(requests[1].legado,undefined);
  assert.equal(requests[1].source['独立目录回归'].chapterList.list,result.candidate.chapterList.list);
  assert.equal(result.candidate.bookDetail.chapterListUrl,original['独立目录回归'].bookDetail.chapterListUrl);
  assert.deepEqual(source,before,'original source remains untouched');
  assert(result.accepted.some(x=>x.path==='chapterList.list'&&x.reason.includes('实际目录 HTML')));
});
