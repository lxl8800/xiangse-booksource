import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {inspectSourceWeb} from './site-evidence.js';
import {summarizeEvidence,summarizeCheckError} from './check-summary.js';

/** Read-only inventory for batch checking the shipped source pack.
 * Clients provide an opaque ID, not an arbitrary URL or extra request headers.
 * The version hash detects a bundle update while a browser queue is running.
 */
export function createSourceCatalog({file=fileURLToPath(new URL('../docs/downloads/xiangse_latest.json',import.meta.url)),inspector=inspectSourceWeb}={}){
 const raw=fs.readFileSync(file),records=JSON.parse(raw);
 const revision=createHash('sha256').update(raw).digest('hex');
 if(!records||typeof records!=='object'||Array.isArray(records))throw Error('Invalid source catalogue');
 const entries=Object.entries(records).map(([name,source])=>{
   if(!source||typeof source.sourceUrl!=='string')throw Error('Invalid catalogue source');
   const id=createHash('sha256').update(name+'\0'+source.sourceUrl).digest('hex').slice(0,20);
   return {id,name,sourceUrl:source.sourceUrl,enabled:source.enable===1||source.enable===true,source};
 });
 const byId=new Map(entries.map(entry=>[entry.id,entry]));
 return {
   metadata(){return {catalogVersion:revision,count:entries.length,defaultKeyword:'斗破苍穹',concurrency:2,
     items:entries.map(({source,...entry})=>entry)};},
   async check(body){
     if(!body||typeof body!=='object'||Array.isArray(body))throw Error('书源检测参数不正确');
     if(body.catalogVersion!==revision){const e=Error('书源合集版本已变化，请重新载入列表后再检测');e.statusCode=409;throw e;}
     if(typeof body.sourceId!=='string'||!byId.has(body.sourceId))throw Error('书源 ID 不在当前维护合集中');
     if(body.keyword!==undefined&&typeof body.keyword!=='string')throw Error('搜索关键词必须是文本');
     const keyword=(body.keyword||'斗破苍穹').trim();
     if(!keyword||keyword.length>50||/[\x00-\x1f]/.test(keyword))throw Error('搜索关键词应为 1～50 个可见字符');
     const entry=byId.get(body.sourceId),start=Date.now();
     let evidence=null,summary;
     try{
       // No original Legado fallback: test exactly the shipped XSGG config.
       evidence=await inspector({source:{[entry.name]:structuredClone(entry.source)},sourceName:entry.name,keyword});
       summary=summarizeEvidence(evidence);
     }catch(error){summary=summarizeCheckError(error);}
     return {sourceId:entry.id,sourceName:entry.name,sourceUrl:entry.sourceUrl,catalogVersion:revision,
       keyword,elapsedMs:Date.now()-start,summary,evidence};
   }
 };
}
