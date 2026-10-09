/**
 * Read-only, SSRF-safe canonical domain probe.
 * This is a server-assisted part of baseline conversion, not AI repair.
 * No arbitrary JS, API keys, cookies or request headers from source records.
 */
import net from 'node:net';
import { checkPublicDns, makeSafeFetch } from './net-safety.js';

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
  if(net.isIP(u.hostname))throw new Error('只检测书源域名，不允许任意 IP 地址');
  return u;
}
function publicUrl(raw){try{const u=new URL(raw);for(const k of [...u.searchParams.keys()])if(/token|api[_-]?key|secret|password|cookie|auth|signature|session/i.test(k))u.searchParams.set(k,"[redacted]");return u.href;}catch{return "[invalid URL]";}}
function short(s,max=160){return String(s||'').replace(/\s+/g,' ').slice(0,max);}
function isWwwVariant(oldHost,newHost){
  const strip=s=>s.startsWith('www.')?s.slice(4):s;
  return strip(oldHost)===strip(newHost);
}
function staticSearch(original, template, keyword='斗破苍穹'){
  if(typeof template!=='string'||!template.trim()||template.length>500||
     /@js:|<js>|\$\{|javascript:/i.test(template))return null;
  let raw=template.split(/,\s*\{/)[0].trim();
  raw=raw.replace(/\{\{key\}\}|%@keyWord/gi,encodeURIComponent(keyword))
    .replace(/\{\{page\}\}|%@pageIndex/gi,'1');
  if(/\{\{|%@|#/.test(raw))return null;
  let url;
  try{url=new URL(raw,original.href);}catch{return null;}
  if(url.origin!==original.origin)return null; // Never probe unrelated domain.
  if(url.pathname===original.pathname && url.search===original.search)return null;
  try{return checkedUrl(url.href);}catch{return null;}
}
async function textHead(response,limit=LIMIT_BYTES){
  if(!response.body)return '';
  const reader=response.body.getReader(),chunks=[];
  let total=0;
  try{
    while(total<limit){
      const item=await reader.read();
      if(item.done)break;
      total+=item.value.byteLength;
      chunks.push(Buffer.from(item.value));
    }
    try{await reader.cancel();}catch{}
  }finally{try{reader.releaseLock();}catch{}}
  return Buffer.concat(chunks).subarray(0,limit).toString('utf8');
}
async function fetchWithRedirects(raw,{fetcher,dnsChecker=checkPublicDns,timeoutMs=4700}={}){
  let current=checkedUrl(raw);
  const timerControl=new AbortController();
  const timer=setTimeout(()=>timerControl.abort(),timeoutMs);
  const redirects=[];
  const started=Date.now();
  try{
    for(let hop=0;hop<=MAX_HOPS;hop++){
      await dnsChecker(current);
      const response=await (fetcher||makeSafeFetch(current.origin,{allowHttp:true,allowRedirectResponse:true}))(current.href,{
        method:'GET',redirect:'manual',signal:timerControl.signal,
        headers:{'User-Agent':'Mozilla/5.0 (compatible; BooksourceWorkbench/1.8)','Accept':'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1'}
      });
      const status=response.status;
      if(REDIRECTS.has(status)){
        const location=response.headers.get('location');
        await response.body?.cancel();
        if(!location||hop===MAX_HOPS)return {status:'unverified',url:current.href,httpStatus:status,redirects,reason:'重定向跳数过多或缺少 Location'};
        let next;
        try{next=checkedUrl(new URL(location,current).href);}
        catch(err){return {status:'unsafe',url:current.href,httpStatus:status,redirects,reason:short(err.message)};}
        redirects.push({status,from:current.origin,to:next.origin,url:publicUrl(current.href),location:publicUrl(next.href),elapsedMs:Date.now()-started,pathChanged:current.pathname!==next.pathname||current.search!==next.search});
        current=next;continue;
      }
      const contentType=String(response.headers.get('content-type')||'').toLowerCase();
      if(status!==200){await response.body?.cancel();return {status:'unverified',url:current.href,httpStatus:status,redirects,reason:'目标网站响应 HTTP '+status};}
      if(!contentType.includes('text/html')&&!contentType.includes('application/xhtml+xml')){
        await response.body?.cancel();
        return {status:'unverified',url:current.href,httpStatus:status,redirects,reason:'目标响应不是 HTML'};
      }
      const html=await textHead(response);
      const title=short(html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]||'',130);
      const suspicious=/domain (for sale|parking)|buy this domain|website suspended|域名出售|域名停放|验证您是人类|just a moment/i.test(title+' '+html.slice(0,500));
      return {status:!suspicious&&html.length>=100?'ok':'unverified',url:current.href,httpStatus:200,title,contentType,elapsedMs:Date.now()-started,originalUrl:publicUrl(raw),finalDomain:current.hostname,redirects,reason:suspicious?'页面疑似停放/风控页面':html.length<100?'返回内容过短，无法证实网站结构':'',bytesSampled:html.length};
    }
    return {status:'unverified',redirects,reason:'重定向超出限制'};
  }catch(error){
    return {status:'unverified',url:current.href,redirects,
      reason:timerControl.signal.aborted?'连接超时':short(error?.message||'连接失败')};
  }finally{clearTimeout(timer);}
}
export async function inspectDomainMove({sourceUrl,searchUrl,keyword='斗破苍穹'}={},options={}){
  const old=checkedUrl(sourceUrl);
  if(old.search)throw new Error('网站首页 URL 不应包含查询参数；避免把任意带参数接口当作书源主页');
  const home=await fetchWithRedirects(old.href,options);
  const final=home.url?checkedUrl(home.url):old;
  const base={oldOrigin:old.origin,newOrigin:final.origin,home,autoApply:false,status:'unchanged'};
  if(home.status!=='ok')return {...base,status:'unverified',reason:home.reason||'首页无法取得有效 HTML'};
  if(old.origin===final.origin){
    const probe=staticSearch(old,searchUrl,keyword);
    if(!probe)return {...base,status:'unchanged',reason:'首页仍使用原域名；没有可静态验证的搜索接口'};
    const searchOnly=await fetchWithRedirects(probe.href,options);
    if(searchOnly.status==='ok' && searchOnly.url && checkedUrl(searchOnly.url).origin!==old.origin){
      return {...base,status:'needs-confirmation',search:searchOnly,newOrigin:checkedUrl(searchOnly.url).origin,
        reason:'首页未迁移，但搜索接口跳转到了新域名；需按模块修改请求，不能替换整个书源的域名'};
    }
    return {...base,status:'unchanged',search:searchOnly,reason:searchOnly.status==='ok'
      ?'首页及搜索均使用原域名':'首页仍使用原域名；搜索接口未完成验证，可能已失效'};
  }
  const crossRoot=!isWwwVariant(old.hostname,final.hostname);
  const firstCross=home.redirects.find(r=>r.from===old.origin && r.to!==old.origin);
  if(!firstCross||!PERMANENT.has(firstCross.status)){
    return {...base,status:'needs-confirmation',reason:'跳转包含临时跳转，不能认定永久迁移'};
  }
  if(home.redirects.some(r=>!PERMANENT.has(r.status)) || old.protocol==='https:' && final.protocol==='http:'){
    return {...base,status:'needs-confirmation',reason:'完整跳转链包含临时跳转或 HTTPS 降级，不能自动应用'};
  }
  if(home.redirects.some(r=>r.pathChanged)){
    return {...base,status:'needs-confirmation',reason:'首页跳转改变了路径，不能仅替换主机名'};
  }
  const search=staticSearch(old,searchUrl,keyword);
  if(!search){
    if(!crossRoot)return {...base,status:'verified',autoApply:true,reason:'HTTP 永久跳转确认 www 规范域名'};
    return {...base,status:'needs-confirmation',reason:'域名已永久跳转，但没有可静态验证的搜索接口；跨域迁移不可自动应用'};
  }
  const searchReport=await fetchWithRedirects(search.href,options);
  const paired={...base,search:searchReport};
  if(searchReport.status!=='ok')return {...paired,status:'needs-confirmation',reason:'首页迁移了，但搜索请求未在新站点成功'};
  const searchFinal=checkedUrl(searchReport.url);
  if(searchFinal.origin!==final.origin)return {...paired,status:'needs-confirmation',reason:'首页与搜索跳转到不同的域名'};
  const searchCross=searchReport.redirects.find(r=>r.from===old.origin && r.to!==old.origin);
  if(!searchCross||!PERMANENT.has(searchCross.status)){
    return {...paired,status:'needs-confirmation',reason:'搜索未经过同样的永久重定向'};
  }
  if(searchReport.redirects.some(r=>!PERMANENT.has(r.status)||r.pathChanged)){
    return {...paired,status:'needs-confirmation',reason:'跨域搜索页面路径改变，简单域名替换不能保证规则有效'};
  }
  if(crossRoot)return {...paired,status:'needs-confirmation',reason:'首页与搜索永久迁移证据已取得，但详情、目录、正文及转换后规则尚未验证，不能自动替换完全不同的新域名'};
  return {...paired,status:'verified',autoApply:true,
    reason:crossRoot?'首页与实际搜索地址均有 HTTP 永久跳转且返回 HTML，确认新域名':'首页和搜索均确认 canonical www 域名'};
}
export async function inspectDomainBatch({sources}={},options={}){
  if(!Array.isArray(sources)||sources.length<1||sources.length>6){
    throw new Error('每次只允许验证 1～6 个书源域名');
  }
  const tasks=sources.map((item,i)=>({
    index:i,sourceName:short(item?.sourceName||'书源',90),
    url:item?.sourceUrl,searchUrl:item?.searchUrl,keyword:item?.keyword
  }));
  const result=[];
  // Cap simultaneous outgoing connections to three public websites.
  for(let i=0;i<tasks.length;i+=3){
    const group=await Promise.all(tasks.slice(i,i+3).map(async task=>{
      try{
        return {index:task.index,sourceName:task.sourceName,
          ...(await inspectDomainMove({sourceUrl:task.url,searchUrl:task.searchUrl,keyword:task.keyword},options))};
      }catch(error){
        return {index:task.index,sourceName:task.sourceName,status:'unverified',autoApply:false,reason:short(error.message)};
      }
    }));
    result.push(...group);
  }
  return {results:result,persisted:false};
}
