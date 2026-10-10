import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {JSDOM} from 'jsdom';
import {inspectDomainMove} from '../domain-migration.js';
import {inspectSourceWeb} from '../site-evidence.js';
const require=createRequire(import.meta.url);
const engine=require('../../converter/lib/index.js');
const rules=require('../../converter/lib/rules.js');
const url=require('../../converter/lib/urlRule.js');
const defaultRule=require('../../converter/lib/defaultRule.js');
const raw={bookSourceName:'通用测试',bookSourceUrl:'https://www.tianxiabachang.cn',searchUrl:'/s?q={{key}}',ruleSearch:{bookList:'.card',name:'a@text',bookUrl:'a@href'},ruleToc:{chapterList:'tag.a',chapterName:'text',chapterUrl:'href'},ruleContent:{content:'#content@text'}};
const ctx={src:raw,host:raw.bookSourceUrl};

test('JS expression inference evaluates the last expression once',()=>{
 const r=rules.ensureReturn('var n=0;\n++n');
 assert.equal(new Function(r)(),1);
});
test('template translation preserves quoted words and object properties',()=>{
 assert.equal(url.exprToJs('"key" + page + obj.key',ctx).expr,'"key" + params.pageIndex + obj.key');
});
test('bookWorld uses App filter with no editor filters and compiles complex paging without eval',()=>{
 const source={...raw,enabledExplore:true,exploreUrl:'玄幻::/xh/{{page===1?"":page+".html"}}\n都市::/ds/{{page===1?"":page+".html"}}',ruleExplore:raw.ruleSearch};
 const r=engine.convert(source);const world=r.output['通用测试'].bookWorld;
 for(const m of Object.values(world)){
   assert(!m.requestInfo.includes('new Function'));assert(!m.requestInfo.includes('eval('));
   const rows=m.moreKeys.requestFilters.split('\n').slice(1),chosen=rows.at(-1).split('::')[1];
   const fn=new Function('config','params','result',m.requestInfo.slice(4));
   const first=fn({host:raw.bookSourceUrl},{filter:chosen,pageIndex:1},'');
   const second=fn({host:raw.bookSourceUrl},{filter:chosen,pageIndex:2},'');
   assert.equal(first,raw.bookSourceUrl+'/ds/');assert.equal(second,raw.bookSourceUrl+'/ds/2.html');
 }
});
test('compatibility distinguishes partial/unsupported output from live success',()=>{
 const r=engine.convertAll([{...raw,ruleContent:{content:'@put:secret'}},raw]);
 assert.equal(r.okCount,2);assert.equal(r.sourceResults[0].compatibility.status,'unsupported');
 assert.equal(r.sourceResults[0].compatibility.networkVerified,false);
});
test('domain migration refuses dynamic scripts containing tokens and old URL literals',()=>{
 const s={sourceUrl:'https://old.example',chapterList:{requestInfo:'@js:var cookie="https://old.example";return cookie;'}};
 const before=JSON.stringify(s);
 const r=engine.applyVerifiedDomainMove(s,{status:'verified',autoApply:true,oldOrigin:s.sourceUrl,newOrigin:'https://www.old.example'});
 assert.equal(r.applied,false);assert.equal(r.needsReview,true);assert.equal(JSON.stringify(s),before);
});


test('jsLib transitive helpers and request-template helpers are included without executing input',()=>{
 const source={...raw,jsLib:'function leaf(x){return String(x).trim();}\nfunction parent(x){return leaf(x);}',searchUrl:'/s?q={{parent(key)}}',ruleSearch:{...raw.ruleSearch,name:'a@text@js:parent(result)'}};
 const s=engine.convert(source).output['通用测试'];
 for(const rule of [s.searchBook.bookName,s.searchBook.requestInfo]){assert(rule.includes('function leaf('));assert(rule.includes('function parent('));}
 const code=s.searchBook.bookName.split('||@js:')[1];assert.equal(new Function('result',code)(' book '),'book');
});
test('relative href resolver handles origin-only base, traversal, query suffix and trailing slash',()=>{
 const s=engine.convert(raw).output['通用测试'],code=s.chapterList.url.split('||@js:')[1];
 const resolve=new Function('params','config','result',code);
 assert.equal(resolve({responseUrl:raw.bookSourceUrl},{},'1.html'),raw.bookSourceUrl+'/1.html');
 assert.equal(resolve({responseUrl:raw.bookSourceUrl+'/book/12/'},{},'../13/?x=a/b'),raw.bookSourceUrl+'/book/13/?x=a/b');
});

