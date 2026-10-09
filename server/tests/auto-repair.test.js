import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import { inspectSourceWeb } from '../site-evidence.js';
import { runAutoRepair } from '../auto-repair.js';
import { staticSourceIssues } from '../repair.js';

const require=createRequire(import.meta.url);
const converter=require('../../converter/lib/index.js');
const myshu=JSON.parse(fs.readFileSync('tests/fixtures/myshu-old.xsgg.json','utf8'));
const legSud=JSON.parse(fs.readFileSync('tests/fixtures/suduguu-legado.json','utf8'));
const legLemon=JSON.parse(fs.readFileSync('tests/fixtures/lemon-legado.json','utf8'));
const sud=converter.convertAll(legSud,{forceEnableAll:true,forceWeight:true,defaultWeight:100}).output;
const lem=converter.convertAll(legLemon,{forceEnableAll:true,forceWeight:true,defaultWeight:100}).output;
const ok=(text)=>new Response(text,{status:200,headers:{'content-type':'text/html; charset=utf-8'}});
const dns=async()=>{};
const myshuFake=async(uri)=>{
 const u=new URL(uri);
 if(u.pathname==='/')return ok('<html><form action="/search.php" method="get"><input name="q"></form><title>天天小书屋</title></html>');
 if(u.pathname==='/s.php')return new Response('Not Found',{status:404});
 if(u.pathname==='/search.php')return ok('<html><div class="col-12 col-md-6"><dl><dt><a href="/109/109277/"><img src="/cover.png"></a></dt><dd><h3><a href="/109/109277/">测试小说</a></h3></dd><dd class="book_other">作者：<span>测试作者</span></dd><dd>最新章节：<a href="/109/109277/392568.html">第1章</a></dd></dl></div></html>');
 if(u.pathname==='/109/109277/')return ok('<html><div class="book_info"><h1>测试小说</h1></div><div class="book_list book_list2"><ul><li><a href="/109/109277/392568.html">第1章</a></li></ul></div></html>');
 if(u.pathname==='/109/109277/392568.html')return ok('<html><article class="font_max">小说正文的真实内容区域。这里是用于单元测试的模拟章节，足够长才能作为静态 HTML 解析测试证据。测试完成。</article><a id="next" href="/109/109277/392568_2.html">下一页</a></html>');
 throw Error('unexpected '+uri);
};
const engine=(fetcher)=>async(request)=>inspectSourceWeb(request,{fetcher,dnsChecker:dns,timeoutMs:2000});

test('old XSGG source uses 404 URL; form detection recovers real search but original rules fail',async()=>{
 const evidence=await inspectSourceWeb({source:myshu,sourceName:'天天小书屋',keyword:'测试小说'},
 {fetcher:myshuFake,dnsChecker:dns});
 assert.equal(evidence.httpChainVerified,true);
 assert.equal(evidence.fullyVerified,false);
 const search=evidence.steps.find(x=>x.step==='search');
 assert.equal(search.searchAttempts[0].httpStatus,404);
 assert.equal(search.searchAttempts[1].httpStatus,200);
 assert.equal(search.discoveredSearch.parameter,'q');
 assert.equal(search.configuredMatches,0);
 assert.equal(search.count,1);
 assert.equal(evidence.steps.find(x=>x.step==='chapterContent').configuredMatches,0);
});

test('no-key auto repair fills verified rules and succeeds only after retesting the XSGG candidate',async()=>{
 const result=await runAutoRepair({source:myshu,sourceName:'天天小书屋',keyword:'测试小说'},
 {webInspector:engine(myshuFake)});
 assert.equal(result.verified,true,JSON.stringify({verification:result.verification,diagnostics:result.diagnostics}));
 assert.equal(result.verification.fullyVerified,true);
 assert.equal(result.liveWebEvidence.fullyVerified,false);
 assert(result.accepted.length>=18);
 assert.deepEqual(staticSourceIssues(result.candidate),[]);
 assert.equal(result.candidate.sourceType,'text');
 assert.equal(result.candidate.enable,0);
 assert.equal(result.candidate.searchBook.requestInfo,'https://www.myshu.cc/search.php?q=%@keyWord');
 assert.equal(result.candidate.searchBook.requestParamsEncode,undefined);
 assert(result.candidate.chapterList.list.includes('book_list2'));
 assert(result.candidate.chapterContent.content.includes('article'));
});

test('301 apex to www is safe; source repair converts script URL and book-relative detail XPath',async()=>{
 const fake=async(href)=>{
  const u=new URL(href);
  if(u.hostname==='suduguu.com')
   return new Response('',{status:301,headers:{location:'https://www.suduguu.com'+u.pathname+u.search}});
  if(u.pathname==='/')return ok('<html><title>速读谷</title></html>');
  if(u.pathname==='/i/sor.aspx')return ok('<html><div class="item"><a href="/448/"><img src="https://www.suduguu.com/cover.jpg"></a><h3><a href="/448/">测试小说</a></h3></div></html>');
  if(u.pathname==='/448/')return ok('<html><div class="item"><h1><a>测试小说</a></h1><img src="https://www.suduguu.com/cover.jpg"></div><div id="list"><ul><li><a href="/448/10.html">第1章</a></li></ul></div></html>');
  if(u.pathname==='/448/10.html')return ok('<html><div class="con">这是通过真实网站静态 DOM 测试逻辑模拟的正文内容，用于证明四步请求与解析流程有效，不是外部作者的真实作品。</div></html>');
  throw Error('unexpected '+href);
 };
 const source=structuredClone(sud);
 const result=await runAutoRepair({source,sourceName:'速读谷',legado:legSud,keyword:'测试小说'},
 {webInspector:engine(fake)});
 assert.equal(result.verified,false);
 assert.equal(result.verification.httpChainVerified,true);
 assert(result.verification.steps.some(s=>s.fieldChecks?.some(f=>f.status==='partially-checked')));
 assert.equal(result.candidate.sourceUrl,'https://www.suduguu.com');
 assert.equal(result.candidate.searchBook.detailUrl,'.//h3/a/@href');
 assert.equal(result.candidate.searchBook.bookName,'.//h3/a/text()');
 assert.equal(result.candidate.searchBook.cover,'.//img/@src');
 assert.equal(result.candidate.searchBook.requestInfo,'https://www.suduguu.com/i/sor.aspx?key=%@keyWord');
 assert.equal(result.verification.steps[2].url,'https://www.suduguu.com/448/');
});

test('do not guess repairs when lemon search hostname times out',async()=>{
 const errors=async()=>{throw new Error('Connection timed out after 2000ms')};
 const result=await runAutoRepair({source:lem,sourceName:'🎉 柠檬小说',legado:legLemon,keyword:'青春'},
 {webInspector:engine(errors)});
 assert.equal(result.verified,false);
 assert.equal(result.candidate,null);
 assert.equal(result.accepted.length,0);
 assert.equal(result.liveWebEvidence.steps[1].status,'timeout');
});
