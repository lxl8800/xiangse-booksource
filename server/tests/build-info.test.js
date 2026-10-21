import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
test('build provenance identifies exact runtime source and version without credentials',()=>{
 const run=spawnSync(process.execPath,['tools/build-info.mjs'],{encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);
 const info=JSON.parse(run.stdout),pkg=JSON.parse(fs.readFileSync('package.json'));
 assert.equal(info.version,pkg.version);assert.match(info.sourceSha256,/^[a-f0-9]{64}$/);assert(info.files>15);
 assert(!('env' in info));assert(!('apiKey' in info));
 if(fs.existsSync('build-info.json')){
  const image=JSON.parse(fs.readFileSync('build-info.json'));
  assert.equal(image.sourceSha256,info.sourceSha256,'image source must equal the tested source');
  assert.equal(image.version,pkg.version);
 }
});
