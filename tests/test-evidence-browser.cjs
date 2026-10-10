'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');
let html=fs.readFileSync('docs/index.html','utf8');
for(const [name,defer] of [['converter.bundle.js',false],['ai-assistant.js',true],['ai-web-probe.js',true],['domain-check.js',true]]){
  html=html.replace('<script src="./'+name+'"'+(defer?' defer':'')+'></script>',()=>'<script>'+fs.readFileSync('docs/'+name,'utf8')+'</script>');
}
async function run(){
  const blobs=[],downloads=[],errors=[];
  const dom=new JSDOM(html,{url:'http://localhost:14497/',runScripts:'dangerously',pretendToBeVisual:true,
    beforeParse(w){
      w.TextEncoder=TextEncoder;w.TextDecoder=TextDecoder;
      w.HTMLElement.prototype.scrollIntoView=()=>{};
      w.URL.createObjectURL=blob=>{blobs.push(blob);return 'blob:evidence-'+blobs.length;};
      w.URL.revokeObjectURL=()=>{};
      w.Blob=Blob;
      w.HTMLAnchorElement.prototype.click=function(){downloads.push({name:this.download,url:this.href});};
      w.fetch=async()=>({ok:true,json:async()=>[]});
      w.addEventListener('error',e=>errors.push(e.message));
    }});
  const w=dom.window,d=w.document;
  await new Promise(r=>setTimeout(r,30));
  w.localStorage.setItem('my-api-key','LOCAL_PRIVATE_API_KEY');
  const evidence={sourceName:'测试源',site:'https://www.myshu.cc',keyword:'测试',fullyVerified:false,appVerified:false,reportVersion:1,
    steps:[{step:'search',status:'ok',httpStatus:200,requestMethod:'GET',url:'https://www.myshu.cc/search?q=test',charset:'utf-8',
      handoff:{from:'bookDetail.chapterListUrl',value:'https://www.myshu.cc/toc/1/'},redirects:[{status:301,url:'http://www.myshu.cc/search',location:'https://www.myshu.cc/search',elapsedMs:10}],
      fieldChecks:[{field:'chapterListUrl',rule:'//a/@href',status:'multiple-values',normalization:'response-url',note:'URL 为单值字段',matches:1,context:'list-node',
        contexts:[{index:0,matches:1,samples:['<img src=x onerror=alert(1)>'],resolvedUrls:['https://www.myshu.cc/book/1/']}]}]}],
    diagnostics:['仅为静态检测']};
  w.BooksourceWebProbe.show(evidence);
  assert.equal(d.getElementById('aiWebEvidence').hidden,false);
  assert(d.getElementById('aiWebEvidenceIntro').textContent.includes('不能认定修复成功'));
  const details=d.querySelector('#aiWebEvidenceSteps details');
  assert.equal(details.open,false,'technical evidence stays collapsed by default');
  assert(details.textContent.includes('列表条目 1'));
  assert(details.textContent.includes('字符编码：utf-8'));
  assert(details.textContent.includes('地址传递：bookDetail.chapterListUrl → https://www.myshu.cc/toc/1/'));
  assert(details.textContent.includes('相对地址按该页最终响应 URL 解析'));
  assert(d.getElementById('aiRepairProblem').value.includes('URL 为单值字段'));
  assert(details.textContent.includes('http://www.myshu.cc/search → https://www.myshu.cc/search'));
  assert(details.textContent.includes('<img src=x onerror=alert(1)>'));
  assert.equal(details.querySelector('img'),null,'sample HTML remains inert text');
  d.getElementById('webEvidenceDownload').click();
  assert.equal(downloads.length,1);assert.equal(downloads[0].name,'booksource-evidence.json');
  const exported=await blobs[0].text();
  assert.deepEqual(JSON.parse(exported),evidence);
  assert(!exported.includes('LOCAL_PRIVATE_API_KEY'));
  d.getElementById('aiReadSources').click();
  d.getElementById('webEvidenceDownload').click();
  assert.equal(downloads.length,1,'reset does not export stale reports');
  assert.equal(errors.length,0,errors.join('; '));
  dom.window.close();
  console.log('PASS field samples, redirect evidence, inert rendering, private JSON export and stale-report reset');
}
run().catch(error=>{console.error(error.stack);process.exitCode=1;});
