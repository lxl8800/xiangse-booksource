import iconv from 'iconv-lite';
import {createRequire} from 'node:module';
const {describeStaticGetRequest}=createRequire(import.meta.url)('../converter/lib/urlRule.js');
const {charsetLabel,parseHeaderData}=createRequire(import.meta.url)('../converter/lib/requestCompat.js');
const OWN=(object,key)=>Object.prototype.hasOwnProperty.call(object||{},key);
const HEADER_NAMES=new Map([['user-agent','User-Agent'],['accept','Accept'],['accept-language','Accept-Language'],['referer','Referer'],['origin','Origin']]);
const PRIVATE_QUERY=/token|api[_-]?key|secret|password|cookie|authorization|signature|session|credential|^(?:auth|auth[_-]?code|access[_-]?key|bearer)$/i;
const dynamic=/@js:|<js>|\{\{|\$\{|%@/i;
function inherited(source,action,key){return OWN(action,key)?action[key]:source?.[key];}
function enabled(value){return value!==false&&value!==0&&value!=='false'&&value!=='0';}
function issue(field,reason){return {field,status:'not-executed',reason};}
export function encodeKeyword(value,encoding='utf-8'){
  if(encoding==='utf-8')return encodeURIComponent(value);
  const bytes=iconv.encode(value,encoding);
  if(iconv.decode(bytes,encoding)!==value)throw Error('搜索关键词包含 '+encoding+' 无法无损表示的字符');
  let out='';
  for(const byte of bytes)out+=byte>=0x30&&byte<=0x39||byte>=0x41&&byte<=0x5a||byte>=0x61&&byte<=0x7a||[0x2d,0x5f,0x2e,0x7e].includes(byte)?String.fromCharCode(byte):'%'+byte.toString(16).toUpperCase().padStart(2,'0');
  return out;
}
export function mergeProbeHeaders(source,action,request,origin){
  const merged=new Map(),issues=[];
  for(const [field,value] of [['source.httpHeaders',source?.httpHeaders],['action.httpHeaders',action?.httpHeaders],['requestInfo.httpHeaders',request?.httpHeaders]]){
    const parsed=parseHeaderData(value);
    if(parsed.reason){issues.push(issue(field,parsed.reason));continue;}
    for(const [key,value] of Object.entries(parsed.headers))merged.set(key.toLowerCase(),{key,value,field});
  }
  const headers={},skipped=[];
  for(const [name,{key,value,field}] of merged){
    let reason='';
    if(!HEADER_NAMES.has(name))reason='该请求头未获安全检测支持，不发送认证、Cookie 或自定义头';
    else if(dynamic.test(value)||/[\r\n\x00-\x08\x0b-\x1f\x7f-\uffff]/.test(value)||value.length>1024)reason='动态或非法请求头值未执行';
    else if(name==='referer'||name==='origin'){
      try{
        const u=new URL(value),base=new URL(origin),strip=s=>s.replace(/^www\./,'');
        if(u.username||u.password||u.hash||u.port||!['https:','http:'].includes(u.protocol)||strip(u.hostname)!==strip(base.hostname)||[...u.searchParams.keys()].some(k=>PRIVATE_QUERY.test(k))||base.protocol==='https:'&&u.protocol!=='https:'||name==='origin'&&(u.pathname!=='/'||u.search))reason='来源请求头必须是同站公开地址或源，不含凭据';
      }catch{reason='来源请求头不是完整 HTTP(S) URL';}
    }
    if(reason){skipped.push(key);issues.push(issue(field+'.'+key,reason));}
    else headers[HEADER_NAMES.get(name)]=value;
  }
  return {headers,names:Object.keys(headers),skipped,issues};
}
export function buildGetPlan({source={},action={},seed='',origin,keyword='',pageIndex=1}){
  const missing=typeof action.requestInfo!=='string'||!action.requestInfo.trim();
  const descriptor=missing?{url:'%@result'}:describeStaticGetRequest(action.requestInfo);
  if(!descriptor)return {reason:'requestInfo 为无法静态识别的动态或 POST 请求；不执行脚本，也不沿用其他动作的地址'};
  for(const key of ['POST','method'])if(key==='POST'?inherited(source,action,key)&&enabled(inherited(source,action,key)):inherited(source,action,key)&&String(inherited(source,action,key)).toUpperCase()!=='GET')return {reason:'声明了非 GET 请求，安全检测不将它静默改为 GET'};
  const params=inherited(source,action,'httpParams');
  if(params&&(!(typeof params==='object')||Object.keys(params).length))return {reason:'配置含 httpParams，尚不能等价执行；不把带参数请求当成普通 GET'};
  const declared=inherited(source,action,'requestParamsEncode');
  const encoding=declared===undefined||declared===null||declared===''?'utf-8':charsetLabel(declared);
  if(!encoding)return {reason:'无法识别 requestParamsEncode；不使用 UTF-8 替代声明的请求编码'};
  let template=descriptor.url;const usedResult=template.includes('%@result');
  if(usedResult&&!seed)return {reason:'请求依赖上一动作的 URL，但未取得一个有效的地址'};
  try{template=template.replace(/%@result/g,()=>seed).replace(/%@keyWord/g,()=>encodeKeyword(keyword,encoding)).replace(/%@pageIndex/g,String(pageIndex));}
  catch(error){return {reason:error.message};}
  if(template.includes('%@'))return {reason:'请求包含无法静态展开的占位符'};
  let url;try{url=new URL(template,action.host||origin);}catch{return {reason:'动作请求无法解析为一个 URL'};}
  if([...url.searchParams.keys()].some(k=>PRIVATE_QUERY.test(k)))return {reason:'请求地址含认证参数，安全检测不发送凭据'};
  const responseDeclared=inherited(source,action,'responseEncode');
  const responseEncoding=responseDeclared===undefined||responseDeclared===null||responseDeclared===''?null:charsetLabel(responseDeclared);
  if(responseDeclared!==undefined&&responseDeclared!==null&&responseDeclared!==''&&!responseEncoding)return {reason:'无法识别 responseEncode；不使用网页声明替代配置的字符编码'};
  const headerPlan=mergeProbeHeaders(source,action,descriptor,origin);
  const capabilities=[...headerPlan.issues];
  if((OWN(action,'webView')||OWN(source,'webView'))&&enabled(inherited(source,action,'webView')))capabilities.push(issue('webView','未执行 WebView，仅获取静态 HTTP 页面'));
  for(const key of ['webViewSniff','webViewContentRules','webViewJs','JSParser','requestJavascript','responseJavascript','requestFunction','responseFunction','responseDecryptType']){
    if(inherited(source,action,key))capabilities.push(issue(key,'未执行 App 动态钩子或网页脚本'));
  }
  if(action.parserID&&action.parserID!=='DOM')capabilities.push(issue('parserID','当前读取链仅执行 DOM 解析'));
  if(action.responseFormatType&&action.responseFormatType!=='html')capabilities.push(issue('responseFormatType','当前读取链仅解析 HTML'));
  if(action.nextPageUrl)capabilities.push(issue('nextPageUrl','尚未验证后续分页，当前只检查第一页'));
  if(action.moreKeys?.skipCount)capabilities.push(issue('moreKeys.skipCount','尚未执行列表跳过条目配置'));
  if(descriptor.url.includes('%@pageIndex'))capabilities.push(issue('requestInfo.pageIndex','页号模板只展开为第一页，尚未检查后续页'));
  return {url:url.href,usedResult,requestInfoMissing:missing,staticRequest:descriptor.generated?'converter-get-template':'plain-get',forbidCookie:!!descriptor.forbidCookie,
    requestEncoding:encoding,responseEncoding,headers:headerPlan.headers,
    requestCapabilities:{headersApplied:headerPlan.names,headersSkipped:headerPlan.skipped,requestEncoding:encoding,responseEncoding:responseEncoding||'auto',unchecked:capabilities},
    capabilitiesChecked:!missing&&!capabilities.length};
}
