const { auditHeaderIcons, checkHeaderFeedback } = require('./mobile-header-icons.helper.cjs');
// Built UI + isolated HTTP fixtures. Search behavior, never real user writes.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium, expect } = require('@playwright/test');
const dist = path.resolve('dist'), out = process.env.MOBILE_SEARCH_OUTPUT || '/tmp/mw-mobile-feedback-20261114';
fs.mkdirSync(out, {recursive:true});
let logged = false, failNext = true, searchDelay = 0;
let pref = {kind:'setting',name:'mw.watchlists.v1',tool:'',revision:1,content:{value:{active:'second',unknown:'keep',lists:[{id:'first',title:'第一组',symbols:[]},{id:'second',title:'第二组',symbols:['MWP:N0']}]}}};
const calls = [], errors = [], writes = [];
const row = (i, q = '') => ({ticker:'MWP:'+(['old','new'].includes(q)?q:'')+'N'+i,display_symbol: q==='old'?'OLD'+i:q==='new'?'NEW'+i:'ITEM'+i,description:'测试品种 · 原生 · Yahoo',source:i % 2 ? 'yahoo':'oanda',asset_class:i%3?'forex':'equity'});
const catalog = i => ({catalog_id:'HC:'+i,source:i%2?'oanda':'yahoo',provider_symbol:'ITEM'+i,display_symbol:'ITEM'+i,logical_symbol:'ITEM'+i,label:'测试品种',asset_class:i%3?'forex':'equity',precision:2,default_mode:'native_periods',supported_modes:['native_periods'],supported_frames:{none:['D1']},default_start_date:'2020-01-01'});
const managed = i => ({maintenance:{active_version_id:null},id:'managed-'+i,logical_symbol:'ITEM'+i,display_symbol:'ITEM'+i,provider_display_symbol:'ITEM'+i,asset_class:'equity',identity:{source:'yahoo',basis:'bid',mode:'native_periods'},usable_timeframes:['M1'],periods:[{timeframe:'M1',available_version_id:'v-'+i}],continuation:{enabled:false}});
const assetFilter = type => ({stock:'equity',fund:'etf',commodity:'metal',futures:'future'})[type]||type;
const qualifies = (item,url) => (!url.searchParams.get('source')||(item.source||item.identity.source)===url.searchParams.get('source'))&&(!url.searchParams.get('symbol_type')||item.asset_class===assetFilter(url.searchParams.get('symbol_type')))&&(!url.searchParams.get('asset_class')||item.asset_class===url.searchParams.get('asset_class'));
const server = http.createServer(async (req, res) => {
 const url = new URL(req.url, 'http://localhost'); let raw=''; for await (const chunk of req) raw+=chunk; const body=raw?JSON.parse(raw):{};
 const json = (value,status=200) => {if(res.destroyed)return;res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
 const p = url.pathname;
 if(p==='/api/session')return json(logged?{csrf:'fixture',subject:'admin'}:{},logged?200:401);
 if(p==='/api/login'){logged=true;return json({csrf:'fixture',subject:'admin'});}
 if(p==='/api/advanced-charts/preferences')return json([pref]);
 if(p==='/api/advanced-charts/preferences/save'){writes.push(body);pref={...body,revision:pref.revision+1};return json(pref);}
 if(p==='/api/market-data/series/page'){
  if(searchDelay)await new Promise(r=>setTimeout(r,searchDelay));
  const q=url.searchParams.get('query')||'', offset=Number(url.searchParams.get('offset')||0);calls.push({kind:'watch',q,offset,params:Object.fromEntries(url.searchParams)});
  if(q==='old')await new Promise(r=>setTimeout(r,900));
  if(q==='fail'&&offset===25&&failNext){failNext=false;return json({detail:'下一批失败'},400);}
  const count=q==='new'||q==='old'?1:55;
  const watched=new Set(pref.content.value.lists.flatMap(group=>group.symbols));
  const all=Array.from({length:count},(_,i)=>row(i,q));
  if(count===55)all.push({...row(90,q),display_symbol:'ITEM0',source:'dukascopy'});
  const retained=new Set((url.searchParams.get('retain_watch')||'').split(','));
  const qualified=all.filter(item=>(!watched.has(item.ticker)||retained.has(item.ticker))&&qualifies(item,url));
  const items=qualified.slice(offset,offset+25);
  if(offset&&qualified[offset-1])items.unshift(qualified[offset-1]);
  assert.equal(url.searchParams.get('mobile'),'true');assert.equal(url.searchParams.get('exclude_watch'),'true');
  return json({items,next_offset:offset+25<qualified.length?offset+25:null});
 }
 if(p==='/api/market-data/history-catalog/search'){
  if(searchDelay)await new Promise(r=>setTimeout(r,searchDelay));
  const offset=Number(url.searchParams.get('offset')||0);calls.push({kind:'catalog',offset,params:Object.fromEntries(url.searchParams)});
  const qualified=Array.from({length:55},(_,i)=>catalog(i)).filter(item=>qualifies(item,url));
  return json({items:qualified.slice(offset,offset+25),total:qualified.length,sources:[]});
 }
 if(p==='/api/market-data/center/dataset-summaries'){
  const q=url.searchParams.get('query')||'', page=Number(url.searchParams.get('page')||1), total=['old','new'].includes(q)?0:27;
  calls.push({kind:'managed',q,page,params:Object.fromEntries(url.searchParams)});
  const watched=new Set(pref.content.value.lists.flatMap(group=>group.symbols));
  const retained=new Set((url.searchParams.get('retain_watch')||'').split(','));
  const qualified=Array.from({length:total},(_,i)=>managed(i)).filter(item=>(!watched.has('MWH:v-'+item.id.split('-')[1])||retained.has('MWH:v-'+item.id.split('-')[1]))&&qualifies(item,url));
  return json({items:qualified.slice((page-1)*25,page*25),total:qualified.length});
 }
 const dataset=p.match(/^\/api\/market-data\/center\/datasets\/managed-(\d+)$/);
 if(dataset)return json(managed(Number(dataset[1])));
 if(/^\/api\/market-data\/datasets\/managed-\d+\/continuation$/.test(p))return json({enabled:false});
 if(p==='/api/market-data/resolve')return json({source:'yahoo',frames:['M1','D1'],precision:2});
 if(p==='/api/market-data/quotes')return json([]);
 if(p==='/api/market-data/sparklines')return json({as_of:Date.now(),items:[]});
 if(p==='/api/health')return json({});
 if(p==='/api/notification-center/events'||p==='/api/notification-center/changes')return json({events:[],changes:[],more:false,unread:0,epoch:'fixture',after:null});
 if(p.startsWith('/api/charts/stream/'))return json({ok:true});
 if(p.startsWith('/api/'))return json({detail:'fixture unavailable'},404);
 let file=path.join(dist,decodeURIComponent(p));if(!fs.existsSync(file)||fs.statSync(file).isDirectory())file=path.join(dist,'m/index.html');
 res.writeHead(200,{'content-type':{'.html':'text/html','.js':'application/javascript','.css':'text/css'}[path.extname(file)]||'application/octet-stream'});res.end(fs.readFileSync(file));
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
 const context=await browser.newContext({viewport:{width:375,height:812},isMobile:true,hasTouch:true,serviceWorkers:'block'}),page=await context.newPage();
 page.on('pageerror',e=>errors.push(e.message));
 const dialog=()=>page.getByRole('dialog').last(), rows=()=>page.locator('.symbol-search-row');
 const settle=()=>page.waitForTimeout(400);
 const close=async()=>{await dialog().getByRole('button',{name:'关闭',exact:true}).click();await settle();};
 const bottom=async()=>{await page.locator('.symbol-search-footer').scrollIntoViewIfNeeded();await settle();};
 try {
  await page.goto('http://127.0.0.1:'+server.address().port+'/m/watch');await page.getByLabel('密码',{exact:true}).fill('fixture');await page.getByRole('button',{name:'登录',exact:true}).click();
  await checkHeaderFeedback(page,page.getByRole('button',{name:'添加自选',exact:true}));
  await page.getByRole('button',{name:'添加自选',exact:true}).click();
  await settle(); await checkHeaderFeedback(page,dialog().getByRole('button',{name:'增强搜索',exact:true}));
  await checkHeaderFeedback(page,dialog().getByRole('button',{name:'关闭',exact:true}));
  await expect(rows()).toHaveCount(50);
  await expect(dialog().getByRole('tab')).toHaveCount(0);
  await expect(dialog().getByRole('combobox')).toHaveCount(0);
  const nativeZero=()=>rows().filter({hasText:'ITEM0'}).filter({hasNotText:'自建'}).first();
  const managedZero=()=>rows().filter({hasText:'ITEM0'}).filter({hasText:'自建'}).first();
  await expect(nativeZero()).toHaveCount(0);assert(!pref.content.value.lists[0].symbols.includes('MWP:N0'),'other group membership is hidden globally');
  const nativeOne=()=>rows().filter({hasNotText:'自建'}).filter({has:page.locator('strong').filter({hasText:/^ITEM1$/})}).first();
  const searchCallsBeforeAdd=calls.length;
  const nativeY=(await nativeOne().boundingBox()).y;
  await nativeOne().getByRole('button',{name:'添加 ITEM1',exact:true}).click();
  await expect(nativeOne().getByRole('button',{name:'已添加 ITEM1',exact:true})).toBeDisabled();
  await expect(nativeOne().locator('svg.lucide-check')).toBeVisible();
  await expect(rows()).toHaveCount(50);
  assert(Math.abs((await nativeOne().boundingBox()).y-nativeY)<1,'successful add keeps its row position');
  assert.equal(calls.length,searchCallsBeforeAdd,'successful add does not restart the search');
  assert(pref.content.value.lists[0].symbols.includes('MWP:N1'));assert.equal(pref.content.value.active,'second');assert.equal(writes.length,1);await expect(page.locator('.mobile-toast')).toHaveCount(0);
  await managedZero().getByRole('button',{name:'添加 ITEM0',exact:true}).click();await expect(managedZero().getByRole('button',{name:'已添加 ITEM0',exact:true})).toBeDisabled();await auditHeaderIcons(page);await page.screenshot({path:out+'/added-native-managed.png'});assert(pref.content.value.lists[0].symbols.includes('MWH:v-0'));await expect(page.locator('.mobile-toast')).toHaveCount(0);
  await bottom();await expect(rows()).toHaveCount(77);await bottom();await expect(rows()).toHaveCount(82);
  await expect(page.getByText('已显示全部',{exact:true})).toBeVisible();const endCount=calls.length;await bottom();await settle();assert.equal(calls.length,endCount,'end stops requests');
  assert.equal(await rows().filter({hasText:/ITEM0/}).count(),2,'initially watched native hidden; current added managed and distinct source retained');
  const nativeCodes=await rows().filter({hasNotText:'自建'}).locator('strong').allTextContents();
  assert.equal(nativeCodes.length,55);
  for(let i=1;i<55;i++)assert(nativeCodes.includes('ITEM'+i),'pagination must not skip ITEM'+i);
  await expect(nativeOne().getByRole('button',{name:'已添加 ITEM1',exact:true})).toBeDisabled();
  const scroll=page.locator('.mobile-drawer-scroll').last();await scroll.evaluate(el=>el.scrollTop=900);const before=await scroll.evaluate(el=>el.scrollTop);
  await rows().nth(12).locator('.symbol-search-body').click();await expect(dialog()).toHaveAccessibleName('行情详情');await close();
  assert(Math.abs(await scroll.evaluate(el=>el.scrollTop)-before)<4,'detail return keeps position');await expect(rows()).toHaveCount(82);
  const search=dialog().getByRole('searchbox');await search.fill('old');
  assert.equal(await search.evaluate(el=>getComputedStyle(el).outlineStyle),'none','InputGroup owns the focus indicator, without an inner outline');
  const clear=dialog().getByRole('button',{name:'清空搜索',exact:true});const target=await clear.boundingBox();assert(target.width>=44&&target.height>=44,'clear search retains a full touch target');await page.waitForTimeout(320);await search.fill('new');await expect(rows().first()).toContainText('NEW0');await page.waitForTimeout(950);await expect(rows()).toHaveCount(1);await expect(rows()).not.toContainText(['OLD0']);
  await search.fill('fail');await expect(rows()).toHaveCount(50);await bottom();await expect(page.getByText('下一批失败',{exact:true})).toBeVisible();const failed=calls.filter(c=>c.q==='fail').length;await settle();await bottom();assert.equal(calls.filter(c=>c.q==='fail').length,failed,'failed next page does not loop');await expect(rows()).toHaveCount(50);
  await page.getByRole('button',{name:'重试',exact:true}).click();await expect(rows()).toHaveCount(77);await bottom();await expect(rows()).toHaveCount(82);
  await scroll.evaluate(el=>el.scrollTop=0);
  for(const width of [375,412])for(const theme of ['light','dark'])for(const font of [14,21]){
   await page.setViewportSize({width,height:915});await page.evaluate(({theme,font})=>{document.querySelector('.mobile-app').dataset.theme=theme;document.documentElement.style.fontSize=font+'px';},{theme,font});await settle();
   assert(await dialog().evaluate(el=>el.scrollWidth<=el.clientWidth+1),'no drawer overflow');await auditHeaderIcons(page);await page.screenshot({path:`${out}/watch-search-${width}-${theme}-${font}.png`});
  }
  await page.evaluate(()=>document.documentElement.style.fontSize='14px');await close();
  await page.getByRole('button',{name:'选择自选分组',exact:true}).click();await page.getByRole('radio',{name:'第二组',exact:true}).click();
  await page.getByRole('button',{name:'添加自选',exact:true}).click();await expect(rows()).toHaveCount(50);
  await expect(nativeOne()).toHaveCount(0);await expect(managedZero()).toHaveCount(0);
  const nativeTwo=()=>rows().filter({hasNotText:'自建'}).filter({has:page.locator('strong').filter({hasText:/^ITEM2$/})}).first();
  await nativeTwo().getByRole('button',{name:'添加 ITEM2',exact:true}).click();
  await expect(nativeTwo().getByRole('button',{name:'已添加 ITEM2',exact:true})).toBeDisabled();assert(pref.content.value.lists[1].symbols.includes('MWP:N2'));assert(!pref.content.value.lists[0].symbols.includes('MWP:N2'));await expect(page.locator('.mobile-toast')).toHaveCount(0);await close();
  await page.getByRole('link' ,{name:'数据',exact:true}).click();await page.getByRole('button',{name:'添加自建',exact:true}).click();await expect(page.locator('.data-catalog-row')).toHaveCount(25);await bottom();await expect(page.locator('.data-catalog-row')).toHaveCount(50);
  const catalogScroll=page.locator('.mobile-drawer-scroll').last();await catalogScroll.evaluate(el=>el.scrollTop=600);
  await page.locator('.data-catalog-row').nth(9).click();await expect(dialog().getByRole('button',{name:'更换品种',exact:true})).toBeVisible();await dialog().getByRole('button',{name:'更换品种',exact:true}).click();await expect(page.locator('.data-catalog-row')).toHaveCount(50);assert(await catalogScroll.evaluate(el=>el.scrollTop)>400,'creation return keeps position');await bottom();await expect(page.locator('.data-catalog-row')).toHaveCount(55);
  await close();
  // A cached page must stay readable during refresh without a transient cache banner.
  await page.evaluate(()=>{
   window.__searchHints=[];
   const observer=new MutationObserver(()=>{
    for(const panel of document.querySelectorAll('.symbol-search-panel'))
     if(/上次读取|离线显示上次目录|联网后核验/.test(panel.textContent))window.__searchHints.push(panel.textContent);
   });observer.observe(document.body,{subtree:true,childList:true,characterData:true});
  });
  searchDelay=1000;
  await page.getByRole('link',{name:'自选',exact:true}).click();
  await page.getByRole('button',{name:'添加自选',exact:true}).click();
  await expect(rows().first()).toBeVisible();
  await expect(page.locator('.symbol-search-footer')).toContainText('正在加载');
  const watchY=(await dialog().getByRole('searchbox').boundingBox()).y;
  await page.waitForTimeout(1400);
  assert(Math.abs((await dialog().getByRole('searchbox').boundingBox()).y-watchY)<1,'cached watch refresh keeps input position');
  await expect(dialog()).not.toContainText(/上次读取|联网后核验/);await close();
  await page.getByRole('link',{name:'数据',exact:true}).click();
  await page.getByRole('button',{name:'添加自建',exact:true}).click();
  await expect(page.locator('.data-catalog-row').first()).toBeVisible();
  await expect(page.locator('.symbol-search-footer')).toContainText('正在加载');
  const createY=(await dialog().getByRole('searchbox').boundingBox()).y;
  await page.waitForTimeout(1400);
  assert(Math.abs((await dialog().getByRole('searchbox').boundingBox()).y-createY)<1,'cached create refresh keeps input position');
  await expect(dialog()).not.toContainText(/上次目录|联网后核验/);
  assert.deepEqual(await page.evaluate(()=>window.__searchHints),[]);
  await context.setOffline(true);
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('.symbol-search-footer')).toContainText('离线');
  await expect(dialog()).not.toContainText(/上次目录|联网后核验/);
  await context.setOffline(false);searchDelay=0;await close();
  // Advanced filters are opt-in, shared by both adding flows, and qualify every
  // backend page. Collapsing changes presentation only; reset keeps typed text.
  const choose=async(label,value)=>{await dialog().getByRole('combobox',{name:label,exact:true}).click();await page.getByRole('option',{name:value,exact:true}).click();await settle();};
  const enhance=()=>dialog().getByRole('button',{name:'增强搜索',exact:true});
  for(const flow of ['watch','catalog']){
   await page.getByRole('link',{name:flow==='watch'?'自选':'数据',exact:true}).click();
   const entry=()=>page.getByRole('button',{name:flow==='watch'?'添加自选':'添加自建',exact:true});
   await entry().click();await expect(rows().first()).toBeVisible();
   await expect(enhance()).toHaveAttribute('aria-expanded','false');await expect(dialog().getByRole('combobox')).toHaveCount(0);
   const enhanceBox=await enhance().boundingBox(),closeBox=await dialog().getByRole('button',{name:'关闭',exact:true}).boundingBox();assert(enhanceBox.x+enhanceBox.width<=closeBox.x+1,'enhance precedes close');assert(enhanceBox.width>=44&&enhanceBox.height>=44);
   const baseline=(await rows().first().boundingBox()).y;
   await dialog().getByRole('searchbox').fill('ITEM');await settle();
   const beforeExpand=calls.length;await enhance().click();await expect(dialog().getByRole('combobox')).toHaveCount(2);await settle();assert.equal(calls.length,beforeExpand,'expansion does not query');
   await choose('来源','Yahoo');await choose('品种分类','股票');
   await expect(dialog().getByLabel('已选筛选',{exact:true})).toHaveText('Yahoo · 股票');
   await expect(enhance()).toHaveAttribute('data-active','true');
   const kinds=flow==='watch'?['watch','managed']:['catalog'];
   for(const kind of kinds){const call=calls.filter(c=>c.kind===kind).at(-1);assert.equal(call.params.source,'yahoo');assert.equal(call.params.query,'ITEM');assert.equal(call.params[kind==='managed'?'asset_class':'symbol_type'],kind==='managed'?'equity':'stock');assert.equal(kind==='managed'?call.page:call.offset,kind==='managed'?1:0,'changing filter resets pagination');}
   await bottom();await expect(dialog().getByText('已显示全部',{exact:true})).toBeVisible();
   for(const kind of kinds){const call=calls.filter(c=>c.kind===kind).at(-1);assert.equal(call.params.source,'yahoo');assert.equal(call.params.query,'ITEM');assert.equal(call.params[kind==='managed'?'asset_class':'symbol_type'],kind==='managed'?'equity':'stock','later pages retain filters');}
   assert((await rows().allTextContents()).every(text=>text.includes('Yahoo')&&text.includes('股票')),'all returned pages match both selections');
   await page.locator('.mobile-drawer-scroll').last().evaluate(el=>el.scrollTop=0);
   const totalBeforeCollapse=calls.length;await enhance().click();await settle();await expect(dialog().getByRole('combobox')).toHaveCount(0);assert.equal(calls.length,totalBeforeCollapse,'collapse keeps query');await expect(dialog().getByLabel('已选筛选',{exact:true})).toHaveText('Yahoo · 股票');
   await auditHeaderIcons(page);await page.screenshot({path:out+'/'+flow+'-filters-collapsed.png'});
   await dialog().getByRole('button',{name:'清除搜索筛选',exact:true}).click();await settle();await expect(dialog().getByRole('searchbox')).toHaveValue('ITEM');await expect(dialog().getByLabel('已选筛选',{exact:true})).toHaveCount(0);
   await expect(enhance()).not.toHaveAttribute('data-active','true');assert(Math.abs((await rows().first().boundingBox()).y-baseline)<2,'cleared collapsed layout returns to compact geometry');
   await enhance().click();await choose('来源','新浪财经');await settle();
   for(const kind of kinds){const call=calls.filter(c=>c.kind===kind).at(-1);assert.equal(call.params.source,'akshare');assert.equal(call.params.query,'ITEM 新浪财经','source family uses the existing upstream-aware query');}
   await expect(dialog().getByText(flow==='watch'?'没有符合条件的行情':'没有找到品种',{exact:true})).toBeVisible();
   await dialog().getByRole('button',{name:'清除搜索筛选',exact:true}).click();await settle();
   for(const width of [375,412])for(const theme of ['light','dark'])for(const font of [14,21]){
    await page.setViewportSize({width,height:880});await page.evaluate(({theme,font})=>{document.querySelector('.mobile-app').dataset.theme=theme;document.documentElement.style.fontSize=font+'px';},{theme,font});await settle();
    assert(await dialog().evaluate(el=>el.scrollWidth<=el.clientWidth+1),'advanced filter layout stays within drawer');
    const fields=await dialog().getByRole('combobox').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().toJSON()));assert(fields.every(r=>r.height>=44&&r.width>100),'selects keep full touch targets');
    await auditHeaderIcons(page);await page.screenshot({path:`${out}/${flow}-enhanced-${width}-${theme}-${font}.png`});
   }
   await page.evaluate(()=>document.documentElement.style.fontSize='14px');await page.setViewportSize({width:375,height:480});await dialog().getByRole('searchbox').focus();await dialog().getByRole('combobox',{name:'品种分类',exact:true}).scrollIntoViewIfNeeded();await auditHeaderIcons(page);await page.screenshot({path:out+'/'+flow+'-short-viewport.png'});
   await page.setViewportSize({width:375,height:880});await dialog().getByRole('searchbox').blur();
   await choose('来源','OANDA');await expect(rows().first()).toBeVisible();
   if(flow==='catalog'){
    await rows().first().locator('.data-catalog-row').click();await expect(dialog().getByRole('button',{name:'增强搜索',exact:true})).toHaveCount(0);
    await dialog().getByRole('button',{name:'更换品种',exact:true}).click();await expect(dialog().getByRole('combobox',{name:'来源',exact:true})).toContainText('OANDA');
   }else{
    await rows().first().locator('.symbol-search-body').click();await expect(dialog()).toHaveAccessibleName('行情详情');await close();await expect(enhance()).toHaveAttribute('aria-expanded','true');await expect(dialog().getByRole('combobox',{name:'来源',exact:true})).toContainText('OANDA');
   }
   await close();await entry().click();await expect(enhance()).toHaveAttribute('aria-expanded','false');await expect(dialog().getByLabel('已选筛选',{exact:true})).toHaveCount(0);await expect(dialog().getByRole('combobox')).toHaveCount(0);await close();
  }
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,checks:['shared entries; default compact search without tabs, filters or group picker','both directory page chains exhaust independently','current/default group and global duplicate exclusion before paging','current opening retains native/managed additions as disabled checks without requery or row jump; next opening excludes them; pagination has no skipped identities','auto append','identity dedup','end stop','late query rejected','next-page failure retains rows and waits for retry','detail and creation return keep rows and scroll','375/412 light/dark 150% typography','both cached searches refresh without cache banners or input jump; offline guard remains','shared opt-in source/category filters before close button; disclosure does not query','both directories and subsequent pages use source and category; filter changes reset paging','collapse keeps query; reset keeps typed text and restores compact geometry','upstream family query; filtered empty state; 16 advanced screenshots and short viewports','detail/creation return preserves expanded filters; reopening starts compact and unfiltered'],calls:calls.length,writes:writes.length,out}));
 } finally {await context.close();await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
