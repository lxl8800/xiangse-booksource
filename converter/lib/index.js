"use strict";
/*
 * 顶层组装：Legado 书源 JSON → XSGG 书源 JSON
 * 核心逻辑不依赖 Node API，可在浏览器/WebView 中运行
 */

var utils = require("./utils");
var modules = require("./modules");
var formatCompat = require("./formatCompat");
var domainRewrite = require("./domainRewrite");

function normalizeSource(source) {
  if (Array.isArray(source)) {
    return source.length ? source[0] : null;
  }
  if (source && typeof source === "object") {
    // Legado 导出格式 { "0": {...} } 或直接对象
    if ("0" in source) return source["0"];
    if ("bookSourceUrl" in source || "searchUrl" in source) return source;
    var keys = Object.keys(source);
    for (var i = 0; i < keys.length; i++) {
      var v = source[keys[i]];
      if (v && typeof v === "object" && ("bookSourceUrl" in v || "searchUrl" in v)) return v;
    }
  }
  return null;
}

// XSGG iOS imports reliably with numeric enable and positive weight.
function validWeight(value, fallback) {
  var n = Number(value);
  if (!Number.isFinite(n) || n < 1) return String(fallback);
  return String(Math.floor(n));
}
function isEnabled(value) {
  return !(value === false || value === 0 || value === "0" || value === "false");
}
// Existing Xiangse JSON should be normalized, not misread as Legado.
// This allows a mixed Legado/XSGG array to use the same baseline convert API.
function unwrapXsgg(source) {
  if(!source||typeof source!=='object'||Array.isArray(source))return null;
  if(typeof source.sourceUrl==='string')return {alias:source.sourceName||'书源',data:source};
  var keys=Object.keys(source);
  if(keys.length===1 && source[keys[0]] && typeof source[keys[0]].sourceUrl==='string')
    return {alias:keys[0],data:source[keys[0]]};
  return null;
}
function normalizeExistingXsgg(data, options) {
  var input=unwrapXsgg(data),warnings=[];
  if(!input)return null;
  var source=JSON.parse(JSON.stringify(input.data));
  if(!source.sourceType){source.sourceType='text';warnings.push({level:'note',msg:'原 XSGG JSON 缺少 sourceType，已补齐 text'});}
  if(!source.sourceName)source.sourceName=input.alias;
  if(!source.bookWorld && source.searchBook){
    source.bookWorld={'首页（待验证）':{
      validConfig:'',actionID:'bookWorld',host:utils.originOf(source.sourceUrl),
      parserID:source.searchBook.parserID||'DOM',responseFormatType:source.searchBook.responseFormatType||'html',
      requestInfo:utils.originOf(source.sourceUrl)+'/',list:source.searchBook.list||'',
      bookName:source.searchBook.bookName||'',detailUrl:source.searchBook.detailUrl||'',
      _sIndex:0,moreKeys:{pageSize:20}
    }};
    warnings.push({level:'degraded',msg:'原 XSGG 缺少 bookWorld，已补齐首页入口；网页规则仍需实际验证'});
  }
  var wrapper={};Object.defineProperty(wrapper,input.alias,{value:source,enumerable:true});
  var normalized=formatCompat.normalize(wrapper,options||{});
  return {output:normalized.output,warnings:warnings.concat(normalized.warnings)};
}

function compatibility(warnings) {
  var blocking=warnings.filter(function(w){return w.level==='error'||w.level==='unsupported';});
  var partial=warnings.filter(function(w){return w.level==='degraded';});
  return {status:blocking.length?'unsupported':partial.length?'partial':'equivalent',blockingCount:blocking.length,partialCount:partial.length,networkVerified:false,officialAppVerified:false};
}

