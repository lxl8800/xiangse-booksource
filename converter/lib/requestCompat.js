"use strict";
// Pure data helpers shared by the converter and the safe HTTP inspector.
// No Node APIs and no evaluation of source-supplied JavaScript.
function charsetLabel(value) {
  if (value === undefined || value === null || value === "") return null;
  var raw=String(value).trim().toLowerCase();
  var aliases={"2147485234":"gbk","2147485232":"gb2312","utf8":"utf-8","utf-8":"utf-8","gbk":"gbk","gb2312":"gb2312"};
  return Object.prototype.hasOwnProperty.call(aliases,raw)?aliases[raw]:null;
}
function parseHeaderData(value) {
  if(value===undefined||value===null||value==="")return {headers:{}};
  if(typeof value==="string"){
    if(value.length>4096)return {reason:"请求头 JSON 超出大小限制"};
    try{value=JSON.parse(value);}catch(e){return {reason:"请求头不是可静态解析的 JSON 对象"};}
  }
  if(!value||typeof value!=="object"||Array.isArray(value))return {reason:"请求头必须是对象或 JSON 对象字符串"};
  var keys=Object.keys(value);
  if(keys.length>24)return {reason:"请求头字段过多"};
  var headers={};
  for(var i=0;i<keys.length;i++){
    var key=keys[i],item=value[key];
    if(!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(key)||typeof item!=="string"||item.length>2048)return {reason:"请求头名称或值不是受限的静态字符串"};
    Object.defineProperty(headers,key,{value:item,enumerable:true,writable:true,configurable:true});
  }
  return {headers:headers};
}
module.exports={charsetLabel:charsetLabel,parseHeaderData:parseHeaderData};