const request=rule=>new Function('config','params','result',rule.replace(/^@js:/,''))({host:raw.bookSourceUrl},{keyWord:'书',pageIndex:2},'');
test('card descendant href is preserved rather than replaced by card attribute',()=>{
 const s=engine.convert(raw).output['通用测试'];const selector=require('../../converter/lib/linkRule.js').describeLinkRule(s.searchBook.detailUrl).selector;assert.equal(selector,'(descendant::a)[1]/@href');
 const d=new JSDOM('<a href="/wrong">menu</a><div class="card"><a href="/right">book</a></div>').window.document;
 assert.equal(d.evaluate(selector.replace(/\/\//g,'.//'),d.querySelector('.card'),null,2,null).stringValue,'/right');
});
test('JSON text import handles mixed wrappers, multiple sources, consecutive JSON and rejects garbage',()=>{
 const x={alias:{sourceName:'X',sourceUrl:'https://x.example',searchBook:{requestInfo:'/s',list:'//a'}}};
 const r=engine.convertAll(JSON.stringify({l:raw,x})+'\n'+JSON.stringify([raw]));
 assert.equal(r.okCount,3);assert.equal(r.failures.length,0);assert.equal(r.output.alias.sourceType,'text');
 assert.equal(engine.convertAll('{} garbage {}').failures.length,1);
 assert.equal(engine.convertAll('[').failures.length,1);
});
test('prototype-like aliases remain own data properties without changing prototype',()=>{
 const r=engine.convertAll([{...raw,bookSourceName:'__proto__'},{...raw,bookSourceName:'constructor'}]);
 assert.equal(r.okCount,2);assert(Object.hasOwn(r.output,'__proto__'));assert.equal(Object.getPrototypeOf(r.output),Object.prototype);
});
test('empty POST stays POST, whitespace options and GBK parameters propagate',()=>{
 const r=url.buildRequestInfo('/s, {"method":"POST","charset":"gbk"}',ctx,'search');
 assert.equal(request(r.requestInfo).POST,true);assert.equal(r.actionExtra.requestParamsEncode,'2147485234');
 const s=engine.convert({...raw,searchUrl:'/s, {"method":"POST","charset":"gbk","body":"q={{key}}"}'}).output['通用测试'];
 assert.equal(s.searchBook.responseEncode,'2147485234');assert.equal(s.searchBook.requestParamsEncode,'2147485234');
});
test('invalid options, raw JSON POST, unknown encoding and WebView are diagnosed',()=>{
 for(const v of ['/s,{invalid}', '/s,{"method":"POST","body":"{\\"q\\":1}"}'])assert(url.buildRequestInfo(v,ctx,'search').warnings.some(w=>w.level==='unsupported'));
 assert(url.buildRequestInfo('/s,{"charset":"big5"}',ctx,'search').warnings.some(w=>w.level==='degraded'));
 assert(url.buildRequestInfo('/s,{"webView":true}',ctx,'search').warnings.some(w=>w.msg.includes('WebView')));
});
test('XPath prefixes and relative expressions survive; JS logical OR stays JS',()=>{
 assert.equal(rules.convertRule('@xpath:.//a/@href',ctx).value,'.//a/@href');
 assert.equal(rules.convertRule('./a/@href',ctx).value,'./a/@href');
 const r=rules.convertRule('@js:result || "fallback"',ctx);assert.equal(request(r.value),'fallback');
});
test('multiple Default indices actually select only requested positions',()=>{
 const d=new JSDOM('<a>0</a><a>1</a><a>2</a><a>3</a>').window.document;
 const rule=defaultRule.convertDefault('tag.a[0,2]',ctx).xpath;
 const result=d.evaluate(rule,d,null,7,null);assert.equal(result.snapshotLength,2);assert.equal(result.snapshotItem(1).textContent,'2');
});
test('list exclusions do not also apply skipCount',()=>{
 const s=engine.convert({...raw,ruleToc:{chapterList:'tag.a[!0,1]',chapterName:'text',chapterUrl:'href'}}).output['通用测试'];
 assert.equal(s.chapterList.moreKeys?.skipCount,undefined);
});
const html=()=>new Response('<html><title>Books</title><body>Public books site with real looking markup and enough text for homepage probe.</body></html>',{headers:{'content-type':'text/html'}});
test('all redirect hops must be permanent; unrelated domains never auto-apply from HTML only',async()=>{
 const result=await inspectDomainMove({sourceUrl:'https://old.example/',searchUrl:'/s?q={{key}}'}, {dnsChecker:async()=>{},fetcher:async input=>{
  const u=new URL(input);return u.hostname==='old.example'?new Response('',{status:308,headers:{location:'https://new.example'+u.pathname+u.search}}):html();
 }});
 assert.equal(result.autoApply,false);assert.equal(result.status,'needs-confirmation');
 assert(result.home.redirects[0].url);assert(result.home.redirects[0].location);assert.equal(result.home.finalDomain,'new.example');assert.equal(typeof result.home.elapsedMs,'number');
 const chain=await inspectDomainMove({sourceUrl:'https://books.example/'},{dnsChecker:async()=>{},fetcher:async input=>{
  const u=new URL(input);if(u.hostname==='books.example')return new Response('',{status:301,headers:{location:'https://www.books.example/'}});
  if(u.hostname==='www.books.example')return new Response('',{status:302,headers:{location:'https://books.example/home'}});return html();
 }});assert.equal(chain.autoApply,false);
});
test('broken XSGG cannot borrow valid Legado selectors to prove success',async()=>{
 const s=engine.convert(raw).output;s['通用测试'].searchBook.list='//nonexistent';
 const r=await inspectSourceWeb({source:s,sourceName:'通用测试',legado:raw},{dnsChecker:async()=>{},fetcher:async()=>html()});
 assert.equal(r.fullyVerified,false);assert.equal(r.steps.find(x=>x.step==='search').configuredMatches,0);
});
