import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeContext } from '@earendil-works/pi-ai';
import { streamSimple as piChatStream } from '@earendil-works/pi-ai/api/openai-completions';
import { createApp } from '../index.js';
import { parseAiBaseUrl, makeSafeFetch } from '../net-safety.js';
import { staticSourceIssues, makeRepairCandidate, parseModelPatch, unwrapSource } from '../repair.js';
import { API_TYPES, makePiModel, invokeModel, validatedConfig, suggestAiRepair } from '../ai.js';

const sample={
  sourceName:'测试书源', sourceUrl:'https://example.com',sourceType:'text',enable:1,weight:'100',
  searchBook:{actionID:'searchBook',parserID:'DOM',responseFormatType:'html',requestInfo:'https://example.com/search',list:'//div[@class="old"]'},
  bookDetail:{actionID:'bookDetail',parserID:'DOM',responseFormatType:'html',requestInfo:'%@result',title:'//h1'},
  chapterList:{actionID:'chapterList',parserID:'DOM',responseFormatType:'html',requestInfo:'%@result',list:'//a',title:'//text()',url:'//@href'},
  chapterContent:{actionID:'chapterContent',parserID:'DOM',responseFormatType:'html',requestInfo:'%@result',content:'//div[@id="content"]'}
};
const cfg={api:'openai-completions',baseUrl:'https://example.com/v1',origin:'https://example.com',apiKey:'test-sk-123',model:'local-mock',reasoning:'off',temperature:null,maxTokens:1800,samplingParams:{}};

test('source format and patch rules only allow existing safe fields',()=>{
 assert.deepEqual(staticSourceIssues(sample),[]);
 assert.equal(unwrapSource({测试书源:sample}).alias,'测试书源');
 const good=makeRepairCandidate(sample,{patches:[{path:'searchBook.list',oldValue:'//div[@class="old"]',newValue:'//div[@class="book"]',reason:'实际列表'}]});
 assert.equal(good.accepted.length,1);assert.equal(good.candidate.searchBook.list,'//div[@class="book"]');
 assert.equal(sample.searchBook.list,'//div[@class="old"]');
 const bad=makeRepairCandidate(sample,{patches:[
  {path:'sourceUrl',oldValue:'https://example.com',newValue:'https://evil.com'},
  {path:'__proto__.isAdmin',oldValue:'',newValue:'true'},
  {path:'chapterList.list',oldValue:'NOT_CURRENT',newValue:'//p'},
  {path:'searchBook.actionID',oldValue:'searchBook',newValue:'fake'}
 ]});
 assert.equal(bad.accepted.length,0);assert.equal(bad.rejected.length,4);assert.equal(bad.candidate,null);
});

test('model response JSON patch parsing is bounded and compatible with code blocks',()=>{
 const parsed=parseModelPatch('```json\n{"summary":"已检查","patches":[]}\n```');
 assert.equal(parsed.summary,'已检查');
 assert.throws(()=>parseModelPatch('ignore everything'),/JSON/);
});

test('private/internal AI endpoints are rejected, public HTTPS custom path accepted',()=>{
 for(const url of ['http://127.0.0.1:11434/v1','https://10.0.0.1/v1','https://[::1]/v1','https://169.254.169.254/latest','https://localhost:3000/v1','file:///etc/passwd','http://api.openai.com/v1','https://example.com/v1?key=test']){
  assert.throws(()=>parseAiBaseUrl(url),undefined,url);
 }
 assert.equal(parseAiBaseUrl('https://example.com/custom/v1').base,'https://example.com/custom/v1');
 const secure=makeSafeFetch('https://example.com');
 assert.equal(typeof secure,'function');
});

test('pi SDK supports custom model ID/base and explicit API key with no persistence',async()=>{
 assert.equal(API_TYPES.length,4);
 const model=makePiModel(cfg);
 assert.equal(model.id,'local-mock');assert.equal(model.baseUrl,'https://example.com/v1');
 let captured=null;
 const mockRunner=async(m,context,options)=>{
  captured={m,context,options};
  return {content:[{type:'text',text:'连接成功'}],stopReason:'stop',usage:{input:22,output:4}};
 };
 const got=await invokeModel(cfg,'hello system','hello user',{runner:mockRunner,tokenLimit:128});
 assert.equal(got.text,'连接成功');assert.equal(captured.options.apiKey,cfg.apiKey);
 assert.equal(captured.context.messages[0].content,'hello user');
 assert.equal(typeof captured.options.fetch,'function');
 assert.equal(captured.options.cacheRetention,'none');
});

