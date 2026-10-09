import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectDomainMove,inspectDomainBatch} from '../domain-migration.js';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {applyVerifiedDomainMove}=require('../../converter/lib/domainRewrite.js');
const html=path=>new Response('<!doctype html><html><title>小说网 - '+path+'</title><body><div class="item">小说内容与搜索列表都存在，模拟实际站点。</div></body></html>',
  {status:200,headers:{'Content-Type':'text/html; charset=utf-8'}});
const dns=async()=>{};
function response301(target){return new Response('',{status:301,headers:{location:target}});}
function stubRedirect(oldHost,newHost,{temp=false,searchOk=true,rewritePath=false}={}){
 return async uri=>{
  const u=new URL(uri);
  if(u.hostname===oldHost){
   return new Response('',{status:temp?302:301,headers:{location:
     'https://'+newHost+(rewritePath?'/new'+u.pathname:u.pathname)+u.search}});
  }
  if(u.hostname===newHost){
   if(!searchOk && u.pathname==='/s')return new Response('Not Found',{status:404});
   return html(u.pathname);
  }
  throw Error('unexpected '+uri);
 };
}
test('www canonical permanent 301 is safely applied without a search URL',async()=>{
 const move=await inspectDomainMove({sourceUrl:'https://suduguu.com/'},{
  fetcher:stubRedirect('suduguu.com','www.suduguu.com'),dnsChecker:dns});
 assert.equal(move.status,'verified');
 assert.equal(move.autoApply,true);
 assert.equal(move.newOrigin,'https://www.suduguu.com');
 assert.equal(move.home.redirects[0].status,301);
});
test('new registrable domain requires same permanent redirect for homepage AND search',async()=>{
 const move=await inspectDomainMove({sourceUrl:'https://old-books.example/',searchUrl:'/s?key={{key}}'},{
  fetcher:stubRedirect('old-books.example','new-books.net'),dnsChecker:dns});
 assert.equal(move.status,'needs-confirmation');
 assert.equal(move.autoApply,false);
 assert.equal(move.newOrigin,'https://new-books.net');
 assert.equal(move.home.redirects.length,1);
 assert.equal(move.search.redirects.length,1);
});
test('a cross-site redirect without independently validated search is a suggestion only',async()=>{
 const move=await inspectDomainMove({sourceUrl:'https://old-books.example/'},{
  fetcher:stubRedirect('old-books.example','new-books.net'),dnsChecker:dns});
 assert.equal(move.status,'needs-confirmation');
 assert.equal(move.autoApply,false);
});
test('temporary redirects, path rewrites, search 404 are never auto-applied',async()=>{
 const base={sourceUrl:'https://old-books.example/',searchUrl:'/s?key={{key}}'};
 for(const details of [{temp:true},{searchOk:false},{rewritePath:true}]){
  const move=await inspectDomainMove(base,{
   fetcher:stubRedirect('old-books.example','new-books.net',details),dnsChecker:dns});
  assert.equal(move.autoApply,false);
  assert.equal(move.status,'needs-confirmation');
 }
});
test('DNS/private/IP redirect is rejected before issuing a second fetch',async()=>{
 let calls=0;
 const fetcher=async uri=>{
  calls++;
  return response301('http://127.0.0.1/admin');
 };
 const result=await inspectDomainMove({sourceUrl:'https://old-books.example/'},{fetcher,dnsChecker:dns});
 assert.equal(result.status,'unverified');
 assert.equal(result.autoApply,false);
 assert.equal(result.home.status,'unsafe');
 assert.equal(calls,1);
});
test('only URL-bearing fields are rewritten; preserve other domains and source identity',()=>{
 const old='https://old-books.example',dest='https://new-books.net';
 const sample={sourceUrl:old,sourceName:'原始书源',searchBook:{host:old,requestInfo:old+'/s?key=%@keyWord',
   bookName:'//*[contains(text(),"'+old+'")]',cover:'https://cdn.example/book.jpg'},
   chapterList:{host:old,requestInfo:old+'/toc'},
   bookWorld:{分类:{host:old,requestInfo:old+'/list'}},
   httpHeaders:{Referer:old,Authorization:'secret'}};
 const original=JSON.stringify(sample);
 const r=applyVerifiedDomainMove(sample,{status:'verified',autoApply:true,oldOrigin:old,newOrigin:dest});
 assert.equal(r.applied,true);
 assert.equal(r.source.sourceUrl,dest);
 assert.equal(r.source.bookWorld['分类'].requestInfo,dest+'/list');
 assert.equal(r.source.chapterList.requestInfo,dest+'/toc');
 assert.equal(r.source.searchBook.bookName,sample.searchBook.bookName);
 assert.equal(r.source.searchBook.cover,'https://cdn.example/book.jpg');
 assert.equal(r.source.httpHeaders.Referer,dest);
 assert.equal(r.source.httpHeaders.Authorization,'secret');
 assert.equal(JSON.stringify(sample),original);
 assert(!applyVerifiedDomainMove(sample,{status:'needs-confirmation',autoApply:false,oldOrigin:old,newOrigin:dest}).applied);
});
test('batch rejects unbounded domain scans',async()=>{
 await assert.rejects(inspectDomainBatch({sources:Array.from({length:7},()=>({sourceUrl:'https://a.example'}))}),/1～6/);
});
