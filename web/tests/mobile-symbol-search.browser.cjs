// Built UI + isolated HTTP fixtures. Search behavior, never real user writes.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium, expect } = require('@playwright/test');
const dist = path.resolve('dist'), out = '/tmp/mw-mobile-feedback-20261114';
fs.mkdirSync(out, {recursive:true});
let logged = false, failNext = true;
let pref = {kind:'setting',name:'mw.watchlists.v1',tool:'',revision:1,content:{value:{active:'second',unknown:'keep',lists:[{id:'first',title:'第一组',symbols:[]},{id:'second',title:'第二组',symbols:['MWP:N0']}]}}};
const calls = [], errors = [], writes = [];
const row = (i, q = '') => ({ticker:'MWP:'+(['old','new'].includes(q)?q:'')+'N'+i,display_symbol: q==='old'?'OLD'+i:q==='new'?'NEW'+i:'ITEM'+i,description:'测试品种 · 原生 · Yahoo',source:i % 2 ? 'yahoo':'oanda'});
const catalog = i => ({catalog_id:'HC:'+i,source:'yahoo',provider_symbol:'ITEM'+i,display_symbol:'ITEM'+i,logical_symbol:'ITEM'+i,label:'测试品种',asset_class:'stock',precision:2,default_mode:'native_periods',supported_modes:['native_periods'],supported_frames:{none:['D1']},default_start_date:'2020-01-01'});
const managed = i => ({maintenance:{active_version_id:null},id:'managed-'+i,logical_symbol:'ITEM'+i,display_symbol:'ITEM'+i,provider_display_symbol:'ITEM'+i,identity:{source:'yahoo',basis:'bid',mode:'native_periods'},usable_timeframes:['M1'],periods:[{timeframe:'M1',available_version_id:'v-'+i}],continuation:{enabled:false}});
const server = http.createServer(async (req, res) => {
 const url = new URL(req.url, 'http://localhost'); let raw=''; for await (const chunk of req) raw+=chunk; const body=raw?JSON.parse(raw):{};
 const json = (value,status=200) => {if(res.destroyed)return;res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
 const p = url.pathname;
 if(p==='/api/session')return json(logged?{csrf:'fixture',subject:'admin'}:{},logged?200:401);
 if(p==='/api/login'){logged=true;return json({csrf:'fixture',subject:'admin'});}
 if(p==='/api/advanced-charts/preferences')return json([pref]);
 if(p==='/api/advanced-charts/preferences/save'){writes.push(body);pref={...body,revision:pref.revision+1};return json(pref);}
 if(p==='/api/market-data/series/page'){
  const q=url.searchParams.get('query')||'', offset=Number(url.searchParams.get('offset')||0);calls.push({kind:'watch',q,offset});
  if(q==='old')await new Promise(r=>setTimeout(r,900));
  if(q==='fail'&&offset===25&&failNext){failNext=false;return json({detail:'下一批失败'},400);}
  const count=q==='new'||q==='old'?1:55;
  const watched=new Set(pref.content.value.lists.flatMap(group=>group.symbols));
  const all=Array.from({length:count},(_,i)=>row(i,q));
  if(count===55)all.push({...row(90,q),display_symbol:'ITEM0',source:'dukascopy'});
  const qualified=all.filter(item=>!watched.has(item.ticker));
  const items=qualified.slice(offset,offset+25);
  if(offset&&qualified[offset-1])items.unshift(qualified[offset-1]);
  assert.equal(url.searchParams.get('mobile'),'true');assert.equal(url.searchParams.get('exclude_watch'),'true');
  return json({items,next_offset:offset+25<qualified.length?offset+25:null});
 }
 if(p==='/api/market-data/history-catalog/search'){
  const offset=Number(url.searchParams.get('offset')||0);calls.push({kind:'catalog',offset});
  return json({items:Array.from({length:Math.min(25,55-offset)},(_,i)=>catalog(offset+i)),total:55,sources:[]});
 }
 if(p==='/api/market-data/center/dataset-summaries'){
  const q=url.searchParams.get('query')||'', page=Number(url.searchParams.get('page')||1), total=['old','new'].includes(q)?0:27;
  calls.push({kind:'managed',q,page});
  const watched=new Set(pref.content.value.lists.flatMap(group=>group.symbols));
  const qualified=Array.from({length:total},(_,i)=>managed(i)).filter(item=>!watched.has('MWH:v-'+item.id.split('-')[1]));
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
  await page.getByRole('button',{name:'添加自选',exact:true}).click();
  await expect(rows()).toHaveCount(50);
  await expect(dialog().getByRole('tab')).toHaveCount(0);
  await expect(dialog().getByRole('combobox')).toHaveCount(0);
  const nativeZero=()=>rows().filter({hasText:'ITEM0'}).filter({hasNotText:'自建'}).first();
  const managedZero=()=>rows().filter({hasText:'ITEM0'}).filter({hasText:'自建'}).first();
  await expect(nativeZero()).toHaveCount(0);assert(!pref.content.value.lists[0].symbols.includes('MWP:N0'),'other group membership is hidden globally');
  const nativeOne=()=>rows().filter({hasNotText:'自建'}).filter({has:page.locator('strong').filter({hasText:/^ITEM1$/})}).first();
  await nativeOne().getByRole('button',{name:'添加 ITEM1',exact:true}).click();
  await expect(nativeOne()).toHaveCount(0);await expect(rows()).toHaveCount(50);
  assert(pref.content.value.lists[0].symbols.includes('MWP:N1'));assert.equal(pref.content.value.active,'second');assert.equal(writes.length,1);await page.getByRole('button',{name:'关闭通知',exact:true}).click();
  await managedZero().getByRole('button',{name:'添加 ITEM0',exact:true}).click();await expect(managedZero()).toHaveCount(0);assert(pref.content.value.lists[0].symbols.includes('MWH:v-0'));await page.getByRole('button',{name:'关闭通知',exact:true}).click();
  await bottom();await expect(rows()).toHaveCount(76);await bottom();await expect(rows()).toHaveCount(80);
  await expect(page.getByText('已显示全部',{exact:true})).toBeVisible();const endCount=calls.length;await bottom();await settle();assert.equal(calls.length,endCount,'end stops requests');
  assert.equal(await rows().filter({hasText:/ITEM0/}).count(),1,'already watched identities hidden; distinct remaining source retained');
  const scroll=page.locator('.mobile-drawer-scroll').last();await scroll.evaluate(el=>el.scrollTop=900);const before=await scroll.evaluate(el=>el.scrollTop);
  await rows().nth(12).locator('.symbol-search-body').click();await expect(dialog()).toHaveAccessibleName('行情详情');await close();
  assert(Math.abs(await scroll.evaluate(el=>el.scrollTop)-before)<4,'detail return keeps position');await expect(rows()).toHaveCount(80);
  const search=dialog().getByRole('searchbox');await search.fill('old');
  assert.equal(await search.evaluate(el=>getComputedStyle(el).outlineStyle),'none','InputGroup owns the focus indicator, without an inner outline');
  const clear=dialog().getByRole('button',{name:'清空搜索',exact:true});const target=await clear.boundingBox();assert(target.width>=44&&target.height>=44,'clear search retains a full touch target');await page.waitForTimeout(320);await search.fill('new');await expect(rows().first()).toContainText('NEW0');await page.waitForTimeout(950);await expect(rows()).toHaveCount(1);await expect(rows()).not.toContainText(['OLD0']);
  await search.fill('fail');await expect(rows()).toHaveCount(50);await bottom();await expect(page.getByText('下一批失败',{exact:true})).toBeVisible();const failed=calls.filter(c=>c.q==='fail').length;await settle();await bottom();assert.equal(calls.filter(c=>c.q==='fail').length,failed,'failed next page does not loop');await expect(rows()).toHaveCount(50);
  await page.getByRole('button',{name:'重试',exact:true}).click();await expect(rows()).toHaveCount(76);await bottom();await expect(rows()).toHaveCount(80);
  await scroll.evaluate(el=>el.scrollTop=0);
  for(const width of [375,412])for(const theme of ['light','dark'])for(const font of [14,21]){
   await page.setViewportSize({width,height:915});await page.evaluate(({theme,font})=>{document.querySelector('.mobile-app').dataset.theme=theme;document.documentElement.style.fontSize=font+'px';},{theme,font});await settle();
   assert(await dialog().evaluate(el=>el.scrollWidth<=el.clientWidth+1),'no drawer overflow');await page.screenshot({path:`${out}/watch-search-${width}-${theme}-${font}.png`});
  }
  await page.evaluate(()=>document.documentElement.style.fontSize='14px');await close();
  await page.getByRole('button',{name:'选择自选分组',exact:true}).click();await page.getByRole('radio',{name:'第二组',exact:true}).click();
  await page.getByRole('button',{name:'添加自选',exact:true}).click();await expect(rows()).toHaveCount(50);
  const nativeTwo=()=>rows().filter({hasNotText:'自建'}).filter({has:page.locator('strong').filter({hasText:/^ITEM2$/})}).first();
  await nativeTwo().getByRole('button',{name:'添加 ITEM2',exact:true}).click();
  await expect(nativeTwo()).toHaveCount(0);assert(pref.content.value.lists[1].symbols.includes('MWP:N2'));assert(!pref.content.value.lists[0].symbols.includes('MWP:N2'));await page.getByRole('button',{name:'关闭通知',exact:true}).click();await close();
  await page.getByRole('link' ,{name:'数据',exact:true}).click();await page.getByRole('button',{name:'搜索并添加行情',exact:true}).click();await expect(page.locator('.data-catalog-row')).toHaveCount(25);await bottom();await expect(page.locator('.data-catalog-row')).toHaveCount(50);
  const catalogScroll=page.locator('.mobile-drawer-scroll').last();await catalogScroll.evaluate(el=>el.scrollTop=600);
  await page.locator('.data-catalog-row').nth(9).click();await expect(dialog().getByRole('button',{name:'更换品种',exact:true})).toBeVisible();await dialog().getByRole('button',{name:'更换品种',exact:true}).click();await expect(page.locator('.data-catalog-row')).toHaveCount(50);assert(await catalogScroll.evaluate(el=>el.scrollTop)>400,'creation return keeps position');await bottom();await expect(page.locator('.data-catalog-row')).toHaveCount(55);
  await close();assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,checks:['shared entries','no tabs or filters or group picker','both directory page chains exhaust independently','current/default group and global duplicate exclusion before paging','continuous add','auto append','identity dedup','end stop','late query rejected','next-page failure retains rows and waits for retry','detail and creation return keep rows and scroll','375/412 light/dark 150% typography'],calls:calls.length,writes:writes.length,out}));
 } finally {await context.close();await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
