"use strict";
var utils=require("./utils");
var legacy=require("./legacyLink");
/* Portable URL normalization for known URL fields. No browser globals or eval. */
function resolveHref(value, base) {
  var u=String(value==null?"":value).trim();
  if(!u)return "";
  if(/^https?:\/\//i.test(u))return u;
  if(/^[a-z][a-z0-9+.-]*:/i.test(u))return "";
  var b=String(base||"").trim().replace(/#.*$/,"");
  var match=b.match(/^(https?):\/\/[^/?#]+/i);
  if(!match)return "";
  var origin=match[0];
  if(u.slice(0,2)==="//")return match[1]+":"+u;
  if(u.charAt(0)==="#")return b+u;
  b=b.replace(/\?.*$/,"");if(b===origin)b+="/";
  if(u.charAt(0)==="?")return b+u;
  var suffix=u.match(/[?#].*$/),tail=suffix?suffix[0]:"";
  u=u.replace(/[?#].*$/,"");
  var path=u.charAt(0)==="/"?u:b.slice(origin.length).replace(/\/[^/]*$/,"/")+u;
  var parts=path.split("/"),stack=[];
  for(var i=0;i<parts.length;i++){
    var dot=parts[i].replace(/%2e/gi,".");
    if(dot===".."){
      if(stack.length>1)stack.pop();
      if(i===parts.length-1)stack.push("");
    }else if(dot==="."){
      if(i===parts.length-1)stack.push("");
    }else stack.push(parts[i]);
  }
  return origin+stack.join("/")+tail;
}
var RESOLVER_SCRIPT="return ("+resolveHref.toString()+")(result, String((typeof params!=='undefined'&&params.responseUrl)||(typeof config!=='undefined'&&config.host)||''));";
function compileLinkRule(rule){
  if(typeof rule!=="string"||!/^(\/|\.\/|\(|\$)/.test(rule.trim())||utils.splitTopLevel(rule,["||"]).length>1||/^@js:/.test(rule.trim()))return rule;
  return rule+"||@js:\n"+RESOLVER_SCRIPT;
}
function describeLinkRule(rule){
  if(typeof rule!=="string"||rule.length>14000)return null;
  var marker="||@js:\n",index=rule.indexOf(marker);
  if(index<=0)return null;
  var selector=rule.slice(0,index),script=rule.slice(index+marker.length);
  if(!/^(\/|\.\/|\(|\$)/.test(selector.trim()))return null;
  if(script===RESOLVER_SCRIPT)return {selector:selector,normalization:"response-url"};
  var known=legacy.recognizeLegacyResolver(script);
  if(known)return {selector:selector,normalization:"legacy-response-url",fallbackHost:known.fallbackHost};
  return null;
}
function resolveRecognizedLink(value,base,descriptor){return descriptor&&descriptor.normalization==="legacy-response-url"?legacy.resolveLegacyHref(value,base,descriptor.fallbackHost):resolveHref(value,base);}
module.exports={resolveRecognizedLink:resolveRecognizedLink,resolveHref:resolveHref,compileLinkRule:compileLinkRule,describeLinkRule:describeLinkRule};
