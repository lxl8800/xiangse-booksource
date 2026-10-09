"use strict";
/* XSGG/StandarReader 2.56.1 serialized source contract.
 * Based on checked public samples and cloudmantou/xiangseSkill references.
 * FORMAT ONLY: does not claim that any site responds with valid chapter text.
 */

function copyProps(x) {
  var y = {};
  Object.keys(x || {}).forEach(function (k) { y[k] = x[k]; });
  return y;
}

function fallbackFilters(value, warnings, name) {
  if (!Array.isArray(value)) return value;
  if (value.length > 1) warnings.push({ level: "degraded", module: name, msg: "分类多维筛选无法完整映射为 iOS 2.56.1 字符串形式，暂只保留首维" });
  var first = value[0];
  if (!first || !first.key || !Array.isArray(first.items)) return null;
  var lines = [String(first.key)];
  first.items.forEach(function (t) { if (t && t.title && t.value !== undefined) lines.push(String(t.title) + "::" + String(t.value)); });
  return lines.join("\n");
}

function patchModule(module, key, warnings) {
  if (!module || typeof module !== "object") return;
  if (module.parserID === "JSON") {
    module.parserID = "DOM";
    module.responseFormatType = "json";
    warnings.push({ level: "note", module: key, msg: "纠正 JSON 格式：parserID=DOM，responseFormatType=json" });
  }
  if (!module.actionID) module.actionID = key;
  if (!module.parserID) module.parserID = "DOM";
  if (module.responseFormatType === undefined) module.responseFormatType = "html";
  if (module.validConfig !== undefined && typeof module.validConfig !== "string") module.validConfig = "";
  if (["searchBook", "bookDetail", "chapterList", "chapterContent"].indexOf(key) !== -1 &&
      (typeof module.requestInfo !== "string" || !module.requestInfo.trim())) {
    if (key === "searchBook") {
      warnings.push({ level: "error", module: key, msg: "没有有效的搜索地址，不能自动编造 searchBook.requestInfo" });
    } else {
      module.requestInfo = "%@result";
    }
  }
  if (module.moreKeys && typeof module.moreKeys === "object" && module.moreKeys.requestFilters !== undefined) {
    var val = fallbackFilters(module.moreKeys.requestFilters, warnings, key);
    if (typeof val === "string") module.moreKeys.requestFilters = val;
    else delete module.moreKeys.requestFilters;
  }
  // In list-item XPath context, /@href is not a valid scoped attribute expression.
  // Verified Xiangse rule style is //@href (rather than root /@href).
  var fields = key === "chapterList" ? ["url", "detailUrl", "title"] : key === "searchBook" ? ["detailUrl"] : [];
  fields.forEach(function (field) {
    var s = module[field];
    if (typeof s !== "string") return;
    var replacement = s.replace(/^\/@href(?=\||$)/, "//@href");
    if (field === "title") replacement = replacement.replace(/^\/text\(\)(?=\||$)/, "//text()");
    if (replacement !== s) {
      module[field] = replacement;
      warnings.push({ level: "note", module: key, msg: field + " 根 XPath 已改为正确列表子字段路径" });
    }
  });
}


function normalize(doc, options) {
  options = options || {};
  var warnings = [];
  Object.keys(doc || {}).forEach(function (name) {
    var s = doc[name];
    if (!s || typeof s !== "object") return;
    s.enable = options.forceEnableAll ? 1 :
      (s.enable === 0 || s.enable === "0" || s.enable === false ? 0 : 1);
    var w = Number(options.forceWeight ? options.defaultWeight : s.weight);
    s.weight = String(Number.isFinite(w) && w >= 1 ? Math.floor(w) : 100);
    if (!/^https?:\/\/[^\s/]+/i.test(String(s.sourceUrl || ""))) {
      warnings.push({ level: "error", source: name, msg: "sourceUrl 必须为真实的 HTTP(S) URL；原始标识不是网址，无法用格式修复代替" });
    }
    if (!s.bookDetail) {
      s.bookDetail = { actionID: "bookDetail", parserID: "DOM", validConfig: "", responseFormatType: "html", requestInfo: "%@result" };
      warnings.push({ level: "degraded", source: name, module: "bookDetail", msg: "缺少详情规则，只补齐核心动作骨架（详情数据还需验证）" });
    }
    ["searchBook", "bookDetail", "chapterList", "chapterContent"].forEach(function (k) {
      if (s[k]) patchModule(s[k], k, warnings);
      else warnings.push({level:"error",source:name,module:k,msg:"缺少核心动作 "+k+"，不能认定为完整书源"});
    });
    if (options.siteAdapters !== false) require("./siteAdapters").apply(s, warnings);
    if(s.sourceType!=="text")warnings.push({level:"unsupported",source:name,msg:"当前通用引擎仅验证 text 书源"});
    if(s.bookWorld && Array.isArray(s.bookWorld))warnings.push({level:"error",source:name,msg:"bookWorld 不能为数组，需分类映射对象"});
    var world = s.bookWorld;
    if (world && typeof world === "object") {
      Object.keys(world).forEach(function (key) { patchModule(world[key], "bookWorld", warnings); });
    }
  });
  return { output: doc, warnings: warnings };
}
module.exports = { normalize: normalize };
