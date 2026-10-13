"use strict";
/*
 * Legado URL 规则 → XSGG requestInfo
 * 处理：
 *   - {{key}} / {{page}} → %@keyWord / %@pageIndex（简单情形直接替换）
 *   - 复杂 {{表达式}}（含 java.*、算术、<,X> 可选前缀）→ @js: 动态脚本
 *   - ,{"method":"POST","body":"a={{key}}&b=1","headers":{...},"webView":true,"charset":"gbk"}
 *     → @js: 返回 {url, POST, httpParams, httpHeaders, webView} + 动作级 responseEncode
 */

var utils = require("./utils");
var jsRule = require("./jsRule");
var requestCompat = require("./requestCompat");

var escStr = utils.escStr;

// 编码 → XSGG responseEncode
var CHARSET_MAP = {
  "": "",
  "utf-8": "",
  "utf8": "",
  "gbk": "2147485234",
  "gb2312": "2147485232"
};

// 匹配 {{...}}，返回 [{expr, start, end}]
function findTemplates(url) {
  var out = [];
  var i = 0;
  var n = url.length;
  while (i < n) {
    if (url[i] === "{" && url[i + 1] === "{") {
      var end = url.indexOf("}}", i + 2);
      if (end === -1) break;
      out.push({ expr: url.slice(i + 2, end), start: i, end: end + 2 });
      i = end + 2;
      continue;
    }
    i++;
  }
  return out;
}

// 表达式 → JS 表达式（key/page/java.*/算术）
// 返回 {expr, needsCrypto, notes}
function exprToJs(expr, ctx) {
  var notes = [];
  var e = expr;
  var needsCrypto = false;
  // java.* 调用翻译
  var i = 0;
  var out = "";
  var n = e.length;
  while (i < n) {
    if (e.substr(i, 5) === "java.") {
      var call = jsRule.findJavaCall ? findJavaCallSafe(e, i) : null;
      if (call) {
        var r = jsRule.translateJavaCall(call.name, call.args);
        if (r) {
          if (r.keep) {
            notes.push(r.msg);
            out += e.slice(i, call.end);
            i = call.end;
            continue;
          }
          out += r.expr;
          if (r.crypto) needsCrypto = true;
          if (r.note) notes.push(r.note);
          i = call.end;
          continue;
        }
        notes.push("java." + call.name + "() 无法翻译，已保留原样");
        out += e.slice(i, call.end);
        i = call.end;
        continue;
      }
    }
    if(e[i]==='"'||e[i]==="'"){
      var quote=e[i],end=i+1;
      while(end<n){if(e[end]==='\\'){end+=2;continue;}if(e[end++]===quote)break;}
      out+=e.slice(i,end);i=end;continue;
    }
    // key / page 变量（词边界）
    var m = e.slice(i).match(/^[a-zA-Z_$][\w$]*/);
    if (m) {
      var w = m[0];
      var prevOk = i === 0 || !/[a-zA-Z0-9_$.]/.test(e[i - 1]);
      if (prevOk && w === "key") { out += "params.keyWord"; i += w.length; continue; }
      if (prevOk && w === "page") { out += "params.pageIndex"; i += w.length; continue; }
      if (prevOk && w === "baseUrl") {
        var rl = ctx && ctx.urlRole;
        if (rl === "toc" || rl === "content" || rl === "nextToc" || rl === "nextContent") {
          out += "result";
          notes.push("baseUrl 已映射为 result（目录/正文请求中 = 上一步传入的 URL，模板占位符亦可写 %@result）");
        } else {
          out += "config.host";
          notes.push("baseUrl 已映射为 config.host（搜索/分类入口模块）");
        }
        i += w.length;
        continue;
      }
      out += w;
      i += w.length;
      continue;
    }
    out += e[i];
    i++;
  }
  return { expr: out, needsCrypto: needsCrypto, notes: notes };
}

