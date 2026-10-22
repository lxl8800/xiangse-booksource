"use strict";
/* Bounded data-expression interpreter, NOT a JavaScript sandbox.
 * Acorn only parses. Every node (including unselected branches) is validated.
 * No eval, Function, vm, arbitrary functions, loops, prototype access, I/O,
 * DOM, imports, async, getters, callbacks or user-defined regular expressions.
 * Allowed operations are implemented explicitly below over copied JSON data.
 */
var acorn=require('acorn');
var LIMIT={source:10000,nodes:600,depth:36,steps:1800,string:24000,keys:120,dataNodes:600};
var DENIED=new Set(['__proto__','prototype','constructor','caller','callee','arguments','__defineGetter__','__defineSetter__','__lookupGetter__','__lookupSetter__']);
var INPUTS=new Set(['params','config','result']);
var CALLS=new Set(['String','Number','parseInt','encodeURIComponent','encodeURI']);
var METHODS=new Set(['trim','charAt','substr','substring','slice','indexOf','startsWith','endsWith','replace','split','match','test']);
// Fixed, individually reviewed, linear/simple patterns used for URL handling.
var REGEXES=[/^https?:\/\//i,/^\/\//,/^\//,/\/$/,/\/+$/,/^\/+/,/\s+/,/\s+/g,/#.*$/,/\?.*$/,
 /\/book\/([a-f0-9-]{36})\.html(?:[?#].*)?$/i,/\/(?:book|chapter)\/(\d+)/,
 /index_(\d+)\.html/,/\/(\d+)(?:_\d+)?\.html/,/\/(\d+)_([0-9]+)\.html/,
 /^作者[：:]?/,/^简介[：:]?/,/作者[：:]/,/简介[：:]/];
var regexMap=new Map(REGEXES.map(function(r){return [r.source+'/'+r.flags,r];}));
var cache=new Map();
function fail(message){throw Error(message);}
function property(name){if(typeof name!=='string'||name.length>100||DENIED.has(name))fail('禁止原型、构造器或非法属性访问');return name;}
function keyOf(node){
 if(node.computed){if(node.property.type!=='Literal'||!['string','number'].includes(typeof node.property.value))fail('不支持动态计算属性');return property(String(node.property.value));}
 if(node.property.type!=='Identifier')fail('不支持的属性访问');return property(node.property.name);
}
function compile(raw){
 if(typeof raw!=='string'||raw.length>LIMIT.source)fail('规则脚本超过长度限制');
 var code=raw.replace(/^\s*@js:\s*/i,'');
 if(cache.has(code))return cache.get(code);
 var ast;
 try{ast=acorn.parse(code,{ecmaVersion:2020,sourceType:'script',allowReturnOutsideFunction:true});}
 catch(e){fail('规则不是可静态解析的表达式');}
 var count=0,declared=new Map(),used=new Set(),paths=new Set(),assigned=new Set();
 function visit(n,depth,scope){
  if(!n)return;
  if(++count>LIMIT.nodes||depth>LIMIT.depth)fail('规则语法树超过预算');
  var next=function(x){visit(x,depth+1,scope);};
  switch(n.type){
   case 'Program':n.body.forEach(next);break;
   case 'BlockStatement':n.body.forEach(function(x){visit(x,depth+1,'block');});break;
   case 'EmptyStatement':break;
   case 'ReturnStatement':if(!n.argument)fail('规则必须返回数据');next(n.argument);break;
   case 'IfStatement':next(n.test);next(n.consequent);next(n.alternate);break;
   case 'VariableDeclaration':
    if(scope==='block'&&n.kind!=='var')fail('暂不解释块级变量声明');
    n.declarations.forEach(function(d){
      if(d.id.type!=='Identifier')fail('不支持解构变量');
      var name=property(d.id.name);
      if(INPUTS.has(name)||CALLS.has(name)||['Math','undefined'].includes(name)||declared.has(name))fail('变量重复或覆盖受保护名称');
      if(declared.size>=64)fail('本地变量数量超过预算');
      declared.set(name,n.kind);if(d.init)next(d.init);
    });break;
   case 'ExpressionStatement':
    if(n.expression.type!=='AssignmentExpression'||n.expression.operator!=='='||n.expression.left.type!=='Identifier')fail('只允许对本地变量赋值');
    used.add(n.expression.left.name);assigned.add(n.expression.left.name);property(n.expression.left.name);next(n.expression.right);break;
   case 'Identifier':property(n.name);used.add(n.name);break;
   case 'Literal':
    if(n.regex){if(!regexMap.has(n.regex.pattern+'/'+n.regex.flags))fail('正则不在有限 URL 规则集合内');}
    else if(n.bigint||!(n.value===null||['string','number','boolean'].includes(typeof n.value)))fail('不支持的字面量');
    if(typeof n.value==='string'&&n.value.length>LIMIT.string)fail('字符串过长');break;
   case 'TemplateLiteral':
    n.quasis.forEach(function(q){if(q.value.cooked===null)fail('非法模板转义');});n.expressions.forEach(next);break;
   case 'ObjectExpression':{
    var keys=new Set();if(n.properties.length>LIMIT.keys)fail('对象字段过多');
    n.properties.forEach(function(p){
      if(p.type!=='Property'||p.kind!=='init'||p.method||p.computed)fail('对象只允许数据属性');
      var key=property(p.key.type==='Identifier'?p.key.name:String(p.key.value));
      if(keys.has(key))fail('重复对象字段');keys.add(key);next(p.value);
    });break;}
   case 'ArrayExpression':if(n.elements.length>LIMIT.keys||n.elements.some(x=>!x))fail('数组过大或含空位');n.elements.forEach(next);break;
   case 'MemberExpression':{
    keyOf(n);var parts=[],object=n;
    while(object.type==='MemberExpression'){parts.unshift(keyOf(object));object=object.object;}
    if(object.type==='Identifier'&&INPUTS.has(object.name))paths.add(object.name+'.'+parts.join('.'));
    next(n.object);break;}

   case 'UnaryExpression':if(!['!','+','-','typeof'].includes(n.operator))fail('不支持的一元运算');next(n.argument);break;
   case 'LogicalExpression':if(!['||','&&','??'].includes(n.operator))fail('不支持逻辑运算');next(n.left);next(n.right);break;
   case 'BinaryExpression':if(!['+','-','*','/','%','===','!==','==','!=','<','<=','>','>='].includes(n.operator))fail('不支持的二元运算');next(n.left);next(n.right);break;
   case 'ConditionalExpression':next(n.test);next(n.consequent);next(n.alternate);break;
   case 'CallExpression':
    if(n.optional||n.arguments.length>4||n.arguments.some(x=>x.type==='SpreadElement'))fail('不支持展开或可选调用');
    if(n.callee.type==='Identifier'){
      if(!CALLS.has(n.callee.name))fail('函数不在静态数据操作白名单');
    }else if(n.callee.type==='MemberExpression'){
      var key=keyOf(n.callee);
      if(n.callee.object.type==='Identifier'&&n.callee.object.name==='Math'){
        if(!['max','min'].includes(key))fail('只允许 Math.max/min');
      }else{if(!METHODS.has(key))fail('方法不在静态数据操作白名单');next(n.callee.object);}
    }else fail('禁止调用表达式、函数和构造器');
    n.arguments.forEach(next);break;
   default:fail('暂不支持的语法：'+n.type);
  }
 }
 visit(ast,0,'top');
 for(var id of used)if(!INPUTS.has(id)&&id!=='undefined'&&!declared.has(id))fail('未知变量或外部运行时依赖');
 for(var id of assigned)if(!declared.has(id)||declared.get(id)==='const')fail('只允许给已声明的可变本地变量赋值');
 var parsed={ast:ast,declared:declared,inputs:Array.from(paths),usesResult:used.has("result")};
 if(cache.size>=96)cache.delete(cache.keys().next().value);
 cache.set(code,parsed);return parsed;
}
function copyData(value,limit){
 var seen=0;
 function copy(v,depth){
  if(++seen>LIMIT.dataNodes||depth>14)fail('输入数据超过预算');
  if(v===null||v===undefined||typeof v==='boolean')return v;
  if(typeof v==='number'){if(!Number.isFinite(v))fail('输入数值非法');return v;}
  if(typeof v==='string'){if(v.length>limit)fail('输入字符串超过预算');return v;}
  if(typeof v!=='object')fail('输入必须为普通 JSON 数据');
  if(Array.isArray(v)){
    if(v.length>LIMIT.keys)fail('输入数组过大');
    var arr=[];
    for(var i=0;i<v.length;i++){
      var desc=Object.getOwnPropertyDescriptor(v,String(i));
      if(!desc||!Object.prototype.hasOwnProperty.call(desc,'value'))fail('禁止数组访问器或稀疏输入');
      arr.push(copy(desc.value,depth+1));
    }
    return arr;
  }
  var keys=Object.keys(v);if(keys.length>LIMIT.keys)fail('输入字段过多');
  var out=Object.create(null);
  for(var key of keys){property(key);var desc=Object.getOwnPropertyDescriptor(v,key);if(!desc||!Object.prototype.hasOwnProperty.call(desc,'value'))fail('禁止访问器属性');out[key]=copy(desc.value,depth+1);}
  return out;
 }
 return copy(value,0);
}
function evaluateStaticScript(raw,bindings){
 try{
  var parsed=compile(raw),env=Object.create(null),ready=new Set(),steps=0;
  var regexValues=new WeakMap();
  bindings=bindings||{};
  for(var name of INPUTS)env[name]=copyData(bindings[name],LIMIT.string);
  for(var pair of parsed.declared){env[pair[0]]=undefined;if(pair[1]==='var')ready.add(pair[0]);}
  function scalar(v){if(v!==null&&typeof v==='object')fail('对象不能隐式转换为字符串或数值');if(typeof v==='function'||typeof v==='symbol')fail('非法值');return v;}
  function text(v){return String(scalar(v));}
  function bounded(v){if(typeof v==='string'&&v.length>LIMIT.string)fail('表达式输出超过长度预算');if(Array.isArray(v)&&v.length>LIMIT.keys)fail('表达式数组超过预算');return v;}
  function value(n){
   if(++steps>LIMIT.steps)fail('表达式超过求值预算');
   var a,b,args,key;
   switch(n.type){
    case 'Literal':if(n.regex){var marker=Object.create(null);regexValues.set(marker,regexMap.get(n.regex.pattern+'/'+n.regex.flags));return marker;}return n.value;
    case 'Identifier':if(n.name==='undefined')return undefined;if(parsed.declared.has(n.name)&&!ready.has(n.name))fail('变量在声明前被读取');return env[n.name];
    case 'TemplateLiteral':{
      var out=n.quasis[0].value.cooked;
      for(var i=0;i<n.expressions.length;i++)out=bounded(out+text(value(n.expressions[i]))+n.quasis[i+1].value.cooked);
      return out;}
    case 'ObjectExpression':a=Object.create(null);for(var p of n.properties)a[p.key.type==='Identifier'?p.key.name:String(p.key.value)]=value(p.value);return a;
    case 'ArrayExpression':return n.elements.map(value);
    case 'MemberExpression':
      a=value(n.object);key=keyOf(n);
      if(a===null||a===undefined)fail('空值不能读取属性');
      if(regexValues.has(a))fail('正则只允许有限匹配操作');
      if((typeof a==='string'||Array.isArray(a))&&key==='length')return a.length;
      if(typeof a==='string'&&/^\d{1,5}$/.test(key))return a[Number(key)];
      if(typeof a!=='object')return undefined;
      return Object.prototype.hasOwnProperty.call(a,key)?a[key]:undefined;
    case 'UnaryExpression':a=value(n.argument);if(n.operator==='!')return !a;if(n.operator==='typeof')return typeof a;return n.operator==='+'?Number(scalar(a)):-Number(scalar(a));
    case 'LogicalExpression':a=value(n.left);return n.operator==='||'?(a||value(n.right)):n.operator==='&&'?(a&&value(n.right)):(a==null?value(n.right):a);
    case 'ConditionalExpression':return value(n.test)?value(n.consequent):value(n.alternate);
    case 'BinaryExpression':
      a=scalar(value(n.left));b=scalar(value(n.right));
      switch(n.operator){case '+':return bounded(a+b);case '-':return a-b;case '*':return a*b;case '/':return a/b;case '%':return a%b;case '===':return a===b;case '!==':return a!==b;case '==':return a==b;case '!=':return a!=b;case '<':return a<b;case '<=':return a<=b;case '>':return a>b;case '>=':return a>=b;}break;
    case 'CallExpression':
      args=n.arguments.map(value);
      if(n.callee.type==='Identifier'){
        if(args.length>2)fail('内置操作参数过多');
        if(n.callee.name==='String')return args.length?bounded(text(args[0])):'';
        if(n.callee.name==='Number')return args.length?Number(scalar(args[0])):0;
        if(n.callee.name==='parseInt'){if(args[1]!==undefined&&args[1]!==10)fail('仅支持十进制页码');return parseInt(text(args[0]),10);}
        if(n.callee.name==='encodeURIComponent')return bounded(encodeURIComponent(text(args[0])));
        if(n.callee.name==='encodeURI')return bounded(encodeURI(text(args[0])));
      }
      key=keyOf(n.callee);
      if(n.callee.object.type==='Identifier'&&n.callee.object.name==='Math')return key==='max'?Math.max.apply(null,args.map(scalar)):Math.min.apply(null,args.map(scalar));
      a=value(n.callee.object);
      if(key==='test'){
        var testRegex=regexValues.get(a);if(!testRegex||args.length!==1)fail('test 仅允许固定 URL 模式');testRegex.lastIndex=0;return testRegex.test(text(args[0]));
      }
      if(typeof a!=='string')fail('字符串方法不接受对象或宿主值');
      var rx=args[0]&&typeof args[0]==='object'?regexValues.get(args[0]):null;
      if(['replace','split','match'].includes(key)){
        if(typeof args[0]!=='string'&&!rx)fail('仅允许固定匹配模式');
        if(rx)rx.lastIndex=0;
        if(key==='match'){if(!rx)fail('match 只支持固定正则');return bounded(a.match(rx));}
        if(key==='replace'){if(args.length!==2||typeof args[1]!=='string')fail('replace 不支持回调或动态替换对象');return bounded(a.replace(rx||args[0],args[1]));}
        if(args.length>2||args[1]!==undefined&&(!Number.isSafeInteger(args[1])||args[1]<0||args[1]>LIMIT.keys))fail('split 条目预算无效');
        return bounded(a.split(rx||args[0],args[1]));
      }
      args.forEach(scalar);
      if(key==='trim'){if(args.length)fail('trim 不需要参数');return a.trim();}
      if(key==='charAt')return a.charAt(args[0]);
      if(key==='substr')return a.substr(args[0],args[1]);
      if(key==='substring')return a.substring(args[0],args[1]);
      if(key==='slice')return a.slice(args[0],args[1]);
      if(key==='indexOf')return a.indexOf(args[0],args[1]);
      if(key==='startsWith')return a.startsWith(args[0],args[1]);
      if(key==='endsWith')return a.endsWith(args[0],args[1]);
      fail('未知数据操作');break;
   }
   fail('无法解释的表达式');
  }
  function statements(list){for(var stmt of list){var result=statement(stmt);if(result)return result;}return null;}
  function statement(n){
   if(++steps>LIMIT.steps)fail('语句超过求值预算');
   switch(n.type){
    case 'EmptyStatement':return null;
    case 'BlockStatement':return statements(n.body);
    case 'ReturnStatement':return {value:value(n.argument)};
    case 'IfStatement':return value(n.test)?statement(n.consequent):n.alternate?statement(n.alternate):null;
    case 'VariableDeclaration':for(var d of n.declarations){env[d.id.name]=d.init?value(d.init):undefined;ready.add(d.id.name);}return null;
    case 'ExpressionStatement':{
      var name=n.expression.left.name;
      if(!parsed.declared.has(name)||parsed.declared.get(name)==='const'||!ready.has(name))fail('只允许修改已声明的本地变量');
      env[name]=value(n.expression.right);return null;}
   }
   fail('无法解释的语句');
  }
  var output=statements(parsed.ast.body);
  if(!output)fail('未得到明确的 return 数据');
  // Copy again: do not return private markers or inherited executable values.
  var clean=copyData(output.value,LIMIT.string);
  return {ok:true,value:clean,mode:'bounded-data-expression',steps:steps,inputs:parsed.inputs,usesResult:parsed.usesResult};
 }catch(error){return {ok:false,reason:String(error.message||'表达式不受支持').slice(0,180)};}
}
function canInterpretStaticScript(raw){try{compile(raw);return {ok:true};}catch(error){return {ok:false,reason:String(error.message||'表达式不受支持').slice(0,180)};}}
function evaluateStaticRequest(raw,bindings){
 var result=evaluateStaticScript(raw,bindings);
 if(!result.ok)return result;
 var obj=typeof result.value==='string'?{url:result.value}:result.value;
 if(!obj||typeof obj!=='object'||Array.isArray(obj)||typeof obj.url!=='string'||!obj.url.trim())return {ok:false,reason:'请求表达式未返回 URL 字符串或请求对象'};
 var allowed=new Set(['url','POST','httpParams','httpHeaders','forbidCookie','forbidCache','cacheTime','webView','webViewJs','webViewJsDelay','requestParamsEncode','responseEncode','responseFormatType']);
 for(var key of Object.keys(obj))if(!allowed.has(key))return {ok:false,reason:'请求返回了未支持的配置字段：'+key};
 if(obj.POST!==undefined&&typeof obj.POST!=='boolean')return {ok:false,reason:'POST 标记必须为布尔值'};
 if(obj.forbidCookie!==undefined&&typeof obj.forbidCookie!=='boolean')return {ok:false,reason:'forbidCookie 必须为布尔值'};
 return {ok:true,request:obj,mode:result.mode,inputs:result.inputs,usesResult:result.usesResult};
}
module.exports={evaluateStaticScript:evaluateStaticScript,evaluateStaticRequest:evaluateStaticRequest,canInterpretStaticScript:canInterpretStaticScript};
