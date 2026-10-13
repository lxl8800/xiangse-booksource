import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectSourceWeb} from '../site-evidence.js';
import {createRequire} from 'node:module';
const {compileLinkRule}=createRequire(import.meta.url)('../../converter/lib/linkRule.js');
const origin='https://www.myshu.cc';
const first='这是第一页的测试正文，只是用于校验分页合并、地址传递和严格预算的虚构文本，不来自真实作品。';
const second='这是第二页的测试正文，内容应当按页面顺序接在第一页之后，同时保留本身的重复语句。';
function source(){
 return {sourceName:'分页回归',sourceUrl:origin,sourceType:'text',enable:1,weight:'100',
  searchBook:{actionID:'searchBook',parserID:'DOM',responseFormatType:'html',requestInfo:origin+'/search',list:'//*[@id="books"]/a',bookName:'//text()',detailUrl:'//@href'},
  bookDetail:{actionID:'bookDetail',parserID:'DOM',responseFormatType:'html',requestInfo:'%@result',title:'//h1/text()'},
  chapterList:{actionID:'chapterList',parserID:'DOM',responseFormatType:'html',requestInfo:'%@result',list:'//*[@id="toc"]/a',title:'//text()',url:compileLinkRule('//@href'),nextPageUrl:compileLinkRule('//a[@rel="next-toc"]/@href'),moreKeys:{maxPage:20}},
  chapterContent:{actionID:'chapterContent',parserID:'DOM',responseFormatType:'html',requestInfo:'%@result',title:'//h1/text()',content:'//*[@id="content"]',nextPageUrl:compileLinkRule('//a[@rel="next-content"]/@href'),moreKeys:{maxPage:6}}};
}
const a=(href,title)=>'<a href="'+href+'">'+title+'</a>';
const toc=(items,next)=>'<h1>测试书</h1><div id="toc">'+items.map(x=>a(...x)).join('')+'</div>'+(next?'<a rel="next-toc" href="'+next+'">下一页</a>':'');
const content=(text,next,title='第一章')=>'<h1>'+title+'</h1><div id="content">'+text+'</div>'+(next?'<a rel="next-content" href="'+next+'">下一页</a>':'');
const pages={'/':'<title>首页</title>','/search':'<div id="books">'+a('/book/','测试书')+'</div>',
 '/book/':toc([['/chapter/1','第一章']],'/toc/2'),
 '/toc/2':toc([['/chapter/1','第一章'],['/chapter/2','第二章']]),
 '/chapter/1':content(first,'/parts/2'),'/parts/2':content(second)};
