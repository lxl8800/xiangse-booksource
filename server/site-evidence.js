/**
 * Online source inspector for the public one-container workbench.
 * It makes real HTTP(S) requests, parses static DOM, and reports precisely
 * where a reading flow fails. It does NOT execute scraped site JS, Legado
 * JavaScript, model generated programs, WebView, browser challenges or logins.
 * Only explicitly approved public domains can be requested, with DNS rebinding
 * protection, no redirect following, strict time/byte/step budgets.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
const { splitUrlOptions } = createRequire(import.meta.url)('../converter/lib/urlRule.js');
import {buildGetPlan,isReadOnlySearchTarget} from './request-plan.js';
import {inspectPagination} from './pagination.js';
import {acceptsResponse,parseResponseDocument,evaluateJsonField} from './response-parser.js';
const {resolveHref,resolveRecognizedLink,describeLinkRule}=createRequire(import.meta.url)('../converter/lib/linkRule.js');
const {evaluateStaticScript,canInterpretStaticScript}=createRequire(import.meta.url)('../converter/lib/staticScript.js');
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { checkPublicDns, makeSafeFetch } from './net-safety.js';
import {redactUrl, splitXPathPipeline, nodeText, sanitizeEvidence} from './evidence-report.js';

const allowedFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/site-allowlist.json');
const builtInHosts = new Set(JSON.parse(fs.readFileSync(allowedFile,'utf8')));
const localAdditionalHosts = new Set((process.env.SITE_PROBE_ALLOWED_HOSTS||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean));
const permittedHosts = new Set([...builtInHosts,...localAdditionalHosts]);
const MAX_HTML_BYTES = 280_000;
const MAX_DOCUMENT_LENGTH = 280_000;
const MAX_KEYWORD_LENGTH = 50;
const USER_AGENT = 'BooksourceWorkbench-Checker/1.0 (+read-only-validation)';

function safeTarget(href, origin) {
  let url;
  try { url = new URL(String(href || '').trim(), origin); }
  catch { throw new Error('书源请求地址格式错误'); }
  if (url.username || url.password || url.hash || !['http:', 'https:'].includes(url.protocol)) throw new Error('书源请求地址包含不允许的协议或用户信息');
  if([...url.searchParams.keys()].some(k=>/token|api[_-]?key|secret|password|cookie|authorization|signature|session|credential|^(?:auth|auth[_-]?code|access[_-]?key|bearer|_t|csrf|csrf[_-]?token|sign|nonce)$/i.test(k)))throw new Error('书源请求地址含认证参数，未发送凭据');
  if (!permittedHosts.has(url.hostname.toLowerCase())) throw new Error('书源域名不在服务器验证白名单，请由维护者审核后添加');
  // A documented apex ↔ www canonical redirect is allowed, but no other
  // cross-site transition. Both hostnames must be on the local allowlist.
  const original=new URL(origin);
  const root=original.hostname.startsWith('www.')?original.hostname.slice(4):original.hostname;
  const canonHosts=new Set([root,'www.'+root]);
  if (url.origin !== origin && !((url.protocol===original.protocol || original.protocol==='http:' && url.protocol==='https:') && canonHosts.has(original.hostname) && canonHosts.has(url.hostname)))
    throw new Error('拒绝跨域跳转及跨站书籍地址（请单独审核后支持）');
  if ((url.port && !['80','443'].includes(url.port)) || url.href.length > 2200) throw new Error('端口或 URL 长度不允许');
  return url;
}

export function checkApprovedSource(sourceUrl) {
  let url;
  try { url = new URL(String(sourceUrl || '')); } catch { throw new Error('书源首页 URL 不是合法地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search || url.port) throw new Error('书源首页仅允许标准 HTTP(S) URL');
  if (!permittedHosts.has(url.hostname.toLowerCase())) throw new Error('该书源网站未加入服务器的安全检测域名白名单');
  return url;
}

function selectedLegado(payload) {
  let data=payload;
  if(Array.isArray(data)) data=data[0];
  if(!data || typeof data!=='object')return null;
  if(typeof data.bookSourceUrl==='string')return data;
  return Object.values(data).find(x=>x && typeof x==='object' && typeof x.bookSourceUrl==='string')||null;
}

function selectedXsgg(payload, selectedName) {
  if (!payload || typeof payload!=='object') return null;
  if (typeof payload.sourceUrl==='string') return payload;
  if(selectedName && payload[selectedName] && typeof payload[selectedName].sourceUrl==='string')return payload[selectedName];
  return Object.values(payload).find(x=>x && typeof x==='object' && typeof x.sourceUrl==='string')||null;
}

function searchRequest(legado, source, keyword) {
  if(source)return buildGetPlan({source,action:source.searchBook||{},origin:new URL(source.sourceUrl).origin,keyword,role:'searchBook'});
  const raw=legado?.searchUrl;
  if(typeof raw!=='string'||!raw.trim())return {reason:'缺少可静态识别的搜索地址'};
  const split=splitUrlOptions(raw),options=split.options||{};
  if(split.error)return {reason:split.error};
  if(options.method&&String(options.method).toUpperCase()!=='GET'||options.body||options.webView||options.js)return {reason:'Legado 请求包含 POST、请求体或动态执行配置，不将它静默当成 GET'};
  let template=split.url.trim();
  if(/@js:|<js>/.test(template))return {reason:'搜索地址使用自定义 JavaScript，静态 HTTP 检测不执行脚本'};
  template=template.replace(/\{\{key\}\}/gi,'%@keyWord').replace(/\{\{page\}\}/gi,'%@pageIndex');
  if(/\{\{/.test(template))return {reason:'搜索 URL 使用无法静态展开的模板变量'};
  return buildGetPlan({source:{httpHeaders:legado.header},action:{requestInfo:template,httpHeaders:options.headers,
    ...(options.charset?{requestParamsEncode:options.charset,responseEncode:options.charset}:{})},
    origin:new URL(legado.bookSourceUrl).origin,keyword});
}
function actionRequest(action,seed,origin,keyword,source){
  return buildGetPlan({source,action:action||{},seed,origin,keyword,role:null});
}
function equivalentResponseConfig(before,after){
  const headers=plan=>Object.entries(plan?.headers||{}).sort(([a],[b])=>a.localeCompare(b));
  return before?.responseEncoding===after?.responseEncoding&&JSON.stringify(headers(before))===JSON.stringify(headers(after));
}
function withinBudget(promise,signal){
  return new Promise((resolve,reject)=>{
    const abort=()=>{const error=new Error('连接超时');error.name='AbortError';reject(error);};
    if(signal.aborted){Promise.resolve(promise).catch(()=>{});abort();return;}
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}

function evaluateField(doc,context,rule,count=3,listMode=false){
  const raw=String(rule||'').trim();
  const config=doc.ruleConfig||{host:new URL(doc.URL).origin};
  const bindings=result=>({result,config,params:{responseUrl:doc.URL}});
  const wrapped=value=>({nodeValue:value==null?'':String(value),textContent:value==null?'':String(value),...(doc.isJsonDocument?{jsonValue:value}:{})});
  if(raw.startsWith('@js:')){
    if(!doc.isJsonDocument||listMode)return {nodes:[],values:[],total:0,reason:'只有 JSON 条目的标量字段可使用受限数据表达式'};
    const result=evaluateStaticScript(raw,bindings(context===doc?doc.jsonData:context?.jsonValue));
    if(!result.ok||result.value!==null&&!['string','number','boolean'].includes(typeof result.value))return {nodes:[],values:[],total:0,reason:result.reason||'字段表达式必须返回标量'};
    const node=wrapped(result.value);
    return {nodes:[node],values:[node.nodeValue],total:1,postprocessUnchecked:false,normalization:'bounded-data-expression'};
  }
  const known=describeLinkRule(rule),parsed=splitXPathPipeline(rule);
  const selected=evaluateXpath(doc,context,known?.selector||parsed.xpath,count,listMode);
  const values=selected.nodes.map(nodeText);
  if(known)return {...selected,values:values.map(value=>resolveRecognizedLink(value,doc.URL,known)),postprocessUnchecked:false,normalization:known.normalization};
  if(parsed.postprocess){
    const script=raw.slice(parsed.xpath.length).replace(/^\s*\|\|\s*/,'');
    const supported=script.startsWith('@js:')?canInterpretStaticScript(script):{ok:false,reason:'后处理不是受支持的 @js 数据表达式'};
    if(!supported.ok)return {...selected,values,postprocessUnchecked:true,postprocessReason:supported.reason};
    if(selected.reason)return {...selected,values,postprocessUnchecked:true};
    if((selected.total??selected.nodes.length)>1)return {...selected,values,postprocessUnchecked:true,postprocessReason:'后处理输入有多个匹配，不能猜测拼接或逐项执行的 App 语义'};
    if(!selected.nodes.length)return {...selected,values,postprocessUnchecked:false};
    const result=evaluateStaticScript(script,bindings(doc.isJsonDocument?selected.nodes[0].jsonValue:values[0]));
    if(!result.ok||result.value!==null&&!['string','number','boolean'].includes(typeof result.value))return {...selected,values,postprocessUnchecked:true,postprocessReason:result.reason||'后处理未返回标量'};
    const node=wrapped(result.value);
    return {nodes:[node],values:[node.nodeValue],total:1,postprocessUnchecked:false,normalization:'bounded-data-expression'};
  }
  return {...selected,values,postprocessUnchecked:false};
}
function singleUrlField(doc,context,rule){
  const field=evaluateField(doc,context,rule,2);
  if(field.reason||field.postprocessUnchecked||(field.total??field.nodes.length)!==1)return '';
  if(doc.isJsonDocument&&typeof field.nodes[0]?.jsonValue!=='string')return '';
  return field.values[0]||'';
}

