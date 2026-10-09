'use strict';
const assert=require('assert');
const c=require('../converter/lib/index');
const compat=require('../converter/lib/formatCompat');
const sample={bookSourceName:'JSON novel',bookSourceUrl:'https://x.example',enabled:true,weight:0,searchUrl:'https://x.example/api?kw={{key}}',ruleSearch:{bookList:'$.data',name:'$.title',bookUrl:'$.link'},ruleToc:{chapterList:'div.a',chapterName:'a@text',chapterUrl:'href'},ruleContent:{content:'id.content@html'}};
const result=c.convert(sample,{forceEnableAll:true,forceWeight:true,defaultWeight:100});
const s=result.output['JSON novel'];
assert.strictEqual(s.enable,1);
assert.strictEqual(s.weight,'100');
assert.strictEqual(s.searchBook.parserID,'DOM');
assert.strictEqual(s.searchBook.responseFormatType,'json');
for(const k of ['searchBook','bookDetail','chapterList','chapterContent']){
 assert.strictEqual(s[k].actionID,k);
 assert(['DOM','JS'].includes(s[k].parserID));
 assert(typeof s[k].requestInfo==='string' && s[k].requestInfo.trim(),k);
}
assert.equal(s.chapterList.url.split('||@js:')[0],'//@href');
const legacy={src:{sourceName:'src',sourceUrl:'https://x.example',enable:'1',weight:'0',searchBook:{actionID:'searchBook',parserID:'JSON',responseFormatType:'json',requestInfo:'https://x.example/api',list:'$.data'},chapterList:{actionID:'chapterList',parserID:'DOM',responseFormatType:'html',list:'//a',url:'/@href||@js:\nreturn result;',title:'/text()'},chapterContent:{actionID:'chapterContent',parserID:'DOM',responseFormatType:'html',content:'//article'},bookWorld:{分类:{actionID:'bookWorld',parserID:'DOM',responseFormatType:'html',requestInfo:'%@result',moreKeys:{requestFilters:[{key:'order',items:[{title:'A',value:'a'},{title:'B',value:'b'}]}]}}}}};
let parsed=compat.normalize(legacy,{forceEnableAll:true,forceWeight:true,defaultWeight:100}).output.src;
assert.strictEqual(parsed.enable,1);assert.strictEqual(parsed.weight,'100');
assert.equal(parsed.searchBook.parserID,'DOM');
assert.equal(parsed.chapterList.url,'//@href||@js:\nreturn result;');
assert.equal(parsed.chapterList.title,'//text()');
assert.equal(parsed.bookWorld.分类.moreKeys.requestFilters,'order\nA::a\nB::b');
assert.equal(parsed.bookDetail.requestInfo,'%@result');
assert.equal(parsed.chapterContent.requestInfo,'%@result');
console.log('PASS: XSGG 2.56.1 parserID, action requestInfo, href, filter-string, enable/weight');
