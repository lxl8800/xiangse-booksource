/* Default conversion post-check: automatically verify safe domain migrations.
 * No personal AI settings or cookies are sent; only source hostname plus a
 * bounded, static search URL. Apply only server-proven permanent migrations.
 */
(function(){
  'use strict';
  var currentRun=0;
  var $=id=>document.getElementById(id);
  function sourceList(source){
    if(Array.isArray(source))return source;
    if(source && typeof source==='object'){
      if(source.bookSourceUrl || source.sourceUrl)return [source];
      return Object.values(source).filter(x=>x&&typeof x==='object');
    }
    return [];
  }
  function optionalSearch(alias,input,converted){
    var request=converted?.searchBook?.requestInfo;
    if(!request){
      var origin=sourceList(input).find(x=>x.bookSourceName===alias||x.sourceName===alias);
      if(!origin&&window.BooksourceWebProbe?.originalLegado)origin=window.BooksourceWebProbe.originalLegado(alias);
      request=origin?.searchUrl;
    }
    if(!request)return {};
    var descriptor=window.ConverterLib?.describeStaticGetRequest?.(request);
    if(!descriptor||/,\s*\{/.test(descriptor.url))return {searchProbeSkipped:'unsupported-search'};
    try{
      var url=new URL(descriptor.url,converted?.searchBook?.host||converted?.sourceUrl);
      if(url.username||url.password||[...url.searchParams.keys()].some(key=>/token|api[_-]?key|secret|password|cookie|authorization|signature|session|credential|^(?:auth|auth[_-]?code|access[_-]?key|bearer)$/i.test(key)))
        return {searchProbeSkipped:'sensitive-search'};
      return {searchUrl:url.href};
    }catch{return {searchProbeSkipped:'unsupported-search'};}
  }
  function render(lines,results){
    var root=$('domainCheckResults');
    if(!root)return;
    root.replaceChildren();
    lines.forEach(function(line){
      var item=document.createElement('div');item.textContent=line;root.appendChild(item);
    });
    (results||[]).slice(0,6).forEach(function(row){
      var evidence=[];
      ['home','search'].forEach(function(key){
        var probe=row[key];if(!probe)return;
        evidence.push((key==='home'?'首页':'搜索')+'：'+probe.status+' '+(probe.httpStatus?'HTTP '+probe.httpStatus:'')+(probe.reason?'；'+probe.reason:''));
        if(probe.originalUrl)evidence.push('原始 URL：'+probe.originalUrl);
        (probe.redirects||[]).forEach(function(hop){evidence.push('HTTP '+hop.status+' '+hop.url+' → '+(hop.location||'缺少 Location')+'；'+(hop.elapsedMs||0)+'ms'+(hop.reason?'；'+hop.reason:''));});
        if(probe.url)evidence.push('最终请求 URL：'+probe.url);
        if(probe.finalDomain)evidence.push('最终域名：'+probe.finalDomain);
        if(probe.contentType)evidence.push('响应类型：'+probe.contentType);
        if(typeof probe.elapsedMs==='number')evidence.push('总耗时：'+probe.elapsedMs+'ms');
      });
      if(!evidence.length)return;
      var detail=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');
      summary.textContent=row.sourceName+'：展开域名 HTTP 证据';
      pre.textContent=evidence.join('\n');detail.append(summary,pre);root.appendChild(detail);
    });
    root.hidden=!lines.length&&!results?.length;
  }
  function setMessage(message){
    var status=$('domainCheckStatus');if(status)status.textContent=message;
  }
  function schedule(output,input){
    var id=++currentRun;
    render([]);
    if(!$('autoDomainProbe')?.checked){setMessage('域名自动检查已关闭。');return;}
    if(!output||typeof output!=='object')return;
    var names=Object.keys(output);
    if(!names.length)return;
    if(names.length>6){
      setMessage('批量转换已完成：共 '+names.length+' 条，超过安全检测上限 6 条，跳过自动联网；格式转换照常使用。');
      return;
    }
    var entries=names.filter(name=>{
      try{
        var u=new URL(output[name]?.sourceUrl||'');
        return /^https?:$/.test(u.protocol) &&
          !/(^|\.)example\.(com|net|org)$|(^|\.)example$|(^|\.)test$/.test(u.hostname);
      }catch{return false;}
    }).map(function(name){
      var source=output[name];
      return {sourceName:name,sourceUrl:source.sourceUrl,
        ...optionalSearch(name,input,source)};
    });
    if(!entries.length){render([]);return;}
    setMessage('正在自动检测 '+entries.length+' 个书源的域名是否迁移；格式结果已生成，不需 AI…');
    var initial=window.lastFullJson || JSON.stringify(output,null,2);
    fetch('/api/source/domains',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({sources:entries}),credentials:'omit',referrerPolicy:'no-referrer',
      cache:'no-store'
    }).then(function(response){return response.json().then(json=>{
      if(!response.ok||!json.ok)throw Error(json.error||'检测接口不可用');
      return json;
    });}).then(function(data){
      if(id!==currentRun)return;
      // Do not stomp on AI edits or a newer converter run.
      if((window.lastFullJson||'')!==initial)return;
      var result=JSON.parse(initial),log=[],applied=0,pending=0;
      (data.results||[]).forEach(function(row){
        if(!row||!result[row.sourceName])return;
        if(row.status==='verified'&&row.autoApply){
          var rewrite=window.ConverterLib?.applyVerifiedDomainMove?.(result[row.sourceName],row);
          if(rewrite?.applied){
            result[row.sourceName]=rewrite.source;applied++;
            log.push(row.sourceName+'：已自动更新 '+row.oldOrigin+' → '+row.newOrigin+'（修改 '+rewrite.changes.length+' 个 URL 配置；阅读规则仍须验证）');
          }else if(rewrite?.needsReview){pending++;log.push(row.sourceName+'：'+rewrite.reason);}
        }else if(row.status==='needs-confirmation'){
          pending++;
          log.push(row.sourceName+'：检测到 '+(row.newOrigin||'新网站')+'，未自动更换'+(row.migrationScope==='searchBook'?'（仅搜索模块）':'')+'：'+row.reason);
        }else if(row.status==='unverified'){
          log.push(row.sourceName+'：暂无法完成域名/搜索验证（'+(row.reason||'连接失败')+'），已保留原域名');
        }
      });
      if(applied){
        var text=JSON.stringify(result,null,2);
        window.lastFullJson=text;
        var editor=$('output');if(editor)editor.value=text;
        var full=window.lastConversionDiagnostics;
        if(full && Array.isArray(full.warnings)){
          log.filter(line=>line.includes('已自动更新')).forEach(function(line){
            full.warnings.push({level:'note',module:'domain',msg:line});
          });
          if(typeof window.renderWarnings==='function')window.renderWarnings(full);
        }
        $('aiReadSources')?.click();
      }
      render(log,data.results);
      setMessage('域名自动检查完成：更新 '+applied+' 条，待进一步确认 '+pending+' 条。未验证的站点保持原始地址。');
    }).catch(function(error){
      if(id!==currentRun)return;
      setMessage('域名检测未完成：'+String(error.message||error).slice(0,180)+'。离线转换结果不受影响。');
    });
  }
  window.BooksourceDomainCheck={schedule:schedule,cancel:function(){currentRun++;}};
})();