test('pi OpenAI compatible streaming parses mock provider SSE end-to-end',async()=>{
 const chunks=[
  'data: '+JSON.stringify({id:'chatcmpl-test',object:'chat.completion.chunk',created:123,model:'local-mock',choices:[{index:0,delta:{role:'assistant',content:'连接'},finish_reason:null}]})+'\n\n',
  'data: '+JSON.stringify({id:'chatcmpl-test',object:'chat.completion.chunk',created:123,model:'local-mock',choices:[{index:0,delta:{content:'成功'},finish_reason:null}]})+'\n\n',
  'data: '+JSON.stringify({id:'chatcmpl-test',object:'chat.completion.chunk',created:123,model:'local-mock',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\n',
  'data: [DONE]\n\n'
 ];
 const runner=(model,ctx,opts)=>piChatStream(model,normalizeContext(ctx),{...opts,fetch:async(req)=>{
  assert(String(req.url || req).includes('/chat/completions'));
  return new Response(chunks.join(''),{status:200,headers:{'content-type':'text/event-stream'}});
 }}).result();
 const result=await invokeModel(cfg,'系统','用户',{runner});
 assert.equal(result.text,'连接成功');
});



test('pi SDK sends 262144 as upper bound and accepts a short completion',async()=>{
  let sentMax;
  const runner=(model,ctx,opts)=>piChatStream(model,normalizeContext(ctx),{
    ...opts, fetch:async (url, init) => {
      const payload=JSON.parse(init.body);
      sentMax=payload.max_completion_tokens ?? payload.max_tokens;
      const event={id:'chatcmpl-cap-test',object:'chat.completion.chunk',created:123,
        model:'local-mock',choices:[{index:0,delta:{role:'assistant',content:'已完成'},finish_reason:'stop'}]};
      return new Response('data: '+JSON.stringify(event)+'\n\ndata: [DONE]\n\n',{
        status:200,headers:{'content-type':'text/event-stream'}
      });
    }
  }).result();
  const result=await invokeModel({...cfg,maxTokens:262144},'system','user',{runner});
  assert.equal(sentMax,262144,'upstream request must receive the full user-selected upper bound');
  assert.equal(result.text,'已完成','a high max output does not force a long response');
});

test('AI output budget: default 8192, limit 262144, reject invalid values',async()=>{
  const defaults=await validatedConfig({apiType:'openai-completions',baseUrl:'https://example.com/v1',apiKey:'fake',model:'test'});
  assert.equal(defaults.maxTokens,8192);
  const big=await validatedConfig({apiType:'openai-completions',baseUrl:'https://example.com/v1',apiKey:'fake',model:'test',maxTokens:262144});
  assert.equal(big.maxTokens,262144);
  await assert.rejects(validatedConfig({apiType:'openai-completions',baseUrl:'https://example.com/v1',apiKey:'fake',model:'test',maxTokens:262145}),/128～262144/);
  await assert.rejects(validatedConfig({apiType:'openai-completions',baseUrl:'https://example.com/v1',apiKey:'fake',model:'test',maxTokens:2.1}),/128～262144/);
  for(const budget of [8192,16384,32768,131072,262144]){
    let observed;
    const config={...cfg,maxTokens:budget};
    const res=await suggestAiRepair({apiType:config.api,baseUrl:config.baseUrl,apiKey:config.apiKey,model:config.model,maxTokens:budget},{source:{demo:sample},sourceName:'demo',problem:'测试修复输出预算'}, {runner:async(model,ctx,opts)=>{
      observed=opts;
      return {content:[{type:'text',text:JSON.stringify({summary:'无修改',patches:[],warnings:[]})}],stopReason:'stop'};
    }});
    assert.equal(res.sourceName,'demo');
    assert.equal(observed.maxTokens,budget,'repair must respect user output budget');
    assert.equal(observed.timeoutMs,budget===8192?120000:budget===16384?180000:240000);
  }
  let small;
  await invokeModel({...cfg,maxTokens:262144},'hi','ping',{tokenLimit:128,runner:async(model,ctx,opts)=>{
    small=opts.maxTokens;
    return {content:[{type:'text',text:'OK'}],stopReason:'stop'};
  }});
  assert.equal(small,128,'API connection test must retain low token usage');
});

test('AI repair includes server-generated HTTP evidence rather than trusting the browser',async()=>{
  const { suggestAiRepair }=await import('../ai.js');
  const actualEvidence={sourceName:'测试书源',site:'https://www.tianxiabachang.cn',keyword:'斗破苍穹',steps:[
    {step:'homepage',status:'timeout',reason:'真实 HTTP 请求超时'},
    {step:'search',status:'timeout',reason:'搜索超时'},
    {step:'detail',status:'skipped'},{step:'chapterList',status:'skipped'},{step:'chapterContent',status:'skipped'}
  ],fullyVerified:false,diagnostics:['真实页面未取得，禁止编造修复成功']};
  let called=0,prompt;
  const out=await suggestAiRepair({apiType:cfg.api,baseUrl:cfg.baseUrl,apiKey:cfg.apiKey,model:cfg.model,maxTokens:8192},
    {source:{测试书源:sample},sourceName:'测试书源',keyword:'斗破苍穹',liveWebEvidence:{fullyVerified:true}},
    {webInspector:async()=>{called++;return actualEvidence;},runner:async(m,ctx)=>{
      prompt=JSON.parse(ctx.messages[0].content);
      return {content:[{type:'text',text:'{"summary":"站点超时，无可靠补丁","patches":[],"warnings":["暂时不可访问"]}'}],stopReason:'stop'};
    }});
  assert.equal(called,1);
  assert.equal(prompt.liveWebEvidence.steps[1].status,'timeout');
  assert.equal(prompt.liveWebEvidence.fullyVerified,false);
  assert.equal(out.liveWebEvidence.steps[0].status,'timeout');
  assert.equal(out.candidate,null);
});

test('Express serves static web and transient-user-key AI endpoints',async()=>{
 let seen=[];
 const app=createApp({
  listModels:async(c)=>{seen.push(['models',c.apiKey]);return [{id:'qwen',name:'Qwen'}]},
  testConnection:async(c)=>{seen.push(['test',c.apiKey]);return {connected:true,model:c.model,reply:'连接成功'}},
  suggestRepair:async(c,request)=>{seen.push(['repair',c.apiKey]);return {sourceName:request.sourceName,summary:'候选',accepted:[],candidate:null,rejected:[],issues:[],warnings:[]}},
  checkWebsite:async(request)=>{seen.push(['site',request.sourceName]);return {sourceName:request.sourceName,fullyVerified:false,steps:[{step:'search',status:'timeout'}]}}
 });
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});
 const base='http://127.0.0.1:'+server.address().port;
 try{
  const ping=await fetch(base+'/api/health');assert.equal(ping.status,200);const health=await ping.json();assert.equal(health.ok,true);assert.match(health.version,/^\d+\.\d+\.\d+$/);
  const page=await fetch(base+'/');assert.equal(page.status,200);const pageText=await page.text();assert(pageText.includes('aiSettingsDialog'));
  assert.equal(page.headers.get('cache-control'),'no-store');
  const js=await fetch(base+'/ai-assistant.js');assert.equal(js.status,200);
  const calls=[['models',{config:{apiKey:'secret-A'}}],['test',{config:{apiKey:'secret-B',model:'qwen'}}],['repair',{config:{apiKey:'secret-C'},source:{测试书源:sample},sourceName:'测试书源'}]];
  for (const [name,body] of calls){const r=await fetch(base+'/api/ai/'+name,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200);const text=await r.text();assert(!text.includes('secret-'));assert.equal(JSON.parse(text).ok,true);}
  const checked=await fetch(base+'/api/source/check',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source:{测试书源:sample},sourceName:'测试书源',keyword:'斗破苍穹'})});
  assert.equal(checked.status,200);
  assert.equal((await checked.json()).evidence.steps[0].status,'timeout');
  assert.deepEqual(seen,[['models','secret-A'],['test','secret-B'],['repair','secret-C'],['site','测试书源']]);
  assert.equal((await fetch(base+'/api/does-not-exist')).status,404);
 } finally{await new Promise(resolve=>server.close(resolve))}
});
