'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');
const dom=new JSDOM('<!doctype html><title>Core adapter test</title>',{runScripts:'outside-only',url:'https://app.example/'});
try{
 const w=dom.window;
 // Only the generated, trusted application bundle is loaded in this test.
 w.eval(fs.readFileSync('docs/converter.bundle.js','utf8'));
 const core=w.ConverterLib;
 assert.equal(typeof core.evaluateStaticRequest,'function');
 assert.equal(typeof core.evaluateStaticScript,'function');
 const result=core.evaluateStaticRequest('@js:var k=encodeURIComponent(String(params.keyWord).trim());return {url:config.host+"/search?q="+k};',
   {params:{keyWord:' a&中文 '},config:{host:'https://books.example'},result:''});
 assert.equal(result.ok,true);
 assert.equal(result.request.url,'https://books.example/search?q=a%26%E4%B8%AD%E6%96%87');
 const bad=core.evaluateStaticScript('@js:globalThis.browserAttack=true;return "fake";',{});
 assert.equal(bad.ok,false);assert.equal(w.browserAttack,undefined);
 const source=JSON.parse(fs.readFileSync('tests/fixtures/suduguu-legado.json','utf8'));
 assert.equal(core.convertAll(source,{forceEnableAll:true}).okCount,1);
 assert(fs.readFileSync('docs/converter.bundle.js','utf8').includes('Acorn JavaScript parser - MIT'));
 console.log('PASS shared bounded expression adapter in browser, encoding, malicious rejection, conversion and parser license');
}finally{dom.window.close();}
