/* Browser-own AI settings only. Nothing is synchronized or stored by our server.
 * The API key is transmitted transiently on explicit model-list/test/repair actions.
 * All model output is displayed with textContent (never as executable HTML).
 */
(function () {
  'use strict';
  var STORAGE_KEY = 'booksource_ai_local_v1';
  var TYPE_DEFAULTS = {
    'openai-completions': 'https://api.openai.com/v1',
    'openai-responses': 'https://api.openai.com/v1',
    'anthropic-messages': 'https://api.anthropic.com/v1',
    'google-generative-ai': 'https://generativelanguage.googleapis.com/v1beta'
  };
  var sourceDocument = null;
  var selectedSourceSnapshot = null;
  var repairResult = null;
  var $ = function (id) { return document.getElementById(id); };

  function showSettings(msg, kind) {
    $('aiSettingsStatus').textContent = msg || '';
    $('aiSettingsStatus').className = 'ai-settings-status ' + (kind || '');
  }
  function showRepair(msg, kind) {
    $('aiRepairStatus').textContent = msg || '';
    $('aiRepairStatus').className = 'ai-repair-status ' + (kind || '');
  }
  function getStored() {
    try {
      var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      // Migrate only the previous default (1800) once; preserve later manual
      // values and keep everything in the user's own localStorage.
      if (saved && saved.maxTokens === 1800 && !saved.tokenLimitV2) {
        saved.maxTokens = 8192;
        saved.tokenLimitV2 = true;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
      }
      return saved;
    }
    catch { return null; }
  }
  function readFields() {
    var paramsText = $('aiSamplingParams').value.trim();
    var samplingParams = {};
    if (paramsText && paramsText !== '{}') {
      try { samplingParams = JSON.parse(paramsText); }
      catch { throw new Error('高级参数不是有效 JSON'); }
      if (!samplingParams || typeof samplingParams !== 'object' || Array.isArray(samplingParams)) throw new Error('高级参数必须是 JSON 对象');
    }
    return {
      apiType: $('aiApiType').value,
      baseUrl: $('aiBaseUrl').value.trim(),
      apiKey: $('aiApiKey').value.trim(),
      model: $('aiModel').value.trim(),
      temperature: $('aiTemperature').value.trim() === '' ? null : Number($('aiTemperature').value),
      maxTokens: $('aiMaxTokens').value.trim() === '' ? 8192 : Number($('aiMaxTokens').value),
      reasoning: $('aiReasoning').value,
      tokenField: $('aiTokenField').value,
      systemRole: $('aiSystemRole').value,
      samplingParams: samplingParams
    };
  }
  function fillFields(data) {
    data = data || {};
    $('aiApiType').value = TYPE_DEFAULTS[data.apiType] ? data.apiType : 'openai-completions';
    $('aiBaseUrl').value = data.baseUrl || TYPE_DEFAULTS[$('aiApiType').value];
    $('aiApiKey').value = data.apiKey || '';
    $('aiModel').value = data.model || '';
    $('aiTemperature').value = data.temperature === null || data.temperature === undefined ? '' : data.temperature;
    $('aiMaxTokens').value = data.maxTokens || 8192;
    $('aiReasoning').value = data.reasoning || 'off';
    $('aiTokenField').value = data.tokenField || 'auto';
    $('aiSystemRole').value = data.systemRole || 'auto';
    $('aiSamplingParams').value = JSON.stringify(data.samplingParams || {}, null, 2);
    $('aiModels').innerHTML = '<option value="">读取模型列表后选择（或直接手动输入）</option>';
  }
  function showDialog() {
    var dialog = $('aiSettingsDialog');
    if (dialog.showModal) dialog.showModal();
    else dialog.setAttribute('open', '');
    showSettings('配置只保存在本浏览器。没有订阅账号，也没有全站公共 API Key。');
  }
  function hideDialog() {
    var dialog = $('aiSettingsDialog');
    if (dialog.close) dialog.close(); else dialog.removeAttribute('open');
  }
  function saveSettings() {
    try {
      var config = readFields();
      if (!config.baseUrl || !config.apiKey || !config.model) throw new Error('请填写 API 地址、API Key 和模型 ID');
      if (!Number.isSafeInteger(config.maxTokens) || config.maxTokens < 128 || config.maxTokens > 262144) throw new Error('最多输出 Token 必须在 128～262144 之间');
      config.tokenLimitV2 = true;
      if (!/^https?:\/\//i.test(config.baseUrl)) throw new Error('API 地址请填写完整 URL');
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
      showSettings('已保存到当前浏览器的 localStorage。服务器不会保存此配置。', 'success');
      showRepair('已保存当前浏览器 AI 配置，可点击 AI 辅助修复。', 'success');
    } catch (error) { showSettings(error.message || '保存失败，浏览器可能禁用了本地存储', 'error'); }
  }
  function clearSettings() {
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    fillFields({});
    showSettings('已清除此网站在当前浏览器保存的 AI 配置。', 'success');
    showRepair('当前浏览器未保存 AI 设置，需要重新填写。');
  }
  async function postJson(url, payload) {
    var response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      body: JSON.stringify(payload)
    });
    var data;
    try { data = await response.json(); } catch { throw new Error('接口没有返回有效 JSON'); }
    if (!response.ok || !data.ok) throw new Error(data.error || ('请求失败：HTTP ' + response.status));
    return data;
  }
  async function runSettingsRequest(kind) {
    var button = kind === 'models' ? $('aiLoadModels') : $('aiTestConnection');
    try {
      var config = readFields();
      if (!config.apiKey || !config.baseUrl) throw new Error('请先填写 API 地址和 API Key');
      if (kind === 'test' && !config.model) throw new Error('请先选择或输入模型 ID');
      button.disabled = true;
      showSettings(kind === 'models' ? '正在从当前接口读取模型列表…' : '正在通过当前 API Key 调用模型进行连接测试（可能消耗少量 token）…');
      var data = await postJson('/api/ai/' + kind, { config: config });
      if (kind === 'models') {
        var selector = $('aiModels');
        selector.innerHTML = '<option value="">选择模型，或在下面手动填写</option>';
        (data.models || []).forEach(function (model) {
          var option = document.createElement('option');
          option.value = model.id;
          option.textContent = model.name && model.name !== model.id ? model.name + ' (' + model.id + ')' : model.id;
          selector.appendChild(option);
        });
        showSettings('成功读取 ' + data.models.length + ' 个模型。选择一项会填充模型 ID；不支持列表的服务可手动填写。', 'success');
      } else {
        showSettings('连接成功 · ' + data.model + ' · 模型回复：' + data.reply, 'success');
      }
    } catch (error) { showSettings(error.message || '调用失败', 'error'); }
    finally { button.disabled = false; }
  }

  function parseDocFromPage() {
    // Prefer the visible output: the original converter retains an old full
    // buffer after clearAll(), which must not become a stale repair target.
    var out = $('output')?.value || '';
    var xbs = $('xbsOutput')?.value || '';
    var text = out || xbs;
    if (!text.trim()) throw new Error('请先在「书源转换」运行转换，或在 XBS 工具中载入文件');
    if (text.includes('…（预览已截断，完整结果共')) text = window.lastFullJson || '';
    var doc;
    try { doc = JSON.parse(text); } catch { throw new Error('当前输出不是有效 JSON，请重新转换或解密 XBS'); }
    var entries = [];
    if (doc && typeof doc === 'object' && typeof doc.sourceUrl === 'string') entries.push([doc.sourceName || '书源', doc]);
    else if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
      Object.keys(doc).forEach(function (name) { if (doc[name] && typeof doc[name].sourceUrl === 'string') entries.push([name, doc[name]]); });
    }
    if (!entries.length) throw new Error('当前内容不是香色闺阁格式，请先转换为 XSGG JSON');
    return { doc: doc, entries: entries };
  }
  function readSources() {
    try {
      var result = parseDocFromPage();
      sourceDocument = result.doc;
      selectedSourceSnapshot = null;
      repairResult = null;
      $('aiRepairResult').hidden = true;
      var selector = $('aiRepairSource');
      selector.innerHTML = '';
      result.entries.forEach(function (pair) {
        var option = document.createElement('option');
        option.value = pair[0];
        option.textContent = pair[0];
        selector.appendChild(option);
      });
      showRepair('已读取 ' + result.entries.length + ' 个书源。选择一个，然后填写要修复的问题。', 'success');
    } catch (error) { showRepair(error.message, 'error'); }
  }
  function currentPair() {
    if (!sourceDocument) throw new Error('请先点击「读取当前书源」');
    var alias = $('aiRepairSource').value;
    if (sourceDocument.sourceUrl) return { alias: alias, value: sourceDocument };
    if (!Object.prototype.hasOwnProperty.call(sourceDocument, alias)) throw new Error('书源选择已失效，请重新读取');
    return { alias: alias, value: sourceDocument[alias] };
  }
  function addText(tag, value, className) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    e.textContent = String(value || '');
    return e;
  }
  function renderRepairResult(data) {
    var root = $('aiRepairPatches');
    root.textContent = '';
    $('aiRepairSummary').textContent = data.summary || '模型没有返回文字摘要。';
    (data.accepted || []).forEach(function (patch) {
      var entry = document.createElement('div');
      entry.className = 'ai-patch';
      entry.appendChild(addText('strong', patch.path));
      entry.appendChild(addText('p', patch.reason, 'ai-patch-reason'));
      entry.appendChild(addText('span', '修改前', 'ai-patch-label'));
      entry.appendChild(addText('pre', patch.oldValue));
      entry.appendChild(addText('span', '修改后', 'ai-patch-label'));
      entry.appendChild(addText('pre', patch.newValue, 'new'));
      root.appendChild(entry);
    });
    var diagnostics = [];
    (data.rejected || []).forEach(function (p) { diagnostics.push('已拒绝 ' + p.path + '：' + p.reason); });
    (data.issues || []).forEach(function (x) { diagnostics.push('静态待修复：' + x); });
    (data.warnings || []).forEach(function (x) { diagnostics.push('AI 提醒：' + x); });
    (data.diagnostics || []).forEach(function (x) { diagnostics.push('自动诊断：' + x); });
    if (data.verification) {
      diagnostics.unshift(data.verification.fullyVerified
        ? '已使用修复后的 XSGG 规则重新联网检测：搜索、详情、目录、正文均取得静态 HTTP/DOM 证据（仍不是 iOS 实机验证）。'
        : '修复候选重新联网检测未全部通过；请查看诊断再决定是否应用。');
    }
    $('aiRepairWarnings').textContent = diagnostics.length ? diagnostics.join('\n') : '没有其他静态诊断提醒。';
    var canApply = !!data.candidate && (data.accepted || []).length > 0;
    ['aiApplyFix', 'aiExportFixJson', 'aiExportFixXbs'].forEach(function (id) { $(id).disabled = !canApply; });
    $('aiRepairResult').hidden = false;
  }
  async function runAutoRepair() {
    var button=$('aiAutoRepairRun');
    try {
      if(window.BooksourceWebProbe?.prepareInput)window.BooksourceWebProbe.prepareInput();
      if(!sourceDocument)readSources();
      var selected=currentPair();
      selectedSourceSnapshot=JSON.stringify(selected.value);
      repairResult=null;
      $('aiRepairResult').hidden=true;
      button.disabled=true;
      showRepair('正在自动采集真实网页，修复规则并使用修复后的 XSGG 配置再次检查。无需 API Key，不会调用收费模型…');
      var source={};source[selected.alias]=selected.value;
      var web=window.BooksourceWebProbe?.params?.(selected.alias)||{};
      var data=await postJson('/api/source/auto-repair',{
        source:source,sourceName:selected.alias,
        legado:web.legado||null,keyword:web.keyword||'斗破苍穹'
      });
      repairResult=data;
      if(data.liveWebEvidence)window.BooksourceWebProbe?.show?.(data.liveWebEvidence);
      data.summary=data.candidate
        ?'根据真实网页找到 '+(data.accepted||[]).length+' 项可应用的修改；'
         +(data.verification?.fullyVerified?'修复后的配置已重新完成服务器 HTTP + DOM 四步验证。':'复测仍有未通过步骤，需人工确认。')
        :'真实网页证据不足，未自动生成修复候选。服务器不会用猜测覆盖原书源。';
      renderRepairResult(data);
      showRepair(data.candidate?
        '自动修复已生成；'+(data.verified?'复测四步成功。':'仍有复测限制。')+' 请在下方查看具体字段变化，确认后才应用到浏览器结果。':
        '没有生成可验证的修复候选：请查看网站 HTTP 状态和字段级检测报告。',data.candidate?'success':'');
    }catch(error){showRepair(error.message||'自动修复失败','error');}
    finally{button.disabled=false;}
  }
  async function runRepair() {
    var btn = $('aiRepairRun');
    try {
      var settings = getStored();
      if (!settings || !settings.apiKey || !settings.baseUrl || !settings.model) throw new Error('请先点击右上角「AI 设置」并保存 API Key、接口和模型');
      if (!sourceDocument && window.BooksourceWebProbe?.prepareInput) window.BooksourceWebProbe.prepareInput();
      if (!sourceDocument) readSources();
      var selected = currentPair();
      selectedSourceSnapshot = JSON.stringify(selected.value);
      repairResult = null;
      $('aiRepairResult').hidden = true;
      btn.disabled = true;
      showRepair('正在真实访问网站，取得搜索、详情、目录和正文证据，然后调用你的 AI 分析修复…');
      var requestSource = {};
      requestSource[selected.alias] = selected.value;
      var webParams = window.BooksourceWebProbe?.params?.(selected.alias) || {};
      var data = await postJson('/api/ai/repair', {
        config: settings,
        source: requestSource,
        sourceName: selected.alias,
        legado: webParams.legado || null,
        keyword: webParams.keyword || '斗破苍穹',
        problem: $('aiRepairProblem').value.trim().slice(0, 1500)
      });
      repairResult = data;
      window.BooksourceWebProbe?.show?.(data.liveWebEvidence);
      renderRepairResult(data);
      showRepair((data.accepted || []).length ? '收到 ' + data.accepted.length + ' 项修复候选。请结合真实网站检测报告查看差异后确认，未在 iOS 实测。' : '联网检测及 AI 分析结束。网站可能不可达或没有足够证据；请查看上方真实 HTTP 检测报告。', (data.accepted || []).length ? 'success' : '');
    } catch (error) { showRepair(error.message || 'AI 修复失败', 'error'); }
    finally { btn.disabled = false; }
  }
  function candidatePackage() {
    if (!repairResult || !repairResult.candidate) throw new Error('当前没有可应用的修复候选');
    var current = currentPair();
    if (current.alias !== repairResult.sourceName || JSON.stringify(current.value) !== selectedSourceSnapshot) {
      throw new Error('当前书源在检测后发生变化，请重新读取并申请修复');
    }
    var out = {};
    out[current.alias] = repairResult.candidate;
    return out;
  }
  function applyRepair() {
    try {
      var wrapped = candidatePackage();
      var alias = Object.keys(wrapped)[0];
      var result = typeof structuredClone === 'function' ? structuredClone(sourceDocument) : JSON.parse(JSON.stringify(sourceDocument));
      if (typeof result.sourceUrl === 'string') result = wrapped[alias];
      else result[alias] = wrapped[alias];
      var text = JSON.stringify(result, null, 2);
      window.lastFullJson = text;
      $('output').value = text.length > 400000 ? text.slice(0,400000) + '\n\n…（预览已截断，完整结果共 ' + text.length + ' 字符，请用下载按钮获取）' : text;
      window.lastOutputName = alias.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
      ['copyBtn', 'dlJsonBtn', 'dlXbsBtn'].forEach(function (id) { $(id).disabled = false; });
      sourceDocument = result;
      selectedSourceSnapshot = JSON.stringify(wrapped[alias]);
      showRepair('已应用到当前浏览器转换结果，可使用原有下载按钮导出；服务器没有保存或改动公共 14 源包。', 'success');
    } catch (error) { showRepair(error.message, 'error'); }
  }
  function exportCandidate(asXbs) {
    try {
      var pkg = candidatePackage();
      var key = Object.keys(pkg)[0];
      var content = JSON.stringify(pkg, null, 2);
      var name = key.replace(/[\\/:*?"<>|\x00-\x1f]/g,'_') + '-ai-repaired';
      if (asXbs) downloadBlob(json2xbs(content), name + '.xbs');
      else downloadBlob(content, name + '.json', 'application/json');
      showRepair('下载已开始。该文件仅保存在你选择的位置，服务器不保存修复结果。', 'success');
    } catch (error) { showRepair(error.message, 'error'); }
  }
  function initialize() {
    if (!$('aiSettingsOpen') || !$('aiSettingsDialog') || !$('aiRepairRun')) return;
    fillFields(getStored());
    $('aiSettingsOpen').addEventListener('click', showDialog);
    $('aiSettingsClose').addEventListener('click', hideDialog);
    $('aiSaveSettings').addEventListener('click', saveSettings);
    $('aiClearSettings').addEventListener('click', clearSettings);
    $('aiLoadModels').addEventListener('click', function () { runSettingsRequest('models'); });
    $('aiTestConnection').addEventListener('click', function () { runSettingsRequest('test'); });
    $('aiModels').addEventListener('change', function () { if (this.value) $('aiModel').value = this.value; });
    $('aiApiType').addEventListener('change', function (event) {
      var old = $('aiBaseUrl').dataset.previousDefault || TYPE_DEFAULTS['openai-completions'];
      if (!$('aiBaseUrl').value || $('aiBaseUrl').value === old) $('aiBaseUrl').value = TYPE_DEFAULTS[event.target.value] || '';
      $('aiBaseUrl').dataset.previousDefault = TYPE_DEFAULTS[event.target.value] || '';
      $('aiModels').innerHTML = '<option value="">更换协议后请重新读取模型列表</option>';
    });
    $('aiBaseUrl').dataset.previousDefault = TYPE_DEFAULTS[$('aiApiType').value];
    $('aiToggleKey').addEventListener('click', function () {
      var field = $('aiApiKey');
      field.type = field.type === 'password' ? 'text' : 'password';
      this.textContent = field.type === 'password' ? '显示' : '隐藏';
    });
    $('aiReadSources').addEventListener('click', readSources);
    $('aiAutoRepairRun').addEventListener('click', runAutoRepair);
    $('aiRepairRun').addEventListener('click', runRepair);
    $('aiApplyFix').addEventListener('click', applyRepair);
    $('aiExportFixJson').addEventListener('click', function () { exportCandidate(false); });
    $('aiExportFixXbs').addEventListener('click', function () { exportCandidate(true); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize);
  else initialize();
})();
