import fs from 'node:fs';
import {createRequire} from 'node:module';
import {inspectSourceWeb} from '../server/site-evidence.js';
import {runAutoRepair} from '../server/auto-repair.js';
const require=createRequire(import.meta.url),c=require('../converter/lib/index.js');
const timeoutMs=Math.min(20000,Math.max(1000,Number(process.env.TEST_TIMEOUT_MS)||7800));
const inspector=input=>inspectSourceWeb(input,{timeoutMs});
const out=process.env.REPORT_DIR||'reports/live-'+new Date().toISOString().slice(0,10).replaceAll('-','');fs.mkdirSync(out,{recursive:true});
for(const [id,file] of [['suduguu','tests/fixtures/suduguu-legado.json'],['myshu','tests/fixtures/myshu-old.xsgg.json']]){
 const input=JSON.parse(fs.readFileSync(file,'utf8')),r=c.convertAll(input),name=Object.keys(r.output)[0];
 fs.writeFileSync(out+'/'+id+'.baseline.json',JSON.stringify(r.output,null,2));
 const evidence=await inspector({source:r.output,sourceName:name,keyword:process.env.TEST_KEYWORD||'斗破苍穹'});
 fs.writeFileSync(out+'/'+id+'.baseline-evidence.json',JSON.stringify(evidence,null,2));
 const repaired=await runAutoRepair({source:r.output,sourceName:name,keyword:process.env.TEST_KEYWORD||'斗破苍穹'},{webInspector:inspector});
 fs.writeFileSync(out+'/'+id+'.repair.json',JSON.stringify(repaired,null,2));
 if(repaired.candidate)fs.writeFileSync(out+'/'+id+'.candidate.json',JSON.stringify({[name]:repaired.candidate},null,2));
 const brief=x=>({fullyVerified:x?.fullyVerified,httpChainVerified:x?.httpChainVerified,steps:x?.steps?.map(s=>({step:s.step,status:s.status,url:s.url,count:s.count,contentLength:s.contentLength,reason:s.reason,examples:s.examples,fields:s.fieldChecks})),diagnostics:x?.diagnostics});
 console.log(JSON.stringify({id,baseline:brief(evidence),repaired:brief(repaired.verification),accepted:repaired.accepted}));
}