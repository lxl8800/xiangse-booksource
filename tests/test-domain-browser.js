'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');
const converter=fs.readFileSync('docs/converter.bundle.js','utf8');
const domain=fs.readFileSync('docs/domain-check.js','utf8');
const ai=fs.readFileSync('docs/ai-assistant.js','utf8');
const live=fs.readFileSync('docs/ai-web-probe.js','utf8');
const html=fs.readFileSync('docs/index.html','utf8').replace('<script src="./request-state.js"></script>',()=>'<script>'+fs.readFileSync('docs/request-state.js','utf8')+'</script>')
 .replace('<script src="./converter.bundle.js"></script>',()=>'<script>'+converter+'</script>')
 .replace('<script src="./ai-assistant.js" defer></script>',()=>'<script>'+ai+'</script>')
 .replace('<script src="./ai-web-probe.js" defer></script>',()=>'<script>'+live+'</script>')
 .replace('<script src="./domain-check.js" defer></script>',()=>'<script>'+domain+'</script>');
async function test(){
 const calls=[],scriptErrors=[];
 let mode='verified',expectedSearch='https://legacy-books.testsource/s?q=%@keyWord',expectedSkip;
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
        assert.equal(body.sources[0].searchUrl,expectedSearch);
        assert.equal(body.sources[0].searchProbeSkipped,expectedSkip);
        assert(!JSON.stringify(body).includes('PRIVATE_SEARCH_TOKEN'));
        assert(!JSON.stringify(body).includes('SECRET_COOKIE'),'do not send headers/cookies');
        const row={sourceName:'测试迁移',oldOrigin:'https://legacy-books.testsource',
          newOrigin:'https://modern-books.testsource',status:mode,autoApply:mode==='verified',
          reason:mode==='verified'?'HTTP 永久跳转已验证':'搜索未成功返回',migrationScope:mode==='verified'?undefined:'searchBook',
          home:{status:'ok',httpStatus:200,originalUrl:'https://legacy-books.testsource/',url:'https://modern-books.testsource/',finalDomain:'modern-books.testsource',contentType:'text/html',elapsedMs:12,
            redirects:[{status:301,url:'https://legacy-books.testsource/',location:'https://modern-books.testsource/?sample=<img src=x onerror=alert(1)>',elapsedMs:7}]}};
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
   bookSourceType:0,header:'',searchUrl:'/s?q={{key}}',
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
 assert.equal(current().searchBook.httpHeaders,undefined);
 assert(d.getElementById('domainCheckStatus').textContent.includes('更新 1 条'));
 mode='needs-confirmation';
 d.getElementById('input').value=JSON.stringify(raw);
 w.doConvert();
 await new Promise(resolve=>setTimeout(resolve,35));
 assert.equal(calls.length,2);
 assert.equal(current().sourceUrl,'https://legacy-books.testsource','unverified move cannot auto change source');
 assert(d.getElementById('domainCheckResults').textContent.includes('未自动更换（仅搜索模块）'));
 const details=d.querySelector('#domainCheckResults details');assert.equal(details.open,false);
 assert(details.textContent.includes('HTTP 301'));assert(details.textContent.includes('最终域名：modern-books.testsource'));
 assert(details.textContent.includes('<img src=x onerror=alert(1)>'));assert.equal(details.querySelector('img'),null);
 d.getElementById('input').value=JSON.stringify({...raw,enabledCookieJar:false});
 w.doConvert();await new Promise(resolve=>setTimeout(resolve,35));
 assert.equal(calls.length,3);assert(current().searchBook.requestInfo.startsWith('@js:'));
 expectedSearch=undefined;expectedSkip='sensitive-search';
 d.getElementById('input').value=JSON.stringify({...raw,searchUrl:'/s?q={{key}}&api_key=PRIVATE_SEARCH_TOKEN'});
 w.doConvert();await new Promise(resolve=>setTimeout(resolve,35));assert.equal(calls.length,4);
 assert.equal(current().sourceUrl,'https://legacy-books.testsource');
 expectedSkip='unsupported-search';
 d.getElementById('input').value=JSON.stringify({...raw,searchUrl:'/s,{"method":"POST","body":"key={{key}}"}'});
 w.doConvert();await new Promise(resolve=>setTimeout(resolve,35));assert.equal(calls.length,5);

 expectedSearch=undefined;expectedSkip='unsupported-search';
 d.getElementById('input').value=JSON.stringify({...raw,header:'{"Cookie":"SECRET_COOKIE"}'});
 w.doConvert();await new Promise(resolve=>setTimeout(resolve,35));assert.equal(calls.length,6);
 assert.equal(current().sourceUrl,'https://legacy-books.testsource');
 assert.equal(current().searchBook.httpHeaders.Cookie,'SECRET_COOKIE','blocked headers remain intact in user output');
 d.getElementById('autoDomainProbe').checked=false;
 w.doConvert();
 await new Promise(resolve=>setTimeout(resolve,35));
 assert.equal(calls.length,6,'disabled probe should not send request');
 assert.equal(d.getElementById('domainCheckResults').hidden,true,'old evidence cleared when probe is disabled');
 assert.equal(scriptErrors.length,0,scriptErrors.join('; '));
 console.log('PASS baseline conversion async domain verification, safe update, uncertain preservation, privacy and opt-out');
 dom.window.close();
}
test().catch(err=>{console.error(err.stack||err);process.exitCode=1});
