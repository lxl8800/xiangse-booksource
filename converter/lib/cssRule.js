"use strict";
/*
 * Legado @css: 规则 → XPath（子集）
 * 支持：tag / .class / #id / [attr] / [attr=val] / [attr^=val] / [attr$=val] / [attr*=val] / [attr~=val]
 *      后代(空格) / 子代(>) / 相邻(+) / :eq(n) / :gt(n) / :lt(n) / :first / :last / :contains / :containsOwn
 * 不支持：:has / :not 嵌套等复杂伪类 → 标记不支持
 */

var utils = require("./utils");
var escAttr = utils.escAttr;
var escStr = utils.escStr;
function decodeCssString(value) {
  return String(value).replace(/\\(["'\\])/g, "$1");
}

// Delimiters inside quoted attribute values or nested pseudo functions are data.
function closingDelimiter(text, start, open, close) {
  var depth=1, quote=null;
  for(var i=start+1;i<text.length;i++) {
    var c=text[i];
    if(quote){if(c==="\\"){i++;continue;}if(c===quote)quote=null;continue;}
    if(c==="\'"||c==='"'){quote=c;continue;}
    if(c===open)depth++;else if(c===close&&--depth===0)return i;
  }
  return -1;
}

// Split comma-separated CSS groups while preserving commas in attributes and pseudo functions.
function splitCssGroups(s) {
  var out = [], start = 0, square = 0, round = 0, quote = null;
  for (var i = 0; i < s.length; i++) {
    var c = s[i];
    if (quote) { if (c === "\\") { i++; continue; } if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "[") square++;
    else if (c === "]") square--;
    else if (c === "(") round++;
    else if (c === ")") round--;
    else if (c === "," && square === 0 && round === 0) {
      if (s.slice(start, i).trim()) out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (s.slice(start).trim()) out.push(s.slice(start).trim());
  return out;
}

// [attr=val] → XPath 谓词（不含方括号）
function attrPredicateToXpath(bracket) {
  var inner = bracket.slice(1, -1).trim();
  var m = inner.match(/^([\w-]+)\s*(?:(\^=|\$=|\*=|~=|=|!=)\s*(.+))?$/);
  if (!m) return { error: "属性选择器无法解析: " + bracket };
  var attr = m[1];
  var op = m[2];
  var val = m[3];
  if (val === undefined || val === null) return { predicate: "[@" + attr + "]", error: null };
  // 去掉引号
  val = val.trim();
  if ((val[0] === '"' && val.slice(-1) === '"') || (val[0] === "'" && val.slice(-1) === "'")) {
    val = val.slice(1, -1);
  }
  val = decodeCssString(val);
  var v = utils.xpathLiteral(val);
  switch (op) {
    case "=": return { predicate: "[@" + attr + "=" + v + "]", error: null };
    case "^=": return { predicate: "[starts-with(@" + attr + "," + v + ")]", error: null };
    case "$=": return {
      predicate: "[substring(@" + attr + ", string-length(@" + attr + ")-string-length(" + v + ")+1)=" + v + "]",
      error: null
    };
    case "*=": return { predicate: "[contains(@" + attr + "," + v + ")]", error: null };
    case "~=": return {
      predicate: "[contains(concat(' ',normalize-space(@" + attr + "),' ')," + utils.xpathLiteral(" "+val+" ") + ")]",
      error: null
    };
    case "!=":
      return { predicate: "[not(@" + attr + "=" + v + ")]", error: null };
    default:
      return { error: "属性操作符不支持: " + op };
  }
}

// 单个 compound 选择器（如 div.foo[attr=x]:eq(0)）→ {tag, preds, notes}
function parseCompound(tok, ctx, notes) {
  var tag = "*";
  var preds = [];
  var posPreds = [];
  var i = 0;
  var n = tok.length;
  var first = true;
  while (i < n) {
    var c = tok[i];
    if (first && /[a-zA-Z_*]/.test(c)) {
      var m = tok.slice(i).match(/^[a-zA-Z_*][\w-]*/);
      tag = m[0];
      i += m[0].length;
      first = false;
      continue;
    }
    if (c === ".") {
      var m2 = tok.slice(i).match(/^\.([\w-]+)/);
      if (!m2) return { error: "class 选择器无法解析: " + tok };
      preds.push("contains(concat(' ', normalize-space(@class), ' '), ' " + escAttr(m2[1]) + " ')");
      i += m2[0].length;
      first = false;
      continue;
    }
    if (c === "#") {
      var m3 = tok.slice(i).match(/^#([\w-]+)/);
      if (!m3) return { error: "id 选择器无法解析: " + tok };
      preds.push('@id="' + escAttr(m3[1]) + '"');
      i += m3[0].length;
      first = false;
      continue;
    }
    if (c === "[") {
      var end = closingDelimiter(tok, i, "[", "]");
      if (end === -1) return { error: "属性选择器未闭合: " + tok };
      var r = attrPredicateToXpath(tok.slice(i, end + 1));
      if (r.error) return { error: r.error };
      preds.push(r.predicate.slice(1, -1));
      i = end + 1;
      first = false;
      continue;
    }
    if (c === ":") {
      var pm = tok.slice(i).match(/^:([a-zA-Z-]+)/);
      if (!pm) return { error: "伪类无法解析: " + tok };
      var name = pm[1], arg = null, consumed = pm[0].length;
      if(tok[i+consumed]==="("){
        var close=closingDelimiter(tok,i+consumed,"(",")");
        if(close<0)return {error:"伪类参数未闭合: "+tok};
        arg=tok.slice(i+consumed+1,close).trim();
        consumed=close-i+1;
      }
      var pr;
      switch (name) {
        case "eq":
          var idx = Number(arg);
          if (!/^-?\d+$/.test(arg || "")) return { error: ":eq 参数非法: " + arg };
          pr = utils.indexToPosExpr(idx);
          break;
        case "gt":
          var idx2 = Number(arg);
          if (!/^-?\d+$/.test(arg || "")) return { error: ":gt 参数非法: " + arg };
          pr = "position()>(" + utils.indexToPosExpr(idx2) + ")";
          break;
        case "lt":
          var idx3 = Number(arg);
          if (!/^-?\d+$/.test(arg || "")) return { error: ":lt 参数非法: " + arg };
          pr = "position()<(" + utils.indexToPosExpr(idx3) + ")";
          break;
        case "first":
          pr = "1";
          break;
        case "first-child":
          pr = "not(preceding-sibling::*)";
          break;
        case "last-child":
          pr = "not(following-sibling::*)";
          break;
        case "nth-child":
          if (arg === "odd") pr = "(count(preceding-sibling::*) mod 2)=0";
          else if (arg === "even") pr = "(count(preceding-sibling::*) mod 2)=1";
          else if (/^\d+$/.test(arg || "")) pr = "count(preceding-sibling::*)=" + (Number(arg) - 1);
          else return { error: ":nth-child 参数暂不支持: " + arg };
          break;
        case "not":
          if (/^\.[\w-]+$/.test(arg || "")) {
            var cls = arg.slice(1);
            pr = "not(contains(concat(' ', normalize-space(@class), ' '), ' " + escAttr(cls) + " '))";
          } else if (/^#[\w-]+$/.test(arg || "")) {
            pr = "not(@id=\"" + escAttr(arg.slice(1)) + "\")";
          } else if (/^[\w-]+$/.test(arg || "")) {
            pr = "not(self::" + arg + ")";
          } else return { error: ":not() 复杂参数暂不支持: " + arg };
          break;
        case "has":
          if (/^[a-zA-Z][\w-]*$/.test(arg || "")) pr = ".//" + arg;
          else if (/^\.[\w-]+$/.test(arg || "")) pr = ".//*[contains(concat(' ', normalize-space(@class), ' '), ' " + escAttr(arg.slice(1)) + " ')]";
          else return { error: ":has() 复杂参数暂不支持: " + arg };
          break;
        case "last":
          pr = "position()=last()";
          break;
        case "contains":
          pr = "contains(.," + utils.xpathLiteral(decodeCssString(utils.unquote(arg || ""))) + ")";
          break;
        case "containsOwn":
          pr = "contains(text()," + utils.xpathLiteral(decodeCssString(utils.unquote(arg || ""))) + ")";
          break;
        default:
          return { error: "伪类 :" + name + " 不支持，不能安全忽略" };
      }
      (pr === "1" || /^position\(\)/.test(pr) || /^last\(\)/.test(pr) || /^\d+$/.test(pr)) ? posPreds.push(pr) : preds.push(pr);
      i += consumed;
      first = false;
      continue;
    }
    if (c === "*" && first) {
      i++;
      first = false;
      continue;
    }
    return { error: "选择器无法解析: " + tok + "（位置 " + i + "）" };
  }
  return { tag: tag, preds: preds, posPred: posPreds.length ? posPreds.join(" and ") : null };
}

// 选择器链（不含内容提取）→ XPath
// 支持组合符：空格(后代) > (子代) + (相邻)
function selectorToXpathChain(selector, ctx) {
  var notes = [];
  var tokens = [];
  var buf = "";
  var comb = null; // null | ' ' | '>' | '+'
  var i = 0;
  var n = selector.length;
  var square=0, round=0, quote=null;
  while (i < n) {
    var c=selector[i];
    if(quote){
      buf+=c;
      if(c==="\\" && i+1<n)buf+=selector[++i];
      else if(c===quote)quote=null;
      i++;continue;
    }
    if(c==="'"||c==='"'){quote=c;buf+=c;i++;continue;}
    if(c==="[")square++;else if(c==="]")square--;
    else if(c==="(")round++;else if(c===")")round--;
    if(square===0&&round===0&&(c===">"||c==="+"||c==="~"||/\s/.test(c))){
      if(buf){tokens.push({sel:buf,comb:comb});buf="";comb=" ";}
      if(!/\s/.test(c))comb=c;
      i++;continue;
    }
    buf+=c;i++;
  }
  if(quote||square!==0||round!==0)return {error:"CSS 引号或括号未闭合",notes:notes};
  if (buf) tokens.push({ sel: buf, comb: comb });
  if (!tokens.length) return { error: "空选择器", notes: notes };

  var acc = null;   // 累积表达式（支持 :eq/:first 等作用域正确的列表取位）
  for (var t = 0; t < tokens.length; t++) {
    var pc = parseCompound(tokens[t].sel, ctx, notes);
    if (pc.error) return { error: pc.error, notes: notes };
    var stepXp = pc.tag + (pc.preds.length ? "[" + pc.preds.join(" and ") + "]" : "");
    var comb2 = tokens[t].comb;
    var sep;
    if (t === 0) sep = "//";
    else if (comb2 === ">") sep = "/";
    else if (comb2 === "+" || comb2 === "~") sep = "/following-sibling::";
    else sep = "//";
    if (comb2 === "+") {
      // CSS + requires the immediate next element, not the next matching sibling.
      var sibBody = acc + "/following-sibling::*[1][self::" + pc.tag + "]" +
        (pc.preds.length ? "["+pc.preds.join(" and ")+"]" : "");
      acc = pc.posPred ? "("+sibBody+")["+pc.posPred+"]" : sibBody;
      continue;
    }
    var body2 = (acc === null ? "" : acc) + sep + stepXp;
    acc = pc.posPred ? "(" + body2 + ")[" + pc.posPred + "]" : body2;
  }
  return { xpath: acc === null ? "" : acc, notes: notes };
}

// 完整 @css: 规则 → XPath
// 格式：@css:选择器@内容
function convertCss(rule, ctx) {
  var body = rule.slice(5); // 去掉 @css:
  var notes = [];
  var selector = body;
  var content = null;
  // 找最后一个位于方括号外的 @
  var at = -1;
  var depth = 0;
  var quote = null;
  for (var i = 0; i < body.length; i++) {
    var c = body[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "[") depth++;
    else if (c === "]") depth--;
    else if (c === "@" && depth === 0) at = i;
  }
  if (at !== -1) {
    selector = body.slice(0, at);
    content = body.slice(at + 1);
  }
  var groups = splitCssGroups(selector);
  if (!groups.length) return { error: "空 CSS 选择器", notes: notes };
  var xps = [];
  for (var gi = 0; gi < groups.length; gi++) {
    var ch = selectorToXpathChain(groups[gi], ctx);
    if (ch.error) return { error: ch.error, notes: notes.concat(ch.notes) };
    xps.push(ch.xpath);
    notes = notes.concat(ch.notes);
  }
  var xpath = xps.length === 1 ? xps[0] : "(" + xps.join(" | ") + ")";
  if (content !== null) {
    var m = require("./defaultRule").mapContentOp(content, ctx);
    xpath += m.xpath;
    notes = notes.concat(m.notes);
  }
  return { xpath: utils.scopeGroupedListXPath(xpath, ctx), notes: notes };
}

module.exports = {
  convertCss: convertCss,
  selectorToXpathChain: selectorToXpathChain,
  attrPredicateToXpath: attrPredicateToXpath
};