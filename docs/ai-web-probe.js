/* Live website diagnostics, separated from the user's browser-local AI credentials. */
(function(){
  'use strict';
  var el=function(id){return document.getElementById(id);};
  var steps={homepage:'首页',search:'搜索',detail:'详情',chapterList:'目录',chapterContent:'正文'};
  var states={ok:'通过',timeout:'连接超时',skipped:'无法继续验证',blocked:'403 / 访问受限',redirect:'网站重定向',unsupported:'不支持自动检测','network-error':'网络失败','no-results':'规则未匹配', 'http-error':'HTTP 错误'};
  var originals=Object.create(null);
  var autofillTimer=null;
  var lastParsedInput=null;
  function splitJsonDocuments(text){
    var out=[],start=-1,depth=0,quote=false,escaped=false;
    for(var i=0;i<text.length;i++){
      var ch=text.charAt(i);
      if(quote){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quote=false;continue;}
      if(ch==='"'){quote=true;continue;}
      if(ch==='{'||ch==='['){if(depth===0)start=i;depth++;}
      if(ch==='}'||ch===']'){
        depth--;
        if(depth===0 && start>=0){out.push(JSON.parse(text.slice(start,i+1)));start=-1;}
        if(depth<0)throw Error('JSON 括号不匹配');
      }
    }
    if(quote||depth!==0||!out.length)throw Error('JSON 未结束或格式不正确');
    return out;
  }
  function normalizeMixedSource(input){
    var records=[];
    function walk(x){
      if(Array.isArray(x)){x.forEach(walk);return;}
      if(!x||typeof x!=='object')return;
      if(typeof x.bookSourceUrl==='string'||typeof x.sourceUrl==='string'){records.push(x);return;}
      for(const [name,value] of Object.entries(x)){
        if(value&&typeof value==='object'&&typeof value.sourceUrl==='string'){
          records.push({sourceName:name,sourceUrl:value.sourceUrl,...value});
        }else if(value&&typeof value==='object'&&(value.bookSourceUrl||Array.isArray(value)))walk(value);
      }
    }
    splitJsonDocuments(input).forEach(walk);
    return records;
  }
  function inferKeyword(record){
    var value=record?.ruleSearch?.checkKeyWord || '';
    return typeof value==='string' && value.trim() ? value.trim().slice(0,50) : '斗破苍穹';
  }
  function makeMergedOutput(text,quiet){
    if(!text||text.length>310000)return false;
    var records;
    try{records=normalizeMixedSource(text);}catch{return false;}
    if(!records.length||records.length>70)return false;
    var originalNext=Object.create(null);
    var converted=window.ConverterLib.convertAll(text,{
      forceEnableAll:!!el('forceEnableAll')?.checked,
      forceWeight:!!el('forceWeight')?.checked,
      defaultWeight:Math.max(1,Number(el('defaultWeight')?.value)||100)
    });
    var next=converted.output;
    records.forEach(function(item){if(item.bookSourceUrl){var names=Object.keys(next).filter(n=>next[n].sourceName===item.bookSourceName);names.forEach(n=>originalNext[n]=item);}});
    window.lastConversionDiagnostics=converted;
    if(typeof window.renderWarnings==='function')window.renderWarnings(converted);
    if(!Object.keys(next).length)return false;
    var previouslySelected=el('aiRepairSource')?.value||'';
    originals=originalNext;
    lastParsedInput=text;
    var json=JSON.stringify(next,null,2);
    window.lastFullJson=json;
    el('output').value=json;
    window.lastOutputName='booksource-auto-converted';
    for(const id of ['copyBtn','dlJsonBtn','dlXbsBtn'])if(el(id))el(id).disabled=false;
    el('aiReadSources')?.click();
    if(previouslySelected && Object.prototype.hasOwnProperty.call(next,previouslySelected) && el('aiRepairSource')){
      el('aiRepairSource').value=previouslySelected;
      el('aiRepairSource').dispatchEvent(new Event('change'));
    }
    if(!quiet)status('已自动识别 '+Object.keys(next).length+' 条书源（支持 Legado / XSGG 混合及连续 JSON），无需手动转换或填写问题。');
    if(window.BooksourceDomainCheck)window.BooksourceDomainCheck.schedule(next,records);
    return true;
  }

  function stringElement(tag,value,klass){
    var e=document.createElement(tag);if(klass)e.className=klass;e.textContent=String(value||'');return e;
  }
  function originalLegado(name){
    if(originals[name])return originals[name];
    try{
      var parsed=JSON.parse((el('input')?.value||'').trim());
      var items=Array.isArray(parsed)?parsed:[parsed];
      return items.find(function(x){return x && typeof x.bookSourceUrl==='string' && x.bookSourceName===name;})||null;
    }catch{return null;}
  }
  function params(name){
    return {legado:originalLegado(name),keyword:(el('aiProbeKeyword')?.value||inferKeyword(originalLegado(name))).trim().slice(0,50)};
  }
  function visibleSource(){
    var input=(el('input')?.value||'').trim();
    if(input && input!==lastParsedInput && (input.charAt(0)==='{'||input.charAt(0)==='['))makeMergedOutput(input,true);
    if(!(el('output')?.value||'').trim() && input && typeof window.doConvert==='function')window.doConvert();
    var select=el('aiRepairSource');
    if(!select || !select.value || !el('output')?.value){
      el('aiReadSources')?.click();
    }
    var name=select?.value;
    if(!name)throw Error('请先把 Legado JSON 粘贴到转换框，并点击「读取当前书源」');
    var sourceDoc;
    try{sourceDoc=JSON.parse(el('output')?.value||'{}');}catch{throw Error('转换结果不是有效 JSON');}
    var source=sourceDoc?.sourceUrl?sourceDoc:sourceDoc?.[name];
    if(!source || typeof source.sourceUrl!=='string')throw Error('转换结果与选中的书源不一致，请重新转换并读取');
    var sourceMap={};sourceMap[name]=source;
    return {source:sourceMap,sourceName:name,legado:originalLegado(name),keyword:(el('aiProbeKeyword').value||'斗破苍穹').trim().slice(0,50)};
  }
  var lastEvidence=null;
  function show(evidence){
    if(!evidence || typeof evidence!=='object')return;
    lastEvidence=evidence;
    var view=el('aiWebEvidence'),list=el('aiWebEvidenceSteps');
    if(!view || !list)return;
    list.textContent='';
    view.hidden=false;
    el('aiWebEvidenceIntro').textContent=(evidence.site||'书源网站')+' · 搜索：'+(evidence.keyword||'')+' · '+(evidence.fullyVerified?'服务器静态网页四步检测通过（不等于 iOS 实测）':'存在失败或无法验证的环节，不能认定修复成功');
    (evidence.steps||[]).forEach(function(step){
      var item=stringElement('div','','ai-web-step');
      item.dataset.status=step.status||'unknown';
      var top=stringElement('div','','ai-web-step-top');
      top.appendChild(stringElement('span',steps[step.step]||step.step,'ai-web-step-title'));
      var state=states[step.status]||step.status||'未知';
      if(step.httpStatus)state+=' · HTTP '+step.httpStatus;
      if(typeof step.count==='number')state+=' · '+step.count+' 条';
      top.appendChild(stringElement('span',state,'ai-web-step-result'));
      item.appendChild(top);
      var message=step.reason||'';
      if(step.examples?.length)message+=(message?' · ':'')+'样例：'+step.examples.map(function(x){return x.title;}).join('、');
      if(step.contentLength)message+=(message?' · ':'')+'正文文本长度：'+step.contentLength;
      if(step.elapsedMs)message+=(message?' · ':'')+'耗时 '+step.elapsedMs+'ms';
      if(message)item.appendChild(stringElement('div',message,'ai-web-step-text'));
      var evidenceLines=[];
      if(step.originalUrl)evidenceLines.push('原始地址：'+step.originalUrl);
      if(step.url)evidenceLines.push((step.reusedResponse?'复用详情响应：':'请求：'+(step.requestMethod||'GET')+' ')+step.url);
      if(step.handoff)evidenceLines.push('地址传递：'+step.handoff.from+(step.handoff.value?' → '+step.handoff.value:''));
      if(step.kind)evidenceLines.push('响应类型：'+step.kind+'，响应字节：'+(step.bytes||0));
      if(step.charset)evidenceLines.push('字符编码：'+step.charset+'（'+(step.charsetSource||'响应声明')+'）');
      if(step.bodyTruncated||step.extractionTruncated)evidenceLines.push('内容受到检测预算限制，不能据此认定完整验证。');
      (step.redirects||[]).forEach(function(x){evidenceLines.push('重定向 HTTP '+x.status+'：'+(x.url||x.from)+' → '+(x.location||x.to)+'；耗时 '+(x.elapsedMs||0)+'ms'+(x.reason?'；'+x.reason:''));});
      (step.searchAttempts||[]).forEach(function(x){evidenceLines.push('尝试：'+(x.httpStatus?'HTTP '+x.httpStatus:x.status)+' '+(x.url||'')+' '+(x.reason||''));});
      if(step.discoveredSearch)evidenceLines.push('自动发现搜索表单：'+step.discoveredSearch.action+' ? '+step.discoveredSearch.parameter+'=关键词');
      if(step.autoDiscovered)evidenceLines.push('自动发现可匹配选择器：'+JSON.stringify(step.autoDiscovered));
      (step.fieldChecks||[]).forEach(function(x){
        evidenceLines.push('字段 '+x.field+'：'+x.status+'，匹配 '+(x.matches??'?')+' 条；'+(x.note||'')+'；规则 '+x.rule);
        if(x.normalization==='response-url')evidenceLines.push('  相对地址按该页最终响应 URL 解析（已识别转换器规则）。');
        (x.contexts||[]).forEach(function(row){
          evidenceLines.push('  '+(x.context==='list-node'?'列表条目 '+(row.index+1):'页面')+'：匹配 '+row.matches+'；样例 '+JSON.stringify(row.samples||[])+(row.resolvedUrls?.length?'；解析地址 '+JSON.stringify(row.resolvedUrls):''));
        });
      });
      if(step.htmlPreview)evidenceLines.push('HTML DOM 片段（已裁剪）：'+step.htmlPreview);
      if(step.textPreview)evidenceLines.push('文本片段（已裁剪）：'+step.textPreview);
      if(evidenceLines.length){
        var details=document.createElement('details');details.className='ai-web-details';
        details.appendChild(stringElement('summary','展开请求、XPath 和网页结构证据'));
        details.appendChild(stringElement('pre',evidenceLines.join('\n')));
        item.appendChild(details);
      }
      list.appendChild(item);
    });
    var notes=evidence.diagnostics||[];
    el('aiWebEvidenceNotes').textContent=notes.length?notes.join('\n'):'仅验证真实 HTTP 与静态 HTML 解析。动态 JS、WebView 与 App 专属协议不能由服务器完全模拟。';
    // Populate the issue report from actual HTTP requests and per-field
    // XPath results. No hand-written problem description is required.
    var problems=[];
    notes.forEach(function(x){problems.push(x);});
    (evidence.steps||[]).forEach(function(step){
      if(step.status!=='ok' && step.status!=='skipped')problems.push((steps[step.step]||step.step)+'：'+(step.reason||step.status));
      (step.fieldChecks||[]).forEach(function(check){
        if(['invalid','no-results','scope-warning','partial-match','missing','multiple-values','partially-checked','not-checked'].includes(check.status))
          problems.push((steps[step.step]||step.step)+'.'+check.field+'：'+(check.note||check.status));
      });
    });
    if(el('aiRepairProblem') && (el('aiRepairProblem').dataset.autofilled==='true'||!el('aiRepairProblem').value.trim())){
      el('aiRepairProblem').value=problems.join('\n').slice(0,1500);
      el('aiRepairProblem').dataset.autofilled='true';
    }
  }
  function status(message,error){
    var target=el('aiRepairStatus');
    if(!target)return;
    target.textContent=message;
    target.className='ai-repair-status'+(error?' error':'');
  }
  async function checkSite(){
    var button=el('aiSiteProbe');
    try{
      var body=visibleSource();
      button.disabled=true;
      status('正在实际访问网页：首页与搜索 → 详情 → 目录 → 正文。这一步不调用 AI，也不需要 API Key。');
      var response=await fetch('/api/source/check',{
        method:'POST',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',
        headers:{'content-type':'application/json'},body:JSON.stringify(body)
      });
      var json=await response.json();
      if(!response.ok||!json.ok)throw Error(json.error||'网站检测失败');
      show(json.evidence);
      status(json.evidence?.fullyVerified?'四步服务器 HTTP 检测通过，仍需 iOS App 确认。':'检测完成，请查看页面中的具体 HTTP 状态与限制。');
    }catch(error){status(error?.message||'网站检测失败',true);}
    finally{button.disabled=false;}
  }
  async function loadThreeExamples(){
    var button=el('aiLoadThreeExamples');
    try{
      button.disabled=true;
      var response=await fetch('./samples/three-test-sources.json',{cache:'no-store',credentials:'omit'});
      if(!response.ok)throw Error('三条测试书源读取失败');
      var records=await response.json();
      if(!Array.isArray(records)||records.length!==3)throw Error('三条书源样本格式不正确');
      if(typeof window.navigateToPanel==='function')window.navigateToPanel('convert');
      el('input').value=records.map(function(x){return JSON.stringify(x,null,2);}).join('\n');
      if(!makeMergedOutput(el('input').value))throw Error('书源自动转换失败');
      el('aiProbeKeyword').value='斗破苍穹';
      status('已自动识别速读谷、柠檬小说、天天小书屋三条书源；无需输入测试问题。选择站点后点击「自动修复并复测」。');
    }catch(error){status(error.message||'载入失败',true);}
    finally{button.disabled=false;}
  }
  async function loadTestExample(){
    var button=el('aiLoadTianxiaExample');
    try{
      button.disabled=true;
      var response=await fetch('./samples/tianxia-legado.json',{cache:'no-store',credentials:'omit'});
      if(!response.ok)throw Error('测试书源示例下载失败');
      var source=await response.json();
      if(!Array.isArray(source)||source[0]?.bookSourceName!=='⚡📂笔趣阁')throw Error('测试源文件格式不正确');
      if(typeof window.navigateToPanel==='function')window.navigateToPanel('convert');
      el('input').value=JSON.stringify(source,null,2);
      if(typeof window.doConvert==='function')window.doConvert();
      el('aiReadSources')?.click();
      el('aiProbeKeyword').value='斗破苍穹';
      status('已加载本次笔趣阁书源并转换为 XSGG。现在可以点击「检测网站」，查看真实 HTTP 请求是否成功。');
    }catch(error){status(error?.message||'加载测试书源失败',true);}
    finally{button.disabled=false;}
  }
  function downloadEvidence(){
    if(!lastEvidence)return;
    var blob=new Blob([JSON.stringify(lastEvidence,null,2)],{type:'application/json;charset=utf-8'});
    var url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download='booksource-evidence.json';document.body.appendChild(link);
    link.click();link.remove();setTimeout(function(){URL.revokeObjectURL(url);},1000);
  }
  function ready(){
    if(!el('aiSiteProbe'))return;
    el('aiSiteProbe').addEventListener('click',checkSite);
    el('webEvidenceDownload')?.addEventListener('click',downloadEvidence);
    var editor=el('input');
    editor?.addEventListener('input',function(){
      clearTimeout(autofillTimer);
      autofillTimer=setTimeout(function(){makeMergedOutput(editor.value,true);},360);
    });
    el('aiRepairSource')?.addEventListener('change',function(){
      var legado=originalLegado(this.value);
      if(legado && el('aiProbeKeyword'))el('aiProbeKeyword').value=inferKeyword(legado);
    });
    el('aiLoadTianxiaExample')?.addEventListener('click',loadTestExample);
    el('aiLoadThreeExamples')?.addEventListener('click',loadThreeExamples);
    el('aiReadSources')?.addEventListener('click',function(){lastEvidence=null;if(el('aiWebEvidence'))el('aiWebEvidence').hidden=true;});
  }
  window.BooksourceWebProbe={params:params,show:show,check:checkSite,prepareInput:visibleSource,loadExample:loadTestExample,parseMixed:makeMergedOutput,originalLegado:originalLegado};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready);else ready();
})();