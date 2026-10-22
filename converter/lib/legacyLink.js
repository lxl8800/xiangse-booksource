"use strict";
/* Older converter versions emitted this exact URL resolver as a JS pipeline.
 * Match its complete AST (one literal host wildcard only), then call reviewed
 * local code. The uploaded loop is NEVER evaluated. Any extra node invalidates
 * the match, including dead code or a changed statement ordering.
 */
var acorn=require('acorn');
var FALLBACK='https://legacy-resolver.invalid';
var TEMPLATE="var u=String(result==null?'':result).trim();\n"+
"if(!u)return '';\n"+
"if(/^(https?:|data:|blob:)/i.test(u))return u;\n"+
"var b=String((typeof params!=='undefined'&&params.responseUrl)||\""+FALLBACK+"\").replace(/[?#].*$/,'');\n"+
"var m=b.match(/^(https?):\\/\\/[^/]+/i);if(!m)return u;\n"+
"var origin=m[0];\n"+
"if(u.slice(0,2)==='//')return m[1]+':'+u;\n"+
"if(u.charAt(0)==='?')return b+u;\n"+
"if(u.charAt(0)==='#')return b+u;\n"+
"var path=u.charAt(0)==='/'?u:b.slice(origin.length).replace(/\\/[^/]*$/,'/')+u;\n"+
"var parts=path.split('/'),stack=[];\n"+
"for(var i=0;i<parts.length;i++){\n"+
"if(parts[i]==='..'){if(stack.length>1)stack.pop();}\n"+
"else if(parts[i]==='.'||parts[i]===''){if(i===0)stack.push('');}\n"+
"else stack.push(parts[i]);\n"+
"}\n"+
"return origin+stack.join('/');";
var options={ecmaVersion:2020,allowReturnOutsideFunction:true};
var expected=acorn.parse(TEMPLATE,options),cache=new Map();
function signature(node){
 if(node===null||typeof node!=='object')return node;
 if(Array.isArray(node))return node.map(signature);
 if(node.type==='Literal'&&node.regex)return {type:'Literal',regex:node.regex};
 var result={};
 for(var key of Object.keys(node))if(!['start','end','raw'].includes(key))result[key]=signature(node[key]);
 return result;
}
var pattern=signature(expected);
function recognizeLegacyResolver(script){
 if(typeof script!=='string'||script.length>6000)return null;
 var raw=script.replace(/^\s*@js:\s*/i,'');
 if(cache.has(raw))return cache.get(raw);
 var fallback=null;
 function same(template,input){
  if(template&&typeof template==='object'){
    if(!input||typeof input!=='object'||Array.isArray(template)!==Array.isArray(input))return false;
    if(template.type==='Literal'&&template.value===FALLBACK){
      if(input.type!=='Literal'||typeof input.value!=='string')return false;
      try{var url=new URL(input.value);if(!/^https?:$/.test(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/')return false;fallback=input.value;return true;}catch(e){return false;}
    }
    var keys=Object.keys(template),other=Object.keys(input);
    if(keys.length!==other.length)return false;
    return keys.every(function(k){return Object.prototype.hasOwnProperty.call(input,k)&&same(template[k],input[k]);});
  }
  return template===input;
 }
 var out=null;
 try{if(same(pattern,signature(acorn.parse(raw,options)))&&fallback)out={fallbackHost:fallback};}catch(e){}
 if(cache.size>=48)cache.delete(cache.keys().next().value);
 cache.set(raw,out);return out;
}
function resolveLegacyHref(value,responseUrl,fallbackHost){
 var u=String(value==null?'':value).trim();
 if(!u||u.length>8192)return '';
 if(/^(https?:|data:|blob:)/i.test(u))return u;
 var b=String(responseUrl||fallbackHost||'').replace(/[?#].*$/,'');
 if(b.length>8192)return '';
 var m=b.match(/^(https?):\/\/[^/]+/i);if(!m)return u;
 var origin=m[0];
 if(u.slice(0,2)==='//')return m[1]+':'+u;
 if(u.charAt(0)==='?')return b+u;
 if(u.charAt(0)==='#')return b+u;
 var path=u.charAt(0)==='/'?u:b.slice(origin.length).replace(/\/[^/]*$/,'/')+u;
 var parts=path.split('/'),stack=[];
 for(var i=0;i<parts.length;i++){
  if(parts[i]==='..'){if(stack.length>1)stack.pop();}
  else if(parts[i]==='.'||parts[i]===''){if(i===0)stack.push('');}
  else stack.push(parts[i]);
 }
 return origin+stack.join('/');
}
module.exports={recognizeLegacyResolver:recognizeLegacyResolver,resolveLegacyHref:resolveLegacyHref};
