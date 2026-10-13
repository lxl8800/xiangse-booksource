import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {inspectSourceWeb} from '../site-evidence.js';
import {runAutoRepair} from '../auto-repair.js';
const require=createRequire(import.meta.url);
const {evaluateJsonPath}=require('../../converter/lib/jsonPath.js');
const {compileLinkRule}=require('../../converter/lib/linkRule.js');
const origin='https://www.myshu.cc';
const text='这是用于 JSON 接口和 JSONPath 验证的模拟章节文本，不来自第三方作品，用于确认传递的是实际书籍和章节链接。';
const query=(data,rule)=>evaluateJsonPath(data,rule).values;
function source(){
 return {sourceName:'JSON回归',sourceUrl:origin,sourceType:'text',enable:1,weight:'100',
  searchBook:{actionID:'searchBook',parserID:'DOM',responseFormatType:'json',requestInfo:origin+'/api/search?q=%@keyWord',list:'$.data.items',bookName:'$.name',detailUrl:compileLinkRule('$.url')},
  bookDetail:{actionID:'bookDetail',parserID:'DOM',responseFormatType:'json',requestInfo:'%@result',bookName:'$.data.name',chapterListUrl:compileLinkRule('$.data.toc')},
  chapterList:{actionID:'chapterList',parserID:'DOM',responseFormatType:'json',requestInfo:'%@result',list:'$.data.chapters',title:'$.title',url:compileLinkRule('$.url')},
  chapterContent:{actionID:'chapterContent',parserID:'DOM',responseFormatType:'json',requestInfo:'%@result',content:'$.data.content'}};
}
const pages={
 '/api/search':{name:'全局错误书名',url:'/wrong',data:{items:[{name:'正确书名',url:'book'},{name:'第二书名',url:'other'}]}},
 '/api/book':{data:{name:'正确书名',toc:'toc'}},
 '/api/toc':{title:'全局错误章节',url:'/wrong',data:{chapters:[{title:'第一章',url:'chapter/1'},{title:'第二章',url:'chapter/2'}]}},
 '/api/chapter/1':{data:{content:text}},
};
const response=(data,type='application/json')=>new Response(typeof data==='string'?data:JSON.stringify(data),{headers:{'content-type':type}});
async function inspect(config=source(),respond=(url)=>response(new URL(url).pathname==='/'?'<title>首页</title>':pages[new URL(url).pathname],new URL(url).pathname==='/'?'text/html':'application/json')){
 const calls=[];const report=await inspectSourceWeb({source:{JSON回归:config},keyword:'中文'},{
  dnsChecker:async()=>{},fetcher:async(url,opts)=>{calls.push({url,opts});return respond(url,opts);}});
 return {report,calls};
}
test('JSONPath names, quoted keys, arrays, wildcard, unions and slices have deterministic values',()=>{
 const data={books:[{name:'甲'},{name:'乙'},{name:'丙'}],'a.b':{'中文':'值'},a:{b:'nested'}};
 assert.deepEqual(query(data,'$.books[*].name'),['甲','乙','丙']);
 assert.deepEqual(query(data,'$.books[-1].name'),['丙']);
 assert.deepEqual(query(data,'$.books[0,2,0].name'),['甲','丙','甲']);
 assert.deepEqual(query(data,'$.books[1:].name'),['乙','丙']);
 assert.deepEqual(query(data,'$.books[::-1].name'),['丙','乙','甲']);
 assert.deepEqual(query(data,'$["a.b"]["中文"]'),['值']);
 assert.deepEqual(query(data,'a/b'),['nested']);
 assert.deepEqual(query({'Bob\'s':'x'},"$['Bob\\'s']"),['x']);
 assert.deepEqual(query(data,'@json:$.a.b'),['nested']);
});
test('recursive descent and static scalar comparison filters never need code execution',()=>{
 const data={x:[{id:1,on:true},{id:2,on:false},{id:3,on:true}],nested:{id:4}};
 assert.deepEqual(query(data,'$..id'),[1,2,3,4]);
 assert.deepEqual(query(data,'$.x[?(@.on==true)].id'),[1,3]);
 assert.deepEqual(query(data,'$.x[?(@.id>=2)].id'),[2,3]);
 assert.deepEqual(query(data,'$.x[?(@.id!=2)].id'),[1,3]);
 assert.deepEqual(query([{name:'a'},{name:'b'}],"$[?(@.name=='a')].name"),['a']);
});
test('unsupported functions, script filters, compound expressions and malformed paths fail closed',()=>{
 delete globalThis.jsonPathAttack;
 for(const rule of ['$.x[?((globalThis.jsonPathAttack=true))]','$.x[?(@.id==1 || @.id==2)]','$.x[?(@.name.match(/(a+)+$/))]','$.x[(@.length-1)]','$.x[','$.x[0:2:0]','$.x[?(@.id===1)]']){
  const r=evaluateJsonPath({x:[{id:1,name:'a'}]},rule);assert(r.reason,rule);assert.deepEqual(r.values,[]);
 }
 assert.equal(globalThis.jsonPathAttack,undefined);
});
test('JSONPath cannot read inherited prototype fields or mutate the input',()=>{
 const data=JSON.parse('{"x":{"constructor":"literal"},"__proto__":{"name":"data-only"}}'),before=JSON.stringify(data);
 assert.deepEqual(query(data,'$.constructor'),[]);
 assert.deepEqual(query(data,'$.x.constructor'),['literal']);
 assert.deepEqual(query(data,'$["__proto__"].name'),['data-only']);
 assert.equal(JSON.stringify(data),before);assert.equal({}.name,undefined);
});
test('wide, deep and expensive JSONPath queries preserve budget diagnostics',()=>{
 assert(evaluateJsonPath({x:Array.from({length:5000},(_,i)=>i)},'$.x[*]').reason.includes('预算'));
 let value={name:'x'};for(let i=0;i<70;i++)value={child:value};
 assert(evaluateJsonPath(value,'$..name').reason.includes('预算'));
 assert(evaluateJsonPath({x:[1,2,3]},'$.x[*]',{maxOperations:1}).reason.includes('预算'));
});
test('JSON search-detail-independent catalog-content chain preserves list-item context and real URLs',async()=>{
 const {report,calls}=await inspect();assert(report.fullyVerified);assert(report.httpChainVerified);assert.equal(report.appVerified,false);
 assert.deepEqual(calls.map(c=>new URL(c.url).pathname),['/','/api/search','/api/book','/api/toc','/api/chapter/1']);
 assert.equal(report.steps[1].count,2);assert.equal(report.steps[1].examples[0].title,'正确书名');
 assert.equal(report.steps[2].title,'正确书名');assert.equal(report.steps[3].examples[0].title,'第一章');
 assert.equal(report.steps[4].contentLength,text.length);assert(report.steps.slice(1).every(s=>s.parserFormat==='json'));
 assert.equal(report.steps[1].fieldChecks.find(f=>f.field==='bookName').parser,'JSONPath');
 assert(!calls.some(c=>c.url.endsWith('/wrong')));assert(!JSON.stringify(report).includes(text));
});
test('JSON and HTML actions can coexist in the same configured reading chain',async()=>{
 const s=source();s.searchBook.responseFormatType='html';s.searchBook.list='//div[@class="card"]';s.searchBook.bookName='//a/text()';s.searchBook.detailUrl='//a/@href';
 s.chapterContent.responseFormatType='html';s.chapterContent.content='//*[@id="content"]';
 const {report}=await inspect(s,url=>{
  const path=new URL(url).pathname;
  if(path==='/api/search')return response('<div class="card"><a href="book">正确书名</a></div>','text/html');
  if(path==='/api/chapter/1')return response('<div id="content">'+text+'</div>','text/html');
  return response(path==='/'?'<title>主页</title>':pages[path],path==='/'?'text/html':'application/json');
 });
 assert(report.fullyVerified);assert.deepEqual(report.steps.slice(1).map(x=>x.parserFormat),['html','json','json','html']);
});
test('JSON pagination merges directory records and content strings with the same next-link safety policy',async()=>{
 const s=source();s.chapterList.nextPageUrl=compileLinkRule('$.data.next');s.chapterContent.nextPageUrl='$.data.next';
 const {report}=await inspect(s,url=>{
  const path=new URL(url).pathname;
  if(path==='/api/toc')return response({data:{chapters:pages[path].data.chapters,next:'toc2'}});
  if(path==='/api/toc2')return response({data:{chapters:[{title:'第二章',url:'chapter/2'},{title:'第三章',url:'chapter/3'}],next:null}});
  if(path==='/api/chapter/1')return response({data:{content:text,next:'../parts2'}});
  if(path==='/api/parts2')return response({data:{content:'这是下一页的测试正文段落。',next:''}});
  return response(path==='/'?'<title>主页</title>':pages[path],path==='/'?'text/html':'application/json');
 });
 assert(report.fullyVerified);assert.equal(report.steps[3].count,3);assert.equal(report.steps[3].pagination.duplicates,1);
 assert.equal(report.steps[4].contentLength,(text+'\n这是下一页的测试正文段落。').length);
});
test('declared JSON parsing may handle JSON with an inaccurate HTTP content type but HTML config is preserved',async()=>{
 const {report}=await inspect(source(),url=>response(new URL(url).pathname==='/'?'<title>首页</title>':pages[new URL(url).pathname],'text/html'));
 assert(report.fullyVerified);assert(report.steps.slice(1).every(x=>x.parserFormat==='json'));
 const s=source();s.searchBook.responseFormatType='html';
 const wrong=await inspect(s);assert.equal(wrong.report.fullyVerified,false);assert.equal(wrong.report.steps[1].status,'unsupported');
});
test('invalid JSON and HTML challenge responses retain HTTP success separately from parser failure',async()=>{
 for(const body of ['{"data":','<html><title>Verify you are human</title></html>']){
  const {report,calls}=await inspect(source(),url=>new URL(url).pathname==='/api/search'?response(body):response(new URL(url).pathname==='/'?'<title>首页</title>':pages[new URL(url).pathname],new URL(url).pathname==='/'?'text/html':'application/json'));
  assert.equal(report.steps[1].httpStatus,200);assert.equal(report.steps[1].status,'unsupported');assert.equal(report.fullyVerified,false);
  assert.equal(calls.length,2);assert(report.steps.slice(2).every(x=>x.status==='skipped'));
 }
});
test('JSON scalar fields do not stringify objects or pick an arbitrary URL from arrays',async()=>{
 for(const url of [{href:'book'},['book','other']]){
  const {report,calls}=await inspect(source(),address=>new URL(address).pathname==='/api/search'?response({data:{items:[{name:'正确书名',url}]}}):response('<title>首页</title>','text/html'));
  assert.equal(report.fullyVerified,false);assert.equal(report.steps[1].status,'no-results');
  assert.equal(calls.length,2);assert.equal(report.steps[1].fieldChecks.find(f=>f.field==='detailUrl').status,'invalid');
 }
});
test('unknown JSON URL pipes are not executed or replaced by their raw selector values',async()=>{
 const s=source();s.searchBook.detailUrl='$.url||@js:globalThis.jsonPathAttack=true;return result;';
 delete globalThis.jsonPathAttack;
 const {report,calls}=await inspect(s);assert.equal(report.fullyVerified,false);assert.equal(globalThis.jsonPathAttack,undefined);
 assert.equal(calls.length,2);assert(report.steps[1].fieldChecks.some(x=>x.status==='partially-checked'));
});
test('unsupported JSONPath filters yield a field diagnosis and never invent fallback HTML selectors',async()=>{
 const s=source();s.searchBook.list='$.data.items[?((globalThis.jsonPathAttack=true))]';
 const {report,calls}=await inspect(s);assert.equal(report.fullyVerified,false);assert.equal(calls.length,2);
 assert.equal(report.steps[1].autoDiscovered,undefined);assert(report.diagnostics.some(x=>x.includes('JSONPath')));
});
test('JSON links to internal services and credential parameters are refused before a request',async()=>{
 for(const target of ['http://169.254.169.254/latest/meta-data','http://127.0.0.1/','book?token=PRIVATE_JSON_TOKEN']){
  const {report,calls}=await inspect(source(),url=>new URL(url).pathname==='/api/search'?response({data:{items:[{name:'正确书名',url:target}]}}):response('<title>首页</title>','text/html'));
  assert.equal(report.fullyVerified,false);assert.equal(calls.length,2);assert.equal(report.steps[2].status,'unsupported');
  assert(!JSON.stringify(report).includes('PRIVATE_JSON_TOKEN'));
 }
});
test('JSON auto repair preserves response formats, retests the candidate, and avoids HTML site adapters',async()=>{
 const s=source();s.enable='1';const before=structuredClone(s),seen=[];
 const inspector=async input=>{seen.push(input);return (await inspect(Object.values(input.source)[0])).report;};
 const r=await runAutoRepair({source:{JSON回归:s},sourceName:'JSON回归',keyword:'中文'},{webInspector:inspector});
 assert(r.candidate);assert.equal(r.verified,true);assert.equal(seen.length,2);
 assert.deepEqual(s,before);assert(Object.values(r.candidate).filter(x=>x&&typeof x==='object'&&x.actionID).every(x=>x.responseFormatType==='json'));
 assert(!r.accepted.some(x=>x.newValue.includes('//div')),'HTML adapters must not replace JSON source rules');
});