function convert(source, options) {
  options = options || {};
  var existing=normalizeExistingXsgg(source,options);
  if(existing){existing.compatibility=compatibility(existing.warnings);return existing;}
  var warnings = [];
  var src = normalizeSource(source);
  if (!src) {
    return { output: null, warnings: [{ level: "error", msg: "无法识别的书源格式" }] };
  }

  // 必填校验：bookSourceUrl（开源阅读）→ sourceUrl（香色闺阁，规则必填）
  if (!src.bookSourceUrl || !String(src.bookSourceUrl).trim()) {
    warnings.push({ level: "error", msg: "缺少 bookSourceUrl：香色闺阁 sourceUrl 必填（站点首页 URL，全局唯一），转换结果中 sourceUrl 为空，请人工补充" });
  }

  // bookSourceType：0=文本 1=音频 2=图片漫画 3=文件 4=视频
  // 香色闺阁支持文本/图片/音频/视频源（sourceType: text/audio/comic/video），
  // 但转换器按文本源生成规则，非文本源需人工核对封面/正文/播放相关规则
  var bst = src.bookSourceType;
  if (bst !== undefined && bst !== null && Number(bst) !== 0) {
    var bstName = { 1: "音频", 2: "图片漫画", 3: "文件", 4: "视频" }[Number(bst)] || "未知类型";
    warnings.push({ level: "error", msg: "bookSourceType=" + bst + "（" + bstName + "）：香色闺阁支持对应 sourceType（text/audio/comic/video），但转换规则按文本源生成，封面/正文/播放规则请人工核对" });
  }

  var host = utils.originOf(src.bookSourceUrl) || "";
  if (!/^https?:\/\/[^\s/]+/i.test(String(src.bookSourceUrl || ""))) {
    warnings.push({ level: "error", msg: "sourceUrl 不是合法 http(s) URL；XSGG 2.56.1 不支持此站点标识，请修复原始书源主机配置" });
  }
  var ctx = {
    src: src,
    host: host,
    jsonEnabled: false,
    cryptoJsSource: options.cryptoJsSource || null
  };

  var modulesOut = {};
  var order = ["searchBook", "bookDetail", "chapterList", "chapterContent", "bookWorld"];
  var builders = {
    searchBook: modules.buildSearchBook,
    bookDetail: modules.buildBookDetail,
    chapterList: modules.buildChapterList,
    chapterContent: modules.buildChapterContent,
    bookWorld: modules.buildBookWorld
  };
  for (var i = 0; i < order.length; i++) {
    var name = order[i];
    var r = builders[name](src, ctx);
    warnings = warnings.concat(r.warnings.map(function (w) {
      return { level: w.level, module: name, msg: w.msg };
    }));
    if (r.module) {
      modulesOut[name] = r.module;
    }
  }

  // XSGG 2.56.1 may hide sources lacking any bookWorld category.
  // Provide a clearly marked homepage fallback when Legado has no browse
  // surface but does have search rules. This guarantees a valid source shape,
  // not that homepage listings will match a search-only site's XPath.
  if(!modulesOut.bookWorld && modulesOut.searchBook){
    var search=modulesOut.searchBook;
    var fallback={
      validConfig:'',actionID:'bookWorld',host:host,parserID:search.parserID||'DOM',
      responseFormatType:search.responseFormatType||'html',
      requestInfo:host+'/',list:search.list||'',bookName:search.bookName||'',
      detailUrl:search.detailUrl||'',_sIndex:0,moreKeys:{pageSize:20}
    };
    if(search.cover)fallback.cover=search.cover;
    if(search.author)fallback.author=search.author;
    modulesOut.bookWorld={'首页（待验证）':fallback};
    warnings.push({level:'degraded',module:'bookWorld',msg:'缺少分类页，已生成首页发现入口以改善书源可见性；首页是否具有书籍列表尚未经联网验证'});
  }

  var now = Date.now() / 1000;
  // bookSourceType → sourceType：0=text 1=audio 2=comic 4=video（3=文件无对应，默认 text）
  var bstMap = { 0: "text", 1: "audio", 2: "comic", 4: "video" };
  var sourceType = bstMap[Number(src.bookSourceType)] || "text";
  var defaultWeight = validWeight(options.defaultWeight, 100);
  var weight = options.forceWeight === true ? defaultWeight : validWeight(src.weight, defaultWeight);
  var enable = options.forceEnableAll === true ? 1 : (isEnabled(src.enabled) ? 1 : 0);
  var top = {
    sourceName: src.bookSourceName || "未命名书源",
    sourceUrl: String(src.bookSourceUrl || "").replace(/\/+$/, ""),
    sourceType: sourceType,
    weight: weight,
    enable: enable,
    miniAppVersion: "2.53.2",
    lastModifyTime: String(now),
    shudanList: {},
    shudanDetail: { actionID: "shudanDetail", parserID: "DOM" },
    shupingList: { actionID: "shupingList", parserID: "DOM" },
    shupingHome: { actionID: "shupingHome", parserID: "DOM" },
    searchShudan: { actionID: "searchShudan", parserID: "DOM" },
    relatedWord: { actionID: "relatedWord", parserID: "DOM" }
  };
  Object.keys(modulesOut).forEach(function (k) { top[k] = modulesOut[k]; });

  // header（JSON 字符串/对象）→ httpHeaders：站点需要特定 UA/Referer/Cookie 时必需
  var hdr = src.header;
  if (hdr !== undefined && hdr !== null && hdr !== "") {
    try {
      var ho = typeof hdr === "string" ? JSON.parse(hdr) : hdr;
      if (ho && typeof ho === "object" && Object.keys(ho).length) {
        // The XSGG 2.56.1 editor flags top-level httpHeaders objects as a
        // medium-risk save/crash field. Keep exactly the same headers on the
        // actual actions, including each discovery category, instead.
        var copied=0;
        ["searchBook","bookDetail","chapterList","chapterContent"].forEach(function (moduleName) {
          if(top[moduleName]){top[moduleName].httpHeaders=Object.assign({},ho);copied++;}
        });
        Object.keys(top.bookWorld||{}).forEach(function (key) {
          if(top.bookWorld[key]){top.bookWorld[key].httpHeaders=Object.assign({},ho);copied++;}
        });
        warnings.push({ level: "note", msg: "已映射 Legado 请求头到 " + copied + " 个动作的 httpHeaders，避免顶层对象触发 iOS 编辑保存兼容风险" });
      }
    } catch (e) {
      warnings.push({ level: "degraded", msg: "header 不是合法 JSON，未映射到 httpHeaders，需人工处理（原始请求头已隐藏）" });
    }
  }

  // 文档中存在但 XSGG 无直接对应的字段：汇总提示，避免静默丢失
  var ignored = [];
  if (src.bookUrlPattern) ignored.push("bookUrlPattern");
  if (src.loginUrl) ignored.push("loginUrl");
  if (src.ruleBookInfo) {
    if (src.ruleBookInfo.canReName) ignored.push("canReName");
    if (src.ruleBookInfo.bookInfoInit) ignored.push("bookInfoInit");
  }
  if (src.ruleToc && src.ruleToc.isVip) ignored.push("isVip");
  if (src.ruleContent) {
    if (src.ruleContent.webJs) ignored.push("webJs");
    if (src.ruleContent.sourceRegex) ignored.push("sourceRegex");
  }
  if (ignored.length) {
    warnings.push({ level: "note", msg: "以下字段无香色闺阁对应，已忽略：" + ignored.join("、") });
  }

  var output = {};
  Object.defineProperty(output,top.sourceName,{value:top,enumerable:true});
  // Apply schema/export safety to all sources (including future converter changes).
  var compat = formatCompat.normalize(output, {forceEnableAll: options.forceEnableAll === true, forceWeight: options.forceWeight === true, defaultWeight: options.defaultWeight || 100});
  warnings = warnings.concat(compat.warnings);
  return { output: compat.output, warnings: warnings, compatibility:compatibility(warnings) };
}

