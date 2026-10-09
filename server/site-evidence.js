/**
 * Online source inspector for the public one-container workbench.
 * It makes real HTTP(S) requests, parses static DOM, and reports precisely
 * where a reading flow fails. It does NOT execute scraped site JS, Legado
 * JavaScript, model generated programs, WebView, browser challenges or logins.
 * Only explicitly approved public domains can be requested, with DNS rebinding
 * protection, no redirect following, strict time/byte/step budgets.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { checkPublicDns, makeSafeFetch } from './net-safety.js';

const allowedFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/site-allowlist.json');
const builtInHosts = new Set(JSON.parse(fs.readFileSync(allowedFile,'utf8')));
const localAdditionalHosts = new Set((process.env.SITE_PROBE_ALLOWED_HOSTS||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean));
const permittedHosts = new Set([...builtInHosts,...localAdditionalHosts]);
const MAX_HTML_BYTES = 280_000;
const MAX_DOCUMENT_LENGTH = 280_000;
const MAX_KEYWORD_LENGTH = 50;
const MAX_STEPS = 4;
const USER_AGENT = 'BooksourceWorkbench-Checker/1.0 (+read-only-validation)';

function safeTarget(href, origin) {
  let url;
  try { url = new URL(String(href || '').trim(), origin); }
  catch { throw new Error('书源请求地址格式错误'); }
  if (url.username || url.password || url.hash || !['http:', 'https:'].includes(url.protocol)) throw new Error('书源请求地址包含不允许的协议或用户信息');
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
  const raw=source ? null : legado?.searchUrl;
  if (typeof raw==='string' && raw.trim()) {
    // The optional ", {charset:...}" Legado request configuration is data,
    // never JS code; we only extract the plain URL portion.
    const template=raw.split(/,\s*\{/)[0].trim();
    if(template.startsWith('@js:') || template.includes('<js>') || template.includes('{{') && !/\{\{(?:key|page)\}\}/.test(template))return {reason:'搜索地址使用自定义 JavaScript，静态 HTTP 检测不执行脚本'};
    const substituted=template.replace(/\{\{key\}\}/gi,encodeURIComponent(keyword)).replace(/\{\{page\}\}/gi,'1');
    if(/\{\{/.test(substituted))return {reason:'搜索 URL 使用无法静态展开的模板变量'};
    return {url:substituted};
  }
  const requestInfo=source?.searchBook?.requestInfo;
  if(typeof requestInfo==='string' && /^\/?(?:https?:\/\/|[^@\s]*\/)/.test(requestInfo.trim()) && !requestInfo.includes('@js:')) {
    const req=requestInfo.trim().replace(/%@keyWord/g,encodeURIComponent(keyword)).replace(/%@pageIndex/g,'1');
    if(!req.includes('%@'))return {url:req};
  }
  return {reason:'此书源搜索 URL 需要执行 App 侧动态 JS（安全起见不在服务器执行）'};
}

function decodeKind(response) {
  const ct=(response.headers?.get?.('content-type') || '').toLowerCase();
  if (ct.includes('json')) return 'json';
  if (ct.includes('html') || ct.includes('text/plain') || !ct) return 'html';
  return 'unknown';
}
function redactUrl(raw){try{const u=new URL(raw);for(const k of [...u.searchParams.keys()])if(/token|api[_-]?key|secret|password|cookie|auth|signature|session/i.test(k))u.searchParams.set(k,"[redacted]");return u.href;}catch{return "[invalid URL]";}}
function tiny(s,max=180){return String(s??'').replace(/\s+/g,' ').trim().slice(0,max);}
function safeTextSnippet(doc) { return tiny(doc?.body?.textContent,700); }
function discoverSearchForm(doc, baseUrl, keyword) {
  if(!doc)return null;
  const likely=['q','keyword','searchkey','key','wd','query','s','querystring'];
  for(const form of Array.from(doc.querySelectorAll('form')).slice(0,10)){
    const method=(form.getAttribute('method')||'get').trim().toUpperCase();
    if(method!=='GET')continue; // POST requires separate authorization/CSRF work.
    const inputs=Array.from(form.querySelectorAll('input[name]'));
    const field=inputs.find(i=>likely.includes(i.getAttribute('name').toLowerCase()));
    if(!field)continue;
    try {
      const target=new URL(form.getAttribute('action')||baseUrl,baseUrl);
      if(!['http:','https:'].includes(target.protocol))continue;
      safeTarget(target.href,new URL(baseUrl).origin);
      target.searchParams.set(field.getAttribute('name'),keyword);
      const checked=target.href;
      return {url:checked,method,parameter:field.getAttribute('name'),action:target.pathname,source:'网页搜索框 form[action] input[name]'};
    }catch{continue;}
  }
  return null;
}
function nonEmptyXpath(doc,context,expr){
  const evaluated=evaluateXpath(doc,context,expr,100);
  return {rule:expr,matches:evaluated.total??evaluated.nodes?.length??0,reason:evaluated.reason||null};
}
function actualSourceFieldChecks(source, doc, module, sampleNode){
  const fields={
    searchBook:['list','bookName','detailUrl','cover','author'],
    bookDetail:['bookName','title','author','desc','cover'],
    chapterList:['list','title','url'],
    chapterContent:['content']
  }[module]||[];
  const rows=[];
  for(const field of fields){
    const value=source?.[module]?.[field];
    if(typeof value!=='string'||!value.trim())continue;
    const entry={field,rule:value.slice(0,240)};
    if(sampleNode && field!=='list' && value.trim().startsWith('//')){
      entry.note='按香色列表子字段上下文模拟 //；官方 App 仍需实测';
    }
    if(value.includes('||') || value.includes('@js:')){
      entry.status='partially-checked';
      entry.note='只检查静态选择器，JS 后处理需在 App 中验证';
    }
    const first=value.split('||')[0].trim();
    if(!first.startsWith('/')&&!first.startsWith('(')&&!first.startsWith('.//')&&!first.startsWith('./')){
      entry.status='not-checked';entry.note='动态脚本或 JSONPath，无法按 DOM XPath 验证';
    }else{
      const check=nonEmptyXpath(doc,field==='list'?doc:(sampleNode||doc),first);
      entry.matches=check.matches;
      if(check.reason){entry.status='invalid';entry.note=check.reason;}
      else if(check.matches===0){entry.status='no-results';entry.note='真实页面中未匹配节点';}
      else if(!entry.status)entry.status='ok';
    }
    rows.push(entry);
  }
  return rows;
}
function recordSearchAttempt(result, reason){
  return {url:result.url||null,httpStatus:result.httpStatus||null,status:result.status,bytes:result.bytes||0,elapsedMs:result.elapsedMs||0,reason:result.reason||reason||'',redirects:result.redirects||[]};
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
    {css:'div.col-md-6 > dl',xpath:"//div[contains(concat(' ',normalize-space(@class),' '),' col-md-6 ')]/dl[.//h3/a]"},
    {css:'.bookbox',xpath:"//*[contains(concat(' ',normalize-space(@class),' '),' bookbox ')]"},
    {css:'.result-item',xpath:"//*[contains(concat(' ',normalize-space(@class),' '),' result-item ')]"}
  ];
  for(const c of candidates){
    const nodes=Array.from(doc.querySelectorAll(c.css)).filter(n=>n.querySelector('h3 a[href],h4 a[href]'));
    if(nodes.length) return {nodes,xpath:c.xpath,bookName:'.//h3/a/text()',detailUrl:'.//h3/a/@href',count:nodes.length};
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
function evaluateXpath(doc, context, expr, count=50) {
  if(typeof expr!=='string'||!expr.trim() || expr.trim().startsWith('@js:'))return {nodes:[],reason:'包含 JS，静态验证不执行'};
  const pipeline=expr.includes('||@js:');
  if(pipeline)expr=expr.split('||@js:')[0].trim();
  try {
    if(context && context!==doc) expr=expr.replace(/(^|[|(]\s*)\/\//g,"$1.//");
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

async function downloadSite(url, origin, { fetcher, dnsChecker=checkPublicDns, timeoutMs=7800, maxBytes=MAX_HTML_BYTES }={}) {
  let safe=safeTarget(url,origin);
  const ctl=new AbortController();
  const started=Date.now();
  const timer=setTimeout(()=>ctl.abort(),timeoutMs);
  const redirects=[];
  try {
    let response;
    for(let i=0;i<3;i++){
      await dnsChecker(safe);
      response=await (fetcher || makeSafeFetch(safe.origin,{allowHttp:true,allowRedirectResponse:true}))(safe.href,{
        method:'GET',signal:ctl.signal,redirect:'manual',
        headers:{'User-Agent':USER_AGENT,Accept:'text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.4'}
      });
      if(response.status>=300 && response.status<400){
        const location=response.headers?.get?.('location');
        if(!location || i>=2){await response.body?.cancel();return {url:safe.href,redirects,status:'redirect',httpStatus:response.status,reason:'重定向次数超出限制或缺少 Location'};}
        let next;
        try{next=safeTarget(new URL(location,safe.href).href,origin);}
        catch(error){await response.body?.cancel();return {url:safe.href,redirects,status:'redirect',httpStatus:response.status,reason:'不安全重定向：'+tiny(error.message)};}
        redirects.push({from:safe.origin,to:next.origin,url:redactUrl(safe.href),location:redactUrl(next.href),status:response.status,elapsedMs:Date.now()-started});
        await response.body?.cancel();
        safe=next;
        continue;
      }
      break;
    }
    const result={url:safe.href,redirects,elapsedMs:Date.now()-started,httpStatus:response.status,kind:decodeKind(response)};
    if(response.status<200||response.status>=300){await response.body?.cancel();return {...result,status:response.status===403?'blocked':'http-error',reason:'网站响应 HTTP '+response.status};}
    const reportedSize=Number(response.headers?.get?.('content-length') || 0);
    if(reportedSize>maxBytes){await response.body?.cancel();return {...result,status:'unsupported',reason:'响应内容超出安全检测的 HTML 大小限制'};}
    const chunks=[];let size=0;
    if(response.body && typeof response.body.getReader==='function'){
      const reader=response.body.getReader();
      try {while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>maxBytes){await reader.cancel();return {...result,status:'unsupported',reason:'响应内容过大，超过 '+maxBytes+' 字节'};}chunks.push(next.value);}}finally{try{reader.releaseLock();}catch{}}
    } else if(response.text){const bytes=new TextEncoder().encode(await response.text());size=bytes.length;if(size>maxBytes)return {...result,status:'unsupported',reason:'响应过大'};chunks.push(bytes);}
    const charset=String(response.headers?.get?.('content-type')||'').match(/charset\s*=\s*["']?([\w-]+)/i)?.[1]||'utf-8';
    const body=new TextDecoder(charset,{fatal:false}).decode(Buffer.concat(chunks.map(x=>Buffer.from(x))));
    return {...result,status:'ok',elapsedMs:Date.now()-started,charset,bytes:size,body:body.slice(0,MAX_DOCUMENT_LENGTH)};
  }catch(error){
    const msg=String(error?.message||'');
    return {url:safe.href,elapsedMs:Date.now()-started,status:ctl.signal.aborted||/timeout|timed out|UND_ERR_CONNECT_TIMEOUT/i.test(msg)?'timeout':'network-error',reason:ctl.signal.aborted?'连接超过 '+timeoutMs+'ms':tiny(msg,180)};
  }finally{clearTimeout(timer);}
}

function reportStep(type,result) {
  const {body,...publicResult}=result;
  if(publicResult.url)publicResult.url=redactUrl(publicResult.url);
  return {step:type,...publicResult};
}
function skipStep(step,reason){return {step,status:'skipped',reason};}

export async function inspectSourceWeb(input,{fetcher,dnsChecker=checkPublicDns,timeoutMs=7800}={}) {
  const source=selectedXsgg(input?.source,input?.sourceName);
  const legado=selectedLegado(input?.legado)||selectedLegado(input?.source);
  if(!source && !legado)throw new Error('请先提供 Legado 或 XSGG 书源');
  const url=checkApprovedSource(source?.sourceUrl||legado.bookSourceUrl);
  if(source && legado && new URL(legado.bookSourceUrl).origin!==url.origin)throw new Error('原始 Legado 与转换后的 XSGG 域名不一致');
  const origin=url.origin;
  const keyword=tiny(input?.keyword || '斗破苍穹',MAX_KEYWORD_LENGTH);
  if(!keyword)throw new Error('搜索关键词不能为空');
  const steps=[];
  const configuredSearch=searchRequest(legado,source,keyword);
  const search=configuredSearch.url ? configuredSearch : searchRequest(legado,null,keyword);
  const homepagePromise=downloadSite(url.href,origin,{fetcher,dnsChecker,timeoutMs});
  const searchPromise=search.url
    ?downloadSite(search.url,origin,{fetcher,dnsChecker,timeoutMs}).catch(error=>({status:'unsupported',reason:tiny(error.message)}))
    :Promise.resolve({status:'unsupported',reason:search.reason});
  const [home,firstSearch]=await Promise.all([homepagePromise,searchPromise]);
  let searchResult=firstSearch;
  const discoveredForm=home.status==='ok'&&home.kind==='html'
    ?discoverSearchForm(new JSDOM(home.body,{url:home.url}).window.document,home.url,keyword):null;
  const searchAttempts=[recordSearchAttempt(firstSearch)];
  const diagnostics=[];
  // Actual HTML form fields are stronger evidence than legacy guessed URLs.
  // Only retry when the configured route fails or does not exist.
  if((searchResult.status!=='ok'||searchResult.kind!=='html')&&discoveredForm&&discoveredForm.url!==searchResult.url){
    const attempted=await downloadSite(discoveredForm.url,origin,{fetcher,dnsChecker,timeoutMs}).catch(e=>({status:'unsupported',reason:tiny(e.message)}));
    searchAttempts.push(recordSearchAttempt(attempted,'网页表单自动发现'));
    if(attempted.status==='ok'&&attempted.kind==='html'){
      searchResult=attempted;
      diagnostics.push('原搜索 URL 失败；已从首页表单自动发现并验证新接口：'+discoveredForm.action+'?'+discoveredForm.parameter+'=关键词');
    }
  }
  steps.push(reportStep('homepage',home));
  const searchStep=reportStep('search',searchResult);
  searchStep.searchAttempts=searchAttempts;
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
  if(searchResult.kind!=='html'){
    steps.push({...searchStep,status:'unsupported',reason:'搜索返回的不是 HTML，当前不解析动态 API 内容'});
    for(const step of ['detail','chapterList','chapterContent'])steps.push(skipStep(step,'搜索规则为非 HTML，需专用解析器'));
    return {sourceName:source?.sourceName||legado?.bookSourceName||'书源',site:origin,keyword,verifiedAt:new Date().toISOString(),steps,diagnostics,fullyVerified:false,depth:'live-static-dom'};
  }
  const doc=new JSDOM(searchResult.body,{url:searchResult.url}).window.document;
  searchStep.htmlPreview=htmlStructure(doc);
  searchStep.textPreview=safeTextSnippet(doc);
  let found=!source && legado?.ruleSearch?.bookList
    ?{nodes:legadoSelect(doc,legado.ruleSearch.bookList,30)}
    :evaluateXpath(doc,doc,source?.searchBook?.list,30);
  const configuredMatches=found.nodes?.length||0;
  if(!configuredMatches){
    const inferred=inferSearchCards(doc);
    if(inferred){
      found={nodes:inferred.nodes.slice(0,30),total:inferred.count};
      searchStep.autoDiscovered={list:inferred.xpath,bookName:inferred.bookName,detailUrl:inferred.detailUrl,detectedCount:inferred.count};
      diagnostics.push('原书源搜索列表规则匹配 0 条；自动识别 '+inferred.count+' 条网页书籍记录（仍须修复 XSGG list/bookName/detailUrl）');
    }
  }
  searchStep.configuredMatches=configuredMatches;
  searchStep.count=found.nodes?.length||0;
  if(found.reason)diagnostics.push('搜索选择器：'+found.reason);
  if(source?.searchBook){
    searchStep.fieldChecks=actualSourceFieldChecks(source,doc,'searchBook',(found.nodes||[])[0]);
  }
  if(source?.searchBook?.list){
    const check=evaluateXpath(doc,doc,source.searchBook.list,30);
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
      :evaluateXpath(doc,n,source?.searchBook?.detailUrl,2).nodes?.[0]?.nodeValue;
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
  try{detailUrl=safeTarget(new URL(bookUrl,searchResult.url).href,origin).href;}
  catch(err){steps.push({step:'detail',status:'unsupported',reason:tiny(err.message)});steps.push(skipStep('chapterList','详情地址不被允许'));steps.push(skipStep('chapterContent','详情地址不被允许'));return {sourceName:source?.sourceName||'书源',site:origin,keyword,verifiedAt:new Date().toISOString(),steps,diagnostics,fullyVerified:false,depth:'live-static-dom'};}
  const detail=await downloadSite(detailUrl,origin,{fetcher,dnsChecker,timeoutMs});
  const detailStep=reportStep('detail',detail);
  if(detail.status!=='ok'||detail.kind!=='html'){
    steps.push(detailStep);
    steps.push(skipStep('chapterList','详情页面请求失败'));steps.push(skipStep('chapterContent','详情页面请求失败'));
    return {sourceName:source?.sourceName||legado?.bookSourceName||'书源',site:origin,keyword,verifiedAt:new Date().toISOString(),steps,diagnostics,fullyVerified:false,depth:'live-static-dom'};
  }
  const detailDoc=new JSDOM(detail.body,{url:detail.url}).window.document;
  detailStep.title=tiny(detailDoc.querySelector('h1')?.textContent||detailDoc.title,130);
  detailStep.htmlPreview=htmlStructure(detailDoc);
  if(source?.bookDetail)detailStep.fieldChecks=actualSourceFieldChecks(source,detailDoc,'bookDetail');
  steps.push(detailStep);
  // For these static Legado formats, TOC usually lives on the detail page.
  // Dynamic toc URLs (requestInfo=@js:) are deliberately not executed.
  let tocFound=!source && legado?.ruleToc?.chapterList
    ?{nodes:legadoSelect(detailDoc,legado.ruleToc.chapterList,80)}
    :evaluateXpath(detailDoc,detailDoc,source?.chapterList?.list,80);
  let inferredToc;
  const configuredTocMatches=tocFound.nodes?.length||0;
  if(!configuredTocMatches){
    inferredToc=inferTocNodes(detailDoc);
    if(inferredToc){
      tocFound={nodes:inferredToc.nodes.slice(0,80),total:inferredToc.nodes.length};
      diagnostics.push('原书源目录规则匹配 0 条；从真实详情网页找到 '+inferredToc.nodes.length+' 个章节链接，建议更新 chapterList.list');
    }
  }
  let chapterUrl='';const chapters=[];
  for(const n of tocFound.nodes||[]){
    const title=!source && legado?fieldValue(detailDoc,n,legado.ruleToc?.chapterName):tiny(n.textContent,100);
    const candidate=!source && legado?fieldValue(detailDoc,n,legado.ruleToc?.chapterUrl):inferredToc?n.getAttribute?.('href')||'':evaluateXpath(detailDoc,n,source?.chapterList?.url,2).nodes?.[0]?.nodeValue||'';
    if(title)chapters.push({title:tiny(title,100),url:tiny(candidate,240)});
    if(!chapterUrl&&candidate)chapterUrl=candidate;
    if(chapters.length>=3)break;
  }
  const tocStep={step:'chapterList',status:tocFound.nodes?.length?'ok':'no-results',url:detail.url,count:tocFound.nodes?.length||0,configuredMatches:configuredTocMatches,examples:chapters};
  if(inferredToc)tocStep.autoDiscovered={list:inferredToc.xpath,title:'./text()',url:'./@href',detectedCount:inferredToc.nodes.length};
  if(source?.chapterList)tocStep.fieldChecks=actualSourceFieldChecks(source,detailDoc,'chapterList',(tocFound.nodes||[])[0]);
  if(tocFound.reason)tocStep.reason=tocFound.reason;
  if(!tocFound.nodes?.length)tocStep.reason=tocStep.reason||'目录规则未能在详情页匹配章节；可能需要独立目录地址或 WebView';
  steps.push(tocStep);
  if(!chapterUrl){steps.push(skipStep('chapterContent','没有可用于验证的章节链接'));return {sourceName:source?.sourceName||legado?.bookSourceName||'书源',site:origin,keyword,verifiedAt:new Date().toISOString(),steps,diagnostics,fullyVerified:false,depth:'live-static-dom'};}
  let chapterAddress;
  try{chapterAddress=safeTarget(new URL(chapterUrl,detail.url).href,origin).href;}
  catch(err){steps.push({step:'chapterContent',status:'unsupported',reason:tiny(err.message)});return {sourceName:source?.sourceName||'书源',site:origin,keyword,verifiedAt:new Date().toISOString(),steps,diagnostics,fullyVerified:false,depth:'live-static-dom'};}
  const chapter=await downloadSite(chapterAddress,origin,{fetcher,dnsChecker,timeoutMs});
  const chapterStep=reportStep('chapterContent',chapter);
  if(chapter.status==='ok'&&chapter.kind==='html'){
    const chapterDoc=new JSDOM(chapter.body,{url:chapter.url}).window.document;
    let section=!source && legado?.ruleContent?.content
      ?{nodes:legadoSelect(chapterDoc,legado.ruleContent.content,2)}
      :evaluateXpath(chapterDoc,chapterDoc,source?.chapterContent?.content,2);
    chapterStep.configuredMatches=section.nodes?.length||0;
    if(!chapterStep.configuredMatches){
      const inferred=inferChapterContent(chapterDoc);
      if(inferred){
        section={nodes:[inferred.node]};
        chapterStep.autoDiscovered={content:inferred.xpath};
        diagnostics.push('原书源正文规则匹配 0 条；从真实章节页面找到正文 DOM 容器 '+inferred.css);
      }
    }
    if(source?.chapterContent)chapterStep.fieldChecks=actualSourceFieldChecks(source,chapterDoc,'chapterContent');
    const text=tiny(section.nodes?.[0]?.textContent||'',800);
    chapterStep.contentLength=String(section.nodes?.[0]?.textContent||'').trim().length;
    chapterStep.excerpt=tiny(text,32);
    chapterStep.status=text.length>=30?'ok':'no-results';
    if(section.reason)chapterStep.reason=section.reason;
    else if(text.length<30)chapterStep.reason='正文未匹配到足够内容，可能是 JavaScript 动态渲染或规则失效';
  }
  steps.push(chapterStep);
  const httpChainVerified=steps.filter(x=>x.step!=='homepage').every(x=>x.status==='ok');
  const staticRulesMatch=steps.filter(x=>['search','chapterList','chapterContent'].includes(x.step))
    .every(x=>(x.configuredMatches??x.count??0)>0);
  const fieldRulesMatch=steps.every(x=>(x.fieldChecks||[]).every(f=>f.status==='ok'));
  const unsupportedRequests=source && ['bookDetail','chapterList','chapterContent'].some(k=>source[k]?.requestInfo!=='%@result');
  const fullyVerified=httpChainVerified&&staticRulesMatch&&fieldRulesMatch&&!unsupportedRequests&&!legado;
  if(unsupportedRequests)diagnostics.push('独立目录/详情/正文 requestInfo 尚未执行，当前 HTTP 链不能证明配置可用');
  if(legado)diagnostics.push('附带原始 Legado 的检测用于发现问题；修复通过必须使用纯 XSGG 配置独立验证');
  if(httpChainVerified&&!staticRulesMatch)diagnostics.push('已从真实网页自动识别完整阅读链，但原 XSGG 规则不能直接匹配全部步骤；生成候选后必须再次验证');
  return {sourceName:source?.sourceName||legado?.bookSourceName||'书源',site:origin,keyword,verifiedAt:new Date().toISOString(),steps,diagnostics,fullyVerified,httpChainVerified,depth:'live-static-dom'};
}
