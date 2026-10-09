// Source patches are proposals only. They MUST NOT modify disk files or
// silently overwrite the user's current bundle. All existing leaf values are
// compared before applying edits to an in-memory candidate.
const MODULES = new Set(['searchBook', 'bookDetail', 'chapterList', 'chapterContent']);
const SAFE_FIELDS = new Set([
  'requestInfo', 'parserID', 'responseFormatType', 'list', 'bookName',
  'title', 'url', 'detailUrl', 'author', 'cover', 'desc', 'cat', 'status',
  'wordCount', 'lastChapterTitle', 'chapterListUrl', 'content',
  'nextPageUrl', 'moreKeys.maxPage', 'moreKeys.pageSize', 'httpHeaders',
  'httpParams', 'responseCharset', 'responseEncode', 'webView',
  'webViewJs', 'webViewJsDelay'
]);
const ALLOWED_PARSERS = new Set(['DOM', 'JS']);
const ALLOWED_FORMATS = new Set(['html', 'json', 'xml', 'data', 'base64str']);

export function unwrapSource(doc, chosenName) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('需要香色闺阁书源 JSON 对象');
  if (typeof doc.sourceUrl === 'string') return { alias: doc.sourceName || '书源', source: doc };
  const matches = Object.entries(doc).filter(([k, v]) => v && typeof v === 'object' && typeof v.sourceUrl === 'string');
  const chosen = chosenName && matches.find(([k]) => k === chosenName);
  if (chosen) return { alias: chosen[0], source: chosen[1] };
  if (!chosenName && matches.length === 1) return { alias: matches[0][0], source: matches[0][1] };
  if (matches.length > 1) throw new Error('整合包包含多个书源，请先选择其中一个');
  throw new Error('找不到符合香色闺阁格式的 sourceUrl 字段');
}

function access(root, segments) {
  let current = root;
  for (const segment of segments) {
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, segment)) return { exists: false };
    current = current[segment];
  }
  return { exists: true, value: current };
}

export function staticSourceIssues(source) {
  const issues = [];
  if (!source || typeof source !== 'object' || typeof source.sourceUrl !== 'string' || !/^https?:\/\/[^\s/]+/i.test(source.sourceUrl)) issues.push('sourceUrl 必须为可识别的 HTTP(S) URL');
  if (!['text','audio','comic','video'].includes(source.sourceType)) issues.push('sourceType 必须为受支持的书源类型');
  if (![0, 1].includes(source.enable)) issues.push('enable 应为整数 0 或 1');
  if (!/^\d+$/.test(String(source.weight)) || Number(source.weight) < 1) issues.push('weight 必须为正整数字符串');
  for (const name of MODULES) {
    const m = source[name];
    if (!m || typeof m !== 'object') { issues.push(name + ' 动作不存在'); continue; }
    if (m.actionID !== name) issues.push(name + '.actionID 应为 ' + name);
    if (!ALLOWED_PARSERS.has(m.parserID)) issues.push(name + '.parserID 必须为 DOM 或 JS');
    if (!ALLOWED_FORMATS.has(m.responseFormatType)) issues.push(name + '.responseFormatType 不受支持');
    if (typeof m.requestInfo !== 'string' || !m.requestInfo.trim()) issues.push(name + '.requestInfo 不能为空');
  }
  return issues;
}

export function parseModelPatch(answer) {
  const text = String(answer || '').trim();
  if (text.length > 1_500_000) throw new Error('模型返回内容过长');
  let obj;
  try { obj = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch {
    const from = text.indexOf('{'), to = text.lastIndexOf('}');
    if (from < 0 || to <= from) throw new Error('模型没有返回 JSON 修复建议');
    try { obj = JSON.parse(text.slice(from, to + 1)); } catch { throw new Error('模型返回的 JSON 格式不正确'); }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('模型修复建议必须是 JSON 对象');
  return obj;
}

export function makeRepairCandidate(source, suggestion) {
  const original = structuredClone(source);
  const candidate = structuredClone(source);
  const accepted = [], rejected = [];
  const patches = Array.isArray(suggestion.patches) ? suggestion.patches.slice(0, 12) : [];
  for (const p of patches) {
    const path = String(p?.path || '').trim();
    const segments = path.split('.');
    const field = segments.slice(1).join('.');
    if (!MODULES.has(segments[0]) || segments.some(x => !x || ['__proto__', 'prototype', 'constructor'].includes(x)) || !SAFE_FIELDS.has(field)) {
      rejected.push({ path, reason: '仅允许修改核心动作内的已知字段' }); continue;
    }
    if (typeof p.newValue !== 'string' || p.newValue.length > 12_000 || (field !== 'webViewJs' && !p.newValue.trim())) {
      rejected.push({ path, reason: '新规则必须是非空文本且长度受限' }); continue;
    }
    const current = access(candidate, segments);
    if (!current.exists || typeof current.value !== 'string' || current.value !== p.oldValue) {
      rejected.push({ path, reason: '原规则不匹配或字段不存在，拒绝覆盖' }); continue;
    }
    if (field === 'parserID' && !ALLOWED_PARSERS.has(p.newValue)) {
      rejected.push({ path, reason: 'parserID 不合法' }); continue;
    }
    if (field === 'responseFormatType' && !ALLOWED_FORMATS.has(p.newValue)) {
      rejected.push({ path, reason: 'responseFormatType 不合法' }); continue;
    }
    let target = candidate;
    for (const key of segments.slice(0, -1)) target = target[key];
    target[segments.at(-1)] = p.newValue;
    accepted.push({ path, oldValue: p.oldValue, newValue: p.newValue, reason: String(p.reason || '').slice(0, 450) });
  }
  const issues = staticSourceIssues(candidate);
  // Existing sources may contain unrelated issues. A candidate must never
  // *introduce* new failures; always report unresolved issues prominently.
  const originalIssues = staticSourceIssues(original);
  const addedIssues = issues.filter(x => !originalIssues.includes(x));
  if (addedIssues.length) return { accepted: [], rejected: [...rejected, { path: '(整体验证)', reason: '候选产生新的格式问题：' + addedIssues.join('；') }], candidate: null, issues: originalIssues, verified: false };
  return { accepted, rejected, candidate: accepted.length ? candidate : null, issues, verified: false, verificationLevel: '仅静态检查（未联网及未在 iOS 实测）' };
}