/** 输入归一化为书源数组：数组 / {"0":{...}} 阅读导出格式 / 单对象。 */
function parseDocuments(input) {
  if (typeof input !== 'string') return input;
  var docs=[],start=-1,stack=[],quote=false,escape=false;
  for(var i=0;i<input.length;i++){
    var ch=input[i];
    if(quote){if(escape)escape=false;else if(ch==='\\')escape=true;else if(ch==='"')quote=false;continue;}
    if(ch==='"'){quote=true;continue;}
    if(ch==='{'||ch==='['){if(!stack.length)start=i;stack.push(ch);continue;}
    if(ch==='}'||ch===']'){
      if(stack.pop()!==(ch==='}'?'{':'['))throw Error('JSON 括号不匹配');
      if(!stack.length){docs.push(JSON.parse(input.slice(start,i+1)));start=-1;}continue;
    }
    if(!stack.length&&!/\s/.test(ch)&&ch!=='\uFEFF')throw Error('JSON 文档之间含非法字符');
  }
  if(quote||stack.length||!docs.length)throw Error('JSON 未结束或格式不正确');
  return docs;
}
function toSourceArray(input) {
  var out=[];
  function walk(x){
    if(Array.isArray(x)){x.forEach(walk);return;}
    if(!x||typeof x!=='object'){out.push(x);return;}
    if(x.bookSourceUrl!==undefined || x.searchUrl!==undefined || x.sourceUrl!==undefined){out.push(x);return;}
    var keys=Object.keys(x);
    if(!keys.length){out.push(x);return;}
    keys.forEach(function(k){
      var v=x[k];
      if(v&&typeof v==='object'&&!Array.isArray(v)&&typeof v.sourceUrl==='string'){
        var entry={};Object.defineProperty(entry,k,{value:v,enumerable:true});out.push(entry);
      }else walk(v);
    });
  }
  walk(parseDocuments(input));return out;
}

