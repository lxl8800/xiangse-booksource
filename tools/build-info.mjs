// Read-only build provenance. Does not read environment files, request data or credentials.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root=process.cwd(),files=['package.json','package-lock.json'];
function walk(relative){
 for(const entry of fs.readdirSync(path.join(root,relative),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'))){
  if(entry.name.startsWith('.')||['test','tests','node_modules'].includes(entry.name))continue;
  const f=path.posix.join(relative,entry.name);
  if(entry.isDirectory())walk(f);else if(entry.isFile())files.push(f);
 }
}
for(const dir of ['server','converter/lib','docs'])walk(dir);
const hash=createHash('sha256');
for(const file of files.sort())hash.update(file+'\0').update(fs.readFileSync(path.join(root,file))).update('\0');
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const revision=/^[a-f0-9]{7,40}$/.test(process.env.BUILD_REVISION||'')?process.env.BUILD_REVISION:'unknown';
console.log(JSON.stringify({version:pkg.version,revision,sourceSha256:hash.digest('hex'),files:files.length},null,2));
