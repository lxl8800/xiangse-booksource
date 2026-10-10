import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {JSDOM} from 'jsdom';
import {inspectSourceWeb} from '../site-evidence.js';
import {inspectDomainMove} from '../domain-migration.js';
const require=createRequire(import.meta.url);
const css=require('../../converter/lib/cssRule.js');
const defaultRule=require('../../converter/lib/defaultRule.js');
const rules=require('../../converter/lib/rules.js');
const urlRule=require('../../converter/lib/urlRule.js');
const converter=require('../../converter/lib/index.js');

function selected(markup, rule) {
 const doc=new JSDOM(markup).window.document;
 const converted=css.convertCss('@css:'+rule,{src:{}});
 assert(!converted.error,converted.error);
 const result=doc.evaluate(converted.xpath,doc,null,7,null);
 return Array.from({length:result.snapshotLength},(_,i)=>result.snapshotItem(i).textContent);
}
test('CSS combinators inside quoted attributes and pseudo text remain data',()=>{
 const doc='<div data-label="A B > C + D"><a>right</a></div><div><a>wrong</a></div>';
 assert.deepEqual(selected(doc,'div[data-label="A B > C + D"] > a'),['right']);
 assert.deepEqual(selected('<p>hello (world), next</p><p>hello world</p>','p:contains("hello (world), next")'),['hello (world), next']);
});
test('CSS quoted closing bracket and mixed quotes produce valid XPath',()=>{
 const doc=new JSDOM('<a>target</a><a>other</a>').window.document;
 const target=doc.querySelector('a');target.setAttribute('data-label','A] B');target.textContent='Bob\'s "book"';
 for(const selector of ['a[data-label="A] B"]','a:contains("Bob\'s \\"book\\"")']) {
  const r=css.convertCss('@css:'+selector,{src:{}});
  assert(!r.error,r.error);const out=doc.evaluate(r.xpath,doc,null,7,null);
  assert.equal(out.snapshotLength,1);assert.equal(out.snapshotItem(0),target);
 }
});
test('CSS adjacent sibling only matches the immediate element for every parent',()=>{
 const html='<div><h3></h3><span>block</span><a>wrong</a></div><div><h3></h3><a>one</a></div><div><h3></h3><a>two</a></div>';
 assert.deepEqual(selected(html,'h3 + a'),['one','two']);
 assert.deepEqual(selected(html,'h3 ~ a'),['wrong','one','two']);
});
test('CSS negative positions and strict integer arguments preserve index semantics',()=>{
 const html='<a>0</a><a>1</a><a>2</a><a>3</a>';
 assert.deepEqual(selected(html,'a:eq(-1)'),['3']);
 assert.deepEqual(selected(html,'a:lt(-1)'),['0','1','2']);
 assert.deepEqual(selected(html,'a:gt(-2)'),['3']);
 for(const selector of ['a:eq(1abc)','a:unknown','a[data-x="unclosed]']) {
  const r=rules.convertRule('@css:'+selector,{src:{}});
  assert(r.warnings.some(x=>x.level==='unsupported'),selector);
  assert.equal(r.value,'@css:'+selector);
 }
});
test('Default ID exact match excludes similarly named catalog containers',()=>{
 const d=new JSDOM('<div id="list-old"><a>wrong</a></div><div id="list"><a>right</a></div>').window.document;
 const xp=defaultRule.convertDefault('#list@tag.a',{src:{}}).xpath;
 const nodes=d.evaluate(xp,d,null,7,null);
 assert.equal(nodes.snapshotLength,1);assert.equal(nodes.snapshotItem(0).textContent,'right');
});
test('generated cookie-free GET requests can be described without executing input',()=>{
 const src={bookSourceUrl:'https://www.myshu.cc',enabledCookieJar:false};
 const generated=urlRule.buildRequestInfo('/search.php?q={{key}}&p={{page}}',{src,host:src.bookSourceUrl},'search');
 assert.deepEqual(urlRule.describeStaticGetRequest(generated.requestInfo),{
  url:src.bookSourceUrl+'/search.php?q=%@keyWord&p=%@pageIndex',method:'GET',forbidCookie:true,generated:true
 });
});
test('static GET recognizer rejects arbitrary expressions, statements, POST and malformed wrappers',()=>{
 const wrap=u=>'@js:\nlet url = `'+u+'`;\nreturn {url: url, forbidCookie: true};';
 for(const raw of [wrap('https://www.myshu.cc?q=$'+'{globalThis.secret=1}'),wrap('https://www.myshu.cc')+'throw Error("run");',wrap('https://www.myshu.cc').replace('forbidCookie: true','POST: true'),'@js:return fetch("https://www.myshu.cc");']) {
  assert.equal(urlRule.describeStaticGetRequest(raw),null,raw);
 }
});
test('site inspector opens encoded GET from converted source with no Legado fallback',async()=>{
 const input={bookSourceName:'test',bookSourceUrl:'https://www.myshu.cc',enabledCookieJar:false,
  searchUrl:'/search.php?q={{key}}',ruleSearch:{bookList:'.card',name:'a@text',bookUrl:'a@href'},
  ruleToc:{chapterList:'#list@tag.a',chapterName:'text',chapterUrl:'href'},ruleContent:{content:'#content@text'}};
 const output=converter.convertAll(input).output;
 const requests=[];
 const r=await inspectSourceWeb({source:output,keyword:'书 & ?'},{
  dnsChecker:async()=>{},fetcher:async(address,options)=>{
   requests.push([address,options]);
   const u=new URL(address),body=u.pathname==='/search.php'?'<div class="card"><a href="/b/">Book</a></div>':
    u.pathname==='/b/'?'<div id="list"><a href="/b/1">Chapter</a></div>':
    u.pathname==='/b/1'?'<div id="content">Long synthetic text for the chapter body, more than thirty characters.</div>':'<html>Home</html>';
   return new Response(body,{headers:{'content-type':'text/html; charset=utf-8'}});
  }});
 const search=r.steps.find(x=>x.step==='search');
 assert.equal(search.staticRequest,'converter-get-template');
 assert(requests.some(([u])=>new URL(u).searchParams.get('q')==='书 & ?'));
 assert.equal(r.httpChainVerified,true);
 assert.equal(r.fullyVerified,true,'known converter URL normalization is verified without executing uploaded JS');
 assert.equal(r.steps.find(x=>x.step==='chapterList').fieldChecks.find(f=>f.field==='url').normalization,'response-url');
 for(const [,options] of requests){assert.equal(options.method,'GET');assert.equal(options.headers.Cookie,undefined);}
});
test('domain migration checks search from generated GET without executing it',async()=>{
 const template=urlRule.buildRequestInfo('/s?q={{key}}',{src:{bookSourceUrl:'https://books.example',enabledCookieJar:false},host:'https://books.example'},'search').requestInfo;
 const requests=[];
 const result=await inspectDomainMove({sourceUrl:'https://books.example',searchUrl:template},{dnsChecker:async()=>{},fetcher:async address=>{
  requests.push(address);const u=new URL(address);
  if(u.hostname==='books.example')return new Response('',{status:301,headers:{location:'https://www.books.example'+u.pathname+u.search}});
  return new Response('<html><title>Books</title>Public book pages and enough structure for the read only domain checker.</html>',{headers:{'content-type':'text/html'}});
 }});
 assert(requests.some(u=>new URL(u).pathname==='/s'));
 assert.equal(result.search?.status,'ok');
});

