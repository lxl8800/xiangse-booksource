'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');
const bundle=fs.readFileSync('docs/converter.bundle.js','utf8');
const ai=fs.readFileSync('docs/ai-assistant.js','utf8');
const live=fs.readFileSync('docs/ai-web-probe.js','utf8');
let html=fs.readFileSync('docs/index.html','utf8')
 .replace('<script src="./converter.bundle.js"></script>','<script>'+bundle+'</script>')
 .replace('<script src="./ai-assistant.js" defer></script>','<script>'+ai+'</script>')
 .replace('<script src="./ai-web-probe.js" defer></script>','<script>'+live+'</script>');
const updates=JSON.parse(fs.readFileSync('docs/updates.json','utf8'));
(async()=>{
 const requests=[],errors=[];
 let expectedCandidate=null,expectedAlias=null,expectedOld=null;
 const dom=new JSDOM(html,{url:'http://130.162.136.114:4397/',runScripts:'dangerously',pretendToBeVisual:true,beforeParse(w){
  w.TextEncoder=TextEncoder;w.TextDecoder=TextDecoder;
  w.HTMLElement.prototype.scrollIntoView=()=>{};
  w.fetch=async(uri,opts)=>{
   const s=String(uri);
   if(s.includes('updates.json'))return {ok:true,json:async()=>updates};
   if(s.includes('/samples/tianxia-legado.json'))return {ok:true,json:async()=>JSON.parse(fs.readFileSync('docs/samples/tianxia-legado.json','utf8'))};
   if(s.includes('/samples/three-test-sources.json'))return {ok:true,json:async()=>JSON.parse(fs.readFileSync('docs/samples/three-test-sources.json','utf8'))};
   const body=JSON.parse(opts.body);requests.push({uri:s,body});
   let response={ok:true};
   if(s.includes('/source/auto-repair')){
     const obj=JSON.parse(JSON.stringify(body.source[body.sourceName]));
     obj.sourceType='text';obj.enable=1;
     response={ok:true,sourceName:body.sourceName,candidate:obj,accepted:[{path:'sourceType',oldValue:'（缺失）',newValue:'text',reason:'实际正文类型'}],rejected:[],issues:[],diagnostics:[],verified:true,verification:{fullyVerified:true},liveWebEvidence:{site:'https://www.myshu.cc',keyword:body.keyword,fullyVerified:false,steps:[{step:'search',status:'no-results',reason:'旧 XPath 匹配 0 条'}],diagnostics:['从站点自动发现新规则']}};
   }else if(s.includes('/source/check'))response={ok:true,evidence:{site:'https://example.com',keyword:'斗破苍穹',fullyVerified:false,steps:[
     {step:'homepage',status:'ok',httpStatus:200}, {step:'search',status:'timeout',reason:'网络超时'},
     {step:'detail',status:'skipped'}, {step:'chapterList',status:'skipped'},{step:'chapterContent',status:'skipped'}
   ],diagnostics:['真实 HTTP 搜索超时，不可假设后续通过']}};
  else if(s.includes('/models'))response.models=[{id:'mock-model',name:'Mock model'},{id:'mock-model-2',name:'Mock 2'}];
   else if(s.includes('/test'))response={ok:true,model:body.config.model,reply:'连接成功'};
   else if(s.includes('/repair')){
     const source=body.source[body.sourceName];
     expectedAlias=body.sourceName;
     expectedOld=source.searchBook.list;
     expectedCandidate=JSON.parse(JSON.stringify(source));
     expectedCandidate.searchBook.list=expectedOld+'[1]';
     response={ok:true,sourceName:expectedAlias,summary:'<img src=x onerror=alert(1)> 测试建议',
       accepted:[{path:'searchBook.list',oldValue:expectedOld,newValue:expectedCandidate.searchBook.list,reason:'修复 XPath'}],
       rejected:[],warnings:[],issues:[],candidate:expectedCandidate,liveWebEvidence:{site:'https://example.com',fullyVerified:false,keyword:'斗破苍穹',steps:[{step:'search',status:'timeout',reason:'真实网站超时'}],diagnostics:['模型无法验证真实网页']}};
   }else throw new Error('Unexpected mock endpoint '+s);
   return {ok:true,status:200,json:async()=>response};
  };
  w.addEventListener('error',e=>errors.push(e.message));
 }});
 const w=dom.window,d=w.document;
 await new Promise(r=>setTimeout(r,30));
 const dialog=d.getElementById('aiSettingsDialog');
 assert(dialog);
 assert.equal(w.localStorage.length,0,'No shared AI data by default');
 assert.equal(d.getElementById('aiMaxTokens').value,'8192');
 assert.equal(d.getElementById('aiMaxTokens').max,'262144');
 assert(d.getElementById('aiMaxTokens').parentNode.textContent.includes('1M 上下文'));

 d.getElementById('aiSettingsOpen').click();
 assert(dialog.hasAttribute('open'));
 assert(dialog.textContent.includes('localStorage'));
 assert(dialog.textContent.includes('服务器不保存'));
 assert(dialog.textContent.includes('HTTP'));
 assert(dialog.textContent.includes('Docker'));
 d.getElementById('aiApiType').value='openai-completions';
 d.getElementById('aiBaseUrl').value='https://example.com/custom/v1';
 d.getElementById('aiApiKey').value='ONLY_THIS_BROWSER_SECRET';
 d.getElementById('aiModel').value='mock-model';
 d.getElementById('aiReasoning').value='off';
 d.getElementById('aiMaxTokens').value='262144';
 d.getElementById('aiSaveSettings').click();
 const stored=JSON.parse(w.localStorage.getItem('booksource_ai_local_v1'));
 assert.equal(stored.apiKey,'ONLY_THIS_BROWSER_SECRET');
 assert.equal(stored.baseUrl,'https://example.com/custom/v1');
 assert.equal(stored.maxTokens,262144);
 assert(!fs.readFileSync('docs/index.html','utf8').includes('ONLY_THIS_BROWSER_SECRET'));
 d.getElementById('aiLoadModels').click();await new Promise(r=>setTimeout(r,18));
 assert.equal(d.getElementById('aiModels').options.length,3);
 d.getElementById('aiModels').value='mock-model-2';
 d.getElementById('aiModels').dispatchEvent(new w.Event('change'));
 assert.equal(d.getElementById('aiModel').value,'mock-model-2');
 d.getElementById('aiTestConnection').click();await new Promise(r=>setTimeout(r,18));
 assert(d.getElementById('aiSettingsStatus').textContent.includes('连接成功'));
 // Persist selected model explicitly, and check local browser settings.
 d.getElementById('aiSaveSettings').click();
 d.getElementById('aiSettingsClose').click();
 assert(!dialog.hasAttribute('open'));
 w.navigateToPanel('convert');w.loadSample();w.doConvert();
 const output=d.getElementById('output').value;
 assert(output.length>500);
 d.getElementById('aiReadSources').click();
 assert.equal(d.getElementById('aiRepairSource').options.length,1);
 d.getElementById('aiRepairProblem').value='章节搜索返回空结果';
 d.getElementById('aiSiteProbe').click();
 await new Promise(r=>setTimeout(r,25));
 assert.equal(requests.length,3);
 assert.equal(requests[2].uri,'/api/source/check');
 assert.equal(d.getElementById('aiWebEvidenceSteps').children.length,5);
 assert(d.getElementById('aiWebEvidence').textContent.includes('连接超时'));
 d.getElementById('aiRepairRun').click();await new Promise(r=>setTimeout(r,20));
 assert.equal(requests.length,4);
 assert.equal(requests[3].body.config.apiKey,'ONLY_THIS_BROWSER_SECRET');
 assert.equal(requests[3].body.config.maxTokens,262144);
 assert.equal(requests[3].body.keyword,'斗破苍穹');
 assert.deepEqual(Object.keys(requests[3].body.source),['示例书屋']);
 assert(!d.getElementById('aiRepairResult').hidden);
 assert(d.getElementById('aiWebEvidenceNotes').textContent.includes('模型无法验证真实网页'));
 assert(!d.getElementById('aiApplyFix').disabled);
 assert(!d.getElementById('aiExportFixJson').disabled);
 assert.equal(d.getElementById('aiRepairSummary').querySelectorAll('img').length,0,'AI output must be escaped');
 const oldJSON=JSON.parse(output);assert.equal(oldJSON['示例书屋'].searchBook.list,expectedOld);
 d.getElementById('aiApplyFix').click();
 const newJSON=JSON.parse(d.getElementById('output').value);
 assert.equal(newJSON['示例书屋'].searchBook.list,expectedOld+'[1]');
 assert(!d.getElementById('dlXbsBtn').disabled);
 // Use the user-supplied Legado source directly as a one-click website test.
 d.getElementById('aiLoadTianxiaExample').click();
 await new Promise(r=>setTimeout(r,28));
 assert.equal(d.getElementById('aiRepairSource').value,'⚡📂笔趣阁');
 const sampleOutput=JSON.parse(d.getElementById('output').value);
 assert.equal(sampleOutput['⚡📂笔趣阁'].searchBook.list,'(//*[contains(@id,"main")]//li)[not(position()=1)]');
 assert(d.getElementById('aiRepairStatus').textContent.includes('已加载本次笔趣阁书源'));
 d.getElementById('aiSiteProbe').click();
 await new Promise(r=>setTimeout(r,20));
 assert.equal(requests.at(-1).uri,'/api/source/check');
 assert.equal(requests.at(-1).body.legado.bookSourceName,'⚡📂笔趣阁');
 // Verify another browser origin has no AI key: localStorage is browser-scoped.
 const separate=new JSDOM('<!doctype html><title>other browser</title>',{url:'http://130.162.136.114:4397/'});
 assert.equal(separate.window.localStorage.getItem('booksource_ai_local_v1'),null);
 separate.window.close();
 // Upgrade an older browser's untouched default once without asking the server.
 const oldStorage={apiType:'openai-completions',baseUrl:'https://example.com/v1',model:'old-model',apiKey:'BROWSER_ONLY_KEY',maxTokens:1800,reasoning:'off'};
 const legacy=new JSDOM(html,{url:'http://130.162.136.114:4397/',runScripts:'dangerously',beforeParse(w2){
   w2.TextEncoder=TextEncoder;w2.TextDecoder=TextDecoder;
   w2.HTMLElement.prototype.scrollIntoView=()=>{};
   w2.localStorage.setItem('booksource_ai_local_v1',JSON.stringify(oldStorage));
   w2.fetch=async()=>({ok:true,json:async()=>updates});
 }});
 await new Promise(r=>setTimeout(r,20));
 assert.equal(legacy.window.document.getElementById('aiMaxTokens').value,'8192');
 assert.equal(JSON.parse(legacy.window.localStorage.getItem('booksource_ai_local_v1')).maxTokens,8192);
 assert.equal(JSON.parse(legacy.window.localStorage.getItem('booksource_ai_local_v1')).apiKey,'BROWSER_ONLY_KEY');
 legacy.window.close();
 d.getElementById('aiSettingsOpen').click();
 d.getElementById('aiClearSettings').click();
 assert.equal(w.localStorage.getItem('booksource_ai_local_v1'),null);
 // A concatenation of independent Legado and XSGG JSON documents is
 // auto-identified, with no manual description, conversion, or model key.
 d.getElementById('aiLoadThreeExamples').click();
 await new Promise(r=>setTimeout(r,45));
 const names=[...d.getElementById('aiRepairSource').options].map(e=>e.value);
 assert.deepEqual(names,['速读谷','🎉 柠檬小说','天天小书屋']);
 const consecutive=JSON.parse(fs.readFileSync('docs/samples/three-test-sources.json','utf8')).map(x=>JSON.stringify(x)).join('\n');
 assert.equal(w.BooksourceWebProbe.parseMixed(consecutive),true);
 assert.equal(d.getElementById('aiRepairSource').options.length,3);
 d.getElementById('aiRepairSource').value='🎉 柠檬小说';
 d.getElementById('aiRepairSource').dispatchEvent(new w.Event('change'));
 assert.equal(d.getElementById('aiProbeKeyword').value,'青春');
 d.getElementById('aiRepairSource').value='天天小书屋';
 d.getElementById('aiRepairSource').dispatchEvent(new w.Event('change'));
 d.getElementById('aiRepairProblem').value='';
 d.getElementById('aiRepairProblem').dataset.autofilled='true';
 d.getElementById('aiAutoRepairRun').click();
 await new Promise(r=>setTimeout(r,30));
 assert.equal(requests.at(-1).uri,'/api/source/auto-repair');
 assert.equal(requests.at(-1).body.sourceName,'天天小书屋');
 assert.equal(requests.at(-1).body.config,undefined);
 assert.equal(requests.at(-1).body.legado,null);
 assert(!d.getElementById('aiApplyFix').disabled);
 assert(d.getElementById('aiRepairProblem').value.includes('自动发现'));
 assert(d.getElementById('aiRepairSummary').textContent.includes('重新完成服务器'));
 d.getElementById('aiApplyFix').click();
 assert.equal(JSON.parse(d.getElementById('output').value)['天天小书屋'].sourceType,'text');
 console.log('PASS mixed sequential JSON auto-fill, auto-keyword, no-key auto repair and recheck report');
 assert.equal(d.getElementById('aiApiKey').value,'');
 assert.equal(errors.length,0,errors.join('; '));
 assert.deepEqual([...new Set([...d.querySelectorAll('[id]')].map(e=>e.id))].length,[...d.querySelectorAll('[id]')].length);
 console.log('PASS localStorage key save/restore/clear and independent browser isolation');
 console.log('PASS default 8192, manual 262144 saved/passed, legacy localStorage 1800 migration');
 console.log('PASS 4 protocol selector, dynamic model list, custom model ID, model test request');
 console.log('PASS AI single-source repair request, safe diff display, manual application');
 console.log('PASS prompt/privacy warning, no inline AI key, no script errors');
 dom.window.close();
})().catch(err=>{console.error(err.stack||String(err));process.exitCode=1});
