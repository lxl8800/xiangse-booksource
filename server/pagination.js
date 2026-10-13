import {redactUrl} from './evidence-report.js';
const MAX_PAGES=3,MAX_BYTES=560000,MAX_ITEMS=2000;
// Callbacks use the same parser/request safety policy as the four-step inspector.
export async function inspectPagination({firstResponse,firstDocument,firstPlan,action,kind,parse,extract,next,download,validateUrl,timeoutMs=7800}){
  const rawLimit=action.moreKeys?.maxPage;
  const configuredLimit=rawLimit===undefined?10:Number(rawLimit);
  const validLimit=Number.isInteger(configuredLimit)&&configuredLimit>0&&configuredLimit<=1000;
  const limit=validLimit?Math.min(configuredLimit,MAX_PAGES):1;
  const started=Date.now(),deadline=started+Math.min(20000,timeoutMs*3);
  const summary={enabled:true,complete:false,status:'incomplete',pagesRequested:1,maxPages:limit,configuredMaxPage:validLimit?configuredLimit:null,pages:[],duplicates:0};
  let response=firstResponse,document=firstDocument,totalBytes=0,content='',previousTitle='',selectedItems=[];
  const seenUrls=new Set(),seenItems=new Set(),seenContent=new Set();
  const fail=(status,reason)=>{summary.status=status;summary.reason=reason;};
  if(!validLimit)fail('unsupported','moreKeys.maxPage 必须为受限正整数');
  for(let index=1;index<=limit;index++){
    const page={page:index,url:redactUrl(response.url),originalUrl:redactUrl(response.originalUrl||response.url),status:response.status,httpStatus:response.httpStatus,
      requestMethod:response.requestMethod||'GET',contentType:response.contentType,headersApplied:response.requestCapabilities?.headersApplied,elapsedMs:response.elapsedMs,bytes:response.bytes,charset:response.charset,redirects:response.redirects||[]};
    summary.pages.push(page);totalBytes+=response.bytes||0;
    if(response.status!=='ok'){fail(response.status,response.reason||'后续分页请求失败');break;}
    if(response.bodyTruncated||totalBytes>MAX_BYTES){fail('budget','分页响应总大小超出检测预算');break;}
    const result=extract(document);
    page.fieldChecks=result.fieldChecks;page.configuredMatches=result.matches;page.status=result.status;
    if(result.status!=='ok'||result.reason){page.reason=result.reason||'分页原规则未匹配有效内容';fail('rule-error',page.reason);break;}
    if(result.truncated){fail('budget','分页字段提取超出条目或文本预算');break;}
    seenUrls.add(response.url);seenUrls.add(response.originalUrl||response.url);
    for(const hop of response.redirects||[])if(hop.url)seenUrls.add(hop.url);
    if(kind==='list'){
      for(const item of result.items){
        if(seenItems.has(item.url)){summary.duplicates++;continue;}
        if(selectedItems.length>=MAX_ITEMS){fail('budget','合并目录条目超出检测预算');break;}
        seenItems.add(item.url);selectedItems.push(item);
      }
      page.count=result.items.length;
    }else{
      const text=result.content.trim();
      if(seenContent.has(text)){fail('loop','后续页返回了重复正文，未重复拼接');break;}
      if(previousTitle&&result.title&&previousTitle!==result.title){fail('chapter-changed','下一页章节标题改变，疑似进入下一章，未合并');break;}
      if(result.title)previousTitle=result.title;
      seenContent.add(text);content+=(content?'\n':'')+text;page.contentLength=text.length;
    }
    if(summary.reason)break;
    if(!validLimit)break;
    const link=next(document);page.nextPageRule=String(action.nextPageUrl).slice(0,240);page.nextMatches=link.matches;
    if(link.reason){fail('unsupported',link.reason);break;}
    if(!link.url){summary.complete=true;summary.status='complete';break;}
    let target;
    try{target=validateUrl(link.url,response.url);}catch(error){fail('unsafe',String(error.message).slice(0,180));break;}
    page.nextUrl=redactUrl(target);
    if(seenUrls.has(target)){fail('loop','下一页地址已请求，检测到分页循环');break;}
    if(index>=limit){fail('limit',configuredLimit>MAX_PAGES?'分页尚未结束，达到安全检测页数上限':'分页尚未结束，达到配置 maxPage 上限');break;}
    const remaining=deadline-Date.now();
    if(remaining<=0){fail('budget','分页验证超过总耗时预算');break;}
    summary.pagesRequested++;
    try{
      response=await download(target,{...firstPlan,url:target,rejectVisitedUrls:seenUrls},Math.min(timeoutMs,remaining));
      if(seenUrls.has(response.url)){
        summary.pages.push({page:index+1,url:redactUrl(response.url),httpStatus:response.httpStatus,status:'loop',redirects:response.redirects||[]});
        fail('loop','后续页重定向到已经验证的页面');break;
      }
      if(response.status!=='ok'){
        summary.pages.push({page:index+1,url:redactUrl(response.url||target),status:response.status,httpStatus:response.httpStatus,reason:response.reason,elapsedMs:response.elapsedMs,redirects:response.redirects||[]});
        fail(response.status,response.reason||'后续页请求失败');break;
      }
      document=parse(response);
    }catch(error){fail('unsupported',String(error.message).slice(0,180));break;}
  }
  summary.fullyChecked=summary.complete&&summary.pages.every(page=>(page.fieldChecks||[]).every(field=>field.status==='ok'));
  summary.totalBytes=totalBytes;summary.elapsedMs=Date.now()-started;
  if(kind==='list')summary.mergedCount=selectedItems.length;
  else summary.mergedContentLength=content.trim().length;
  return {summary,items:selectedItems,content};
}
