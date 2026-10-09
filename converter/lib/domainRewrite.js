"use strict";
/** Apply a *verified* permanent domain move to URL-bearing fields only.
 * Never rewrite arbitrary XPath/HTML, source names, user headers or CDN hosts.
 */
function canonicalOrigin(raw) {
  try {
    var url=new URL(String(raw||'').trim());
    if(!/^https?:$/.test(url.protocol)||url.username||url.password)return null;
    return url.origin;
  }catch(e){return null;}
}
function replaceOrigin(text, oldOrigin, newOrigin) {
  if(typeof text!=='string'||!oldOrigin)return text;
  var cursor=0,out='';
  while(cursor<text.length) {
    var at=text.indexOf(oldOrigin,cursor);
    if(at<0){out+=text.slice(cursor);break;}
    var next=text.charAt(at+oldOrigin.length);
    var prev=text.charAt(at-1);
    // Only match exact URL authorities (not old.tld.evil or credentials).
    var follows=!next || '/?# \t\r\n"\'\x60;)}>,'.includes(next);
    if(follows && next!=='@' && prev!=='@'){
      out+=text.slice(cursor,at)+newOrigin;
    }else{
      out+=text.slice(cursor,at+oldOrigin.length);
    }
    cursor=at+oldOrigin.length;
  }
  return out;
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
    if(typeof before!=='string' || !/^https?:\/\//i.test(before))continue;
    var after=replaceOrigin(before,oldOrigin,newOrigin);
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
  if(allModules.some(function(m){return m && Object.keys(m).some(function(k){return typeof m[k]==='string' && m[k].indexOf('@js:')>=0 && m[k].indexOf(oldOrigin)>=0;});})){
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
