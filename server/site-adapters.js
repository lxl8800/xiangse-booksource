/**
 * Site-specific metadata compatibility stays outside the general repair flow.
 * These are proposals only: the repaired XSGG configuration is re-tested.
 */
export function applySiteMetadataAdapters(stage,candidate,update) {
  const host=raw=>{try{return new URL(raw).hostname;}catch{return '';}};
  const myshu=raw=>/(^|\.)myshu\.cc$/.test(host(raw));
  if(stage.search?.parserFormat!=='json'&&stage.search?.autoDiscovered && stage.search.configuredMatches===0 && myshu(stage.search.url)) {
    update('searchBook','author',"//dd[contains(@class,'book_other')][1]/span/text()",'网站适配候选：书籍节点中的作者字段，须以候选配置复测');
    update('searchBook','cover','//dt/a/img/@src','网站适配候选：书籍节点中的封面图片，须以候选配置复测');
    update('searchBook','lastChapterTitle',"//dd[contains(text(),'最新章节')]/a/text()",'网站适配候选：最新章节链接，须以候选配置复测');
  }
  if(stage.detail?.parserFormat!=='json'&&!candidate.bookDetail?.bookName && stage.detail?.title && myshu(stage.detail.url)) {
    update('bookDetail','bookName',"//div[contains(@class,'book_info')]//h1/text()",'网站适配候选：详情页书名位置，须以候选配置复测');
  }
}
