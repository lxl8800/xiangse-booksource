"use strict";
/* A bounded, data-only JSONPath subset. Unknown expressions are diagnosed;
 * no eval, Function, script filters or uploaded JavaScript is executed. */
var OWN=function(value,key){return value!==null&&typeof value==="object"&&Object.prototype.hasOwnProperty.call(value,key);};
var NAME=/^[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*/;
function quoted(text){
  if(text[0]==='"')return JSON.parse(text);
  if(text[0]!=="'"||text[text.length-1]!=="'")throw Error("非法 JSONPath 属性名");
  var out="";
  for(var i=1;i<text.length-1;i++){
    var c=text[i];
    if(c==="\\"){
      var e=text[++i];
      if(e==="'")out+="'";
      else if(e==='u'){var h=text.slice(i+1,i+5);if(!/^[0-9a-f]{4}$/i.test(h))throw Error("非法 Unicode 转义");out+=String.fromCharCode(parseInt(h,16));i+=4;}
      else if('"/\\bfnrt'.indexOf(e)>=0)out+=JSON.parse('"\\'+e+'"');
      else throw Error("不支持的属性名转义");
    }else {if(c==="'"||c.charCodeAt(0)<32)throw Error("非法属性名");out+=c;}
  }
  return out;
}
function parts(text){
  var result=[],start=0,q="",escaped=false;
  for(var i=0;i<text.length;i++){
    var c=text[i];
    if(q){if(escaped)escaped=false;else if(c==="\\")escaped=true;else if(c===q)q="";continue;}
    if(c==='"'||c==="'"){q=c;continue;}
    if(c===","){result.push(text.slice(start,i).trim());start=i+1;}
  }
  if(q)throw Error("JSONPath 字符串未结束");
  result.push(text.slice(start).trim());return result;
}
function atom(text){
  if(text==="*")return {type:"wildcard"};
  if(text[0]==='"'||text[0]==="'")return {type:"name",key:quoted(text)};
  if(/^-?(?:0|[1-9]\d*)$/.test(text)){
    var n=Number(text);if(!Number.isSafeInteger(n))throw Error("索引超出精度范围");
    return {type:"index",index:n};
  }
  if(/^-?\d*:-?\d*(?::-?\d+)?$/.test(text)){
    var p=text.split(":").map(function(x){return x===""?null:Number(x);});
    if(p.some(function(x){return x!==null&&!Number.isSafeInteger(x);})||p[2]===0)throw Error("不支持的切片参数");
    return {type:"slice",start:p[0],end:p[1],step:p[2]==null?1:p[2]};
  }
  throw Error("不支持的 JSONPath 索引、函数或脚本表达式");
}
function filter(text){
  var m=text.match(/^\?\(\s*(@.*?)\s*(==|!=|<=|>=|<|>)\s*(.*?)\s*\)$/);
  if(!m)throw Error("仅支持静态字段与标量的单个比较筛选");
  var left=parse("$"+m[1].slice(1));
  if(left.some(function(x){return x.recursive||x.selectors.length!==1||!["name","index"].includes(x.selectors[0].type);}))throw Error("筛选左侧必须是单值属性路径");
  var value=m[3][0]==="'"?quoted(m[3]):JSON.parse(m[3]);
  if(value!==null&&typeof value==="object")throw Error("筛选右侧仅支持标量");
  if(["<",">","<=",">="].includes(m[2])&&typeof value!=="number")throw Error("有序筛选仅支持数字");
  return {type:"filter",path:left,operator:m[2],value:value};
}
function parse(rule){
  var text=String(rule||"").trim();if(text.length>4096||!text)throw Error("JSONPath 为空或过长");
  if(text.indexOf("@json:")===0)text=text.slice(6).trim();
  if(text[0]!=="$"){
    if(/^[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*(?:\/[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*)+$/.test(text))text=text.replace(/\//g,".");
    if(!NAME.test(text))throw Error("JSONPath 必须是 $ 路径或静态相对键");
    text="$."+text;
  }
  var tokens=[],i=1;
  while(i<text.length){
    if(tokens.length>=64)throw Error("JSONPath 层数过多");
    var recursive=false;
    if(text.slice(i,i+2)===".."){recursive=true;i+=2;}
    else if(text[i]==="."){i++;}
    else if(text[i]!=="[")throw Error("无法识别的 JSONPath 语法");
    var selectors;
    if(text[i]==="["){
      var begin=++i,depth=1,q="",escaped=false;
      while(i<text.length&&depth){
        var c=text[i];
        if(q){if(escaped)escaped=false;else if(c==="\\")escaped=true;else if(c===q)q="";}
        else if(c==='"'||c==="'")q=c;
        else if(c==="[")depth++;
        else if(c==="]")depth--;
        if(depth)i++;
      }
      if(depth||q)throw Error("JSONPath 方括号未闭合");
      var inside=text.slice(begin,i).trim();i++;
      if(inside.indexOf("?(")===0)selectors=[filter(inside)];
      else selectors=parts(inside).map(atom);
    }else if(text[i]==="*"){selectors=[{type:"wildcard"}];i++;}
    else{
      var name=text.slice(i).match(NAME);if(!name)throw Error("JSONPath 缺少属性名");
      selectors=[{type:"name",key:name[0]}];i+=name[0].length;
    }
    tokens.push({recursive:recursive,selectors:selectors});
  }
  return tokens;
}
function evaluateJsonPath(data,rule,options){
  options=options||{};var budget=Math.min(20000,Math.max(1,options.maxOperations||20000)),operations=0,maxMatches=Math.min(4096,options.maxMatches||4096);
  function tick(){if(++operations>budget)throw Error("JSONPath 检测超过遍历预算");}
  function select(value,selector){
    tick();
    if(selector.type==="name")return OWN(value,selector.key)?[value[selector.key]]:[];
    if(selector.type==="index"){
      if(!Array.isArray(value))return [];
      var i=selector.index<0?value.length+selector.index:selector.index;
      return i>=0&&i<value.length?[value[i]]:[];
    }
    if(selector.type==="wildcard"){var children=value&&typeof value==="object"?Object.values(value):[];if(children.length>maxMatches)throw Error("JSONPath 匹配超过数量预算");return children;}
    if(selector.type==="slice"){
      if(!Array.isArray(value))return [];
      var n=value.length,step=selector.step,normalize=function(x,positive){x=x<0?n+x:x;return positive?Math.min(n,Math.max(0,x)):Math.min(n-1,Math.max(-1,x));};
      var start=selector.start===null?(step>0?0:n-1):normalize(selector.start,step>0);
      var end=selector.end===null?(step>0?n:-1):normalize(selector.end,step>0),out=[];
      for(var j=start;step>0?j<end:j>end;j+=step){tick();out.push(value[j]);if(out.length>maxMatches)throw Error("JSONPath 匹配超过数量预算");}
      return out;
    }
    if(selector.type==="filter"){
      var rows=value&&typeof value==="object"?Object.values(value):[],matched=[];
      for(var row of rows){
        tick();var v=row,exists=true;
        for(var token of selector.path){var values=select(v,token.selectors[0]);if(!values.length){exists=false;break;}v=values[0];}
        var same=exists&&v===selector.value,op=selector.operator;
        var accepted=op==="=="?same:op==="!="?!same:exists&&typeof v==="number"&&(op==="<"?v<selector.value:op===">"?v>selector.value:op==="<="?v<=selector.value:v>=selector.value);
        if(accepted)matched.push(row);
        if(matched.length>maxMatches)throw Error("JSONPath 匹配超过数量预算");
      }
      return matched;
    }
    return [];
  }
  try{
    var tokens=parse(rule),values=[data];
    for(var token of tokens){
      var out=[];
      for(var value of values){
        var stack=[{value:value,depth:0}];
        while(stack.length){
          tick();var current=stack.pop();
          for(var selector of token.selectors){out.push.apply(out,select(current.value,selector));if(out.length>maxMatches)throw Error("JSONPath 匹配超过数量预算");}
          if(token.recursive&&current.value&&typeof current.value==="object"){
            if(current.depth>=64)throw Error("JSONPath 递归超过深度预算");
            var children=Object.values(current.value);if(children.length+stack.length>20000)throw Error("JSONPath 递归超过遍历预算");
            for(var i=children.length-1;i>=0;i--)stack.push({value:children[i],depth:current.depth+1});
          }
        }
      }
      values=out;
    }
    return {values:values,total:values.length,operations:operations};
  }catch(error){return {values:[],total:0,reason:"JSONPath 无法安全解析："+String(error.message).slice(0,150)};}
}
module.exports={evaluateJsonPath:evaluateJsonPath};
