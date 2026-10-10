"use strict";
// Xiangse-specific catalog URL handling for m.cuoceng.com/.org.
// The detail page contains only the latest chapters and a link to /book/chapter/{id}.html.
// Preserve working chapterContent rules and do not change manually customized catalog actions.
function patchCuocengCatalog(source, warnings) {
  if (!/^https?:\/\/m\.cuoceng\.(?:com|org)(?:\/|$)/i.test(String(source.sourceUrl || ""))) return;
  // An explicit catalog link keeps the original source semantics and takes priority.
  if (source.bookDetail && typeof source.bookDetail.chapterListUrl === "string" &&
      source.bookDetail.chapterListUrl.trim()) return;
  var catalog = source.chapterList;
  if (!catalog || typeof catalog !== "object" || catalog.requestInfo !== "%@result" ||
      !/allchapter/i.test(String(catalog.list || ""))) return;
  catalog.requestInfo = "@js:\nvar base = String(config.host || 'https://m.cuoceng.com').replace(/\\/+$/, '');\nvar u = '';\nif (params && params.lastResponse && params.lastResponse.nextPageUrl) u = params.lastResponse.nextPageUrl;\nif (!u && params && params.queryInfo) u = params.queryInfo.url || params.queryInfo.detailUrl || '';\nif (!u && typeof result === 'string') u = result;\nif (!u && result && typeof result === 'object') u = result.url || result.detailUrl || '';\nif (!u && params && params.responseUrl) u = params.responseUrl;\nu = String(u || '').trim().split(/\\s+/)[0];\nif (u.indexOf('//') === 0) u = 'https:' + u;\nelse if (u && u.indexOf('http') !== 0) u = base + (u.charAt(0) === '/' ? '' : '/') + u;\nvar m = u.match(/\\/book\\/([a-f0-9-]{36})\\.html(?:[?#].*)?$/i);\nif (m) u = base + '/book/chapter/' + m[1] + '.html';\nreturn u;";
  catalog.list = "//div[@id='allchapter']//dd/a";
  catalog.title = "//text()";
  catalog.url = "//@href";
  catalog.detailUrl = "//@href";
  catalog.nextPageUrl = "//a[@id='linkNext']/@href";
  catalog.moreKeys = catalog.moreKeys || {};
  catalog.moreKeys.maxPage = 10;
  // A malformed older Legado XPath quote produced a 2.56.1 parser error.
  if (source.bookDetail && /booktag/.test(String(source.bookDetail.wordCount || ""))) {
    source.bookDetail.wordCount = "//p[@class='booktag']/span[1]/text()";
  }
  warnings.push({ level: "note", module: "chapterList", msg: "错层小说目录已改用 /book/chapter/{书籍ID}.html 独立目录页（支持目录分页；保留原正文规则）" });
}


module.exports={apply:patchCuocengCatalog};