test('verified origin rewrite preserves cookie intent and every non-origin literal',()=>{
 const rewrite=require('../../converter/lib/domainRewrite.js').applyVerifiedDomainMove;
 const info=urlRule.buildRequestInfo('/s?q={{key}}&page={{page}}&ref=https://books.example',
  {src:{bookSourceUrl:'https://books.example',enabledCookieJar:false},host:'https://books.example'},'search').requestInfo;
 const source={sourceUrl:'https://books.example',searchBook:{host:'https://books.example',requestInfo:info},
  httpHeaders:{Cookie:'domain=books.example',Authorization:'Bearer private'},bookWorld:{}};
 const moved=rewrite(source,{status:'verified',autoApply:true,oldOrigin:'https://books.example',newOrigin:'https://www.books.example'});
 assert.equal(moved.applied,true);
 assert.deepEqual(urlRule.describeStaticGetRequest(moved.source.searchBook.requestInfo),{
  url:'https://www.books.example/s?q=%@keyWord&page=%@pageIndex&ref=https://books.example',
  method:'GET',forbidCookie:true,generated:true});
 assert.deepEqual(moved.source.httpHeaders,source.httpHeaders);
 assert.equal(source.searchBook.requestInfo,info,'input remains unchanged');
 for(const raw of ['https://books.example.evil/s','https://books.example@evil.example/s',
  '@js:return {url:"https://books.example/s",httpHeaders:{Cookie:secret}};']) {
  assert.equal(urlRule.rewriteStaticGetOrigin(raw,'https://books.example','https://www.books.example'),raw);
 }
});

