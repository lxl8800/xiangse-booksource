import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
const {evaluateJsonPath}=createRequire(import.meta.url)('../converter/lib/jsonPath.js');
export function acceptsResponse(response,action){
  const format=action?.responseFormatType||'html';
  return response.status==='ok'&&(format==='json'||format==='html'&&response.kind==='html');
}
export function parseResponseDocument(response,action){
  const format=action?.responseFormatType||'html';
  if(!acceptsResponse(response,action))throw Error('响应不能按配置的 '+format+' 解析');
  if(format==='html')return new JSDOM(response.body,{url:response.url}).window.document;
  let data;
  try{data=JSON.parse(response.body);}
  catch{throw Error('JSON 响应语法错误或实际为 HTML/验证码页面');}
  return {isJsonDocument:true,jsonData:data,URL:response.url,title:'',querySelector:()=>null,querySelectorAll:()=>[]};
}
function wrap(value){
  const scalar=value===null?'':typeof value==='object'?'':String(value);
  return {jsonValue:value,nodeValue:scalar,textContent:scalar};
}
export function evaluateJsonField(doc,context,rule,count=50,listMode=false){
  const data=context===doc?doc.jsonData:context?.jsonValue;
  const result=evaluateJsonPath(data,rule);
  if(result.reason)return {nodes:[],values:[],total:0,reason:result.reason};
  let values=result.values;
  if(listMode){
    const flat=[];let total=0;
    for(const value of values){
      for(const item of Array.isArray(value)?value:[value]){
        total++;if(total>10000)return {nodes:[],values:[],total,reason:'JSON 列表超过条目预算'};
        if(flat.length<count)flat.push(item);
      }
    }
    return {nodes:flat.map(wrap),total,values:flat.map(x=>wrap(x).nodeValue),jsonValues:flat};
  }
  if(values.some(v=>v!==null&&typeof v==='object'))return {nodes:values.slice(0,count).map(wrap),total:values.length,values:[],
    reason:'JSON 字段返回对象或数组，不能猜测字符串化或运行转换脚本'};
  const selected=values.slice(0,count);
  return {nodes:selected.map(wrap),total:values.length,values:selected.map(v=>wrap(v).nodeValue),jsonValues:selected};
}
