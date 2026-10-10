"use strict";
/** Apply a *verified* permanent domain move to URL-bearing fields only.
 * Never rewrite arbitrary XPath/HTML, source names, user headers or CDN hosts.
 */
var urlRule=require("./urlRule");
function canonicalOrigin(raw) {
  try {
    var url=new URL(String(raw||'').trim());
    if(!/^https?:$/.test(url.protocol)||url.username||url.password)return null;
    return url.origin;
  }catch(e){return null;}
}
function replaceOrigin(text, oldOrigin, newOrigin) {
  if(typeof text!=='string'||!oldOrigin||!newOrigin)return text;
  // Only replace the leading authority. Query values, tokens and nested URLs
  // are data and must remain byte-for-byte unchanged.
  var authority=text.match(/^https?:\/\/[^/?#\s]+/i);
  if(!authority||canonicalOrigin(authority[0])!==oldOrigin)return text;
  return newOrigin+text.slice(authority[0].length);
}
function rewriteTrustedHeaders(h, oldOrigin, newOrigin, changes, path){
  if(!h||typeof h!=='object'||Array.isArray(h))return;
  for(var name in h){
    if(!Object.prototype.hasOwnProperty.call(h,name)||! /^(referer|origin)$/i.test(name))continue;
    var before=h[name],after=replaceOrigin(before,oldOrigin,newOrigin);
    if(before!==after){h[name]=after;changes.push({path:path+'.'+name,oldValue:before,newValue:after});}
  }
}
function rewriteModuleFields(module, oldOrigin,newOrigin,changes,path){
  if(!module||typeof module!=='object'||Array.isArray(module))return;
  var fields=['host','requestInfo','url','detailUrl','chapterListUrl','nextPageUrl','cover'];
  for(var i=0;i<fields.length;i++){
    var field=fields[i],before=module[field];
    if(typeof before!=='string')continue;
    var after=field==="requestInfo" ? urlRule.rewriteStaticGetOrigin(before,oldOrigin,newOrigin) : /^https?:\/\//i.test(before) ? replaceOrigin(before,oldOrigin,newOrigin) : before;
    if(after!==before){
      module[field]=after;
      changes.push({path:path+'.'+field,oldValue:before,newValue:after});
    }
  }
  rewriteTrustedHeaders(module.httpHeaders,oldOrigin,newOrigin,changes,path+'.httpHeaders');
}
function applyVerifiedDomainMove(source, verifiedMove) {
  if(!source||typeof source!=='object'||!verifiedMove||verifiedMove.status!=='verified'||verifiedMove.autoApply!==true){
    return {source:source,changes:[],applied:false};
  }
  var oldOrigin=canonicalOrigin(verifiedMove.oldOrigin);
  var newOrigin=canonicalOrigin(verifiedMove.newOrigin);
  if(!oldOrigin||!newOrigin||oldOrigin===newOrigin||canonicalOrigin(source.sourceUrl)!==oldOrigin){
    return {source:source,changes:[],applied:false};
  }
  var allModules=['searchBook','bookDetail','chapterList','chapterContent'].map(function(k){return source[k];}).concat(Object.values(source.bookWorld||{}));
  if(allModules.some(function(m){return m && Object.keys(m).some(function(k){return typeof m[k]==='string' && m[k].indexOf('@js:')>=0 && m[k].toLowerCase().indexOf(oldOrigin.toLowerCase())>=0 && !(k==='requestInfo' && urlRule.describeStaticGetRequest(m[k]));});})){
    return {source:source,changes:[],applied:false,needsReview:true,reason:'动态脚本包含旧域名，不能用字符串替换修改 Cookie/Token 或代码文本；需字段级候选与复测'};
  }
  var result=JSON.parse(JSON.stringify(source)),changes=[];
  var before=result.sourceUrl;
  result.sourceUrl=replaceOrigin(before,oldOrigin,newOrigin);
  if(before!==result.sourceUrl)changes.push({path:'sourceUrl',oldValue:before,newValue:result.sourceUrl});
  var sections=['searchBook','bookDetail','chapterList','chapterContent'];
  for(var i=0;i<sections.length;i++){
    var module=sections[i];
    rewriteModuleFields(result[module],oldOrigin,newOrigin,changes,module);
  }
  rewriteTrustedHeaders(result.httpHeaders,oldOrigin,newOrigin,changes,'httpHeaders');
  for(var key in result.bookWorld){
    if(Object.prototype.hasOwnProperty.call(result.bookWorld,key)){
      rewriteModuleFields(result.bookWorld[key],oldOrigin,newOrigin,changes,'bookWorld.'+key);
    }
  }
  return {source:result,changes:changes,applied:changes.length>0};
}
module.exports={applyVerifiedDomainMove:applyVerifiedDomainMove,canonicalOrigin:canonicalOrigin,replaceOrigin:replaceOrigin};