/**
 * 批量转换（阅读订阅包常为 JSON 数组，可达上千个书源）：
 * - 每个书源独立 try/catch，单个失败不影响其余
 * - 重名书源自动追加 "(2)" 后缀
 * - 警告附加 source 字段（所属书源名），便于批量场景定位
 * 返回 { output(合并后单对象), warnings, failures:[{index,name?,error}], count, okCount }
 */
function convertAll(source, options) {
  options = options || {};
  var arr;
  try { arr = toSourceArray(source); } catch(e) { return {output:{},warnings:[],failures:[{index:0,error:e.message}],count:0,okCount:0}; }
  var out = {};
  var warnings = [];
  var failures = [];
  var okCount = 0;
  var sourceResults=[];
  for (var i = 0; i < arr.length; i++) {
    try {
      var r = convert(arr[i], options);
      if (!r.output || !Object.keys(r.output).length) {
        failures.push({ index: i, error: (r.warnings[0] && r.warnings[0].msg) || "无法识别的书源格式" });
        continue;
      }
      var baseName = Object.keys(r.output)[0];
      var name = baseName;
      var n = 2;
      while (Object.prototype.hasOwnProperty.call(out, name)) {
        name = baseName + "(" + n + ")";
        n++;
      }
      Object.defineProperty(out,name,{value:r.output[baseName],enumerable:true,writable:true,configurable:true});
      okCount++;
      sourceResults.push({index:i,source:name,compatibility:r.compatibility||compatibility(r.warnings)});
      for (var w = 0; w < r.warnings.length; w++) {
        var ww = r.warnings[w];
        warnings.push({ level: ww.level, module: ww.module, msg: ww.msg, source: name });
      }
    } catch (e) {
      failures.push({ index: i, error: String(e && e.message ? e.message : e) });
    }
  }
  return { output: out, warnings: warnings, failures: failures, count: arr.length, okCount: okCount, sourceResults:sourceResults };
}

module.exports = { evaluateJsonPath: require('./jsonPath').evaluateJsonPath, convert: convert, convertAll: convertAll, applyVerifiedDomainMove: domainRewrite.applyVerifiedDomainMove, describeStaticGetRequest: require("./urlRule").describeStaticGetRequest };