function findJavaCallSafe(code, from) {
  // 轻量复用 jsRule 的平衡括号匹配（导出前先内联一份）
  var m = code.slice(from).match(/java\.[a-zA-Z_]\w*\s*\(/);
  if (!m) return null;
  var start = from + m.index;
  var nameEnd = code.indexOf("(", start);
  var name = code.slice(start + 5, nameEnd).trim();
  var depth = 1;
  var quote = null;
  var i = nameEnd + 1;
  var n = code.length;
  while (i < n) {
    var c = code[i];
    if (quote) {
      if (c === "\\") { i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; i++; continue; }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return { name: name, args: code.slice(nameEnd + 1, i), start: start, end: i + 1 };
    }
    i++;
  }
  return null;
}

// 单个模板值 → JS 片段（用于模板字符串或拼接）
function templateToJs(expr, ctx) {
  // <,X> 形式：X 为空时省略前导逗号
  var m = expr.match(/^<,(.+),\s*$/);
  if (m) {
    var inner = exprToJs(m[1], ctx);
    return {
      js: "(" + inner.expr + ' ? "," + String(' + inner.expr + ") : \"\")",
      needsCrypto: inner.needsCrypto,
      notes: inner.notes
    };
  }
  var r = exprToJs(expr, ctx);
  return { js: "String(" + r.expr + ")", needsCrypto: r.needsCrypto, notes: r.notes };
}

// body 字符串（a=1&b={{key}}&c=x{{page}}y）→ httpParams JS 对象字面量
function bodyToParams(body, ctx) {
  var notes = [];
  var needsCrypto = false;
  var pairs = body.split("&");
  var parts = [];
  for (var i = 0; i < pairs.length; i++) {
    var kv = pairs[i];
    if (!kv) continue;
    var eq = kv.indexOf("=");
    var k = eq === -1 ? kv : kv.slice(0, eq);
    var v = eq === -1 ? "" : kv.slice(eq + 1);
    var tpls = findTemplates(v);
    var jsVal;
    if (!tpls.length) {
      jsVal = '"' + escStr(v) + '"';
    } else if (tpls.length === 1 && tpls[0].start === 0 && tpls[0].end === v.length) {
      var r1 = exprToJs(tpls[0].expr, ctx);
      jsVal = r1.expr;
      notes = notes.concat(r1.notes);
      if (r1.needsCrypto) needsCrypto = true;
    } else {
      // 混合：字符串与表达式拼接
      var out = "";
      var last = 0;
      for (var j = 0; j < tpls.length; j++) {
        var t = tpls[j];
        if (t.start > last) out += '"' + escStr(v.slice(last, t.start)) + '" + ';
        var r2 = exprToJs(t.expr, ctx);
        out += "String(" + r2.expr + ") + ";
        notes = notes.concat(r2.notes);
        if (r2.needsCrypto) needsCrypto = true;
        last = t.end;
      }
      if (last < v.length) out += '"' + escStr(v.slice(last)) + '"';
      else out = out.slice(0, -3);
      jsVal = out;
    }
    parts.push('"' + escStr(k) + '": ' + jsVal);
  }
  return { literal: "{" + parts.join(", ") + "}", needsCrypto: needsCrypto, notes: notes };
}

// 拆分 url,{options}（options 必须是合法 JSON）
// 返回 {url, options} 或 {url}（无选项）
function splitUrlOptions(urlRule) {
  var match = /,\s*\{(?!\{)/.exec(urlRule);
  var i = match ? match.index : -1;
  if (i === -1) return { url: urlRule };
  // 找匹配的右花括号
  var depth = 1;
  var quote = null;
  var j = urlRule.indexOf("{", i) + 1;
  var n = urlRule.length;
  while (j < n) {
    var c = urlRule[j];
    if (quote) {
      if (c === "\\") { j += 2; continue; }
      if (c === quote) quote = null;
      j++;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; j++; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) break;
    }
    j++;
  }
  if (depth !== 0) return { url: urlRule.slice(0,i), error: "请求选项 JSON 未闭合" };
  var optStr = urlRule.slice(i + 1, j + 1);
  try {
    var options = JSON.parse(optStr);
    return { url: urlRule.slice(0, i), options: options };
  } catch (e) {
    return { url: urlRule.slice(0,i), error: "请求选项不是合法 JSON" };
  }
}

// 生成 requestInfo；返回 { requestInfo, actionExtra, warnings }
// ctx: { src, host(origin), jsonEnabled, cryptoJsSource }
function buildRequestInfo(urlRule, ctx, role) {
  // role: 'search' | 'explore' | 'toc' | 'content' | 'nextToc' | 'nextContent'
  // baseUrl 的语义随模块不同：目录/正文=上一步 URL(result)，搜索/分类=站点入口(config.host)
  var xctx = {};
  for (var ck in ctx) xctx[ck] = ctx[ck];
  xctx.urlRole = role;
  var warnings = [];
  var split = splitUrlOptions(urlRule);
  var url = split.url.trim();
  var options = split.options || null;
  var notes = [];
  if (split.error) warnings.push({level:"unsupported",msg:split.error});
  if (options && options.method && !/^(GET|POST)$/i.test(String(options.method))) warnings.push({level:"unsupported",msg:"无法等价映射 HTTP 方法 " + options.method});
  if (options && options.webView) warnings.push({level:"degraded",msg:"WebView 已保留请求标记，动态执行与嗅探需要 App 实测；静态验证不支持"});

  var urlStr = url;
  // 预处理 <,{{expr}}> 可选前缀 → 条件表达式占位（须在绝对化之前，避免 <> 被编码）
  var opt = expandOptionalPrefix(urlStr);
  urlStr = opt.url;
  var optMaps = opt.maps;

  // 相对 URL 绝对化（以 sourceUrl 为基准）
  if (!/^https?:\/\//i.test(urlStr) && !/^data:/i.test(urlStr)) {
    urlStr = utils.resolveUrl(urlStr, ctx.src.bookSourceUrl || ctx.host);
    notes.push("相对 URL 已基于站点地址绝对化");
  }

  var tpls = findTemplates(urlStr);
  var simple = true; // 是否所有模板都是 key/page 且无可选前缀
  for (var i = 0; i < tpls.length; i++) {
    var e = tpls[i].expr.trim();
    if (e !== "key" && e !== "page") { simple = false; break; }
  }
  if (optMaps.length) simple = false;
  // 需要注入 forbidCookie 时，纯占位符形态放不下 → 强制走 @js 对象
  var forbidCookiePre = !!(ctx.src && ctx.src.enabledCookieJar === false);
  if (forbidCookiePre) simple = false;

  // 选项中的可动作级字段
  var actionExtra = {};
  if (options && options.charset) {
    var enc = CHARSET_MAP[String(options.charset).toLowerCase()];
    if (enc !== undefined) {
      if (enc !== "") { actionExtra.responseEncode = enc; actionExtra.requestParamsEncode = enc; }
    } else {
      warnings.push({ level: "degraded", msg: "charset=" + options.charset + " 无对应 responseEncode，已忽略（站点若为非 UTF-8 需人工处理）" });
    }
  }

  var needsCrypto = false;
  var jsLines = [];
  // 阅读源关闭了 CookieJar → 香色闺阁各请求注入 forbidCookie:true
  var forbidCookie = !!(ctx.src && ctx.src.enabledCookieJar === false);
  if (forbidCookie) {
    warnings.push({ level: "note", msg: "enabledCookieJar=false → 请求已写入 forbidCookie: true（不携带 Cookie）" });
  }

  if (options && options.method && String(options.method).toUpperCase() === "POST") {
    // POST 情形 → @js: 脚本
    var bp = bodyToParams(String(options.body == null ? "" : options.body), ctx);
    notes = notes.concat(bp.notes);
    if (options.body && (typeof options.body !== "string" || /^\s*[\[{]/.test(options.body))) warnings.push({level:"unsupported",msg:"JSON/对象 POST body 无法等价转换为表单 httpParams，需专用请求适配"});
    if (bp.needsCrypto) needsCrypto = true;
    var tplLit = jsUrlTemplate(urlStr, tpls, optMaps, xctx, notes);
    if (tplLit.needsCrypto) needsCrypto = true;
    jsLines.push("let url = `" + tplLit.literal + "`;");
    jsLines.push("let httpParams = " + bp.literal + ";");
    var ret = "{url: url, POST: true, httpParams: httpParams";
    if (options.headers) {
      var hdr = typeof options.headers === "string" ? options.headers : JSON.stringify(options.headers);
      jsLines.push("let httpHeaders = " + hdr + ";");
      ret += ", httpHeaders: httpHeaders";
    }
    if (forbidCookie) ret += ", forbidCookie: true";
    if (options.webView) ret += ', webView: ""';
    if (options.retry) warnings.push({ level: "note", msg: "retry=" + options.retry + " 已忽略" });
    jsLines.push("return " + ret + "};");
  } else if (!simple || options) {
    // 复杂模板或带选项 → @js: 脚本
    var tplLit2 = jsUrlTemplate(urlStr, tpls, optMaps, xctx, notes);
    if (tplLit2.needsCrypto) needsCrypto = true;
    jsLines.push("let url = `" + tplLit2.literal + "`;");
    var ret2 = "{url: url";
    if (forbidCookie) ret2 += ", forbidCookie: true";
    if (options) {
      if (options.method && String(options.method).toUpperCase() === "POST") {
        warnings.push({ level: "degraded", msg: "POST 但无 body，已按 GET 处理" });
      }
      if (options.headers) {
        var hdr2 = typeof options.headers === "string" ? options.headers : JSON.stringify(options.headers);
        jsLines.push("let httpHeaders = " + hdr2 + ";");
        ret2 += ", httpHeaders: httpHeaders";
      }
      if (options.webView) ret2 += ', webView: ""';
      if (options.js) {
        var jsOpt = jsRule.translateJs(String(options.js), ctx);
        notes = notes.concat(jsOpt.notes.map(function (x) { return x; }));
        if (jsOpt.needsCrypto) needsCrypto = true;
        jsLines.push(jsOpt.code);
        warnings.push({ level: "degraded", msg: "URL 的 js 参数已并入脚本执行，请人工确认" });
      }
    }
    jsLines.push("return " + ret2 + "};");
  } else {
    // 简单情形：直接占位符（反向迭代避免索引错位）
    var plain = urlStr;
    for (var k3 = tpls.length - 1; k3 >= 0; k3--) {
      var t4 = tpls[k3];
      var rep = t4.expr.trim() === "key" ? "%@keyWord" : "%@pageIndex";
      plain = plain.slice(0, t4.start) + rep + plain.slice(t4.end);
    }
    if (role === "search" && urlStr.indexOf("{{key}}") === -1) {
      warnings.push({ level: "note", msg: "搜索 URL 未包含 {{key}}，搜索结果可能不随关键词变化" });
    }
    var ri = plain;
    return { requestInfo: ri, actionExtra: actionExtra, warnings: warnings.concat(notes.map(function (n) { return { level: "note", msg: n }; })) };
  }

  var block = jsRule.wrapJsBlock(jsLines, ctx, needsCrypto);
  warnings = warnings.concat(notes.map(function (n) { return { level: "note", msg: n }; }));
  if (needsCrypto) {
    warnings.push({ level: "note", msg: "已注入 cryptojs（前端 CryptoJS 库），注入语法请以实际 App 验证为准" });
  }
  return { requestInfo: block, actionExtra: actionExtra, warnings: warnings };
}

function escTemplate(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function applyOptMaps(s, maps) {
  for (var i = 0; i < maps.length; i++) {
    s = s.split(maps[i].marker).join("${" + maps[i].js + "}");
  }
  return s;
}

// 构建模板字符串字面量正文：
// 1. 模板插值位置先放占位符 \u0002N\u0002（反向迭代避免索引错位）
// 2. escTemplate 只转义 URL 文本自身的 \ ` ${，不动占位符
// 3. 最后把占位符还原为真实 ${expr} 插值
function jsUrlTemplate(urlStr, tpls, optMaps, ctx, notes) {
  var tplMarkers = [];
  var needsCrypto = false;
  var i;
  for (i = tpls.length - 1; i >= 0; i--) {
    var t = tpls[i];
    var r = exprToJs(t.expr, ctx);
    notes = notes.concat(r.notes);
    if (r.needsCrypto) needsCrypto = true;
    var marker = "\u0002tpl" + tplMarkers.length + "\u0002";
    tplMarkers.push({ marker: marker, js: r.expr });
    urlStr = urlStr.slice(0, t.start) + marker + urlStr.slice(t.end);
  }
  var escaped = escTemplate(urlStr);
  var maps = tplMarkers.concat(optMaps);
  for (i = 0; i < maps.length; i++) {
    escaped = escaped.split(maps[i].marker).join("${" + maps[i].js + "}");
  }
  return { literal: escaped, needsCrypto: needsCrypto };
}

// 展开 <,{{expr}}> 可选前缀：expr 为空(假)时省略前导逗号
// 返回 { url: 替换后的url, maps: [{marker, js}] }
function expandOptionalPrefix(urlStr) {
  var out = "";
  var maps = [];
  var i = 0;
  var n = urlStr.length;
  var counter = 0;
  while (i < n) {
    if (urlStr[i] === "<" && urlStr[i + 1] === "," && urlStr[i + 2] === "{" && urlStr[i + 3] === "{") {
      var exprEnd = urlStr.indexOf("}}", i + 4);
      if (exprEnd !== -1 && urlStr[exprEnd + 2] === ">") {
        var expr = urlStr.slice(i + 4, exprEnd);
        var r = exprToJs(expr, {});
        var marker = "_XOPT" + (counter++) + "_";
        maps.push({
          marker: marker,
          js: "(" + r.expr + ' ? "," + String(' + r.expr + ") : \"\")"
        });
        out += marker;
        i = exprEnd + 3;
        continue;
      }
    }
    out += urlStr[i];
    i++;
  }
  return { url: out, maps: maps };
}


// Recognize only data-only GET grammar emitted by the converter. Never execute input.
function describeStaticGetRequest(rule) {
  if (typeof rule !== "string" || rule.length > 6000) return null;
  var raw=rule.trim(),forbidCookie=false,generated=false,headers=null;
  if (/^@js:/i.test(raw)) {
    var match=raw.match(/^@js:\s*(?:let|var|const)\s+url\s*=\s*`([^`\\]*)`;\s*(?:(?:let|var|const)\s+httpHeaders\s*=\s*(\{[\s\S]*?\})\s*;\s*)?return\s+\{\s*url:\s*url([^{}]*)\};?\s*$/);
    if(!match)return null;
    var fields=match[3].trim(),seen={};
    if(fields){
      if(fields.charAt(0)!==",")return null;
      var parts=fields.slice(1).split(",");
      for(var i=0;i<parts.length;i++){
        var field=parts[i].trim(),cookie=field.match(/^forbidCookie\s*:\s*(true|false)$/);
        if(cookie&&!seen.cookie){forbidCookie=cookie[1]==="true";seen.cookie=true;}
        else if(/^httpHeaders\s*:\s*httpHeaders$/.test(field)&&!seen.headers){seen.headers=true;}
        else return null;
      }
    }
    if(!!match[2]!==!!seen.headers)return null;
    if(match[2]){
      var parsed=requestCompat.parseHeaderData(match[2]);
      if(parsed.reason)return null;headers=parsed.headers;
    }
    raw=match[1];generated=true;
    raw=raw.replace(/\$\{params\.keyWord\}/g,"%@keyWord").replace(/\$\{params\.pageIndex\}/g,"%@pageIndex");
  }
  if (/@js:|<js>|\$\{|javascript:/i.test(raw)) return null;
  if (!raw || /[\r\n`]/.test(raw)) return null;
  var result={url:raw,method:"GET",forbidCookie:forbidCookie,generated:generated};
  if(headers!==null)result.httpHeaders=headers;
  return result;
}

// Rewrite only the literal origin of a statically recognized GET request.
// Keep the generated request object, paging placeholders and cookie intent.
function rewriteStaticGetOrigin(rule, oldOrigin, newOrigin) {
  var request=describeStaticGetRequest(rule);
  if(!request || typeof oldOrigin!=="string" || typeof newOrigin!=="string")return rule;
  var authority=request.url.match(/^https?:\/\/[^/?#\s]+/i);
  if(!authority)return rule;
  try {
    var before=new URL(authority[0]),target=new URL(newOrigin);
    if(before.username||before.password||before.origin!==oldOrigin||
       !/^https?:$/.test(target.protocol)||target.username||target.password||target.origin!==newOrigin)return rule;
  }catch(e){return rule;}
  return rule.replace(authority[0],newOrigin);
}

// Replace a verified static GET URL without discarding its request object.
function rewriteStaticGetUrl(rule, nextUrl) {
  var request=describeStaticGetRequest(rule);
  if(!request || typeof nextUrl!=="string" || nextUrl.length>2200 ||
      /[\r\n\x60\\]|\$\{|@js:|<js>/i.test(nextUrl))return null;
  var unknown=nextUrl.replace(/%@(?:keyWord|pageIndex)/g,"");
  if(unknown.includes("%@"))return null;
  try{
    var target=new URL(nextUrl);
    if(!/^https?:$/.test(target.protocol)||target.username||target.password||target.hash)return null;
  }catch(e){return null;}
  if(!request.generated)return nextUrl;
  var literal=nextUrl.replace(/%@keyWord/g,"$"+"{params.keyWord}").replace(/%@pageIndex/g,"$"+"{params.pageIndex}");
  return rule.replace(/\x60[^\x60\\]*\x60/,function(){return String.fromCharCode(96)+literal+String.fromCharCode(96);});
}

module.exports = {
  rewriteStaticGetUrl: rewriteStaticGetUrl,
  describeStaticGetRequest: describeStaticGetRequest,
  rewriteStaticGetOrigin: rewriteStaticGetOrigin,
  buildRequestInfo: buildRequestInfo,
  splitUrlOptions: splitUrlOptions,
  findTemplates: findTemplates,
  exprToJs: exprToJs,
  CHARSET_MAP: CHARSET_MAP
};
