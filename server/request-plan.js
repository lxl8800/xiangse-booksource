import iconv from 'iconv-lite';
import {createRequire} from 'node:module';
const {describeStaticGetRequest}=createRequire(import.meta.url)('../converter/lib/urlRule.js');
const {evaluateStaticRequest}=createRequire(import.meta.url)('../converter/lib/staticScript.js');
const {charsetLabel,parseHeaderData}=createRequire(import.meta.url)('../converter/lib/requestCompat.js');
const OWN=(object,key)=>Object.prototype.hasOwnProperty.call(object||{},key);
const HEADER_NAMES=new Map([['user-agent','User-Agent'],['accept','Accept'],['accept-language','Accept-Language'],['referer','Referer'],['origin','Origin']]);
const PRIVATE_QUERY=/token|api[_-]?key|secret|password|cookie|authorization|signature|session|credential|^(?:auth|auth[_-]?code|access[_-]?key|bearer|_t|csrf|csrf[_-]?token|sign|nonce)$/i;
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
export function isReadOnlySearchTarget(url){
  return /^(?:\/search\/?|\/home\/search\/?|\/modules\/article\/search(?:we)?\.php)$/i.test(url.pathname);
}
function buildReadOnlySearchForm(url,params,keyword,role,encoding,origin){
  const base=new URL(origin),canonical=s=>s.replace(/^www\./,'');
  if(role!=='searchBook'||url.search||!isReadOnlySearchTarget(url)||canonical(url.hostname)!==canonical(base.hostname)||base.protocol==='https:'&&url.protocol!=='https:')throw Error('POST 仅支持同站已知的只读书籍搜索入口；其他操作未发送');
  if(!params||typeof params!=='object'||Array.isArray(params))throw Error('只读搜索 POST 必须有明确表单参数');
  const allowed=new Set(['q','keyword','keywords','searchkey','key','wd','page','p','action','Submit']);
  const queryFields=['q','keyword','keywords','searchkey','key','wd'];
  const keys=Object.keys(params);
  if(keys.length<1||keys.length>6||keys.some(k=>!allowed.has(k)))throw Error('POST 表单含未获支持或认证字段，不转发 Token、Cookie 或动态签名');
  const query=keys.filter(k=>queryFields.includes(k));
  if(query.length!==1||typeof params[query[0]]!=='string'||!keyword.trim()||params[query[0]].trim()!==keyword.trim())throw Error('POST 必须只提交当前搜索关键词，不能推断其他操作');
  for(const key of keys){
    const v=params[key];if(!['string','number'].includes(typeof v)||String(v).length>100)throw Error('POST 字段不是受限的静态值');
    if(key==='action'&&v!=='search'||key==='Submit'&&v!==''||['page','p'].includes(key)&&!/^\d{1,3}$/.test(String(v)))throw Error('POST 控制参数不是已支持的只读搜索值');
  }
  const body=keys.map(k=>encodeKeyword(k,encoding)+'='+encodeKeyword(String(params[k]),encoding)).join('&');
  if(body.length>4096)throw Error('搜索表单超过长度预算');
  return body;
}
export function buildGetPlan({source={},action={},seed='',origin,keyword='',pageIndex=1,role=null}){
  const missing=typeof action.requestInfo!=='string'||!action.requestInfo.trim();
  let descriptor=missing?{url:'%@result'}:describeStaticGetRequest(action.requestInfo);
  let expressionMode=false,expressionInputs=[],expressionUsesResult=false;
  if(!descriptor && /^\s*@js:/i.test(String(action.requestInfo||''))){
    // The expression layer receives only approved public header values.
    // Original skipped headers are still reported by mergeProbeHeaders below.
    const h=mergeProbeHeaders(source,action,{},origin).headers;
    const interpreted=evaluateStaticRequest(action.requestInfo,{
      params:{keyWord:keyword,pageIndex,queryInfo:{url:seed,detailUrl:seed},responseUrl:seed,lastResponse:{}},
      config:{host:action.host||origin,httpHeaders:h},result:seed
    });
    if(!interpreted.ok)return {reason:'requestInfo 含未支持的动态能力：'+interpreted.reason};
    descriptor=interpreted.request;expressionMode=true;expressionInputs=interpreted.inputs||[];expressionUsesResult=!!interpreted.usesResult;
  }
  if(!descriptor)return {reason:'requestInfo 为无法静态识别的动态请求；不执行任意脚本，也不沿用其他动作的地址'};
  const method=descriptor.POST===true?'POST':'GET';
  for(const key of ['POST','method'])if(key==='POST'?inherited(source,action,key)&&enabled(inherited(source,action,key))&&method!=='POST':inherited(source,action,key)&&String(inherited(source,action,key)).toUpperCase()!==method)return {reason:'声明的请求方法与解析出的请求不一致，不静默改写方法'};
  const params=descriptor.httpParams??inherited(source,action,'httpParams');
  if(method==='GET'&&params&&(!(typeof params==='object')||Object.keys(params).length))return {reason:'GET 含 httpParams，尚不能等价执行；不把带参数请求当成普通 GET'};
  // Request-object overrides must not disappear while the DOM parser continues
  // using the action config. Equivalent overrides are safe, others are explicit.
  for(const name of ['responseEncode','requestParamsEncode','responseFormatType']){
    if(descriptor[name]!==undefined && descriptor[name]!==inherited(source,action,name))return {reason:'请求对象覆盖 '+name+'，当前动作解析配置不一致，未擅自忽略'};
  }
  const declared=inherited(source,action,'requestParamsEncode');
  const encoding=declared===undefined||declared===null||declared===''?'utf-8':charsetLabel(declared);
  if(!encoding)return {reason:'无法识别 requestParamsEncode；不使用 UTF-8 替代声明的请求编码'};
  let template=descriptor.url;const usedResult=expressionMode?expressionUsesResult||expressionInputs.some(k=>/^params\.(queryInfo|responseUrl|lastResponse)/.test(k)):template.includes('%@result');
  if(usedResult&&!seed)return {reason:'请求依赖上一动作的 URL，但未取得一个有效的地址'};
  try{if(!expressionMode)template=template.replace(/%@result/g,()=>seed).replace(/%@keyWord/g,()=>encodeKeyword(keyword,encoding)).replace(/%@pageIndex/g,String(pageIndex));}
  catch(error){return {reason:error.message};}
  if(template.includes('%@'))return {reason:'请求包含无法静态展开的占位符'};
  let url;try{url=new URL(template,action.host||origin);}catch{return {reason:'动作请求无法解析为一个 URL'};}
  if([...url.searchParams.keys()].some(k=>PRIVATE_QUERY.test(k)))return {reason:'请求地址含认证参数，安全检测不发送凭据'};
  const responseDeclared=inherited(source,action,'responseEncode');
  const responseEncoding=responseDeclared===undefined||responseDeclared===null||responseDeclared===''?null:charsetLabel(responseDeclared);
  if(responseDeclared!==undefined&&responseDeclared!==null&&responseDeclared!==''&&!responseEncoding)return {reason:'无法识别 responseEncode；不使用网页声明替代配置的字符编码'};
  let body;
  if(method==='POST'){
    try{body=buildReadOnlySearchForm(url,params,keyword,role,encoding,origin);}
    catch(error){return {reason:error.message};}
  }
  const headerPlan=mergeProbeHeaders(source,action,descriptor,origin);
  const capabilities=[...headerPlan.issues];
  const requestAction={...action,...Object.fromEntries(Object.entries(descriptor).filter(([k])=>!['url','httpHeaders','httpParams','POST'].includes(k)))};
  if(expressionMode&&encoding!=='utf-8')capabilities.push(issue('requestInfo.encoding','受限表达式中的 encodeURIComponent 按 UTF-8 解释，不能证明与自定义参数编码完全等价'));
  if((OWN(requestAction,'webView')||OWN(source,'webView'))&&enabled(inherited(source,requestAction,'webView')))capabilities.push(issue('webView','未执行 WebView，仅获取静态 HTTP 页面'));
  for(const key of ['webViewSniff','webViewContentRules','webViewJs','JSParser','requestJavascript','responseJavascript','requestFunction','responseFunction','responseDecryptType']){
    if(inherited(source,requestAction,key))capabilities.push(issue(key,'未执行 App 动态钩子或网页脚本'));
  }
  if(action.parserID&&action.parserID!=='DOM')capabilities.push(issue('parserID','当前读取链仅执行 DOM 解析'));
  if(action.responseFormatType&&!['html','json'].includes(action.responseFormatType))capabilities.push(issue('responseFormatType','当前读取链仅解析 HTML 和 JSON'));
  if(action.nextPageUrl)capabilities.push(issue('nextPageUrl','尚未验证后续分页，当前只检查第一页'));
  if(action.moreKeys?.skipCount)capabilities.push(issue('moreKeys.skipCount','尚未执行列表跳过条目配置'));
  if(descriptor.url.includes('%@pageIndex')||expressionInputs.includes('params.pageIndex'))capabilities.push(issue('requestInfo.pageIndex','页号模板只展开为第一页，尚未检查后续页'));
  return {url:url.href,usedResult,requestInfoMissing:missing,staticRequest:expressionMode?'bounded-data-expression':descriptor.generated?'converter-get-template':'plain-get',forbidCookie:!!descriptor.forbidCookie,
    method,body,requestEncoding:encoding,responseEncoding,headers:headerPlan.headers,
    requestCapabilities:{method,expressionMode,formFields:method==='POST'?Object.keys(params):[],headersApplied:headerPlan.names,headersSkipped:headerPlan.skipped,requestEncoding:encoding,responseEncoding:responseEncoding||'auto',unchecked:capabilities},
    capabilitiesChecked:!missing&&!capabilities.length};
}