const ok=body=>new Response(body,{headers:{'content-type':'text/html; charset=utf-8'}});
async function inspect(config=source(),respond=(url)=>ok(pages[new URL(url).pathname]),options={}){
 const calls=[],dns=[];const r=await inspectSourceWeb({source:{分页回归:config},keyword:'测试'},{
  timeoutMs:options.timeoutMs||7800,fetcher:async(url,init)=>{calls.push({url,init});return respond(url,init);},
  dnsChecker:async u=>{dns.push(u.href);if(options.dns)await options.dns(u);}});
 return {report:r,calls,dns};
}
test('directory pagination merges unique resolved URLs and content pagination concatenates exact pages',async()=>{
 const {report,calls}=await inspect();assert(report.httpChainVerified);assert(report.fullyVerified);assert.equal(report.appVerified,false);
 const list=report.steps[3],body=report.steps[4];
 assert.equal(list.count,2);assert.equal(list.pagination.duplicates,1);assert.equal(list.pagination.complete,true);assert.equal(list.pagination.pagesRequested,2);
 assert.deepEqual(list.examples.map(x=>x.url),[origin+'/chapter/1',origin+'/chapter/2']);
 assert.equal(body.contentLength,(first+'\n'+second).length);assert.equal(body.pagination.complete,true);assert.equal(body.pagination.pagesRequested,2);
 assert.equal(body.pagination.pages[1].contentLength,second.length);
 assert(calls.every(c=>c.init.method==='GET'));assert(!JSON.stringify(report).includes(first+'\n'+second),'full content remains private');
});
test('valid empty next-page selectors prove a terminal page without speculative requests',async()=>{
 const {report,calls}=await inspect(source(),url=>new URL(url).pathname==='/book/'?ok(toc([['/chapter/1','第一章']])):new URL(url).pathname==='/chapter/1'?ok(content(first)):ok(pages[new URL(url).pathname]));
 assert(report.fullyVerified);assert.equal(report.steps[3].pagination.pagesRequested,1);assert.equal(report.steps[4].pagination.pagesRequested,1);
 assert(!calls.some(c=>new URL(c.url).pathname==='/toc/2'));
});
test('ambiguous next links stop without choosing any one of them',async()=>{
 const {report,calls}=await inspect(source(),url=>new URL(url).pathname==='/book/'?ok(pages['/book/']+'<a rel="next-toc" href="/toc/3">下一页</a>'):ok(pages[new URL(url).pathname]));
 assert.equal(report.steps[3].pagination.status,'unsupported');assert.equal(report.fullyVerified,false);
 assert(!calls.some(c=>new URL(c.url).pathname.startsWith('/toc/')));
});
test('next-page scripts are never executed or mistaken for a terminal selector',async()=>{
 const s=source();s.chapterList.nextPageUrl='@js:globalThis.paginationAttack=true;return "";';delete globalThis.paginationAttack;
 const {report,calls}=await inspect(s);assert.equal(globalThis.paginationAttack,undefined);
 assert.equal(report.steps[3].pagination.complete,false);assert.equal(report.fullyVerified,false);assert(!calls.some(c=>new URL(c.url).pathname==='/toc/2'));
});
test('direct and redirected pagination loops never fetch a visited page twice',async()=>{
 for(const redirect of [false,true]){
  const {report,calls}=await inspect(source(),url=>{
   const path=new URL(url).pathname;
   if(path==='/book/'&&!redirect)return ok(toc([['/chapter/1','第一章']],'/book/'));
   if(path==='/toc/2'&&redirect)return new Response('',{status:302,headers:{location:'/book/'}});
   return ok(pages[path]);
  });
  assert.equal(report.steps[3].pagination.status,'loop');assert.equal(report.fullyVerified,false);
  assert(calls.filter(c=>new URL(c.url).pathname==='/book/').length<=2,'redirect transport may reach the visited final address once');
 }
});
test('configured maxPage and hard safety max stop an unfinished chain with an explicit incomplete result',async()=>{
 for(const [maximum,expected] of [[1,1],[20,3]]){
  const s=source();s.chapterList.moreKeys.maxPage=maximum;
  const {report,calls}=await inspect(s,url=>{
   const path=new URL(url).pathname;
   if(path.startsWith('/toc/')){const n=Number(path.split('/').at(-1));return ok(toc([['/chapter/'+n,'第'+n+'章']],'/toc/'+(n+1)));}
   return ok(pages[path]);
  });
  const list=report.steps[3].pagination;assert.equal(list.pagesRequested,expected);assert.equal(list.complete,false);assert.equal(list.status,'limit');
  assert.equal(report.fullyVerified,false);assert(!calls.some(c=>new URL(c.url).pathname==='/toc/4'));
 }
});
test('failed later pages preserve HTTP failures and do not inherit the first-page pass',async()=>{
 for(const status of [403,404,429]){
  const {report}=await inspect(source(),url=>new URL(url).pathname==='/toc/2'?new Response('blocked',{status}):ok(pages[new URL(url).pathname]));
  assert(report.httpChainVerified);assert.equal(report.fullyVerified,false);
  assert.equal(report.steps[3].pagination.complete,false);assert.equal(report.steps[3].pagination.pages.at(-1).httpStatus,status);
 }
});
test('private, cross-site and authenticated pagination addresses stop before DNS/fetch',async()=>{
 for(const url of ['http://169.254.169.254/latest/meta-data','http://127.0.0.1/','https://www.suduguu.com/catalog','/toc/2?token=PRIVATE_PAGINATION_TOKEN']){
  const {report,calls,dns}=await inspect(source(),address=>new URL(address).pathname==='/book/'?ok(toc([['/chapter/1','第一章']],url)):ok(pages[new URL(address).pathname]));
  assert.equal(report.steps[3].pagination.status,'unsafe');assert.equal(report.fullyVerified,false);
  assert(!calls.some(c=>c.url.includes('PRIVATE_PAGINATION_TOKEN')||c.url.includes('169.254')||c.url.includes('127.0.0.1')||c.url.includes('suduguu')));
  assert(!dns.some(c=>c.includes('PRIVATE_PAGINATION_TOKEN')));assert(!JSON.stringify(report).includes('PRIVATE_PAGINATION_TOKEN'));
 }
});
test('relative links are based on each final response URL and keep the action headers',async()=>{
 const s=source();s.httpHeaders={'User-Agent':'Pagination UA'};
 const {report,calls}=await inspect(s,url=>{
  const path=new URL(url).pathname;
  if(path==='/toc/2')return new Response('',{status:301,headers:{location:'/deep/toc/page2'}});
  if(path==='/deep/toc/page2')return ok(toc([['../chapter/9','第九章']]));
  if(path==='/parts/2')return new Response('',{status:301,headers:{location:'/deep/content/page2'}});
  if(path==='/deep/content/page2')return ok(content(second,'page3'));
  if(path==='/deep/content/page3')return ok(content('最后一段测试内容，仍属于同一章。'));
  return ok(pages[path]);
 });
 assert(report.fullyVerified);assert(report.steps[3].examples.some(x=>x.url===origin+'/deep/chapter/9'));
 assert(calls.some(c=>c.url===origin+'/deep/content/page3'));assert(calls.every(c=>c.init.headers['User-Agent']==='Pagination UA'));
});
test('identical later body and changed chapter titles are not silently concatenated',async()=>{
 for(const replacement of [content(first),content(second,undefined,'第二章')]){
  const {report}=await inspect(source(),url=>new URL(url).pathname==='/parts/2'?ok(replacement):ok(pages[new URL(url).pathname]));
  assert.equal(report.steps[4].contentLength,first.length);assert.equal(report.fullyVerified,false);
  assert(['loop','chapter-changed'].includes(report.steps[4].pagination.status));
 }
});
test('later-page mismatches and extraction limits preserve incomplete evidence rather than guessing selectors',async()=>{
 for(const replacement of ['<div id="wrong">页面结构发生变化</div>',toc(Array.from({length:1201},(_,i)=>['/chapter/'+i,'第'+i+'章']))]){
  const {report}=await inspect(source(),url=>new URL(url).pathname==='/toc/2'?ok(replacement):ok(pages[new URL(url).pathname]));
  assert.equal(report.fullyVerified,false);assert.equal(report.steps[3].pagination.complete,false);
  assert(['rule-error','budget'].includes(report.steps[3].pagination.status));
 }
});
test('invalid maxPage remains unsupported instead of falling back to guessed paging limits',async()=>{
 const s=source();s.chapterList.moreKeys.maxPage='invalid';const {report,calls}=await inspect(s);
 assert.equal(report.steps[3].pagination.status,'unsupported');assert.equal(report.fullyVerified,false);
 assert(!calls.some(c=>new URL(c.url).pathname==='/toc/2'));
});
test('per-page DNS failure is bounded and remains incomplete',async()=>{
 const {report}=await inspect(source(),undefined,{timeoutMs:100,dns:async u=>{if(u.pathname==='/toc/2')return new Promise(()=>{});}});
 assert.equal(report.fullyVerified,false);assert.equal(report.steps[3].pagination.complete,false);
 assert(['timeout','budget'].includes(report.steps[3].pagination.status));
});

test('unexecuted title postprocessing does not block URL pagination evidence or claim full field verification',async()=>{
 const s=source();s.chapterList.title+='||@js:return result.trim();';
 const {report,calls}=await inspect(s);
 assert(calls.some(c=>new URL(c.url).pathname==='/toc/2'));
 assert.equal(report.steps[3].pagination.complete,true);assert.equal(report.steps[3].pagination.fullyChecked,false);
 assert.equal(report.fullyVerified,false);assert(report.diagnostics.some(x=>x.includes('chapterList.title')));
});
test('document headings also prevent merging a new chapter when no explicit title rule exists',async()=>{
 const s=source();delete s.chapterContent.title;
 const {report}=await inspect(s,url=>new URL(url).pathname==='/parts/2'?ok(content(second,undefined,'第二章')):ok(pages[new URL(url).pathname]));
 assert.equal(report.steps[4].pagination.status,'chapter-changed');assert.equal(report.steps[4].contentLength,first.length);
});
