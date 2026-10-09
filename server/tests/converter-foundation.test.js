import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const converter=require('../../converter/lib/index.js');
const sudugu=JSON.parse(fs.readFileSync('tests/fixtures/suduguu-legado.json','utf8'));
const lemon=JSON.parse(fs.readFileSync('tests/fixtures/lemon-legado.json','utf8'));

test('basic conversion statically extracts 19 real categories from Legado JS without running it',()=>{
 const r=converter.convertAll(sudugu,{forceEnableAll:true,forceWeight:true,defaultWeight:100});
 assert.equal(r.failures.length,0);
 const s=r.output['速读谷'];
 const cats=Object.keys(s.bookWorld);
 assert.equal(cats.length,19);
 assert(cats.includes('最近更新')&&cats.includes('言情小说'));
 for(const [category,obj] of Object.entries(s.bookWorld)){
   assert.equal(obj.actionID,'bookWorld');
   assert.equal(obj.parserID,'DOM');
   assert.equal(obj.responseFormatType,'html');
   assert(obj.requestInfo.includes('suduguu.com'),category);
   assert(!obj.requestInfo.includes('var inputData'),category);
   assert(!obj.requestInfo.includes('JSON.stringify(categories)'),category);
 }
 assert(r.warnings.some(w=>w.msg.includes('19 个书源分类')));
});
test('Legado jsLib helper is self-contained inside relevant output fields',()=>{
 const r=converter.convertAll(sudugu,{forceEnableAll:true,forceWeight:true,defaultWeight:100});
 const s=r.output['速读谷'];
 for(const code of [s.searchBook.cover,s.bookDetail.cover,s.bookWorld['最近更新'].cover]){
   assert.match(code,/function getCover\(href\)/);
   assert.match(code,/return \(getCover\(result\)\)/);
   const script=code.split('||@js:')[1];
   const run=new Function('result',script);
   assert.equal(run('https://www.suduguu.com/image.jpg'),'https://www.suduguu.com/image.jpg');
   assert.equal(run('/images/1.jpg'),'https://suduguu.com/images/1.jpg');
 }
});
test('dynamic unknown explore JS is not mistaken for a URL; visibility fallback is explicit',()=>{
 const r=converter.convert({
  bookSourceName:'动态目录',bookSourceType:0,
  bookSourceUrl:'https://books.example.net',
  enabled:true,searchUrl:'/search?key={{key}}',
  ruleSearch:{bookList:'.item',name:'h3@text',bookUrl:'a@href'},
  ruleToc:{chapterList:'#list a',chapterUrl:'href'},
  ruleContent:{content:'#content@text'},
  exploreUrl:'@js:\nvar url = java.ajax("http://private");JSON.stringify([{title:"偷链",url:url}]);',
  enabledExplore:true,ruleExplore:{bookList:'.item'}
 });
 assert(r.output);
 const s=r.output['动态目录'];
 assert.equal(Object.keys(s.bookWorld).length,1);
 assert(s.bookWorld['首页（待验证）']);
 assert(r.warnings.some(w=>w.level==='unsupported' && w.msg.includes('动态 exploreUrl')));
 assert(r.warnings.some(w=>w.msg.includes('首页发现入口')));
});
test('search-only source still generates visible bookWorld fallback, numeric enable and text type',()=>{
 const r=converter.convert({
  bookSourceName:'搜索专用',bookSourceUrl:'https://one.example',
  bookSourceType:0,searchUrl:'/s?q={{key}}',enabled:true,
  ruleSearch:{bookList:'.result',name:'a@text',bookUrl:'a@href'},
  ruleToc:{chapterList:'#toc a',chapterName:'text',chapterUrl:'href'},
  ruleContent:{content:'#txt@text'}
 });
 const obj=r.output['搜索专用'];
 assert.equal(obj.sourceType,'text');
 assert.equal(obj.enable,1);
 assert.equal(obj.weight,'100');
 assert(obj.bookWorld['首页（待验证）'].requestInfo==='https://one.example/');
});
test('JSON explore category arrays still work for existing book sources',()=>{
 const r=converter.convertAll(lemon,{forceEnableAll:true,forceWeight:true,defaultWeight:100});
 assert.equal(r.failures.length,0);
 const s=r.output['🎉 柠檬小说'];
 assert(Object.keys(s.bookWorld).length>=1);
 assert.equal(s.sourceType,'text');
 assert.equal(s.searchBook.responseFormatType,'json');
});
test('the core converter handles a mixed Legado and already-XSGG array without AI',()=>{
 const raw=JSON.parse(fs.readFileSync('tests/fixtures/myshu-old.xsgg.json','utf8'));
 const mixed=converter.convertAll([sudugu[0],raw],{forceEnableAll:true,forceWeight:true,defaultWeight:100});
 assert.equal(mixed.okCount,2);
 assert.equal(mixed.failures.length,0);
 assert.equal(mixed.output['天天小书屋'].sourceType,'text');
 assert.equal(mixed.output['天天小书屋'].enable,1);
 assert.equal(mixed.output['速读谷'].sourceType,'text');
 const aliases=converter.convertAll(raw,{forceEnableAll:true});
 assert.equal(aliases.okCount,1);
 assert.deepEqual(Object.keys(aliases.output),['天天小书屋']);
});
test('request headers go to action modules and avoid top-level editor warning',()=>{
 const r=converter.convertAll(sudugu,{forceEnableAll:true,forceWeight:true,defaultWeight:100});
 const src=r.output['速读谷'];
 assert.equal(src.httpHeaders,undefined);
 assert.equal(src.searchBook.httpHeaders['User-Agent'],'Mozilla/5.0 (Linux; Android 9) Mobile Safari/537.36');
 assert.equal(src.bookWorld['最近更新'].httpHeaders['User-Agent'],src.searchBook.httpHeaders['User-Agent']);
});
