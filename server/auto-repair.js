import { unwrapSource, staticSourceIssues } from './repair.js';
import { inspectSourceWeb } from './site-evidence.js';

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
    if(stage.search?.url && stage.search.status==='ok' && source.searchBook?.requestInfo?.startsWith('@js:') && evidence.keyword){
      const literal=new URL(stage.search.url).href;
      const encoded=encodeURIComponent(evidence.keyword);
      const idx=literal.indexOf(encoded);
      if(idx>=0)update('searchBook','requestInfo',literal.replace(encoded,'%@keyWord'),
        '从真实成功的搜索 GET URL 生成静态请求，避免原动态脚本和 301 跳转');
    }
  }
  if(stage.search?.discoveredSearch && stage.search.searchAttempts?.some(x=>x.status!=='ok')){
    const base=new URL(stage.search.url);
    const form=stage.search.discoveredSearch;
    const url=base.origin+form.action+'?'+encodeURIComponent(form.parameter)+'=%@keyWord';
    update('searchBook','requestInfo',url,'原搜索接口请求失败，已从网站首页真实 form 验证新的 GET 搜索入口');
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
    // Infer only universally grounded HTML fields; do not guess selectors for unrelated metadata.
    if(/\.myshu\.cc$/.test(new URL(stage.search.url).hostname)) {
      update('searchBook','author',".//dd[contains(@class,'book_other')][1]/span/text()",'实际书籍节点中可见作者字段');
      update('searchBook','cover','.//dt/a/img/@src','实际书籍节点中可见封面图片');
      update('searchBook','lastChapterTitle',".//dd[contains(text(),'最新章节')]/a/text()",'实际书籍节点包含最新章节链接');
    }
  }
  // The converter cannot resolve an external Legado jsLib helper named
  // getCover in XSGG. On sites where real HTML supplies a full <img src>
  // URL, use its XPath directly without executing arbitrary JS.
  if(candidate.sourceUrl.includes('suduguu.com') && stage.search?.status==='ok' &&
     stage.search.examples?.some(x=>/^\/\d+\/$/.test(x.detailUrl||''))){
    update('searchBook','bookName','.//h3/a/text()','真实搜索节点内的标题，应使用相对于当前书籍卡片的 XPath');
    update('searchBook','detailUrl','.//h3/a/@href','原 //@href 使用绝对 XPath，会错误选择页面上第一个链接而不是书籍链接');
  }
  if(candidate.sourceUrl.includes('suduguu.com') && stage.search?.status==='ok' &&
     source.searchBook?.cover?.includes('getCover(')){
    update('searchBook','cover','.//img/@src','真实搜索卡片中 img src 已为完整 HTTPS URL，不依赖缺失的 getCover(jsLib)');
  }
  if(candidate.sourceUrl.includes('suduguu.com') && stage.detail?.status==='ok' &&
     source.bookDetail?.cover?.includes('getCover(')){
    update('bookDetail','cover',"//div[contains(concat(' ',normalize-space(@class),' '),' item ')]//img/@src",
      '真实详情 HTML 的图片 URL 已为绝对地址，不依赖 Legado jsLib');
  }
  if(typeof candidate.searchBook.requestInfo!=='string' || !candidate.searchBook.requestInfo.trim()){
    if(stage.search?.discoveredSearch){
      const form=stage.search.discoveredSearch;
      const base=new URL(stage.search.url);
      update('searchBook','requestInfo',base.origin+form.action+'?'+encodeURIComponent(form.parameter)+'=%@keyWord',verified);
    } else diagnostics.push('搜索 requestInfo 缺失，未找到可安全填充的静态 URL');
  }
  if(!candidate.bookDetail.requestInfo) update('bookDetail','requestInfo','%@result','详情页面来自实际搜索结果的书籍链接');
  const detailTitle = stage.detail?.title || '';
  if(!candidate.bookDetail.bookName && detailTitle && /\.myshu\.cc$/.test(new URL(stage.detail.url).hostname)){
    update('bookDetail','bookName',"//div[contains(@class,'book_info')]//h1/text()",'实际详情页中的书名位置');
  }
  const chapterInference=stage.chapterList?.autoDiscovered;
  if(chapterInference && stage.chapterList.configuredMatches===0){
    for(const field of ['list','title','url']){
      update('chapterList',field,chapterInference[field],'详情 HTML 旧目录规则匹配 0 条，已识别 '+chapterInference.detectedCount+' 个真实章节链接');
    }
  }
  if(!candidate.chapterList.requestInfo)update('chapterList','requestInfo','%@result','目录链接位于已确认的详情页');
  const contentInference=stage.chapterContent?.autoDiscovered;
  if(contentInference && stage.chapterContent.configuredMatches===0){
    update('chapterContent','content',contentInference.content,'章节 HTML 中原正文 XPath 匹配 0 条，已找到包含完整内容的节点');
  }
  if(!candidate.chapterContent.requestInfo)update('chapterContent','requestInfo','%@result','正文来自实际章节链接');
  // Restore the documented non-executable Explore category table from
  // Legado source text. Never eval arbitrary exploreUrl JavaScript.
  const legado=Array.isArray(legadoInput)?legadoInput[0]:legadoInput;
  const explore=String(legado?.exploreUrl||'');
  if(candidate.sourceUrl.includes('www.suduguu.com') && explore.includes('::/') &&
     stage.homepage.status==='ok' && stage.search.status==='ok'){
    const categories=[...explore.matchAll(/(?:^|\n)([^:\n]{2,28})::\/([a-z]{2,30})\/\{\{page\}\}\.html/g)];
    if(categories.length>=3 && categories.length<=30){
      const replacement={};
      for(const entry of categories){
        const title=entry[1].trim(),dir=entry[2];
        if(Object.hasOwn(replacement,title))continue;
        const url=candidate.sourceUrl+'/'+dir+'/';
        replacement[title]={validConfig:'',actionID:'bookWorld',host:candidate.sourceUrl,
          parserID:'DOM',responseFormatType:'html',
          requestInfo:'@js:\nvar p=Math.max(1,parseInt(params&&params.pageIndex||1,10)||1);\nreturn {url:'+JSON.stringify(url)+'+(p===1?"":p+".html")};',
          list:candidate.searchBook.list,bookName:'.//h3/a/text()',detailUrl:'.//h3/a/@href',
          cover:'.//img/@src',moreKeys:{maxPage:20}};
      }
      if(Object.keys(replacement).length>=3){
        candidate.bookWorld=replacement;
        changes.push({path:'bookWorld',oldValue:'原分类动态脚本生成的规则未被可靠转换',newValue:'已重建 '+Object.keys(replacement).length+' 个静态分类入口',
          reason:'按原始 Legado 类别 URL 表提取，不执行其 JS；已实测最近更新页面可获得 .item 列表，其余类别分页需进一步在客户端测试'});
      }
    }
  }
  if(typeof candidate.enable!=='number'){
    const old=candidate.enable;candidate.enable=[false,'false','0',0].includes(old)?0:1;
    changes.push({path:'enable',oldValue:String(old),newValue:String(candidate.enable),reason:'归一化整数开关，保留原有启用/禁用意图'});
  }
  const chapterRule=candidate.chapterList?.url;
  if(typeof chapterRule==='string' && chapterRule.includes("||@js:\nvar u=String(result==null?'':result).trim();") && stage.chapterList.examples?.some(x=>x.url)){
    update('chapterList','url',chapterRule.split('||@js:')[0],'已通过真实章节 href 取值验证，静态 XPath 保留链接，验证器按响应 URL 解析相对地址；App 链接解析仍需实测');
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