function catalogSeed(doc,rule){
  const field=evaluateField(doc,doc,rule,2);
  if(doc.isJsonDocument&&field.nodes.some(n=>n.jsonValue!==null&&typeof n.jsonValue!=='string'))return {reason:'JSON 目录地址必须是字符串，不能猜测 ID 拼接',status:'unsupported'};
  if(field.postprocessUnchecked)return {reason:'目录地址使用未验证的 JS 后处理；静态检测不能将选择器原值替代脚本结果',status:'unsupported'};
  if(field.reason)return {reason:field.reason,status:'unsupported'};
  const total=field.total??field.nodes.length;
  if(total!==1||!field.values[0])return {reason:total>1?'目录地址规则匹配多个 URL，不能拼接或任意选取':'目录地址规则未取得有效链接',status:'no-results'};
  try{return {url:new URL(field.values[0],doc.URL).href};}
  catch{return {reason:'目录地址不是有效 URL',status:'unsupported'};}
}
function paginationNext(doc,rule){
  const field=evaluateField(doc,doc,rule,2);
  const matches=field.total??field.nodes.length;
  if(field.reason||field.postprocessUnchecked)return {matches,reason:field.reason||'下一页规则存在未执行的后处理'};
  if(matches>1)return {matches,reason:'下一页规则匹配多个地址，不能任意选择或拼接'};
  if(!matches)return {matches,url:''};
  if(doc.isJsonDocument&&field.nodes[0]?.jsonValue!==null&&typeof field.nodes[0]?.jsonValue!=='string')return {matches,reason:'JSON 下一页地址不是字符串，未猜测 URL'};
  if(!field.values[0]){
    if(nodeText(field.nodes[0]))return {matches,reason:'下一页含不支持的地址协议，未执行或忽略'};
    return {matches,url:''};
  }
  try{return {matches,url:new URL(field.values[0],doc.URL).href};}
  catch{return {matches,reason:'下一页规则未返回一个有效 URL'};}
}
function extractPaged(doc,source,module){
  const action=source[module];
  if(module==='chapterList'){
    const selected=evaluateXpath(doc,doc,action.list,1200,true),items=[];let reason=selected.reason;
    const fieldChecks=actualSourceFieldChecks(source,doc,module,selected.nodes);
    for(const node of selected.nodes){
      const title=evaluateField(doc,node,action.title,10),url=evaluateField(doc,node,action.url,2);
      if(title.reason||url.reason||url.postprocessUnchecked){reason='分页字段含无法等价执行的规则';break;}
      if((url.total??url.nodes.length)!==1||!url.values[0]||!title.values.some(Boolean)){reason='目录条目缺少标题或唯一 URL';break;}
      try{items.push({title:tiny(title.values.join(''),100),url:new URL(url.values[0],doc.URL).href});}
      catch{reason='目录条目地址不是有效 URL';break;}
    }
    return {status:items.length?'ok':'no-results',matches:selected.total??selected.nodes.length,items,fieldChecks,reason,
      truncated:(selected.total??0)>selected.nodes.length};
  }
  const fieldChecks=actualSourceFieldChecks(source,doc,module);
  const selected=evaluateField(doc,doc,action.content,2000);
  const content=selected.values.join('\n');
  const title=action.title?evaluateField(doc,doc,action.title,2):null;
  const heading=!action.title&&!doc.isJsonDocument?tiny(doc.querySelector('h1')?.textContent,180):'';
  return {status:content.trim()?'ok':'no-results',matches:selected.total??selected.nodes.length,content,fieldChecks,
    title:title&&!title.reason&&!title.postprocessUnchecked?title.values.join(''):heading,
    reason:selected.reason||selected.postprocessUnchecked?'正文存在无法等价执行的后处理':undefined,
    truncated:(selected.total??0)>selected.nodes.length};
}
function applyPagination(step,result){
  step.pagination=result.summary;
  const capabilities=step.requestCapabilities;
  if(capabilities){
    capabilities.unchecked=capabilities.unchecked.filter(x=>x.field!=='nextPageUrl'&&(!result.summary.complete||x.field!=='requestInfo.pageIndex'));
    if(!result.summary.complete)capabilities.unchecked.push({field:'nextPageUrl',status:'not-executed',reason:result.summary.reason||'分页未完成'});
  }
  if(result.items.length){step.count=result.items.length;step.examples=result.items.slice(0,3).map(x=>({title:x.title,url:redactUrl(x.url)}));}
  if(result.content){step.contentLength=result.content.trim().length;step.excerpt=tiny(result.content,32);}
}

