'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');
const tick=()=>new Promise(resolve=>setTimeout(resolve,15));
const page=fs.readFileSync('docs/index.html','utf8').replace(/<script src="\.\/([a-z.-]+\.js)"(?: defer)?><\/script>/g,(_,name)=>'<script>'+fs.readFileSync('docs/'+name,'utf8')+'</script>');
const source=name=>({sourceName:name,sourceUrl:'https://www.myshu.cc',sourceType:'text',enable:1,weight:'100',
 searchBook:{actionID:'searchBook',parserID:'DOM',responseFormatType:'html',requestInfo:'/s?q=%@keyWord',list:'//li',bookName:'.//a/text()',detailUrl:'.//a/@href'},
 bookDetail:{actionID:'bookDetail',parserID:'DOM',responseFormatType:'html',requestInfo:'%@result'},
 chapterList:{actionID:'chapterList',parserID:'DOM',responseFormatType:'html',requestInfo:'%@result',list:'//li',title:'.//a/text()',url:'.//a/@href'},
 chapterContent:{actionID:'chapterContent',parserID:'DOM',responseFormatType:'html',requestInfo:'%@result',content:'//article'}});
async function setup(t){
 const pending=[],errors=[];
 const dom=new JSDOM(page,{url:'http://localhost:4397/',runScripts:'dangerously',pretendToBeVisual:true,beforeParse(w){
  w.TextEncoder=TextEncoder;w.TextDecoder=TextDecoder;
  w.HTMLElement.prototype.scrollIntoView=()=>{};
  w.fetch=async(url,options)=>{
   if(String(url).includes('updates.json'))return {ok:true,json:async()=>JSON.parse(fs.readFileSync('docs/updates.json','utf8'))};
   return new Promise(resolve=>pending.push({url:String(url),options,body:options.body?JSON.parse(options.body):null,resolve}));
  };
  w.addEventListener('error',e=>errors.push(e.message));
 }});
 t.after(()=>{assert.deepEqual(errors,[]);dom.window.close();});
 await tick();const w=dom.window,d=w.document;
 d.getElementById('autoDomainProbe').checked=false;
 d.getElementById('input').value=JSON.stringify([source('A'),source('B')]);
 assert(w.BooksourceWebProbe.parseMixed(d.getElementById('input').value));
 const complete=(call,label='new')=>{
  const alias=call.body.sourceName,original=call.body.source[alias];
  const candidate=JSON.parse(JSON.stringify(original));candidate.chapterContent.content='//*[@id="'+label+'"]';
  call.resolve({ok:true,json:async()=>({ok:true,sourceName:alias,summary:label,candidate,accepted:[{path:'chapterContent.content',oldValue:original.chapterContent.content,newValue:candidate.chapterContent.content,reason:label}],issues:[],diagnostics:[],verified:true,verification:{fullyVerified:true},liveWebEvidence:{site:original.sourceUrl,keyword:'test',steps:[],diagnostics:[label],fullyVerified:false}})});
 };
 return {w,d,pending,complete};
}
test('changing the selected source aborts repair and rejects a late response',async t=>{
 const {w,d,pending,complete}=await setup(t);
 d.getElementById('aiAutoRepairRun').click();assert.equal(pending.length,1);
 d.getElementById('aiRepairSource').value='B';d.getElementById('aiRepairSource').dispatchEvent(new w.Event('change',{bubbles:true}));
 assert.equal(pending[0].options.signal.aborted,true);complete(pending[0]);await tick();
 assert.equal(d.getElementById('aiRepairResult').hidden,true);assert.equal(d.getElementById('aiApplyFix').disabled,true);
 assert.equal(JSON.parse(w.lastFullJson).B.chapterContent.content,'//article');
});
test('programmatic input change without DOM events still invalidates delayed repair',async t=>{
 const {w,d,pending,complete}=await setup(t);
 d.getElementById('aiAutoRepairRun').click();d.getElementById('input').value='{"new":"unconverted input"}';
 complete(pending[0]);await tick();assert(d.getElementById('aiRepairResult').hidden);
 assert(!d.getElementById('aiAutoRepairRun').disabled);assert.equal(d.getElementById('input').value,'{"new":"unconverted input"}');
});
test('clearAll also clears full export data; late responses cannot resurrect it',async t=>{
 const {w,d,pending,complete}=await setup(t);d.getElementById('aiAutoRepairRun').click();w.clearAll();
 assert.equal(w.lastFullJson,'');assert.equal(pending[0].options.signal.aborted,true);
 complete(pending[0]);await tick();assert.equal(d.getElementById('output').value,'');assert(d.getElementById('aiApplyFix').disabled);
});
test('cancel request works without an API key and the same source can be retried',async t=>{
 const {w,d,pending,complete}=await setup(t);d.getElementById('aiAutoRepairRun').click();
 const cancel=d.getElementById('cancelCurrentRequest');assert(!cancel.disabled);cancel.click();
 assert(pending[0].options.signal.aborted);assert(cancel.disabled);assert(!d.getElementById('aiAutoRepairRun').disabled);
 d.getElementById('aiAutoRepairRun').click();assert.equal(pending.length,2);
 complete(pending[0],'old');await tick();assert(d.getElementById('aiAutoRepairRun').disabled);
 complete(pending[1],'retry');await tick();assert(!d.getElementById('aiRepairResult').hidden);assert(!d.getElementById('aiApplyFix').disabled);
 assert(d.getElementById('aiRepairPatches').textContent.includes('retry'));assert.equal(w.localStorage.length,0);
});
test('older repair cannot replace a newer optional AI result on the same source',async t=>{
 const {w,d,pending,complete}=await setup(t);d.getElementById('aiAutoRepairRun').click();
 w.localStorage.setItem('booksource_ai_local_v1',JSON.stringify({apiType:'openai-completions',baseUrl:'https://example.com/v1',apiKey:'FAKE_BROWSER_KEY',model:'mock'}));
 d.getElementById('aiRepairRun').click();assert.equal(pending.length,2);assert(pending[0].options.signal.aborted);
 complete(pending[1],'latest');await tick();assert.equal(d.getElementById('aiRepairSummary').textContent,'latest');
 complete(pending[0],'outdated');await tick();assert.equal(d.getElementById('aiRepairSummary').textContent,'latest');
});
test('keyword changes invalidate live website reports and report downloads',async t=>{
 const {w,d,pending}=await setup(t);d.getElementById('aiSiteProbe').click();
 d.getElementById('aiProbeKeyword').value='another';d.getElementById('aiProbeKeyword').dispatchEvent(new w.Event('input',{bubbles:true}));
 assert(pending[0].options.signal.aborted);
 pending[0].resolve({ok:true,json:async()=>({ok:true,evidence:{site:'old',steps:[{step:'search',status:'ok'}],diagnostics:[]}})});
 await tick();assert(d.getElementById('aiWebEvidence').hidden);assert(!d.getElementById('aiSiteProbe').disabled);
});
test('applying a candidate never overwrites programmatically edited current output',async t=>{
 const {w,d,pending,complete}=await setup(t);d.getElementById('aiAutoRepairRun').click();complete(pending[0],'candidate');await tick();
 assert(!d.getElementById('aiApplyFix').disabled);
 const edit=JSON.parse(w.lastFullJson);edit.B.authorId='preserve-this';const text=JSON.stringify(edit,null,2);
 w.lastFullJson=text;d.getElementById('output').value=text;
 d.getElementById('aiApplyFix').click();assert.equal(w.lastFullJson,text);assert(d.getElementById('aiRepairStatus').textContent.includes('已变化'));
});
test('old domain result cannot restore output after clearing it',async t=>{
 const {w,d,pending}=await setup(t);d.getElementById('autoDomainProbe').checked=true;
 const output=JSON.parse(w.lastFullJson);w.BooksourceDomainCheck.schedule(output,[]);
 assert.equal(pending[0].url,'/api/source/domains');w.clearAll();assert(pending[0].options.signal.aborted);
 pending[0].resolve({ok:true,json:async()=>({ok:true,results:[{sourceName:'A',status:'verified',autoApply:true,oldOrigin:'https://www.myshu.cc',newOrigin:'https://myshu.cc'}]})});
 await tick();assert.equal(w.lastFullJson,'');assert.equal(d.getElementById('output').value,'');
});
test('late built-in sample download cannot overwrite newly cleared input',async t=>{
 const {w,d,pending}=await setup(t);d.getElementById('aiLoadThreeExamples').click();
 assert.equal(pending[0].url,'./samples/three-test-sources.json');w.clearAll();
 assert(pending[0].options.signal.aborted);
 pending[0].resolve({ok:true,json:async()=>[source('X'),source('Y'),source('Z')]});
 await tick();assert.equal(d.getElementById('input').value,'');assert.equal(w.lastFullJson,'');assert(!d.getElementById('aiLoadThreeExamples').disabled);
});
test('clearing while an XBS FileReader is pending aborts read and rejects its late callback',async t=>{
 const {w,d}=await setup(t);let reader;
 const payload=w.json2xbs(JSON.stringify({old:source('old')}));
 w.FileReader=function(){reader=this;this.readyState=0;};
 w.FileReader.prototype.readAsArrayBuffer=function(){this.readyState=1;};
 w.FileReader.prototype.abort=function(){this.readyState=2;this.aborted=true;};
 const field=d.getElementById('xbsFile');
 Object.defineProperty(field,'files',{configurable:true,value:[new w.File([payload],'old.xbs')]});
 field.dispatchEvent(new w.Event('change',{bubbles:true}));assert(reader);
 w.clearAll();assert(reader.aborted);
 reader.result=payload.buffer.slice(payload.byteOffset,payload.byteOffset+payload.byteLength);reader.onload();
 assert.equal(d.getElementById('output').value,'');assert.equal(d.getElementById('xbsOutput').value,'');assert.equal(w.lastFullJson,'');
});
