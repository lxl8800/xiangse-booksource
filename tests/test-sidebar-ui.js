'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {JSDOM}=require('jsdom');
const htmlOriginal=fs.readFileSync('docs/index.html','utf8');
const bundle=fs.readFileSync('docs/converter.bundle.js','utf8');
const html=htmlOriginal.replace('<script src="./converter.bundle.js"></script>',()=>'<script>'+bundle+'</script>');
const updates=JSON.parse(fs.readFileSync('docs/updates.json','utf8'));
async function run(){
 const errors=[];
 const dom=new JSDOM(html,{
  url:'http://127.0.0.1:4397/',runScripts:'dangerously',pretendToBeVisual:true,
  beforeParse(w){
   w.TextEncoder=TextEncoder;w.TextDecoder=TextDecoder;
   w.HTMLElement.prototype.scrollIntoView=()=>{};
   w.fetch=async()=>({ok:true,json:async()=>updates});
   w.addEventListener('error',e=>errors.push(e.message));
  }
 });
 const w=dom.window,d=w.document;
 const allIds=[...d.querySelectorAll('[id]')].map(x=>x.id);
 assert.equal(new Set(allIds).size,allIds.length,'duplicate DOM ID');
 assert.equal(d.querySelectorAll('.sidebar-nav .nav-item').length,6);
 assert.equal(d.querySelectorAll('[data-panel-section]').length,6);
 assert.equal(d.querySelectorAll('#panel-downloads a[href*="xiangse_latest.zip"]').length,2);
 assert.equal(d.querySelectorAll('#panel-downloads .source-chip-grid span').length,14);
 assert(d.querySelector('style').textContent.includes('@media (max-width: 920px)'));
 assert.equal(d.querySelector('header.topbar').tagName,'HEADER');
 assert.equal(typeof w.ConverterLib.convertAll,'function');
 const navs=['convert','check','xbs','downloads','guide','updates'];
 for(const panel of navs){
  const button=d.querySelector('.nav-item[data-panel="'+panel+'"]');
  button.click();
  const visible=[...d.querySelectorAll('.workspace-panel')].filter(x=>!x.hidden);
  assert.equal(visible.length,1,panel+' visible panels');
  assert.equal(visible[0].dataset.panelSection,panel);
  assert.equal(button.getAttribute('aria-current'),'page');
  assert(button.classList.contains('is-active'));
 }
 const menu=d.getElementById('menuTrigger');
 menu.click();
 assert(d.body.classList.contains('sidebar-open'));
 assert.equal(menu.getAttribute('aria-expanded'),'true');
 d.getElementById('sidebarBackdrop').click();
 assert(!d.body.classList.contains('sidebar-open'));
 menu.click();d.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape'}));
 assert(!d.body.classList.contains('sidebar-open'));
 w.navigateToPanel('convert');
 w.loadSample();
 const input=d.getElementById('input');assert(input.value.includes('示例书屋'));
 w.doConvert();
 const output=d.getElementById('output').value;
 assert(output.includes('示例书屋')&&output.length>400);
 assert(!d.getElementById('dlXbsBtn').disabled);
 const xbs=w.json2xbs(output);
 assert.equal(w.xbs2json(xbs),output);
 const fakeSource={bookSourceName:'测试检测书源',bookSourceUrl:'https://example.com/'};
 const parsed=w.chkParse(JSON.stringify([fakeSource]));
 assert.equal(parsed.entries.length,1);
 assert.equal(parsed.entries[0].name,'测试检测书源');
 w.navigateToPanel('check');
 assert.equal(input.value.length>0,true,'conversion draft preserved across panels');
 w.navigateToPanel('xbs');
 const el=d.getElementById('xbsFile');
 const file=new w.File([xbs],'sample.xbs',{type:'application/octet-stream'});
 Object.defineProperty(el,'files',{configurable:true,value:[file]});
 el.dispatchEvent(new w.Event('change',{bubbles:true}));
 await new Promise(resolve=>setTimeout(resolve,220));
 assert.equal(d.getElementById('xbsOutput').value,output);
 assert(d.getElementById('xbsStatus').textContent.includes('解密成功'));
 assert(!d.getElementById('xbsCopyBtn').disabled&&!d.getElementById('xbsJsonBtn').disabled);
 w.clearXbs();
 assert.equal(d.getElementById('xbsOutput').value,'');
 assert(d.getElementById('xbsCopyBtn').disabled);
 await Promise.resolve();await Promise.resolve();
 const history=d.querySelectorAll('#updateHistory .release-item');
 assert.equal(history.length,updates.length,'update history displayed');
 assert(d.getElementById('upbar').classList.contains('show'));
 assert.equal(d.getElementById('upTitle').textContent.includes(updates[0].version),true);
 assert.equal(errors.length,0,'runtime script errors: '+errors.join(' / '));
 console.log('PASS 6 sidebar tabs + responsive drawer state + Escape close');
 console.log('PASS preserved original converter, sample input and XML checker data parser');
 console.log('PASS XBS encrypt/decrypt, XBS panel output, copy/download enabled, clear works');
 console.log('PASS 14 source links, '+updates.length+' release history items, unique IDs, no script errors');
}
run().catch(e=>{console.error(e.stack||String(e));process.exitCode=1});
