import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const mode=process.argv[2]||'all';
if(!['all','server','browser','converter'].includes(mode))throw Error('Use all, server, browser or converter');
const required=['tests/fixtures/tianxia-legado.json','tests/fixtures/suduguu-legado.json','tests/fixtures/lemon-legado.json','tests/fixtures/myshu-old.xsgg.json','test-data/1298-original.json'];
const missing=required.filter(file=>!fs.existsSync(path.join(root,file)));
if(missing.length){
 console.error('Test fixtures are missing: '+missing.join(', '));
 console.error('Use the complete source workspace or Docker --target test, not the production image.');
 process.exit(2);
}
const guard=path.join(root,'tools/offline-test-guard.mjs');
const suites=[];
if(mode==='all'||mode==='server')suites.push(['server',['--test',...fs.readdirSync(path.join(root,'server/tests')).filter(f=>f.endsWith('.test.js')).sort().map(f=>'server/tests/'+f)]]);
if(mode==='all'||mode==='converter')for(const f of ['run.js','units.js'])suites.push(['converter/'+f,['converter/test/'+f]]);
if(mode==='all'||mode==='browser')for(const f of ['test-xiangse-format.js','test-sidebar-ui.js','test-ai-browser.js','test-domain-browser.js','test-evidence-browser.cjs','test-request-state.cjs','test-batch-browser.cjs']){
 if(fs.existsSync(path.join(root,'tests',f)))suites.push(['browser/'+f,['tests/'+f]]);
}
let failed=0;
for(const [name,args] of suites){
 console.log('\n=== '+name+' (offline, deterministic fixtures) ===');
 const run=spawnSync(process.execPath,['--import',guard,...args],{cwd:root,stdio:'inherit',timeout:120000,env:{...process.env,NODE_ENV:'test'}});
 if(run.status!==0){failed++;console.error('FAILED '+name+(run.error?': '+run.error.message:''));}
}
console.log('\nSUITE_SUMMARY '+JSON.stringify({mode,suites:suites.length,passed:suites.length-failed,failed}));
process.exitCode=failed?1:0;
