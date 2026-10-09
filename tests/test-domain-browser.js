'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');
const converter=fs.readFileSync('docs/converter.bundle.js','utf8');
const domain=fs.readFileSync('docs/domain-check.js','utf8');
const ai=fs.readFileSync('docs/ai-assistant.js','utf8');
const live=fs.readFileSync('docs/ai-web-probe.js','utf8');
const html=fs.readFileSync('docs/index.html','utf8')
 .replace('<script src="./converter.bundle.js"></script>','<script>'+converter+'</script>')
 .replace('<script src="./ai-assistant.js" defer></script>','<script>'+ai+'</script>')
 .replace('<script src="./ai-web-probe.js" defer></script>','<script>'+live+'</script>')
 .replace('<script src="./domain-check.js" defer></script>','<script>'+domain+'</script>');
async function test(){
 const calls=[],scriptErrors=[];
 let mode='verified';
 const dom=new JSDOM(html,{url:'http://130.162.136.114:4397/',runScripts:'dangerously',pretendToBeVisual:true,
  beforeParse(w){
    w.TextEncoder=TextEncoder;w.TextDecoder=TextDecoder;
    w.HTMLElement.prototype.scrollIntoView=()=>{};
    w.fetch=async(uri,opts)=>{
      const u=String(uri);
      if(u.includes('updates.json'))return {ok:true,json:async()=>[]};
      if(u==='/api/source/domains'){
        const body=JSON.parse(opts.body);
        calls.push(body);
        assert.equal(body.sources.length,1);
        assert.equal(body.sources[0].sourceName,'测试迁移');
        assert.equal(body.sources[0].sourceUrl,'https://legacy-books.testsource');
        assert.equal(body.sources[0].searchUrl,'/s?q={{key}}');
        assert(!JSON.stringify(body).includes('SECRET_COOKIE'),'do not send headers/cookies');
        const row={sourceName:'测试迁移',oldOrigin:'https://legacy-books.testsource',
          newOrigin:'https://modern-books.testsource',status:mode,autoApply:mode==='verified',
          reason:mode==='verified'?'HTTP 永久跳转已验证':'搜索未成功返回'};
        return {ok:true,status:200,json:async()=>({ok:true,results:[row]})};
      }
      throw Error('Unexpected fetch '+u);
    };
    w.addEventListener('error',e=>scriptErrors.push(e.message));
  }});
 const w=dom.window,d=w.document;
 await new Promise(resolve=>setTimeout(resolve,20));
 assert(w.BooksourceDomainCheck);
 assert.equal(d.getElementById('autoDomainProbe').checked,true);
 const raw={bookSourceName:'测试迁移',bookSourceUrl:'https://legacy-books.testsource',
   bookSourceType:0,header:'{"Cookie":"SECRET_COOKIE"}',searchUrl:'/s?q={{key}}',
   ruleSearch:{bookList:'.item',name:'h3@text',bookUrl:'a@href'},
   ruleToc:{chapterList:'#list a',chapterName:'text',chapterUrl:'href'},
   ruleContent:{content:'#content@text'}};
 function current(){return JSON.parse(w.lastFullJson)['测试迁移'];}
 d.getElementById('input').value=JSON.stringify(raw);
 w.doConvert();
 await new Promise(resolve=>setTimeout(resolve,35));
 assert.equal(calls.length,1);
 assert.equal(current().sourceUrl,'https://modern-books.testsource');
 assert.equal(current().searchBook.host,'https://modern-books.testsource');
 assert(current().searchBook.requestInfo.startsWith('https://modern-books.testsource/s'));
 assert.equal(current().searchBook.httpHeaders.Cookie,'SECRET_COOKIE','keys were not modified');
 assert(d.getElementById('domainCheckStatus').textContent.includes('更新 1 条'));
 mode='needs-confirmation';
 d.getElementById('input').value=JSON.stringify(raw);
 w.doConvert();
 await new Promise(resolve=>setTimeout(resolve,35));
 assert.equal(calls.length,2);
 assert.equal(current().sourceUrl,'https://legacy-books.testsource','unverified move cannot auto change source');
 assert(d.getElementById('domainCheckResults').textContent.includes('未自动更换'));
 d.getElementById('autoDomainProbe').checked=false;
 w.doConvert();
 await new Promise(resolve=>setTimeout(resolve,35));
 assert.equal(calls.length,2,'disabled probe should not send request');
 assert.equal(scriptErrors.length,0,scriptErrors.join('; '));
 console.log('PASS baseline conversion async domain verification, safe update, uncertain preservation, privacy and opt-out');
 dom.window.close();
}
test().catch(err=>{console.error(err.stack||err);process.exitCode=1});
