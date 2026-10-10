'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),converter=require('../converter/lib/index.js');
const root=process.env.REPORT_DIR||'reports/engine-'+new Date().toISOString().slice(0,10).replaceAll('-','');fs.mkdirSync(root,{recursive:true});
const original=JSON.parse(fs.readFileSync('test-data/1298-original.json','utf8'));
const t=performance.now(),result=converter.convertAll(original,{forceEnableAll:true,forceWeight:true,defaultWeight:100});
assert.equal(result.okCount,15);assert.equal(result.failures.length,0);
const summary={generatedAt:new Date().toISOString(),inputCount:result.count,outputCount:result.okCount,elapsedMs:performance.now()-t,warningCounts:{},sources:result.sourceResults,officialApp:'blocked: no official iOS runtime available'};
for(const w of result.warnings)summary.warningCounts[w.level]=(summary.warningCounts[w.level]||0)+1;
for(const [name,source] of Object.entries(result.output)){
 assert.equal(source.sourceType,'text');assert.equal(source.enable,1);assert.equal(source.weight,'100');
 fs.writeFileSync(root+'/source-'+Object.keys(result.output).indexOf(name)+'.json',JSON.stringify({[name]:source},null,2));
}
const large=Array.from({length:1500},(_,i)=>({...original[i%15],bookSourceName:'performance-'+i}));
const began=performance.now(),bulk=converter.convertAll(large);
assert.equal(bulk.okCount,1500);assert.equal(bulk.failures.length,0);
summary.performance1500={elapsedMs:performance.now()-began,outputs:bulk.okCount};
for(const fixture of ['suduguu-legado.json','lemon-legado.json','myshu-old.xsgg.json']){
 const input=JSON.parse(fs.readFileSync('tests/fixtures/'+fixture,'utf8'));
 const r=converter.convertAll(input);
 assert(r.okCount>0);assert.equal(r.failures.length,0);
 const name=fixture.replace(/\.[^.]+$/,'');
 fs.writeFileSync(root+'/'+name+'.converted.json',JSON.stringify(r.output,null,2));
}
fs.writeFileSync(root+'/corpus.json',JSON.stringify(summary,null,2));
console.log(JSON.stringify({inputCount:summary.inputCount,outputCount:summary.outputCount,warningCounts:summary.warningCounts,elapsedMs:Math.round(summary.elapsedMs),performance1500:summary.performance1500}));
