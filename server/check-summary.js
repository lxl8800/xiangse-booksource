import {redactText} from './evidence-report.js';

/** A deterministic interpretation of sampled evidence, not a source repair.
 * HTTP 200 or a reachable homepage is never enough for a verified result.
 * No model, persistence, source edits, or JavaScript evaluation here.
 */
export const CHECK_STATES=Object.freeze({
 verified:'样本规则通过',partial:'部分验证',rules:'规则需修复',no_results:'搜索无结果',
 unreachable:'网络不可达',restricted:'访问受限',unsupported:'检测能力受限',error:'检测异常'
});
const REQUIRED=['search','detail','chapterList','chapterContent'];
const narrow=x=>redactText(String(x??'')).slice(0,400);
const number=x=>Number.isFinite(x)?Math.max(0,x):null;
const suggestions={
 verified:'本次关键词与抽样章节已通过静态 HTTP/DOM 检测；仍需官方 iOS App 验证。',
 partial:'展开证据检查 JS、编码及分页限制；未验证的部分不能标记为已修复。',
 rules:'有响应但现有字段提取或请求配置存在问题；可在单源检测中生成候选并独立复测。',
 no_results:'先尝试站点确实收录的小说名；搜索无结果不证明整个站点失效，也不要据此盲改 XPath。',
 unreachable:'保留原规则，检查 DNS、证书、站点状态或稍后重试；网络失败不能靠猜 XPath 修复。',
 restricted:'站点拒绝访问或存在验证/认证限制；不绕过限制，不自动替换源。',
 unsupported:'存在动态 JS、WebView、POST、跨站或安全限制；保留规则和诊断，使用允许的环境或目标 App 验证。',
 error:'检测未生成可信证据，保留原书源；查看错误并在问题解决后重试。'
};
export function summarizeEvidence(evidence){
 const ev=evidence&&typeof evidence==='object'?evidence:{};
 const rows=Array.isArray(ev.steps)?ev.steps.slice(0,12):[];
 const byStep=new Map(rows.map(s=>[s.step,s]));
 const required=REQUIRED.map(s=>byStep.get(s));
 const actual=required.filter(Boolean);
 const reasons=[];
 const add=value=>{const v=narrow(value);if(v&&!reasons.includes(v)&&reasons.length<16)reasons.push(v);};
 let state='partial';
 let failed=actual.find(s=>s.status!=='ok'&&s.status!=='skipped');
 // Detail request may succeed even if a homepage is blocked; judge the reading
 // chain rather than assuming the homepage is mandatory for all source types.
 if(failed){
   const status=failed.status;
   if(['blocked','forbidden','rate-limited'].includes(status)||[401,403,429].includes(failed.httpStatus))state='restricted';
   else if(['timeout','network-error','dns-error','tls-error','http-error'].includes(status))state='unreachable';
   else if(['unsupported','redirect'].includes(status))state='unsupported';
   else if(status==='no-results')state=failed.step==='search'&&!(Number(failed.count)>0||Number(failed.configuredMatches)>0)?'no_results':'rules';
   else state='error';
   add((failed.step||'')+'：'+(failed.reason||failed.status));
 }else if(required.some(s=>!s||s.status!=='ok')){
   state='unsupported';
   add('阅读链未完成：至少一项不存在、跳过或未取得有效响应');
 }
 let capabilityGap=false,ruleGap=false;
 for(const row of rows){
   for(const field of row.fieldChecks||[]){
     if(['invalid','no-results','multiple-values','scope-warning'].includes(field.status))ruleGap=true;
     if(field.status!=='ok'){capabilityGap=true;add(row.step+'.'+field.field+'：'+(field.note||field.status));}
   }
   for(const gap of row.requestCapabilities?.unchecked||[]){capabilityGap=true;add(row.step+'.'+gap.field+'：'+gap.reason);}
   if(row.requestInfoMissing||row.bodyTruncated||row.extractionTruncated){capabilityGap=true;add(row.step+'：缺少请求配置或样本被安全上限截断');}
   if(row.pagination && (row.pagination.complete!==true||row.pagination.fullyChecked===false)){
     capabilityGap=true;add(row.step+' 分页：'+(row.pagination.reason||'分页或后处理未完成验证'));
   }
   if(row.recoveredRequest||row.autoDiscovered){ruleGap=true;add(row.step+' 使用自动发现的替代地址/规则，原配置不能视为通过');}
 }
 for(const message of (Array.isArray(ev.diagnostics)?ev.diagnostics:[]))add(message);
 const chain=required.every(s=>s&&s.status==='ok');
 if(chain){
   if(ruleGap)state='rules';
   else if(ev.fullyVerified===true && !capabilityGap)state='verified';
   else state='partial';
 }else if(!rows.length){state='error';add('没有可检查的阅读链证据');}
 return {
   state,label:CHECK_STATES[state],verificationScope:'sampled-static-http-reading-chain',appVerified:false,
   httpChainVerified:chain,fullyVerified:state==='verified',
   failureStage:failed?.step||(!chain?REQUIRED.find((_,i)=>!required[i]||required[i].status!=='ok'):null),
   reasons,suggestion:suggestions[state],
   stages:REQUIRED.map(name=>{const s=byStep.get(name);return {name,status:s?.status||'not-tested',httpStatus:number(s?.httpStatus),count:number(s?.count),contentLength:number(s?.contentLength),pages:number(s?.pagination?.pagesRequested),paginationComplete:s?.pagination?!!s.pagination.complete:null};}),
   checkedAt:typeof ev.verifiedAt==='string'?ev.verifiedAt:null
 };
}
export function summarizeCheckError(error){
 const message=narrow(error?.message||'检测未完成');
 const restricted=/白名单|不允许|禁止|不安全|not allowed|unsupported|动态|协议/i.test(message);
 return {state:restricted?'unsupported':'error',label:CHECK_STATES[restricted?'unsupported':'error'],
   fullyVerified:false,httpChainVerified:false,appVerified:false,failureStage:null,stages:[],reasons:[message],
   suggestion:suggestions[restricted?'unsupported':'error'],verificationScope:'not-tested',checkedAt:new Date().toISOString()};
}
