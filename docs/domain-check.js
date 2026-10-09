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
    var origin=sourceList(input).find(x=>x.bookSourceName===alias || x.sourceName===alias);
    if(!origin && window.BooksourceWebProbe?.originalLegado)origin=window.BooksourceWebProbe.originalLegado(alias);
    if(typeof origin?.searchUrl==='string')return origin.searchUrl;
    var request=converted?.searchBook?.requestInfo;
    if(typeof request==='string' && !request.startsWith('@js:'))return request;
    return '';
  }
  function render(lines){
    var root=$('domainCheckResults');
    if(!root)return;
    root.replaceChildren();
    lines.forEach(function(line){
      var item=document.createElement('div');item.textContent=line;root.appendChild(item);
    });
    root.hidden=!lines.length;
  }
  function setMessage(message){
    var status=$('domainCheckStatus');if(status)status.textContent=message;
  }
  function schedule(output,input){
    var id=++currentRun;
    if(!$('autoDomainProbe')?.checked)return;
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
        searchUrl:optionalSearch(name,input,source)};
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
            log.push(row.sourceName+'：已自动更新 '+row.oldOrigin+' → '+row.newOrigin+'（修改 '+rewrite.changes.length+' 个 URL 配置）');
          }else if(rewrite?.needsReview){pending++;log.push(row.sourceName+'：'+rewrite.reason);}
        }else if(row.status==='needs-confirmation'){
          pending++;
          log.push(row.sourceName+'：检测到 '+(row.newOrigin||'新网站')+'，未自动更换：'+row.reason);
        }else if(row.status==='unverified'){
          log.push(row.sourceName+'：暂无法确认站点跳转（'+(row.reason||'连接失败')+'），已保留原域名');
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
      render(log);
      setMessage('域名自动检查完成：更新 '+applied+' 条，待进一步确认 '+pending+' 条。未验证的站点保持原始地址。');
    }).catch(function(error){
      if(id!==currentRun)return;
      setMessage('域名检测未完成：'+String(error.message||error).slice(0,180)+'。离线转换结果不受影响。');
    });
  }
  window.BooksourceDomainCheck={schedule:schedule,cancel:function(){currentRun++;}};
})();
