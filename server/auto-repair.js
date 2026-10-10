import { unwrapSource, staticSourceIssues } from './repair.js';
import { inspectSourceWeb } from './site-evidence.js';
import {applySiteMetadataAdapters} from './site-adapters.js';
import {createRequire} from 'node:module';
const {rewriteStaticGetOrigin,rewriteStaticGetUrl}=createRequire(import.meta.url)('../converter/lib/urlRule.js');

/**
 * Deterministic, evidence-backed proposals. No user API key or model prompt.
 * Never runs website/Legado JavaScript. Nothing is saved on the server.
 */
export function buildAutoCandidate(doc, sourceName, evidence, legadoInput = null) {
  const { alias, source } = unwrapSource(doc, sourceName);
  const candidate = structuredClone(source);
  const changes = [];
  const diagnostics = [];
  const stage = Object.fromEntries((evidence?.steps||[]).map(x => [x.step,x]));
  const working = !!(stage.search?.status==='ok' && stage.detail?.status==='ok'
    && stage.chapterList?.status==='ok' && stage.chapterContent?.status==='ok');

  function update(module, field, next, reason) {
    if (typeof next !== 'string' || !next.trim() || next.length > 3000) return;
    const target = candidate[module];
    if (!target || typeof target !== 'object' || Array.isArray(target)) return;
    const old = target[field];
    if (old === next) return;
    target[field] = next;
    changes.push({path:module+'.'+field,oldValue:old===undefined?'（缺失）':String(old),
      newValue:next,reason:reason.slice(0,250)});
  }
  function updateTop(field, next, reason) {
    if(typeof next!=='string'||!next.trim()||next.length>1000)return;
    const old=candidate[field];
    if(old===next)return;
    candidate[field]=next;
    changes.push({path:field,oldValue:String(old??'（缺失）'),newValue:next,reason});
  }
  function ensureModule(module,reason) {
    if(!candidate[module] || typeof candidate[module]!=='object'){
      candidate[module]={};
      diagnostics.push(module+' 缺少动作模块，依据成功抓取的网页重建基础字段');
    }
    update(module,'actionID',module,reason);
    update(module,'parserID','DOM',reason);
    update(module,'responseFormatType','html',reason);
  }

  // The proposal must not pretend to fix a site that refuses HTTP requests.
  if(!working) return {
    sourceName:alias, candidate:null, accepted:[],
    issues:staticSourceIssues(source),
    diagnostics:['未取得成功的搜索→详情→目录→正文 HTTP 证据，不自动修改 XPath 或凭空假设网页结构']
  };
  const verified='来自本次 HTTP200 的真实页面与 DOM 匹配结果';
  if(!candidate.sourceType && stage.chapterContent.status==='ok')
    updateTop('sourceType','text','真实章节 HTML 已验证为文字小说正文，补齐 XSGG 必需书源类型');
  for (const module of ['searchBook','bookDetail','chapterList','chapterContent']) ensureModule(module,verified);
  // Canonical-domain proof: the server actually followed an apex -> www
  // redirect. Propose changing the source host and module hosts in the
  // downloadable copy. Do not infer changes for unrelated third-party hosts.
  const liveHomepage=stage.homepage?.url?new URL(stage.homepage.url):null;
  const originalSite=new URL(source.sourceUrl);
  if(liveHomepage && liveHomepage.origin!==originalSite.origin &&
     liveHomepage.hostname==='www.'+originalSite.hostname &&
     stage.homepage.status==='ok' && stage.homepage.redirects?.length && stage.homepage.redirects.every(r=>[301,308].includes(r.status))){
    updateTop('sourceUrl',liveHomepage.origin,'真实首页 HTTP 301 已确认规范域名为 '+liveHomepage.hostname);
    for(const m of ['searchBook','bookDetail','chapterList','chapterContent']){
      if(candidate[m]?.host && new URL(candidate[m].host).origin===originalSite.origin)
        update(m,'host',liveHomepage.origin,'跟随已验证的 canonical 域名变更');
    }
    if(stage.search?.url && stage.search.status==='ok' &&
       new URL(stage.search.url).origin===liveHomepage.origin &&
       (stage.search.redirects||[]).every(r=>[301,308].includes(r.status))) {
      const original=source.searchBook?.requestInfo;
      const rewritten=rewriteStaticGetOrigin(original,originalSite.origin,liveHomepage.origin);
      update('searchBook','requestInfo',rewritten,
        '仅修改已验证 GET 请求的规范域名，保留分页、请求对象和 forbidCookie 设置');
    }
  }
  if(stage.search?.discoveredSearch && stage.search.searchAttempts?.some(x=>x.status!=='ok')){
    const base=new URL(stage.search.url);
    const form=stage.search.discoveredSearch;
    const url=form.requestTemplate||base.origin+form.action+'?'+encodeURIComponent(form.parameter)+'=%@keyWord';
    update('searchBook','requestInfo',rewriteStaticGetUrl(candidate.searchBook.requestInfo,url)||url,'原搜索接口失败，从真实 form 验证新的 GET 入口；保留可识别请求对象的 Cookie 设置');
    if (candidate.searchBook.requestParamsEncode) {
      const old=String(candidate.searchBook.requestParamsEncode);
      delete candidate.searchBook.requestParamsEncode;
      changes.push({path:'searchBook.requestParamsEncode',oldValue:old,newValue:'（已移除）',
        reason:'旧搜索 URL 声明 GBK 编码；当前真实网站搜索表单使用 UTF-8 q 参数，删除旧的特殊编码设置'});
    }
  }
  const searchInference=stage.search?.autoDiscovered;
  if(searchInference && stage.search?.configuredMatches===0){
    for(const field of ['list','bookName','detailUrl']){
      update('searchBook',field,searchInference[field],'真实搜索 HTML 中旧选择器匹配 0 条，新选择器匹配 '+searchInference.detectedCount+' 条');
    }
  }

  if(typeof candidate.searchBook.requestInfo!=='string' || !candidate.searchBook.requestInfo.trim()){
    if(stage.search?.discoveredSearch){
      const form=stage.search.discoveredSearch;
      const base=new URL(stage.search.url);
      update('searchBook','requestInfo',form.requestTemplate||base.origin+form.action+'?'+encodeURIComponent(form.parameter)+'=%@keyWord',verified);
    } else diagnostics.push('搜索 requestInfo 缺失，未找到可安全填充的静态 URL');
  }
  if(!candidate.bookDetail.requestInfo) update('bookDetail','requestInfo','%@result','详情页面来自实际搜索结果的书籍链接');
  if(!candidate.bookDetail.bookName&&stage.detail.fieldChecks?.some(x=>x.field==='title'&&x.status==='ok'))
    update('bookDetail','bookName',candidate.bookDetail.title,'沿用本次真实详情页验证通过的标题规则，补齐书名字段');
  applySiteMetadataAdapters(stage,candidate,update);
  const chapterInference=stage.chapterList?.autoDiscovered;
  if(chapterInference && stage.chapterList.configuredMatches===0){
    for(const field of ['list','title','url']){
      update('chapterList',field,chapterInference[field],'实际目录 HTML 中旧规则匹配 0 条，已识别 '+chapterInference.detectedCount+' 个真实章节链接');
    }
  }
  if(!candidate.chapterList.requestInfo)update('chapterList','requestInfo','%@result','目录请求沿用检测报告已确认的详情或独立目录地址');
  const contentInference=stage.chapterContent?.autoDiscovered;
  if(contentInference && stage.chapterContent.configuredMatches===0){
    update('chapterContent','content',contentInference.content,'章节 HTML 中原正文 XPath 匹配 0 条，已找到包含完整内容的节点');
  }
  if(!candidate.chapterContent.requestInfo)update('chapterContent','requestInfo','%@result','正文来自实际章节链接');
  if(typeof candidate.enable!=='number'){
    const old=candidate.enable;candidate.enable=[false,'false','0',0].includes(old)?0:1;
    changes.push({path:'enable',oldValue:String(old),newValue:String(candidate.enable),reason:'归一化整数开关，保留原有启用/禁用意图'});
  }
  if(!/^[1-9]\d*$/.test(String(candidate.weight))){candidate.weight='100';}
  else candidate.weight=String(candidate.weight);
  const issues=staticSourceIssues(candidate);
  return {sourceName:alias, candidate:changes.length && !issues.length?candidate:null,
    accepted:issues.length?[]:changes,
    issues,diagnostics:issues.length?diagnostics.concat(issues):diagnostics,
    verificationLevel:'候选根据真实 HTTP/DOM 自动生成；仍须使用 XSGG 配置独立复测和 iOS App 确认'};
}
export async function runAutoRepair({source,sourceName,legado,keyword},{webInspector=inspectSourceWeb}={}) {
  const evidence=await webInspector({source,sourceName,legado,keyword});
  const repaired=buildAutoCandidate(source,sourceName,evidence,legado);
  let verification=null;
  if(repaired.candidate){
    const replacement={};replacement[repaired.sourceName]=repaired.candidate;
    // Crucially, re-test the *converted* source without favoring Legado.
    try { verification=await webInspector({source:replacement,sourceName:repaired.sourceName,keyword}); }
    catch(error){verification={fullyVerified:false,diagnostics:[String(error.message).slice(0,200)]};}
  }
  return {...repaired,liveWebEvidence:evidence,verification,
    verified:!!(verification?.fullyVerified),success:!!(verification?.fullyVerified)};
}
