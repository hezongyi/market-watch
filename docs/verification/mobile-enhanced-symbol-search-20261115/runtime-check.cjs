// Real Ubuntu APIs, read-only. Authentication stays in the task-private directory.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium,expect}=require(path.resolve(__dirname,'../../../web/node_modules/@playwright/test'));
const base='https://127.0.0.1:18447',root=__dirname;
fs.mkdirSync(root+'/runtime',{recursive:true});
(async()=>{const browser=await chromium.launch();try{
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:375,height:880},isMobile:true,hasTouch:true,serviceWorkers:'block'});
 const credentials=JSON.parse(fs.readFileSync('/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/credentials.json'));
 assert((await context.request.post(base+'/api/login',{data:{password:credentials.login_password}})).ok());
 const page=await context.newPage(),errors=[],writes=[],blockedBackgroundReads=[],queries=[],screenshots=[];let reads=0;
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',route=>{const req=route.request(),url=new URL(req.url());if(req.method()!=='GET'){const entry={path:url.pathname,method:req.method()};if(['/api/market-data/quotes','/api/market-data/sparklines','/api/market-data/resolve','/api/charts/stream/subscribe'].includes(url.pathname))blockedBackgroundReads.push(entry);else writes.push(entry);return route.abort();}if(['/series/page','/dataset-summaries','/history-catalog/search'].some(s=>url.pathname.endsWith(s)))reads++;return route.continue();});
 const dialog=()=>page.getByRole('dialog').last(),rows=()=>dialog().locator('.symbol-search-row');
 const settle=()=>page.waitForTimeout(350);
 const shot=async name=>{await settle();assert(await dialog().evaluate(el=>el.scrollWidth<=el.clientWidth+1));await page.screenshot({path:root+'/runtime/'+name+'.png'});screenshots.push(name);};
 const choose=async(label,value)=>{await dialog().getByRole('combobox',{name:label,exact:true}).click();await page.getByRole('option',{name:value,exact:true}).click();await settle();};
 const api=async route=>{const res=await context.request.get(base+'/api'+route);assert(res.ok(),route);return res.json();};
 await page.goto(base+'/m/watch');
 for(const flow of ['watch','catalog']){
  await page.getByRole('link',{name:flow==='watch'?'自选':'数据',exact:true}).click();
  await page.getByRole('button',{name:flow==='watch'?'添加自选':'搜索并添加行情',exact:true}).click();await expect(rows().first()).toBeVisible({timeout:30000});
  const enhance=()=>dialog().getByRole('button',{name:'增强搜索',exact:true});
  await expect(enhance()).toHaveAttribute('aria-expanded','false');await expect(dialog().getByRole('combobox')).toHaveCount(0);await shot(flow+'-default');
  const before=reads;await enhance().click();await settle();assert.equal(reads,before,'disclosure never restarts directory requests');
  const response=page.waitForResponse(r=>{const u=new URL(r.url());return u.pathname.endsWith(flow==='watch'?'/series/page':'/history-catalog/search')&&u.searchParams.get('source')==='dukascopy'&&u.searchParams.get('symbol_type')==='stock';});
  await choose('来源','Dukas');await choose('品种分类','股票');const value=await (await response).json();assert(value.items.length>0);assert(value.items.every(i=>i.source==='dukascopy'&&i.asset_class==='equity'));
  await expect(rows().first()).toBeVisible();await expect(dialog().getByLabel('已选筛选',{exact:true})).toHaveText('Dukas · 股票');await shot(flow+'-selected');
  queries.push({flow,source:'dukascopy',type:'stock',sample:value.items.slice(0,3).map(i=>i.display_symbol)});
  const beforeCollapse=reads;await enhance().click();await settle();assert.equal(reads,beforeCollapse,'collapse preserves active filter scope');await expect(dialog().getByRole('combobox')).toHaveCount(0);await shot(flow+'-collapsed');
  await dialog().getByRole('button',{name:'清除搜索筛选',exact:true}).click();await enhance().click();
  await choose('来源','新浪财经');await choose('品种分类','股票');
  const upstreamRoute=flow==='watch'?'/market-data/series/page?kind=provider&mobile=true&exclude_watch=true&include_total=false&page_size=25':'/market-data/history-catalog/search?mobile=true&exclude_existing=true&include_total=false&limit=25';
  for(const [term,label] of [['新浪财经','新浪财经'],['腾讯财经','腾讯财经']]){
   if(term==='腾讯财经')await choose('来源',label);
   const upstream=await api(upstreamRoute+'&source=akshare&symbol_type=stock&query='+encodeURIComponent(term));
   assert(upstream.items.every(i=>i.mobile_identity.provider===label),term+' must not include another upstream');
   queries.push({flow,source:term,samples:upstream.items.length,providers:[...new Set(upstream.items.map(i=>i.mobile_identity.provider))]});
  }
  await dialog().getByRole('button',{name:'清除搜索筛选',exact:true}).click();await settle();
  for(const width of [375,412])for(const theme of ['light','dark'])for(const font of [14,21]){
   await page.setViewportSize({width,height:880});await page.evaluate(({theme,font})=>{document.querySelector('.mobile-app').dataset.theme=theme;document.documentElement.style.fontSize=font+'px';},{theme,font});await settle();
   const controls=await dialog().getByRole('combobox').evaluateAll(nodes=>nodes.map(n=>({height:n.getBoundingClientRect().height,width:n.getBoundingClientRect().width})));
   assert(controls.length===2&&controls.every(c=>c.height>=44&&c.width>100));await shot(`${flow}-${width}-${theme}-${font}`);
  }
  await page.evaluate(()=>document.documentElement.style.fontSize='14px');await page.setViewportSize({width:375,height:480});await dialog().getByRole('searchbox').focus();await dialog().getByRole('combobox',{name:'品种分类',exact:true}).scrollIntoViewIfNeeded();await shot(flow+'-short');
  await dialog().getByRole('button',{name:'关闭',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);await page.setViewportSize({width:375,height:880});
 }
 assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
 const proof={passed:true,host:'Ubuntu local Docker',url:'https://192.168.7.232:18447',readOnly:true,queries,screenshots,errors,writes,blockedBackgroundReads};fs.writeFileSync(root+'/runtime-proof.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
