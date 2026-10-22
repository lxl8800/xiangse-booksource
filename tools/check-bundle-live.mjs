// Explicit, bounded live verification. Never part of the offline regression suite.
// No model key, source changes, arbitrary target URLs or persisted user settings.
import fs from 'node:fs';
import path from 'node:path';
const workspace=process.argv.includes('--workspace');
let server,base=process.env.CHECK_BASE_URL||'http://127.0.0.1:4397';
if(workspace){const {createApp}=await import('../server/index.js');server=await new Promise(resolve=>{const s=createApp().listen(0,'127.0.0.1',()=>resolve(s));});base='http://127.0.0.1:'+server.address().port;}
const directory=process.env.REPORT_DIR||'reports/bundle-live-'+new Date().toISOString().slice(0,10);
fs.mkdirSync(directory,{recursive:true});
const save=(file,data)=>fs.writeFileSync(path.join(directory,file),JSON.stringify(data,null,2)+'\n',{mode:0o600});
try{
 const metaResponse=await fetch(base+'/api/source/catalog',{signal:AbortSignal.timeout(10000)}),catalog=await metaResponse.json();
 if(!metaResponse.ok||!catalog.ok||!Array.isArray(catalog.items))throw Error('Unable to load catalogue');
 const report={startedAt:new Date().toISOString(),catalogVersion:catalog.catalogVersion,keyword:process.env.TEST_KEYWORD||catalog.defaultKeyword,aiCalled:false,appVerified:false,scope:'sampled-static-http-reading-chain',results:[]};
 const items=catalog.items.filter(x=>!process.env.SOURCE_IDS||process.env.SOURCE_IDS.split(',').includes(x.id));
 let cursor=0;
 async function worker(){
   while(cursor<items.length){
     const item=items[cursor++],response=await fetch(base+'/api/source/catalog-check',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sourceId:item.id,catalogVersion:catalog.catalogVersion,keyword:report.keyword}),signal:AbortSignal.timeout(50000)});
     const data=await response.json();
     if(!response.ok||!data.ok||data.sourceId!==item.id)throw Error('Catalogue check failed: '+item.id+' HTTP '+response.status+' '+JSON.stringify(data).slice(0,300));
     report.results.push(data);save(item.id+'.json',data);
     console.log(JSON.stringify({name:item.name,state:data.summary.state,label:data.summary.label,stage:data.summary.failureStage,elapsedMs:data.elapsedMs,reason:data.summary.reasons[0]||'',fullyVerified:data.summary.fullyVerified}));
   }
 }
 await Promise.all([worker(),worker()]);
 report.completedAt=new Date().toISOString();report.results.sort((a,b)=>catalog.items.findIndex(x=>x.id===a.sourceId)-catalog.items.findIndex(x=>x.id===b.sourceId));
 report.counts=report.results.reduce((acc,row)=>{acc[row.summary.state]=(acc[row.summary.state]||0)+1;return acc;},{});
 save('report.json',report);console.log('BATCH_COMPLETE '+JSON.stringify({count:report.results.length,catalogVersion:catalog.catalogVersion,counts:report.counts,aiCalled:false}));
}finally{if(server)await new Promise(resolve=>server.close(resolve));}
