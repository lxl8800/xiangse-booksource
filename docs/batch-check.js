/* Read-only queue over the server's shipped catalogue. No API keys, automatic
 * repairs, public proxies, persistent user data or unattended background work. */
(function(){
 'use strict';
 var $=function(id){return document.getElementById(id);};
 var labels={queued:'待检测',running:'检测中',cancelled:'已取消',verified:'样本规则通过',partial:'部分验证',rules:'规则需修复',no_results:'搜索无结果',unreachable:'网络不可达',restricted:'访问受限',unsupported:'检测能力受限',error:'检测异常'};
 var stageNames={search:'搜索',detail:'详情',chapterList:'目录',chapterContent:'正文'};
 var stageStates={ok:'HTTP/解析取得结果',skipped:'未继续',unsupported:'无法验证','not-tested':'未测试','no-results':'未匹配',timeout:'超时','network-error':'网络错误','http-error':'HTTP 错误',blocked:'受限',redirect:'跳转待确认'};
 var catalog=null,rows=[],generation=0,running=false,loading=false,controllers=new Map(),loadController=null;
 var readyAfter=0,cooldownTimer=null,runKeyword='',startedAt=null,updatedAt=null;
 function node(tag,text,className){var e=document.createElement(tag);if(className)e.className=className;if(text!==undefined)e.textContent=String(text);return e;}
 function message(text,error){$('batchStatus').textContent=text;$('batchStatus').className='batch-status'+(error?' error':'');}
 function secondsLeft(){return Math.max(0,Math.ceil((readyAfter-Date.now())/1000));}
 function controls(){
   var blocked=secondsLeft()>0;
   $('batchStart').disabled=running||loading||!rows.length||blocked;
   $('batchRetry').disabled=running||loading||blocked||!rows.some(function(r){return r.state!=='verified'&&r.state!=='queued';});
   $('batchStop').disabled=!running&&!loading;
   $('batchReload').disabled=running||loading;
   $('batchKeyword').disabled=running;
   $('batchExportJson').disabled=!rows.some(function(r){return r.result||r.state==='error'||r.state==='cancelled';});
   $('batchExportCsv').disabled=$('batchExportJson').disabled;
 }
 function setCooldown(seconds){
   readyAfter=Math.max(readyAfter,Date.now()+Math.min(3600,Math.max(1,Number(seconds)||10))*1000);
   if(cooldownTimer)clearInterval(cooldownTimer);
   $('batchCooldown').textContent='限流冷却：'+secondsLeft()+' 秒后可手动重试。不会自动重复请求。';
   cooldownTimer=setInterval(function(){
     var left=secondsLeft();$('batchCooldown').textContent=left?'限流冷却：'+left+' 秒后可手动重试。不会自动重复请求。':'';
     controls();if(!left){clearInterval(cooldownTimer);cooldownTimer=null;}
   },1000);controls();
 }
 function render(){
   var filter=$('batchFilter').value;
   var list=$('batchRows');list.replaceChildren();
   var checked=rows.filter(function(r){return !['queued','running','cancelled'].includes(r.state);}).length;
   var passed=rows.filter(function(r){return r.state==='verified';}).length;
   var partial=rows.filter(function(r){return r.state==='partial';}).length;
   var active=rows.filter(function(r){return r.state==='running';}).length;
   $('batchProgress').max=Math.max(1,rows.length);$('batchProgress').value=checked;
   $('batchProgressText').textContent='已完成 '+checked+' / '+rows.length+' · 样本通过 '+passed+' · 部分验证 '+partial+' · 运行中 '+active;
   rows.filter(function(r){return filter==='all'||r.state===filter||(filter==='attention'&&!['verified','queued','running'].includes(r.state));}).forEach(function(r){
     var tr=node('tr');tr.dataset.state=r.state;
     var title=node('td');title.appendChild(node('strong',r.item.name));title.appendChild(node('div',r.item.sourceUrl,'batch-host'));tr.appendChild(title);
     tr.appendChild(node('td',labels[r.state]||'检测异常','batch-result'));
     var stages=node('td'),summary=r.result?.summary;
     (summary?.stages||[]).forEach(function(s){var label=(stageNames[s.name]||s.name)+'：'+(stageStates[s.status]||s.status);if(s.httpStatus)label+=' '+s.httpStatus;if(s.count!==null&&s.count!==undefined)label+=' / '+s.count+' 条';if(s.pages)label+=' / '+s.pages+' 页'+(s.paginationComplete===false?'（未完）':'');stages.appendChild(node('div',label));});
     if(!stages.childNodes.length)stages.textContent=r.state==='running'?'正在获取真实网页证据…':'—';
     tr.appendChild(stages);
     var desc=node('td');
     if(summary){
       desc.appendChild(node('div',summary.reasons?.[0]||summary.suggestion||''));
       var detail=node('details'),caption=node('summary','查看诊断与请求证据');detail.appendChild(caption);
       detail.appendChild(node('p',summary.suggestion||''));
       detail.appendChild(node('pre',JSON.stringify({summary:summary,evidence:r.result.evidence},null,2).slice(0,120000)));
       desc.appendChild(detail);
     }else desc.textContent=r.message||'等待执行';
     if(r.elapsedMs)desc.appendChild(node('div',(r.elapsedMs/1000).toFixed(1)+' 秒 · 第 '+r.attempts+' 次检测','batch-host'));
     tr.appendChild(desc);list.appendChild(tr);
   });controls();
 }
 function invalidate(reason){
   generation++;running=false;loading=false;
   if(loadController){loadController.abort();loadController=null;}
   controllers.forEach(function(ctl){ctl.abort();});controllers.clear();
   rows.forEach(function(r){if(r.state==='running'||r.state==='queued'){r.state='cancelled';r.message=reason||'已取消，迟到响应不会改动结果';}});
   updatedAt=new Date().toISOString();render();
 }
 async function load(){
   invalidate();catalog=null;rows=[];loading=true;var own=generation;render();message('正在载入服务器维护的书源列表…');
   var controller=new AbortController();loadController=controller;var timer=setTimeout(function(){controller.abort();},12000);
   try{
     var res=await fetch('/api/source/catalog',{credentials:'omit',cache:'no-store',signal:controller.signal});var data=await res.json();
     if(own!==generation)return;
     if(!res.ok||!data.ok||!Array.isArray(data.items)||data.items.length>100||typeof data.catalogVersion!=='string')throw Error(data.error||'书源列表响应不正确');
     var ids=new Set();data.items.forEach(function(item){if(!item||typeof item.id!=='string'||typeof item.name!=='string'||ids.has(item.id))throw Error('书源列表 ID 无效');ids.add(item.id);});
     catalog=data;rows=data.items.map(function(item){return {item:item,state:'queued',attempts:0,result:null,elapsedMs:0};});
     $('batchSourceCount').textContent=String(rows.length);
     if(!$('batchKeyword').value)$('batchKeyword').value=data.defaultKeyword||'斗破苍穹';
     message('已载入 '+rows.length+' 条维护书源。点击开始后逐源验证，不调用 AI，也不会改动合集。');
   }catch(error){if(own===generation)message(error.name==='AbortError'?'载入超时或已取消，请重试。':error.message,true);}
   finally{clearTimeout(timer);if(own===generation){loading=false;loadController=null;render();}}
 }
 function responseError(data,fallback){return typeof data?.error==='string'?data.error.slice(0,300):fallback;}
 async function run(retry){
   if(running||loading||!catalog||secondsLeft())return;
   var keyword=$('batchKeyword').value.trim()||catalog.defaultKeyword;
   if(!keyword||keyword.length>50){message('测试关键词应为 1～50 个字符。',true);return;}
   var selected=rows.filter(function(r){return !retry||r.state!=='verified';});
   if(!selected.length)return;
   var own=++generation,cursor=0;running=true;runKeyword=keyword;startedAt=new Date().toISOString();
   selected.forEach(function(r){r.state='queued';r.result=null;r.message='';});render();
   message('正在批量验证，最多同时检测 2 条。HTTP 成功不等于规则全部通过。');
   async function worker(){
     while(own===generation&&cursor<selected.length){
       var row=selected[cursor++],ctl=new AbortController(),start=Date.now();
       row.state='running';row.attempts++;controllers.set(row.item.id,ctl);render();
       var timer=setTimeout(function(){ctl.abort();},50000);
       try{
         var res=await fetch('/api/source/catalog-check',{method:'POST',headers:{'content-type':'application/json'},credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:ctl.signal,
           body:JSON.stringify({sourceId:row.item.id,catalogVersion:catalog.catalogVersion,keyword:keyword})});
         var data=await res.json();if(own!==generation)return;
         if(res.status===429){row.state='error';row.message=responseError(data,'服务器限流');setCooldown(data.retryAfter||res.headers?.get?.('Retry-After'));invalidate('限流后停止队列，保留已经完成的结果');message('服务器限流，已停止剩余请求；冷却结束后点击重试。',true);return;}
         if(res.status===409){row.state='error';row.message=responseError(data,'合集版本变化');invalidate('合集版本变化，请重新载入');message('书源合集发生更新，请重新载入列表后再开始。',true);return;}
         if(!res.ok||!data.ok)throw Error(responseError(data,'检测接口 HTTP '+res.status));
         if(data.sourceId!==row.item.id||data.catalogVersion!==catalog.catalogVersion||!Object.hasOwn(labels,data.summary?.state)||['running','queued','cancelled'].includes(data.summary?.state))throw Error('检测响应与当前书源或结果类型不一致');
         row.result=data;row.state=data.summary.state;row.message='';
       }catch(error){if(own!==generation)return;row.state='error';row.message=error.name==='AbortError'?'本次请求达到等待上限；服务器仍受独立请求预算限制':String(error.message||'检测失败').slice(0,300);}
       finally{clearTimeout(timer);if(own===generation){controllers.delete(row.item.id);row.elapsedMs=Date.now()-start;updatedAt=new Date().toISOString();render();}}
     }
   }
   await Promise.all([worker(),worker()]);
   if(own===generation){running=false;render();message('本轮检测完成。通过仅指当前关键词和抽样页面；未通过项请先查看原因，不要自动删除书源。');}
 }
 function report(){
   return {reportVersion:1,tool:'xiangse-booksource',catalogVersion:catalog?.catalogVersion||null,startedAt:startedAt,updatedAt:updatedAt,
     keyword:runKeyword||$('batchKeyword').value,scope:'sampled-static-http-reading-chain',appVerified:false,aiCalled:false,
     results:rows.map(function(r){return {sourceId:r.item.id,sourceName:r.item.name,sourceUrl:r.item.sourceUrl,state:r.state,label:labels[r.state],attempts:r.attempts,elapsedMs:r.elapsedMs,message:r.message||'',result:r.result};})};
 }
 function exportReport(csv){
   var data=report(),text,type,name;
   if(csv){
     var escape=function(value){var s=String(value??'');if(/^[\s]*[=+@-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
     var lines=[['书源','站点','状态','失败环节','原因','建议','关键词','检测次数','耗时毫秒']];
     data.results.forEach(function(r){var s=r.result?.summary;lines.push([r.sourceName,r.sourceUrl,r.label,s?.failureStage||'',(s?.reasons||[r.message]).join('；'),s?.suggestion||'',r.result?.keyword||data.keyword,r.attempts,r.elapsedMs]);});
     text='\ufeff'+lines.map(function(row){return row.map(escape).join(',');}).join('\r\n');type='text/csv;charset=utf-8';name='booksource-batch-report.csv';
   }else{text=JSON.stringify(data,null,2);type='application/json';name='booksource-batch-report.json';}
   var blob=new Blob([text],{type:type}),url=URL.createObjectURL(blob),link=document.createElement('a');
   link.href=url;link.download=name;document.body.appendChild(link);link.click();link.remove();setTimeout(function(){URL.revokeObjectURL(url);},1000);
 }
 function ready(){
   if(!$('batchStart'))return;
   $('batchReload').addEventListener('click',load);
   $('batchStart').addEventListener('click',function(){run(false);});
   $('batchRetry').addEventListener('click',function(){run(true);});
   $('batchStop').addEventListener('click',function(){invalidate();message('已停止队列并取消浏览器等待；不会应用迟到结果。已发出的服务端探测仍受超时限制。');});
   $('batchFilter').addEventListener('change',render);
   $('batchKeyword').addEventListener('input',function(){invalidate('关键词已变化，请重新开始检测');rows.forEach(function(r){r.result=null;r.state='queued';r.elapsedMs=0;});runKeyword='';startedAt=null;render();message('关键词已变化，旧结果已清除。点击开始进行新的检测。');});
   $('batchExportJson').addEventListener('click',function(){exportReport(false);});
   $('batchExportCsv').addEventListener('click',function(){exportReport(true);});
   window.addEventListener('beforeunload',function(){generation++;controllers.forEach(function(c){c.abort();});loadController?.abort();});
   render();load();
 }
 // No request starts automatically except for the read-only catalogue metadata.
 window.BooksourceBatch={report:report,load:load,run:run,cancel:invalidate};
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready);else ready();
})();
