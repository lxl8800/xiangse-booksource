/**
 * Read-only, SSRF-safe canonical domain probe.
 * This is a server-assisted part of baseline conversion, not AI repair.
 * No arbitrary JS, API keys, cookies or request headers from source records.
 */
import net from 'node:net';
import {createRequire} from 'node:module';
const {describeStaticGetRequest}=createRequire(import.meta.url)('../converter/lib/urlRule.js');
import { checkPublicDns, makeSafeFetch } from './net-safety.js';
import {redactUrl,redactText} from './evidence-report.js';

const MAX_HOPS=3;
const LIMIT_BYTES=8192;
const BLOCKED_HOST=/(\.localhost|\.local|\.internal|\.home\.arpa|\.onion)$/i;
const REDIRECTS=new Set([301,302,303,307,308]);
const PERMANENT=new Set([301,308]);

function checkedUrl(raw){
  let u;
  try{u=new URL(String(raw||'').trim());}catch{throw new Error('书源 URL 格式不正确');}
  if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.hash||
     u.port && !['80','443'].includes(u.port) || u.href.length>2000 ||
     BLOCKED_HOST.test(u.hostname) || u.hostname==='localhost'){
    throw new Error('禁止非 HTTP(S)、带凭据、内网域名、非标准端口或过长 URL');
  }
  if(net.isIP(u.hostname.replace(/^\[|\]$/g,'')))throw new Error('只检测书源域名，不允许任意 IP 地址');
  return u;
}
function publicUrl(raw){return redactUrl(raw);}
function short(s,max=160){return redactText(s||'').replace(/\s+/g,' ').slice(0,max);}
const PRIVATE_QUERY=/token|api[_-]?key|secret|password|cookie|authorization|signature|session|credential|^(?:auth|auth[_-]?code|access[_-]?key|bearer)$/i;
function hasPrivateQuery(url){return [...url.searchParams.keys()].some(key=>PRIVATE_QUERY.test(key));}
function isWwwVariant(oldHost,newHost){
  const strip=s=>s.startsWith('www.')?s.slice(4):s;
  return strip(oldHost)===strip(newHost);
}
function staticSearch(original, template, keyword='斗破苍穹',skipped){
  if(skipped)return {requested:true,reason:skipped==='sensitive-search'
    ?'搜索地址含认证信息，域名检查不发送凭据':'搜索请求无法静态识别为 GET，未执行其脚本或请求配置'};
  if(typeof template!=='string'||!template.trim())return {requested:false};
  const descriptor=describeStaticGetRequest(template);
  if(!descriptor||Object.keys(descriptor.httpHeaders||{}).length||/,\s*\{/.test(descriptor.url))return {requested:true,reason:'搜索请求无法静态识别为普通 GET，不执行脚本或额外请求配置'};
  let raw=descriptor.url.trim();
  if(raw.length>2000)return {requested:true,reason:'搜索地址超出长度限制'};
  raw=raw.replace(/\{\{key\}\}|%@keyWord/gi,()=>encodeURIComponent(String(keyword).slice(0,50)))
    .replace(/\{\{page\}\}|%@pageIndex/gi,'1');
  if(/\{\{|%@|#/.test(raw))return {requested:true,reason:'搜索地址包含无法静态展开的占位符'};
  let url;
  try{url=checkedUrl(new URL(raw,original.href).href);}catch{return {requested:true,reason:'搜索 URL 不符合安全检测范围'};}
  if(hasPrivateQuery(url))return {requested:true,reason:'搜索地址含认证信息，域名检查不发送凭据'};
  if(url.origin!==original.origin)return {requested:true,reason:'配置使用独立搜索域名，不能用首页迁移证明该接口已迁移'};
  if(url.pathname===original.pathname&&url.search===original.search)return {requested:false};
  return {requested:true,url};
}
function withinBudget(promise,signal){
  return new Promise((resolve,reject)=>{
    const abort=()=>{const error=new Error('连接超时');error.name='AbortError';reject(error);};
    if(signal.aborted){Promise.resolve(promise).catch(()=>{});abort();return;}
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
async function textHead(response,signal,limit=LIMIT_BYTES){
  if(!response.body)return '';
  const reader=response.body.getReader(),chunks=[];
  let total=0;
  try{
    while(total<limit){
      const item=await withinBudget(reader.read(),signal);
      if(item.done)break;
      const chunk=item.value.subarray(0,limit-total);
      total+=chunk.byteLength;chunks.push(Buffer.from(chunk));
    }
  }finally{
    try{void reader.cancel().catch(()=>{});}catch{}
    try{reader.releaseLock();}catch{}
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function fetchWithRedirects(raw,{fetcher,dnsChecker=checkPublicDns,timeoutMs=4700}={}){
  let current=checkedUrl(raw);
  const timerControl=new AbortController();
  const timer=setTimeout(()=>timerControl.abort(),timeoutMs);
  const redirects=[],seen=new Set();
  const started=Date.now();
  let responseInfo={};
  const finish=(extra)=>({...responseInfo,originalUrl:publicUrl(raw),url:publicUrl(current.href),
    finalDomain:current.hostname,requestMethod:'GET',elapsedMs:Date.now()-started,redirects,...extra});
  try{
    for(let hop=0;hop<=MAX_HOPS;hop++){
      responseInfo={};seen.add(current.href);
      await withinBudget(dnsChecker(current),timerControl.signal);
      const requestStarted=Date.now();
      const response=await withinBudget((fetcher||makeSafeFetch(current.origin,{allowHttp:true,allowRedirectResponse:true}))(current.href,{
        method:'GET',redirect:'manual',signal:timerControl.signal,
        headers:{'User-Agent':'Mozilla/5.0 (compatible; BooksourceWorkbench/1.8)','Accept':'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1'}
      }),timerControl.signal);
      const status=response.status;
      const contentType=String(response.headers.get('content-type')||'').toLowerCase();
      responseInfo={httpStatus:status,contentType:short(contentType,160),
        responseElapsedMs:Date.now()-requestStarted,
        kind:contentType.includes('json')?'json':contentType.includes('html')?'html':'unknown'};
      if(REDIRECTS.has(status)){
        const location=response.headers.get('location');
        let next,reason='';
        if(!location)reason='重定向缺少 Location';
        else try{
          next=checkedUrl(new URL(location,current).href);
          if(hasPrivateQuery(next))reason='重定向包含认证参数，未转发凭据';
        }catch(error){reason=short(error.message);}
        let observed;
        try{observed=location?new URL(location,current):null;}catch{}
        if(!reason&&hop===MAX_HOPS)reason='重定向跳数超出限制';
        if(!reason&&seen.has(next.href))reason='检测到重定向循环';
        const row={status,from:current.origin,to:observed?.origin||null,
          url:publicUrl(current.href),location:observed?publicUrl(observed.href):null,
          elapsedMs:responseInfo.responseElapsedMs,
          pathChanged:!!observed&&(current.pathname!==observed.pathname||current.search!==observed.search),
          protocolDowngrade:!!observed&&current.protocol==='https:'&&observed.protocol==='http:',
          ...(reason?{reason}:{})};
        redirects.push(row);
        await withinBudget(response.body?.cancel(),timerControl.signal);
        if(reason)return finish({status:!location||reason==='重定向跳数超出限制'||reason==='检测到重定向循环'?'unverified':'unsafe',reason});
        current=next;continue;
      }
      if(status!==200){await withinBudget(response.body?.cancel(),timerControl.signal);return finish({status:'unverified',reason:'目标网站响应 HTTP '+status});}
      if(responseInfo.kind!=='html'){
        await withinBudget(response.body?.cancel(),timerControl.signal);
        return finish({status:'unverified',reason:'目标响应不是 HTML，当前域名探测未验证其解析规则'});
      }
      const html=await textHead(response,timerControl.signal);
      const title=short(html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]||'',130);
      const suspicious=/domain (for sale|parking)|buy this domain|website suspended|域名出售|域名停放|验证您是人类|just a moment/i.test(title+' '+html.slice(0,500));
      return finish({status:!suspicious&&html.length>=100?'ok':'unverified',title,
        reason:suspicious?'页面疑似停放/风控页面':html.length<100?'返回内容过短，无法证实网站结构':'',bytesSampled:Buffer.byteLength(html)});
    }
    return finish({status:'unverified',reason:'重定向超出限制'});
  }catch(error){
    return finish({status:'unverified',reason:timerControl.signal.aborted?'连接超时':short(error?.message||'连接失败')});
  }finally{clearTimeout(timer);}
}
function chainIssue(report){
  if(report.redirects.some(row=>!PERMANENT.has(row.status)))return '跳转链包含临时跳转，不能自动应用';
  if(report.redirects.some(row=>row.protocolDowngrade))return '跳转链包含 HTTPS 降级，不能自动应用';
  if(report.redirects.some(row=>row.pathChanged))return '跳转改变了路径或查询参数，不能仅替换域名';
  return '';
}
export async function inspectDomainMove({sourceUrl,searchUrl,keyword='斗破苍穹',searchProbeSkipped}={},options={}){
  const old=checkedUrl(sourceUrl);
  if(old.search)throw new Error('网站首页 URL 不应包含查询参数；避免把任意带参数接口当作书源主页');
  const home=await fetchWithRedirects(old.href,options);
  const final=home.url?checkedUrl(home.url):old;
  const probe=staticSearch(old,searchUrl,keyword,searchProbeSkipped);
  const search=probe.url?await fetchWithRedirects(probe.url.href,options):probe.requested
    ?{status:'unsupported',reason:probe.reason,redirects:[]}:null;
  const base={oldOrigin:old.origin,newOrigin:final.origin,home,...(search?{search}:{}),
    autoApply:false,status:'unchanged',verificationScope:'domain-http-only'};
  const searchFinal=search?.url?checkedUrl(search.url):null;
  const searchMoved=search?.status==='ok'&&searchFinal?.origin!==old.origin;
  if(home.status!=='ok'){
    if(searchMoved)return {...base,newOrigin:searchFinal.origin,status:'needs-confirmation',migrationScope:'searchBook',
      reason:'首页无法验证，但搜索接口已跳转到新域名；只取得模块证据，不能替换整个书源'};
    return {...base,status:'unverified',reason:home.reason||'首页无法取得有效 HTML'};
  }
  const homeIssue=chainIssue(home);
  if(old.origin===final.origin){
    if(homeIssue)return {...base,status:'needs-confirmation',migrationScope:'homepage',reason:homeIssue};
    if(searchMoved)return {...base,status:'needs-confirmation',newOrigin:searchFinal.origin,migrationScope:'searchBook',
      reason:'首页未迁移，但搜索接口跳转到了新域名；需按模块验证，不能替换整个书源'};
    if(search?.status==='ok'&&chainIssue(search))return {...base,status:'needs-confirmation',migrationScope:'searchBook',reason:'搜索接口'+chainIssue(search)};
    if(search&&search.status!=='ok')return {...base,status:'unverified',reason:'首页可达，但搜索接口未完成验证：'+search.reason};
    return {...base,reason:search?'首页及搜索均使用原域名':'首页仍使用原域名；未配置可检测的搜索接口'};
  }
  if(homeIssue)return {...base,status:'needs-confirmation',reason:homeIssue};
  const crossRoot=!isWwwVariant(old.hostname,final.hostname);
  if(!home.redirects.length)return {...base,status:'needs-confirmation',reason:'未取得永久重定向证据'};
  if(!probe.requested){
    if(!crossRoot)return {...base,status:'verified',autoApply:true,verificationScope:'homepage-origin',
      reason:'首页永久跳转确认协议或 www 规范地址；未验证阅读规则'};
    return {...base,status:'needs-confirmation',reason:'域名已永久跳转，但没有搜索证据；跨域迁移不可自动应用'};
  }
  if(search?.status!=='ok')return {...base,status:'needs-confirmation',reason:'首页迁移了，但搜索未完成验证：'+(search?.reason||'未取得响应')};
  if(searchFinal.origin!==final.origin)return {...base,status:'needs-confirmation',reason:'首页与搜索使用不同的域名'};
  if(!search.redirects.some(row=>row.from===old.origin&&row.to!==old.origin))
    return {...base,status:'needs-confirmation',reason:'搜索未经过同样的永久重定向'};
  const searchIssue=chainIssue(search);
  if(searchIssue)return {...base,status:'needs-confirmation',migrationScope:'searchBook',reason:'搜索接口'+searchIssue};
  if(crossRoot)return {...base,status:'needs-confirmation',reason:'首页与搜索永久迁移证据已取得，但详情、目录、正文及转换后规则尚未验证，不能自动替换完全不同的新域名'};
  return {...base,status:'verified',autoApply:true,verificationScope:'homepage-search-origins',
    reason:'首页及搜索的永久跳转、路径和协议均已核对；阅读规则仍需独立验证'};
}
export async function inspectDomainBatch({sources}={},options={}){
  if(!Array.isArray(sources)||sources.length<1||sources.length>6){
    throw new Error('每次只允许验证 1～6 个书源域名');
  }
  const tasks=sources.map((item,i)=>({
    index:i,sourceName:short(item?.sourceName||'书源',90),
    url:item?.sourceUrl,searchUrl:item?.searchUrl,keyword:item?.keyword,searchProbeSkipped:item?.searchProbeSkipped
  }));
  const result=[];
  // Cap simultaneous outgoing connections to three public websites.
  for(let i=0;i<tasks.length;i+=3){
    const group=await Promise.all(tasks.slice(i,i+3).map(async task=>{
      try{
        return {index:task.index,sourceName:task.sourceName,
          ...(await inspectDomainMove({sourceUrl:task.url,searchUrl:task.searchUrl,keyword:task.keyword,searchProbeSkipped:task.searchProbeSkipped},options))};
      }catch(error){
        return {index:task.index,sourceName:task.sourceName,status:'unverified',autoApply:false,reason:short(error.message)};
      }
    }));
    result.push(...group);
  }
  return {results:result,persisted:false};
}