test('generated grouped Default/CSS XPath stays within each book card and keeps position semantics',()=>{
 const doc=new JSDOM('<nav><a href="/">Home</a></nav><div class="card"><p><a href="/one/">One</a></p><p><a href="/one-more/">Other</a></p></div><div class="card"><p><a href="/two/">Two</a></p><p><a href="/two-more/">Other</a></p></div>').window.document;
 const cards=[...doc.querySelectorAll('.card')];
 for(const input of ['tag.a.0@href','@css:a:eq(0)@href']) {
  const r=rules.convertRule(input,{src:{},listChildFields:true});
  assert(!r.value.includes('(//'),r.value);
  const values=cards.map(card=>doc.evaluate(r.value,card,null,2,null).stringValue);
  assert.deepEqual(values,['/one/','/two/']);
 }
 const negative=rules.convertRule('tag.a.-1@href',{src:{},listChildFields:true}).value;
 assert.deepEqual(cards.map(card=>doc.evaluate(negative,card,null,2,null).stringValue),['/one-more/','/two-more/']);
 const union=rules.convertRule('@css:a:eq(0), a:eq(-1)@href',{src:{},listChildFields:true}).value;
 for(const card of cards)assert.equal(doc.evaluate(union,card,null,7,null).snapshotLength,2);
 const literal='(//a[contains(.,"(//literal")])[1]/@href';
 const scoped=require('../../converter/lib/utils.js').scopeGroupedListXPath(literal,{listChildFields:true});
 assert(scoped.includes('"(//literal"'),'quoted XPath data remains unchanged');
 assert.equal(rules.convertRule('@XPath:'+literal,{src:{},listChildFields:true}).value,literal,'explicit user XPath remains unchanged');
});

test('search module first href extraction selects each card rather than page navigation',()=>{
 const converted=converter.convertAll({bookSourceName:'Cards',bookSourceUrl:'https://www.myshu.cc',
  searchUrl:'/search?q={{key}}',ruleSearch:{bookList:'.card',name:'a@text',bookUrl:'a@href'}}).output.Cards;
 const d=new JSDOM('<nav><a href="/">Home</a></nav><div class="card"><a href="/one/">One</a><a href="/more/">More</a></div><div class="card"><a href="/two/">Two</a></div>').window.document;
 assert.deepEqual([...d.querySelectorAll('.card')].map(card=>d.evaluate(require('../../converter/lib/linkRule.js').describeLinkRule(converted.searchBook.detailUrl).selector,card,null,2,null).stringValue),['/one/','/two/']);
});
