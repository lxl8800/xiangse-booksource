import {createRequire} from 'node:module';
const {describeStaticGetRequest}=createRequire(import.meta.url)('../converter/lib/urlRule.js');
/** Bounded, read-only evidence formatting. Does not execute any rule. */
const SENSITIVE=/token|api[_-]?key|secret|password|cookie|authorization|signature|session|credential/i;
export function redactText(value) {
  return String(value??'')
    .replace(/(https?:\/\/)[^/\s"'<>]*@/gi,'$1[redacted]@')
    .replace(/((?:[?&]|&amp;)(?:[^=&#\s"'<>]*)(?:token|api[_-]?key|secret|password|cookie|auth|signature|session)[^=&#\s"'<>]*=)[^&#\s"'<>]*/gi,'$1[redacted]');
}
export function redactUrl(value,base) {
  try {
    const url=new URL(value,base);
    url.username='';url.password='';
    for(const key of [...url.searchParams.keys()])
      if(SENSITIVE.test(key)||/^auth$/i.test(key))url.searchParams.set(key,'[redacted]');
    return url.href;
  }catch{return redactText(value).slice(0,240);}
}
export function splitXPathPipeline(rule) {
  const text=String(rule??'').trim();
  let quote=null,depth=0;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(quote){if(ch===quote)quote=null;continue;}
    if(ch==='"'||ch==="'"){quote=ch;continue;}
    if(ch==='['||ch==='(')depth++;
    else if(ch===']'||ch===')')depth--;
    else if(ch==='|'&&text[i+1]==='|'&&depth===0)
      return {xpath:text.slice(0,i).trim(),postprocess:true};
  }
  return {xpath:text,postprocess:text.startsWith('@js:')};
}
export function nodeText(node) {
  return String(node?.nodeValue??node?.textContent??'').trim();
}
export function sanitizeEvidence(report,source) {
  const secrets=new Set();
  let visited=0;
  function remember(value){
    if(typeof value!=='string'||value.length<6||value.length>4000)return;
    secrets.add(value);secrets.add(encodeURIComponent(value));
  }
  function inspect(value,key=''){
    if(++visited>2000)return;
    if(typeof value==='string'){
      if(key==='requestInfo'){
        const request=describeStaticGetRequest(value);
        if(request?.httpHeaders)inspect(request.httpHeaders,'httpHeaders');
      }
      if(SENSITIVE.test(key)){
        remember(value);
        if(/authorization/i.test(key))remember(value.replace(/^(?:Bearer|Basic)\s+/i,''));
        if(/cookie/i.test(key))for(const pair of value.split(';')){
          const pos=pair.indexOf('=');if(pos>=0)remember(pair.slice(pos+1).trim());
        }
      }
      for(const match of value.matchAll(/[?&]([^=&\s]+)=([^&#\s"'<>]+)/g)){
        if(SENSITIVE.test(match[1])||/^auth$/i.test(match[1])){
          remember(match[2]);try{remember(decodeURIComponent(match[2]));}catch{}
        }
      }
      if(/^(header|httpHeaders|httpParams)$/i.test(key)){
        try{inspect(JSON.parse(value));}catch{}
      }
    }else if(value&&typeof value==='object'){
      for(const [name,item] of Object.entries(value))inspect(item,name);
    }
  }
  inspect(source);
  function clean(value,depth=0){
    if(depth>10)return '[omitted]';
    if(typeof value==='string'){
      let text=redactText(value);
      for(const secret of secrets)text=text.replaceAll(secret,'[redacted]');
      return text.slice(0,2200);
    }
    if(Array.isArray(value))return value.slice(0,100).map(x=>clean(x,depth+1));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,80).map(([key,item])=>[key,clean(item,depth+1)]));
    return value;
  }
  return clean({...report,reportVersion:1,verificationScope:'single-book-first-chapter-static-html',appVerified:false});
}