function decodeKind(response) {
  const ct=(response.headers?.get?.('content-type') || '').toLowerCase();
  if (ct.includes('json')) return 'json';
  if (ct.includes('html') || ct.includes('text/plain') || !ct) return 'html';
  return 'unknown';
}
function tiny(s,max=180){return String(s??'').replace(/\s+/g,' ').trim().slice(0,max);}
function safeTextSnippet(doc) { return tiny(doc?.body?.textContent,700); }
function discoverSearchForm(doc, baseUrl, keyword) {
  if(!doc)return null;
  const likely=['q','keyword','searchkey','key','wd','query','s','querystring'];
  for(const form of Array.from(doc.querySelectorAll('form')).slice(0,10)){
    const method=(form.getAttribute('method')||'get').trim().toUpperCase();
    if(method!=='GET')continue; // POST requires separate authorization/CSRF work.
    const inputs=Array.from(form.querySelectorAll('input[name]')).filter(i=>!i.disabled);
    if(inputs.length>20)continue;
    const field=inputs.find(i=>likely.includes(i.getAttribute('name').toLowerCase())&&!['hidden','password','checkbox','radio','submit','button','file'].includes(i.type));
    if(!field)continue;
    try {
      const target=new URL(form.getAttribute('action')||baseUrl,baseUrl);
      if(!['http:','https:'].includes(target.protocol))continue;
      safeTarget(target.href,new URL(baseUrl).origin);
      if([...target.searchParams.keys()].some(k=>/token|secret|password|cookie|auth|session|signature|api[_-]?key/i.test(k)))continue;
      const hidden=inputs.filter(i=>i!==field&&(i.getAttribute('type')||'').toLowerCase()==='hidden');
      if(hidden.some(i=>/token|secret|password|cookie|auth|session|signature|api[_-]?key/i.test(i.name)||i.value.length>160||/%@|\{\{/.test(i.value)))continue;
      for(const input of hidden)target.searchParams.append(input.name,input.value);
      target.searchParams.set(field.getAttribute('name'),keyword);
      safeTarget(target.href,new URL(baseUrl).origin);
      const parameter=field.getAttribute('name');
      const query=[...target.searchParams].map(([key,value])=>encodeURIComponent(key)+'='+(key===parameter?'%@keyWord':encodeURIComponent(value))).join('&');
      return {url:target.href,requestTemplate:target.origin+target.pathname+'?'+query,
        method,parameter:field.getAttribute('name'),action:target.pathname,hiddenParameters:hidden.map(i=>i.name),
        source:'网页搜索框 form[action] input[name]'};
    }catch{continue;}
  }
  return null;
}
function actualSourceFieldChecks(source, doc, module, sampleNodes=[]){
  const fields={
    searchBook:['list','bookName','detailUrl','cover','author'],
    bookDetail:['bookName','title','author','desc','cover','chapterListUrl'],
    chapterList:['list','title','url'],
    chapterContent:['content']
  }[module]||[];
  const required={searchBook:['list','bookName','detailUrl'],chapterList:['list','title','url'],chapterContent:['content']}[module]||[];
  const rows=[];
  for(const field of fields){
    const value=source?.[module]?.[field];
    if(typeof value!=='string'||!value.trim()){
      if(required.includes(field))rows.push({field,rule:'',status:'missing',matches:0,note:'缺少读取链所需字段'});
      continue;
    }
    const entry={field,rule:value.slice(0,240),...(doc.isJsonDocument?{parser:'JSONPath'}:{})};
    const {xpath,postprocess}=splitXPathPipeline(value);
    const known=describeLinkRule(value);
    if(!doc.isJsonDocument&&!/^(\/|\(|\.\/)/.test(xpath)){
      rows.push({...entry,status:'not-checked',note:'动态脚本或 JSONPath，无法按 DOM XPath 验证'});continue;
    }
    const contexts=field==='list'||!sampleNodes.length?[doc]:sampleNodes.slice(0,3);
    const checks=contexts.map((context,index)=>{
      const evaluated=evaluateField(doc,context,value,3,field==='list');
      const row={index,matches:evaluated.total??evaluated.nodes.length,
        samples:evaluated.values.map(value=>tiny(value,field==='content'?32:80))};
      if(['detailUrl','url','cover','chapterListUrl'].includes(field))
        row.resolvedUrls=evaluated.values.map(value=>redactUrl(value,doc.URL)).slice(0,3);
      if(doc.isJsonDocument&&['detailUrl','url','cover','chapterListUrl'].includes(field)&&evaluated.nodes.some(n=>typeof n.jsonValue!=='string'))row.error='JSON URL 字段必须是字符串，不能猜测 ID 拼接';
      if(evaluated.reason)row.error=evaluated.reason;
      row.postprocessUnchecked=!!evaluated.postprocessUnchecked;
      if(evaluated.postprocessReason)row.postprocessReason=evaluated.postprocessReason;
      if(evaluated.normalization)row.normalization=evaluated.normalization;
      return row;
    });
    entry.matches=checks[0].matches;
    entry.contexts=checks;
    entry.samples=checks[0].samples;
    entry.context=contexts[0]===doc?'document':'list-node';
    if(known)entry.normalization=known.normalization;
    if(checks.some(x=>x.error)){entry.status='invalid';entry.note=checks.find(x=>x.error).error;}
    else if(checks.every(x=>x.matches===0)){entry.status='no-results';entry.note='真实页面中未匹配节点';}
    else if(field!=='list'&&checks.every(x=>!x.samples.some(Boolean))){entry.status='no-results';entry.note='匹配节点但提取值为空';}
    else if(checks.some(x=>x.matches===0||field!=='list'&&!x.samples.some(Boolean))){entry.status='partial-match';entry.note='部分列表条目未匹配字段或提取值为空，需核对规则与空值';}
    else if(['detailUrl','url','chapterListUrl'].includes(field)&&checks.some(x=>x.matches>1)){entry.status='multiple-values';entry.note='URL 为单值字段，多个匹配不能证明地址传递正确';}
    else if(checks.some(x=>x.postprocessUnchecked)){entry.status='partially-checked';entry.note=checks.find(x=>x.postprocessReason)?.postprocessReason||'部分后处理超出受限表达式范围，未执行';}
    else entry.status='ok';
    rows.push(entry);
  }
  return rows;
}
function recordSearchAttempt(result, reason){
  return {url:result.url?redactUrl(result.url):null,requestMethod:result.requestMethod||'GET',httpStatus:result.httpStatus||null,status:result.status,bytes:result.bytes||0,elapsedMs:result.elapsedMs||0,reason:result.reason||reason||'',redirects:result.redirects||[]};
}
function makeSummary(evidence){
  const flags=[];
  for(const step of evidence.steps||[]){
    if(!['ok','skipped'].includes(step.status))flags.push(step.step+': '+step.status+(step.reason?' '+step.reason:''));
  }
  for(const item of evidence.diagnostics||[])flags.push(item);
  return flags.length?flags.join('；').slice(0,1400):'服务器 HTTP 搜索、详情、目录和正文检查通过；仍需要目标 App 校验 JS/WebView。';
}
function inferSearchCards(doc) {
  const candidates=[
    {css:'.item',xpath:"//*[contains(concat(' ',normalize-space(@class),' '),' item ')]"},
    {css:'div.col-md-6 > dl',xpath:"//div[contains(concat(' ',normalize-space(@class),' '),' col-md-6 ')]/dl[.//*[self::h3 or self::h4]/a]"},
    {css:'.bookbox',xpath:"//*[contains(concat(' ',normalize-space(@class),' '),' bookbox ')]"},
    {css:'.result-item',xpath:"//*[contains(concat(' ',normalize-space(@class),' '),' result-item ')]"}
  ];
  for(const c of candidates){
    const nodes=Array.from(doc.querySelectorAll(c.css)).filter(n=>n.querySelector('h3 a[href],h4 a[href]'));
    if(nodes.length) return {nodes,xpath:c.xpath,bookName:'//*[self::h3 or self::h4]/a/text()',detailUrl:'//*[self::h3 or self::h4]/a/@href',count:nodes.length};
  }
  return null;
}
function inferTocNodes(doc){
  for(const row of [
    {css:'.book_list.book_list2 ul li a',xpath:"//div[contains(@class,'book_list2')]//li/a"},
    {css:'#list ul li a',xpath:"//*[@id='list']//ul//li/a"},
    {css:'.book_list ul li a',xpath:"//div[contains(@class,'book_list')]//li/a"}
  ]){
    const nodes=Array.from(doc.querySelectorAll(row.css)).filter(n=>n.getAttribute('href')?.startsWith('/'));
    if(nodes.length)return {...row,nodes};
  }
  return null;
}
function inferChapterContent(doc){
  for(const row of [
    {css:'article[class^="font_"]',xpath:"//article[starts-with(@class,'font_')]"},
    {css:'.con',xpath:"//*[contains(concat(' ',normalize-space(@class),' '),' con ')]"},
    {css:'#content',xpath:"//*[@id='content']"}
  ]){
    const n=doc.querySelector(row.css);
    if(n?.textContent && tiny(n.textContent,900).length>30)return {...row,node:n};
  }
  return null;
}
function htmlStructure(doc) {
  const main=doc.querySelector('#main,#list,.search-list,.book-list,.result-list,main') || doc.body;
  if(!main)return '';
  const cloned=main.cloneNode(true);
  cloned.querySelectorAll('script,style,iframe,form,input,textarea,button,object').forEach(n=>n.remove());
  cloned.querySelectorAll('*').forEach(n=>{
    for(const attribute of Array.from(n.attributes)) {
      if(!['id','class','href','src','itemprop'].includes(attribute.name))n.removeAttribute(attribute.name);
      else if(['href','src'].includes(attribute.name) && !/^\/?[\w./:#?=&%-]+$/.test(attribute.value))n.removeAttribute(attribute.name);
    }
  });
  return tiny(cloned.outerHTML,1800);
}
function evaluateXpath(doc, context, expr, count=50, listMode=false) {
  if(typeof expr!=='string'||!expr.trim() || expr.trim().startsWith('@js:'))return {nodes:[],reason:'包含 JS，静态验证不执行'};
  const parsed=splitXPathPipeline(expr),pipeline=parsed.postprocess;
  expr=parsed.xpath;
  if(doc.isJsonDocument){
    const selected=evaluateJsonField(doc,context||doc,expr,count,listMode);
    return {...selected,...(pipeline&&!selected.reason?{reason:'仅检查 JSONPath，后处理未执行'}:{})};
  }
  try {
    if(context && context!==doc && expr.startsWith("//")) expr="."+expr;
    const snap=doc.evaluate(expr,context||doc,null,doc.defaultView.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null);
    const nodes=[];
    for(let i=0;i<Math.min(snap.snapshotLength,count);i++)nodes.push(snap.snapshotItem(i));
    return {nodes, total:snap.snapshotLength, ...(pipeline?{reason:'仅检查选择器，JS 后处理未执行'}:{})};
  } catch(error) {return {nodes:[],reason:'XPath 无法解析：'+tiny(error.message,150)};}
}
function legadoSelect(context,rule,max=50) {
  if(typeof rule!=='string'||!rule.trim())return [];
  const raw=rule.split('##')[0].split('<js>')[0];
  const segments=raw.split('@').map(x=>x.trim()).filter(Boolean);
  let nodes=[context];
  for(const segment of segments){
    if(['text','textNodes','ownText','html','href','src','content'].includes(segment))break;
    let kind,tag,index,excluded=[];
    let m=segment.match(/^(?:id\.|#)([\w-]+)$/);
    if(m){kind='id';tag=m[1];}
    else if((m=segment.match(/^(?:class\.|\.)([\w-]+)$/))){kind='class';tag=m[1];}
    else if((m=segment.match(/^(?:tag\.)?([a-zA-Z][\w-]*)(?:\.(-?\d+))?(?:!(\d+(?::\d+)*))?$/))){kind='tag';tag=m[1];index=m[2]===undefined?null:Number(m[2]);if(m[3])excluded=m[3].split(':').map(Number);}
    else return [];
    const next=[];
    for(const n of nodes){
      if(!n.querySelectorAll)continue;
      let matched=[];
      if(kind==='id')matched=Array.from(n.querySelectorAll('[id]')).filter(e=>e.id===tag);
      else if(kind==='class')matched=Array.from(n.querySelectorAll('[class]')).filter(e=>e.classList.contains(tag));
      else matched=Array.from(n.querySelectorAll(tag));
      if(index!==undefined && index!==null){const idx=index>=0?index:matched.length+index;matched=matched[idx]?[matched[idx]]:[];}
      if(excluded.length)matched=matched.filter((_,i)=>!excluded.includes(i));
      for(const node of matched){next.push(node);if(next.length>=max)break;}
      if(next.length>=max)break;
    }
    nodes=next;
    if(!nodes.length)break;
  }
  return nodes;
}
function fieldValue(doc,node,rule) {
  if(!rule)return '';
  const parts=String(rule).split('##')[0].split('@');
  const last=parts.at(-1);
  const isAttr=['href','src','content'].includes(last);
  let target=node;
  const selector=parts.slice(0, isAttr||['text','textNodes','html'].includes(last)?-1:undefined).join('@');
  if(selector){const found=legadoSelect(node,selector,1);target=found[0];}
  if(!target)return '';
  if(isAttr)return target.getAttribute?.(last)||'';
  return tiny(target.textContent,250);
}

async function downloadSite(url, origin, { fetcher, dnsChecker=checkPublicDns, timeoutMs=7800, maxBytes=MAX_HTML_BYTES, plan }={}) {
  if(plan?.reason)return {url,requestMethod:plan.method||'GET',status:'unsupported',reason:plan.reason};
  let method=plan?.method||'GET',requestBody=plan?.body;
  let safe=safeTarget(url,origin);
  const ctl=new AbortController();
  const started=Date.now();
  const timer=setTimeout(()=>ctl.abort(),timeoutMs);
  const redirects=[];
  const initialUrl=safe.href;
  let responseInfo={};
  try {
    let response,responseElapsedMs=0;
    for(let i=0;i<3;i++){
      const hopStarted=Date.now();
      await withinBudget(dnsChecker(safe),ctl.signal);
      response=await withinBudget((fetcher || makeSafeFetch(safe.origin,{allowHttp:true,allowRedirectResponse:true}))(safe.href,{
        method,body:method==='POST'?requestBody:undefined,signal:ctl.signal,redirect:'manual',
        headers:{'User-Agent':USER_AGENT,Accept:'text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.4',...plan?.headers,...(method==='POST'?{'Content-Type':'application/x-www-form-urlencoded'}:{})}
      }),ctl.signal);
      responseElapsedMs=Date.now()-hopStarted;
      if(response.status>=300 && response.status<400){
        const location=response.headers?.get?.('location');
        let next,reason,redirectLoop=false;
        try{
          if(!location)throw new Error('重定向缺少 Location');
          next=safeTarget(new URL(location,safe.href).href,origin);
          if(method==='POST'&&[307,308].includes(response.status)&&(next.origin!==safe.origin||!isReadOnlySearchTarget(next)))throw Error('POST 重定向未保持同源只读搜索入口，不转发表单');
          if(plan?.rejectVisitedUrls?.has(next.href)){redirectLoop=true;throw Error('分页重定向到已经验证的页面');}
        }catch(error){reason='不安全重定向：'+tiny(error.message);}
        let target;
        try{target=location?new URL(location,safe.href):null;}catch{}
        redirects.push({from:safe.origin,to:target?.origin||null,url:redactUrl(safe.href),
          location:target?redactUrl(target.href):null,status:response.status,requestMethod:method,elapsedMs:responseElapsedMs,
          ...(reason?{reason}:{})});
        await withinBudget(response.body?.cancel(),ctl.signal);
        if(reason||i>=2)return {url:safe.href,originalUrl:initialUrl,requestMethod:method,redirects,
          elapsedMs:Date.now()-started,status:redirectLoop?'loop':'redirect',httpStatus:response.status,
          reason:reason||'重定向次数超出限制'};
        if(method==='POST'&&[301,302,303].includes(response.status)){method='GET';requestBody=undefined;}
        safe=next;continue;
      }
      break;
    }
    const result=responseInfo={responseElapsedMs,url:safe.href,originalUrl:initialUrl,requestMethod:method,redirects,elapsedMs:Date.now()-started,httpStatus:response.status,kind:decodeKind(response),contentType:tiny(response.headers?.get?.('content-type'),160),requestCapabilities:plan?.requestCapabilities};
    if(response.status<200||response.status>=300){await withinBudget(response.body?.cancel(),ctl.signal);return {...result,status:response.status===403?'blocked':'http-error',reason:'网站响应 HTTP '+response.status};}
    const reportedSize=Number(response.headers?.get?.('content-length') || 0);
    if(reportedSize>maxBytes){await withinBudget(response.body?.cancel(),ctl.signal);return {...result,status:'unsupported',reason:'响应内容超出安全检测的 HTML 大小限制'};}
    const chunks=[];let size=0;
    if(response.body && typeof response.body.getReader==='function'){
      const reader=response.body.getReader();
      try {while(true){const next=await withinBudget(reader.read(),ctl.signal);if(next.done)break;size+=next.value.byteLength;if(size>maxBytes){await withinBudget(reader.cancel(),ctl.signal);return {...result,status:'unsupported',reason:'响应内容过大，超过 '+maxBytes+' 字节'};}chunks.push(next.value);}}finally{try{reader.releaseLock();}catch{}}
    } else if(response.text){const bytes=new TextEncoder().encode(await withinBudget(response.text(),ctl.signal));size=bytes.length;if(size>maxBytes)return {...result,status:'unsupported',reason:'响应过大'};chunks.push(bytes);}
    const bytes=Buffer.concat(chunks.map(x=>Buffer.from(x)));
    const headerCharset=String(response.headers?.get?.('content-type')||'').match(/charset\s*=\s*["']?([\w-]+)/i)?.[1];
    const metas=bytes.subarray(0,4096).toString('latin1').match(/<meta\b[^>]*>/gi)||[];
    const metaCharset=metas.map(x=>x.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1]).find(Boolean);
    const requestedCharset=plan?.responseEncoding||headerCharset||metaCharset||'utf-8';
    let decoder;
    try{decoder=new TextDecoder(requestedCharset,{fatal:false});}
    catch{return {...result,status:'unsupported',bytes:size,charset:requestedCharset,reason:'当前解码器不支持响应字符编码 '+tiny(requestedCharset,40)};}
    const body=decoder.decode(bytes);
    return {...result,status:'ok',elapsedMs:Date.now()-started,charset:decoder.encoding,
      charsetSource:plan?.responseEncoding?'source-config':headerCharset?'content-type':metaCharset?'html-meta':'default',
      bytes:size,bodyTruncated:body.length>MAX_DOCUMENT_LENGTH,body:body.slice(0,MAX_DOCUMENT_LENGTH)};
  }catch(error){
    const msg=String(error?.message||'');
    return {...responseInfo,url:safe.href,originalUrl:initialUrl,requestMethod:method,redirects,elapsedMs:Date.now()-started,status:ctl.signal.aborted||/timeout|timed out|UND_ERR_CONNECT_TIMEOUT/i.test(msg)?'timeout':'network-error',reason:ctl.signal.aborted?'连接超过 '+timeoutMs+'ms':tiny(msg,180)};
  }finally{clearTimeout(timer);}
}

function reportStep(type,result) {
  const {body,...publicResult}=result;
  if(publicResult.url)publicResult.url=redactUrl(publicResult.url);
  if(publicResult.originalUrl)publicResult.originalUrl=redactUrl(publicResult.originalUrl);
  return {step:type,...publicResult};
}
function skipStep(step,reason){return {step,status:'skipped',reason};}

async function inspectSourceWebRaw(input,{fetcher,dnsChecker=checkPublicDns,timeoutMs=7800}={}) {
  const source=selectedXsgg(input?.source,input?.sourceName);
  const legado=selectedLegado(input?.legado)||selectedLegado(input?.source);
  if(!source && !legado)throw new Error('请先提供 Legado 或 XSGG 书源');
  const url=checkApprovedSource(source?.sourceUrl||legado.bookSourceUrl);
  if(source && legado && new URL(legado.bookSourceUrl).origin!==url.origin)throw new Error('原始 Legado 与转换后的 XSGG 域名不一致');
  const origin=url.origin;
  const deadline=Date.now()+Math.min(35000,timeoutMs*10);
  let requestCount=0;
  const requestPage=async (target,site,options)=>{
    const remaining=deadline-Date.now();
    if(remaining<=0||requestCount>=10)return {url:target,status:'timeout',reason:'整条读取链达到时间或请求次数预算'};
    requestCount++;
    return downloadSite(target,site,{...options,timeoutMs:Math.min(options.timeoutMs||timeoutMs,remaining)});
  };
  const followPages=(response,document,plan,action,module)=>inspectPagination({
    firstResponse:response,firstDocument:document,firstPlan:plan,action,kind:module==='chapterList'?'list':'content',
    parse:r=>parseResponseDocument(r,action),
    extract:d=>extractPaged(d,source,module),next:d=>paginationNext(d,action.nextPageUrl),
    validateUrl:(target,base)=>safeTarget(target,origin).href,
    download:(target,nextPlan,budget)=>requestPage(target,origin,{fetcher,dnsChecker,timeoutMs:budget,plan:nextPlan}),
    timeoutMs
  });

  const keyword=tiny(input?.keyword || '斗破苍穹',MAX_KEYWORD_LENGTH);
  if(!keyword)throw new Error('搜索关键词不能为空');
  const steps=[];
  const configuredSearch=searchRequest(legado,source,keyword);
  const search=configuredSearch.url||!legado ? configuredSearch : searchRequest(legado,null,keyword);
  const homepagePlan=buildGetPlan({source:source||{httpHeaders:legado?.header},action:{requestInfo:url.href},origin,keyword});
  const homepagePromise=requestPage(url.href,origin,{fetcher,dnsChecker,timeoutMs,plan:homepagePlan});
  const searchPromise=search.url
    ?requestPage(search.url,origin,{fetcher,dnsChecker,timeoutMs,plan:search}).catch(error=>({status:'unsupported',reason:tiny(error.message)}))
    :Promise.resolve({status:'unsupported',reason:search.reason});
  const [home,firstSearch]=await Promise.all([homepagePromise,searchPromise]);
  let searchResult=firstSearch;
  const discoveredForm=home.status==='ok'&&home.kind==='html'
    ?discoverSearchForm(new JSDOM(home.body,{url:home.url}).window.document,home.url,keyword):null;
  const searchAttempts=[recordSearchAttempt(firstSearch)];
  const diagnostics=[];
  // Actual HTML form fields are stronger evidence than legacy guessed URLs.
  // Only retry when the configured route fails or does not exist.
  if((!acceptsResponse(searchResult,source?.searchBook))&&discoveredForm&&discoveredForm.url!==searchResult.url){
    const discoveredPlan=buildGetPlan({source:source||{},action:{...(source?.searchBook||{}),requestInfo:discoveredForm.url},origin,keyword});
    const attempted=await requestPage(discoveredForm.url,origin,{fetcher,dnsChecker,timeoutMs,plan:discoveredPlan}).catch(e=>({status:'unsupported',reason:tiny(e.message)}));
    searchAttempts.push(recordSearchAttempt(attempted,'网页表单自动发现'));
    if(attempted.status==='ok'&&attempted.kind==='html'){
      searchResult=attempted;
      diagnostics.push('原搜索 URL 失败；已从首页表单自动发现并验证新接口：'+discoveredForm.action+'?'+discoveredForm.parameter+'=关键词');
    }
  }
  steps.push(reportStep('homepage',home));
  const searchStep=reportStep('search',searchResult);
  searchStep.searchAttempts=searchAttempts;
  searchStep.recoveredRequest=searchAttempts.length>1&&searchResult.status==='ok';
  if(configuredSearch.staticRequest)searchStep.staticRequest=configuredSearch.staticRequest;
  if(discoveredForm)searchStep.discoveredSearch=discoveredForm;
  if(source){
    const emptyDoc=new JSDOM('<!doctype html><html><body></body></html>').window.document;
    for(const [module,fields] of Object.entries({searchBook:['list','bookName','detailUrl'],bookDetail:['title','desc'],chapterList:['list','title','url'],chapterContent:['content']})){
      for(const field of fields){
        const exp=source[module]?.[field];
        if(typeof exp!=='string'||!exp.trim()||exp.includes('@js:')||exp.includes('||'))continue;
        if(/\/\@[A-Za-z][\w-]*!-?\d+/.test(exp)){
          diagnostics.push(module+'.'+field+'：检测到非法 XPath 属性形式（例如 @li!0），原本应是标签选择器及排除索引');
          continue;
        }
        if(!exp.startsWith('/')&&!exp.startsWith('('))continue;
        const r=evaluateXpath(emptyDoc,emptyDoc,exp,1);
        if(r.reason)diagnostics.push(module+'.'+field+'：'+r.reason);
      }
    }
  }
  if(home.status==='ok'&&home.kind==='html'){
    const doc=new JSDOM(home.body,{url:home.url}).window.document;
    steps[0].title=tiny(doc.title,120);
  }
  if(searchResult.status!=='ok'){
    steps.push(searchStep);
    for(const step of ['detail','chapterList','chapterContent'])steps.push(skipStep(step,'搜索网页未取得，不能推断后续步骤有效'));
    if(searchResult.status==='timeout'||home.status==='timeout')diagnostics.push('真实 HTTP 访问超时：属于站点或网络可达性问题，不能靠修改 XPath 证明书源已经修复');
    return {sourceName:source?.sourceName||legado?.bookSourceName||input?.sourceName||'书源',site:origin,keyword,verifiedAt:new Date().toISOString(),steps,diagnostics,fullyVerified:false,depth:'live-static-dom'};
  }
  if(!acceptsResponse(searchResult,source?.searchBook)){
    steps.push({...searchStep,status:'unsupported',reason:'搜索响应与配置的解析格式不匹配'});
    for(const step of ['detail','chapterList','chapterContent'])steps.push(skipStep(step,'搜索响应格式未验证'));
    return {sourceName:source?.sourceName||legado?.bookSourceName||'书源',site:origin,keyword,verifiedAt:new Date().toISOString(),steps,diagnostics,fullyVerified:false,depth:'live-static-dom'};
  }
  let doc;
  try{doc=parseResponseDocument(searchResult,source?.searchBook);}
  catch(error){
    steps.push({...searchStep,status:'unsupported',reason:error.message});
    for(const step of ['detail','chapterList','chapterContent'])steps.push(skipStep(step,'搜索响应未解析，不能推断后续步骤'));
    return {sourceName:source?.sourceName||legado?.bookSourceName||'书源',site:origin,keyword,steps,diagnostics,fullyVerified:false,depth:'live-static-dom'};
  }
  searchStep.parserFormat=doc.isJsonDocument?'json':'html';
  searchStep.htmlPreview=htmlStructure(doc);
  searchStep.textPreview=safeTextSnippet(doc);
  let found=!source && legado?.ruleSearch?.bookList
    ?{nodes:legadoSelect(doc,legado.ruleSearch.bookList,30)}
    :evaluateXpath(doc,doc,source?.searchBook?.list,30,true);
  const configuredMatches=found.total??found.nodes?.length??0;
  if(!configuredMatches){
    const inferred=inferSearchCards(doc);
    if(inferred){
      found={nodes:inferred.nodes.slice(0,30),total:inferred.count};
      searchStep.autoDiscovered={list:inferred.xpath,bookName:inferred.bookName,detailUrl:inferred.detailUrl,detectedCount:inferred.count};
      diagnostics.push('原书源搜索列表规则匹配 0 条；自动识别 '+inferred.count+' 条网页书籍记录（仍须修复 XSGG list/bookName/detailUrl）');
    }
  }
  searchStep.configuredMatches=configuredMatches;
  searchStep.count=found.total??found.nodes?.length??0;
  searchStep.sampledCount=found.nodes?.length||0;
  if(found.reason)diagnostics.push('搜索选择器：'+found.reason);
  if(source?.searchBook){
    searchStep.fieldChecks=actualSourceFieldChecks(source,doc,'searchBook',found.nodes||[]);
  }
  if(source?.searchBook?.list){
    const check=evaluateXpath(doc,doc,source.searchBook.list,30,true);
    searchStep.xsggXPathMatches=check.total??check.nodes.length;
    if(check.reason)diagnostics.push('转换后搜索 XPath：'+check.reason);
  }
  const examples=[];
  let bookUrl='';
  for(const n of found.nodes||[]){
    const inferredSearch=searchStep.autoDiscovered;
    const title=!source && legado?fieldValue(doc,n,legado.ruleSearch?.name)
      :inferredSearch?tiny(n.querySelector('h3 a,h4 a')?.textContent,100)
      :tiny(evaluateXpath(doc,n,source?.searchBook?.bookName,2).nodes?.[0]?.textContent||n.textContent,100);
    const candidate=!source && legado?fieldValue(doc,n,legado.ruleSearch?.bookUrl)
      :inferredSearch?n.querySelector('h3 a,h4 a')?.getAttribute('href')
      :singleUrlField(doc,n,source?.searchBook?.detailUrl);
    if(title)examples.push({title:tiny(title,100),detailUrl:tiny(candidate,240)});
    if(!bookUrl && candidate)bookUrl=candidate;
    if(examples.length>=3)break;
  }
  searchStep.examples=examples;
  if(!searchStep.count||!bookUrl){
    searchStep.status='no-results';
    searchStep.reason=!searchStep.count?'网页返回成功，但搜索列表规则未匹配任何书籍':'找到列表但没有有效详情链接';
    steps.push(searchStep);
    for(const step of ['detail','chapterList','chapterContent'])steps.push(skipStep(step,'搜索结果提取失败，后续不可验证'));
    return {sourceName:source?.sourceName||legado?.bookSourceName||'书源',site:origin,keyword,verifiedAt:new Date().toISOString(),steps,diagnostics,fullyVerified:false,depth:'live-static-dom'};
  }
  steps.push(searchStep);
  let detailUrl;
  let selectedBookUrl,detailRequest;
  try{selectedBookUrl=new URL(bookUrl,searchResult.url).href;
    detailRequest=source?actionRequest(source.bookDetail,selectedBookUrl,origin,keyword,source):{url:selectedBookUrl};
    if(!detailRequest.url)throw Error(detailRequest.reason);detailUrl=safeTarget(detailRequest.url,origin).href;}
  catch(err){steps.push({step:'detail',status:'unsupported',reason:tiny(err.message)});steps.push(skipStep('chapterList','详情地址不被允许'));steps.push(skipStep('chapterContent','详情地址不被允许'));return {sourceName:source?.sourceName||'书源',site:origin,keyword,verifiedAt:new Date().toISOString(),steps,diagnostics,fullyVerified:false,depth:'live-static-dom'};}
  const detail=await requestPage(detailUrl,origin,{fetcher,dnsChecker,timeoutMs,plan:detailRequest});
  const detailStep={...reportStep('detail',detail),requestInfoMissing:!!detailRequest.requestInfoMissing,
    handoff:{from:detailRequest.usedResult===false?'bookDetail.requestInfo':'searchBook.detailUrl',value:redactUrl(detailRequest.usedResult===false?detailRequest.url:selectedBookUrl)}};
  if(!acceptsResponse(detail,source?.bookDetail)){
    if(detail.status==='ok'){detailStep.status='unsupported';detailStep.reason='详情响应与配置的解析格式不匹配：'+detail.kind;}
    steps.push(detailStep);
    steps.push(skipStep('chapterList','详情页面请求失败'));steps.push(skipStep('chapterContent','详情页面请求失败'));
    return {sourceName:source?.sourceName||legado?.bookSourceName||'书源',site:origin,keyword,verifiedAt:new Date().toISOString(),steps,diagnostics,fullyVerified:false,depth:'live-static-dom'};
  }
  let detailDoc;
  try{detailDoc=parseResponseDocument(detail,source?.bookDetail);}
  catch(error){
    steps.push({...detailStep,status:'unsupported',reason:error.message});
    steps.push(skipStep('chapterList','详情响应未解析'));steps.push(skipStep('chapterContent','详情响应未解析'));
    return {sourceName:source?.sourceName||'书源',site:origin,keyword,steps,diagnostics,fullyVerified:false,depth:'live-static-dom'};
  }
  detailStep.parserFormat=detailDoc.isJsonDocument?'json':'html';
  detailStep.title=tiny(detailDoc.isJsonDocument?evaluateField(detailDoc,detailDoc,source?.bookDetail?.bookName||source?.bookDetail?.title,1).values?.[0]:detailDoc.querySelector('h1')?.textContent||detailDoc.title,130);
  detailStep.htmlPreview=htmlStructure(detailDoc);
  if(source?.bookDetail)detailStep.fieldChecks=actualSourceFieldChecks(source,detailDoc,'bookDetail');
  steps.push(detailStep);
  const declaredCatalog=source?.bookDetail?.chapterListUrl;
  const seed=declaredCatalog?catalogSeed(detailDoc,declaredCatalog):{url:detail.url};
  const tocRequest=source?actionRequest(source.chapterList,seed.url,origin,keyword,source):{url:seed.url};
  if(!tocRequest.url){
    steps.push({step:'chapterList',status:seed.status||'unsupported',reason:seed.reason||tocRequest.reason});
    steps.push(skipStep('chapterContent','目录地址未验证，不推断后续正文'));
    return {sourceName:source?.sourceName||legado?.bookSourceName||'书源',site:origin,keyword,verifiedAt:new Date().toISOString(),steps,diagnostics,fullyVerified:false,depth:'live-static-dom'};
  }
  let toc;
  try{
    const target=safeTarget(tocRequest.url,origin).href;
    toc=target===detail.url&&equivalentResponseConfig(detailRequest,tocRequest)?detail:await requestPage(target,origin,{fetcher,dnsChecker,timeoutMs,plan:tocRequest});
  }catch(error){toc={status:'unsupported',reason:tiny(error.message)};}
  const tocRequestStep={...reportStep('chapterList',toc),requestInfoMissing:!!tocRequest.requestInfoMissing,requestCapabilities:tocRequest.requestCapabilities,
    reusedResponse:toc===detail,handoff:{from:tocRequest.usedResult===false?'chapterList.requestInfo':declaredCatalog?'bookDetail.chapterListUrl':'bookDetail.responseUrl',
      ...(tocRequest.usedResult===false?{value:redactUrl(tocRequest.url)}:seed.url?{value:redactUrl(seed.url)}:{})}};
  if(!acceptsResponse(toc,source?.chapterList)){
    if(toc.status==='ok'){tocRequestStep.status='unsupported';tocRequestStep.reason='目录响应与配置的解析格式不匹配：'+toc.kind;}
    steps.push(tocRequestStep);
    steps.push(skipStep('chapterContent','目录页面未取得可解析 HTML，正文不可验证'));
    return {sourceName:source?.sourceName||legado?.bookSourceName||'书源',site:origin,keyword,verifiedAt:new Date().toISOString(),steps,diagnostics,fullyVerified:false,depth:'live-static-dom'};
  }
  let tocDoc;
  try{tocDoc=toc===detail&&(source?.chapterList?.responseFormatType||'html')===(source?.bookDetail?.responseFormatType||'html')?detailDoc:parseResponseDocument(toc,source?.chapterList);}
  catch(error){
    steps.push({...tocRequestStep,status:'unsupported',reason:error.message});steps.push(skipStep('chapterContent','目录响应未解析'));
    return {sourceName:source?.sourceName||'书源',site:origin,keyword,steps,diagnostics,fullyVerified:false,depth:'live-static-dom'};
  }
  tocRequestStep.parserFormat=tocDoc.isJsonDocument?'json':'html';
  let tocFound=!source && legado?.ruleToc?.chapterList
    ?{nodes:legadoSelect(tocDoc,legado.ruleToc.chapterList,80)}
    :evaluateXpath(tocDoc,tocDoc,source?.chapterList?.list,80,true);
  let inferredToc;
  const configuredTocMatches=tocFound.total??tocFound.nodes?.length??0;
  if(!configuredTocMatches){
    inferredToc=inferTocNodes(tocDoc);
    if(inferredToc){
      tocFound={nodes:inferredToc.nodes.slice(0,80),total:inferredToc.nodes.length};
      diagnostics.push('原书源目录规则匹配 0 条；从真实目录网页找到 '+inferredToc.nodes.length+' 个章节链接，建议更新 chapterList.list');
    }
  }
  let chapterUrl='';const chapters=[];
  for(const n of tocFound.nodes||[]){
    const title=!source && legado?fieldValue(tocDoc,n,legado.ruleToc?.chapterName):inferredToc?tiny(n.textContent,100):tiny(nodeText(evaluateXpath(tocDoc,n,source?.chapterList?.title,2).nodes?.[0]),100);
    const candidate=!source && legado?fieldValue(tocDoc,n,legado.ruleToc?.chapterUrl):inferredToc?n.getAttribute?.('href')||'':singleUrlField(tocDoc,n,source?.chapterList?.url);
    if(title)chapters.push({title:tiny(title,100),url:tiny(candidate,240)});
    if(!chapterUrl&&candidate)chapterUrl=candidate;
    if(chapters.length>=3)break;
  }
  const tocStep={...tocRequestStep,status:tocFound.nodes?.length?'ok':'no-results',count:tocFound.total??tocFound.nodes?.length??0,sampledCount:tocFound.nodes?.length||0,configuredMatches:configuredTocMatches,examples:chapters};
  if(inferredToc)tocStep.autoDiscovered={list:inferredToc.xpath,title:'//text()',url:'//@href',detectedCount:inferredToc.nodes.length};
  if(source?.chapterList)tocStep.fieldChecks=actualSourceFieldChecks(source,tocDoc,'chapterList',tocFound.nodes||[]);
  if(tocFound.reason)tocStep.reason=tocFound.reason;
  if(!tocFound.nodes?.length)tocStep.reason=tocStep.reason||'目录规则未能在实际目录页匹配章节；可能需要不同规则或 WebView';
  if(source?.chapterList?.nextPageUrl){
    const paging=await followPages(toc,tocDoc,tocRequest,source.chapterList,'chapterList');
    applyPagination(tocStep,paging);
    if(paging.items.length)chapterUrl=paging.items[0].url;
  }
  steps.push(tocStep);
  if(!chapterUrl){steps.push(skipStep('chapterContent','没有可用于验证的章节链接'));return {sourceName:source?.sourceName||legado?.bookSourceName||'书源',site:origin,keyword,verifiedAt:new Date().toISOString(),steps,diagnostics,fullyVerified:false,depth:'live-static-dom'};}
  let chapterAddress;
  let selectedChapterUrl,contentRequest;
  try{selectedChapterUrl=new URL(chapterUrl,toc.url).href;
    contentRequest=source?actionRequest(source.chapterContent,selectedChapterUrl,origin,keyword,source):{url:selectedChapterUrl};
    if(!contentRequest.url)throw Error(contentRequest.reason);chapterAddress=safeTarget(contentRequest.url,origin).href;}
  catch(err){steps.push({step:'chapterContent',status:'unsupported',reason:tiny(err.message)});return {sourceName:source?.sourceName||'书源',site:origin,keyword,verifiedAt:new Date().toISOString(),steps,diagnostics,fullyVerified:false,depth:'live-static-dom'};}
  const chapter=await requestPage(chapterAddress,origin,{fetcher,dnsChecker,timeoutMs,plan:contentRequest});
  const chapterStep={...reportStep('chapterContent',chapter),requestInfoMissing:!!contentRequest.requestInfoMissing,
    handoff:{from:contentRequest.usedResult===false?'chapterContent.requestInfo':'chapterList.url',value:redactUrl(contentRequest.usedResult===false?contentRequest.url:selectedChapterUrl)}};
  if(acceptsResponse(chapter,source?.chapterContent)){
    try{
    const chapterDoc=parseResponseDocument(chapter,source?.chapterContent);
    chapterStep.parserFormat=chapterDoc.isJsonDocument?'json':'html';
    let section=!source && legado?.ruleContent?.content
      ?{nodes:legadoSelect(chapterDoc,legado.ruleContent.content,2)}
      :evaluateField(chapterDoc,chapterDoc,source?.chapterContent?.content,2000);
    chapterStep.configuredMatches=section.total??section.nodes?.length??0;
    if(!chapterStep.configuredMatches){
      const inferred=inferChapterContent(chapterDoc);
      if(inferred){
        section={nodes:[inferred.node]};
        chapterStep.autoDiscovered={content:inferred.xpath};
        diagnostics.push('原书源正文规则匹配 0 条；从真实章节页面找到正文 DOM 容器 '+inferred.css);
      }
    }
    if(source?.chapterContent)chapterStep.fieldChecks=actualSourceFieldChecks(source,chapterDoc,'chapterContent');
    const content=(section.values||(section.nodes||[]).map(nodeText)).join('\n');
    const text=tiny(content,800);
    chapterStep.contentLength=content.trim().length;
    chapterStep.extractionTruncated=(section.total??0)>(section.nodes?.length||0);
    chapterStep.excerpt=tiny(text,32);
    chapterStep.status=text.length>=30?'ok':'no-results';
    if(section.reason)chapterStep.reason=section.reason;
    else if(text.length<30)chapterStep.reason='正文未匹配到足够内容，可能是 JavaScript 动态渲染或规则失效';
    }catch(error){chapterStep.status='unsupported';chapterStep.reason=error.message;}
  }
  if(chapter.status==='ok'&&!acceptsResponse(chapter,source?.chapterContent)){chapterStep.status='unsupported';chapterStep.reason='正文响应与配置的解析格式不匹配：'+chapter.kind;}
  if(source?.chapterContent?.nextPageUrl&&chapterStep.status!=='unsupported'&&acceptsResponse(chapter,source?.chapterContent)){
    const paging=await followPages(chapter,parseResponseDocument(chapter,source?.chapterContent),contentRequest,source.chapterContent,'chapterContent');
    applyPagination(chapterStep,paging);
    if(paging.content)chapterStep.status=tiny(paging.content,800).length>=30?'ok':'no-results';
  }
  steps.push(chapterStep);
  const httpChainVerified=steps.filter(x=>x.step!=='homepage').every(x=>x.status==='ok');
  const staticRulesMatch=steps.filter(x=>['search','chapterList','chapterContent'].includes(x.step))
    .every(x=>(x.configuredMatches??x.count??0)>0);
  const fieldRulesMatch=steps.every(x=>(x.fieldChecks||[]).every(f=>f.status==='ok'));
  const unsupportedRequests=source && steps.filter(x=>x.step!=='homepage').some(x=>x.requestInfoMissing||x.requestCapabilities?.unchecked?.length);
  for(const step of steps){
    for(const item of step.requestCapabilities?.unchecked||[])diagnostics.push(step.step+'.'+item.field+'：'+item.reason);
    for(const field of step.fieldChecks||[])if(field.status!=='ok')diagnostics.push(step.step+'.'+field.field+'：'+(field.note||field.status));
    if(step.pagination?.complete&&step.pagination.fullyChecked===false)diagnostics.push(step.step+'：翻页已到末页，但分页字段仍有未验证能力');
  }
  const fullyVerified=httpChainVerified&&staticRulesMatch&&fieldRulesMatch&&!unsupportedRequests&&!legado&&!searchStep.recoveredRequest&&!steps.some(x=>x.bodyTruncated||x.extractionTruncated||x.pagination?.complete&&x.pagination.fullyChecked===false);
  if(unsupportedRequests)diagnostics.push('部分请求能力或分页未执行，见逐项诊断；当前 HTTP 链不能证明完整配置可用');
  if(searchStep.recoveredRequest)diagnostics.push('搜索请求使用网页表单替代了失败的配置；原配置未通过，须用修复候选独立复测');
  if(legado)diagnostics.push('附带原始 Legado 的检测用于发现问题；修复通过必须使用纯 XSGG 配置独立验证');
  if(httpChainVerified&&!staticRulesMatch)diagnostics.push('已从真实网页自动识别完整阅读链，但原 XSGG 规则不能直接匹配全部步骤；生成候选后必须再次验证');
  return {sourceName:source?.sourceName||legado?.bookSourceName||'书源',site:origin,keyword,verifiedAt:new Date().toISOString(),steps,diagnostics,fullyVerified,httpChainVerified,depth:'live-static-dom'};
}

export async function inspectSourceWeb(input,options={}) {
  const report=await inspectSourceWebRaw(input,options);
  return sanitizeEvidence(report,{source:input?.source,legado:input?.legado});
}
