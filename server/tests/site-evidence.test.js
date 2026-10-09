import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { inspectSourceWeb, checkApprovedSource } from '../site-evidence.js';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const converter=require('../../converter/lib/index.js');
const legado=JSON.parse(fs.readFileSync('tests/fixtures/tianxia-legado.json','utf8'));
const converted=converter.convertAll(legado,{forceEnableAll:true,forceWeight:true,defaultWeight:100}).output;
const base='https://www.tianxiabachang.cn';
const html=(text)=>new Response(text,{status:200,headers:{'content-type':'text/html; charset=utf-8'}});
const source={source:converted,sourceName:'⚡📂笔趣阁',legado,keyword:'测试小说'};
const dns=async()=>{};
const seen=[];
const fakeFetch=async url=>{
  const u=new URL(url);seen.push(u.pathname);
  if(u.pathname==='/')return html('<html><title>笔趣阁</title><body><h1>测试站点</h1></body></html>');
  if(u.pathname==='/cse/search')return html(`<html><title>搜索结果</title><div id="main"><ul>
    <li>广告</li><li><a href="/book/123/">测试小说第一部</a><span class="s4">测试作者</span></li>
    <li><a href="/book/456/">测试小说第二部</a></li></ul></div></html>`);
  if(u.pathname==='/book/123/')return html(`<html><title>测试小说第一部详情</title><h1>测试小说第一部</h1>
    <div id="intro"><p>简介</p></div><div id="list"><dl><dd><a href="/book/123/1.html">第一章</a></dd><dd><a href="/book/123/2.html">第二章</a></dd></dl></div></html>`);
  if(u.pathname==='/book/123/1.html')return html('<html><div id="content">这是模拟的测试正文段落，专门用于验证文本提取过程，绝不是实际小说内容，也不是来自第三方网站的数据。</div></html>');
  throw new Error('unexpected url '+u.href);
};

test('given Legado source converts id.main@li!0 into valid XPath',()=>{
  assert.equal(converted['⚡📂笔趣阁'].searchBook.list,'(//*[contains(@id,"main")]//li)[not(position()=1)]');
});

test('real request pipeline on synthetic web pages validates all four reading stages',async()=>{
  seen.length=0;
  const report=await inspectSourceWeb(source,{fetcher:fakeFetch,dnsChecker:dns});
  assert.equal(report.site,base);
  assert.equal(report.keyword,'测试小说');
  assert.equal(report.fullyVerified,false);
  assert.deepEqual(report.steps.map(x=>x.step),['homepage','search','detail','chapterList','chapterContent']);
  assert(report.steps.every(x=>x.status==='ok'),JSON.stringify(report.steps));
  assert.equal(report.steps[1].count,2);
  assert.equal(report.steps[1].examples[0].title,'测试小说第一部');
  assert.equal(report.steps[1].xsggXPathMatches,2);
  assert.equal(report.steps[3].count,2);
  assert(report.steps[4].contentLength>=30);
  assert.deepEqual(seen,['/','/cse/search','/book/123/','/book/123/1.html']);
  assert(!JSON.stringify(report).includes('模拟的测试正文段落，专门用于验证文本提取过程，绝不是实际小说内容，也不是来自第三方网站的数据。'),'report should avoid full chapter content');
});

test('network failure is reported as failed search, never asserts later pages work',async()=>{
  const mock=async url=>{
    if(new URL(url).pathname==='/')return html('<html><title>home</title></html>');
    throw new Error('Connection timed out after 6500ms');
  };
  const report=await inspectSourceWeb(source,{fetcher:mock,dnsChecker:dns});
  assert.equal(report.steps[1].status,'timeout');
  assert(report.steps.slice(2).every(x=>x.status==='skipped'));
  assert.equal(report.fullyVerified,false);
});

test('HTTP 403 and wrong XPath show honest diagnostic',async()=>{
  const broken=structuredClone(source);
  broken.source['⚡📂笔趣阁'].searchBook.list='//*[contains(@id,"main")]/@li!0';
  const mock=async url=>new Response(new URL(url).pathname==='/'?'<h1>home</h1>':'blocked',{status:new URL(url).pathname==='/'?200:403,headers:{'content-type':'text/html'}});
  const report=await inspectSourceWeb(broken,{fetcher:mock,dnsChecker:dns});
  assert.equal(report.steps[1].status,'blocked');
  assert(report.diagnostics.some(x=>x.includes('searchBook.list')),'must flag old invalid conversion even when site offline');
});

test('source checker disallows arbitrary hosts and private addresses',async()=>{
  assert.throws(()=>checkApprovedSource('http://127.0.0.1:9000'),/书源首页|白名单/);
  assert.throws(()=>checkApprovedSource('https://example.com'),/白名单/);
  assert.throws(()=>checkApprovedSource('https://www.tianxiabachang.cn@localhost'),/书源首页|白名单/);
  const outsider={legado:[{bookSourceUrl:'https://example.com',searchUrl:'https://example.com/s?keyword={{key}}'}],keyword:'demo'};
  await assert.rejects(()=>inspectSourceWeb(outsider,{fetcher:fakeFetch,dnsChecker:dns}),/白名单/);
});
