// Real Yahoo data in the isolated candidate PostgreSQL database.
const {chromium}=require('@playwright/test');
const fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const APP=process.env.APP_ORIGIN||'http://127.0.0.1:16202', CHART=process.env.CHART_ORIGIN||'http://127.0.0.1:16201';
const ROOT='../docs/verification/yahoo';
(async()=>{
 const started_at=new Date().toISOString();
 const source_sha256=Object.fromEntries(['../advanced-host/chart-runtime.js','../advanced-host/series.js','../backend/alerts/market_data.py','../backend/alerts/market_names.py','../backend/alerts/yahoo_aliases.py'].map(path=>[path,crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex')]));
 const browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 const pages=[],errors=[],requests=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('request',r=>{if(/\/api\/(charts|market-data)\//.test(r.url()))requests.push({url:r.url(),body:r.postDataJSON()})});
 page.on('response',async r=>{if(r.url().includes('/api/charts/data')){const p=await r.json().catch(()=>({}));pages.push({status:r.status(),frame:r.request().postDataJSON()?.timeframe,bars:p.bars?.length,detail:p.detail,cache_hit:p.cache_hit})}});
 try {
  await page.addInitScript(()=>{
    window.acceptanceFeedErrors=[];
    addEventListener('message',event=>{
      if(event.data?.channel==='mw-chart-v1' && event.data?.type==='error')
        window.acceptanceFeedErrors.push(event.data.error);
    });
  });
  await page.goto(APP);
  await page.getByLabel('管理员密码').fill(fs.readFileSync('/tmp/market-watch-yahoo-acceptance/password','utf8'));
  await page.getByRole('button',{name:'登录工作台'}).click();
  await page.waitForFunction(()=>!document.querySelector('input[type=password]'));
  const setup=await page.evaluate(async()=>{
   const session=await(await fetch('/api/session')).json();
   const catalog=await(await fetch('/api/market-data/catalog')).json();
   const aapl=catalog.find(x=>x.source==='yahoo'&&x.symbol==='AAPL');
   const oil=catalog.find(x=>x.source==='yahoo'&&x.symbol==='CL=F');
   const gold=catalog.find(x=>x.source==='yahoo'&&x.symbol==='GC=F');
   const headers={'Content-Type':'application/json','X-CSRF-Token':session.csrf};
   const w=await(await fetch('/api/advanced-charts/workspaces',{method:'POST',headers,body:JSON.stringify({name:'Yahoo 真实环境验收'})})).json();
   const document={...w.document,symbol:'MWP:'+aapl.id,series_kind:'provider',interval:'5'};
   const saved=await(await fetch('/api/advanced-charts/workspaces/'+w.id+'/save',{method:'POST',headers,body:JSON.stringify({name:w.name,revision:w.revision,document})})).json();
   return {aapl,oil,gold,workspace:saved};
  });
  assert.deepEqual(setup.aapl.series_kinds,['provider']);
  await page.goto(APP+'/advanced-charts');await page.waitForSelector('iframe');
  let frame=page.frames().find(f=>f.url().startsWith(CHART+'/'));
  await frame.waitForFunction(()=>ready&&widget.activeChart().dataReady(),null,{timeout:60000});
  await frame.waitForFunction(()=>quoteSubscriptions.size>0,null,{timeout:30000});
  await page.waitForTimeout(100); // let the native details render its quote callback
  const startupText=(await Promise.all(page.frames().map(f=>f.locator('body').innerText()))).join('\n');
  assert.ok(!/YAHOO:[A-Fa-f0-9]{12}/.test(startupText),'loaded startup details must display the human name');
  assert.equal(await frame.evaluate(()=>MWSeries.encode(MWSeries.decode(widget.activeChart().symbol()).symbol,"provider")),'MWP:'+setup.aapl.id);
  const resolve=await frame.evaluate(ticker=>new Promise((ok,fail)=>feed.resolveSymbol(ticker,ok,fail)),'MWP:'+setup.gold.id);
  assert.deepEqual(resolve.supported_resolutions,['1','5','15','60','1D','1W','1M']);
  assert.equal(resolve.name,'GC=F');assert.equal(resolve.type,'futures');
  assert.equal(resolve.data_status,'delayed_streaming');assert.equal(resolve.delay,1800);
  const search=await frame.evaluate(()=>new Promise(ok=>feed.searchSymbols('黄金','','',ok)));
  assert.ok(search.some(x=>x.symbol==='GC=F'&&x.ticker.startsWith('MWP:YAHOO:')));
  assert.ok(search.every(x=>x.ticker.startsWith('MWP:') && !x.description.includes('自建行情')));
  const chineseSearch={};
  for(const query of ['欧元','比特币','英伟达']) {
   const rows=await frame.evaluate(q=>new Promise(ok=>feed.searchSymbols(q,'','',ok)),query);
   assert.ok(rows.length && rows.every(x=>x.ticker.startsWith('MWP:') && x.description.includes(query) && !x.description.includes('自建行情')));
   chineseSearch[query]=rows;
  }
  const nativeFrame=page.frames().find(f=>f.parentFrame()===frame);
  await nativeFrame.getByRole('button',{name:'商品代码搜索',exact:true}).click();
  const searchInput=nativeFrame.locator('input:visible').first();
  await searchInput.fill('黄金');
  await nativeFrame.waitForFunction(()=>document.querySelectorAll('[data-name="symbol-search-dialog-content-item"]').length>0 && [...document.querySelectorAll('[data-name="symbol-search-dialog-content-item"]')].every(el=>el.textContent.includes('黄金')));
  const nativeSearchText=await nativeFrame.locator('[data-name="symbol-search-dialog-content-item"]').allTextContents();
  assert.ok(nativeSearchText.length && nativeSearchText.every(text=>text.includes('黄金') && !text.includes('自建行情')));
  await page.screenshot({path:ROOT+'/chinese-search.png',fullPage:true});
  await searchInput.press('Escape');
  await frame.evaluate(()=>{globalThis.acceptanceSourceTransitions=[];widget.activeChart().onSymbolChanged().subscribe(null,info=>acceptanceSourceTransitions.push({ticker:info.ticker,resolution:widget.activeChart().resolution(),supported:info.supported_resolutions}))});
  await frame.evaluate(()=>widget.activeChart().setSymbol('MWP:BTCUSDT',{doNotActivateChart:true}));
  await frame.evaluate(()=>widget.activeChart().setResolution('240',{doNotActivateChart:true}));
  await frame.waitForFunction(()=>widget.activeChart().dataReady(),null,{timeout:60000});
  await frame.evaluate(ticker=>widget.activeChart().setSymbol(ticker,{doNotActivateChart:true}),'MWP:'+setup.aapl.id);
  await frame.waitForFunction(()=>widget.activeChart().dataReady(),null,{timeout:60000});
  assert.ok(['1','5','15','60','1D','1W','1M'].includes(await frame.evaluate(()=>widget.activeChart().resolution())));
  const metrics=[];
  for(const resolution of ['1','15','60','1D','1W','1M','5']) {
   const start=Date.now();
   await frame.evaluate(r=>widget.activeChart().setResolution(r,{doNotActivateChart:true}),resolution);
   await frame.waitForFunction(()=>widget.activeChart().dataReady(),null,{timeout:60000});
   const range=await frame.evaluate(()=>widget.activeChart().getVisibleRange());
   assert.ok(range.from<range.to);metrics.push({resolution,elapsed_ms:Date.now()-start,range});
  }
  await frame.evaluate(()=>widget.activeChart().createStudy('守望 Python SMA',false,false,{period:20}));
  await frame.waitForFunction(()=>[...subscriptions.values()].some(s=>decode(s.symbol).spec));
  await frame.waitForFunction(()=>pending.size===0,null,{timeout:60000});
  assert.ok(requests.some(r=>r.body?.indicators?.length&&r.body.instrument===setup.aapl.id));
  await frame.evaluate(async()=>{
   const range=widget.activeChart().getVisibleRange();
   await widget.activeChart().createShape({time:Math.round((range.from+range.to)/2),price:330},{shape:'horizontal_line'});
  });
  await frame.evaluate(()=>snapshot());await page.waitForTimeout(1000);await page.reload();await page.waitForSelector('iframe');
  frame=page.frames().find(f=>f.url().startsWith(CHART+'/'));
  await frame.waitForFunction(()=>ready&&widget.activeChart().dataReady(),null,{timeout:60000});
  assert.equal(await frame.evaluate(()=>MWSeries.encode(MWSeries.decode(widget.activeChart().symbol()).symbol,"provider")),'MWP:'+setup.aapl.id);
  assert.ok((await frame.evaluate(()=>widget.activeChart().getAllShapes())).length>0);
  const quotes=await frame.evaluate(ticker=>new Promise((ok,fail)=>feed.getQuotes([ticker],ok,fail)),'MWP:'+setup.gold.id);
  assert.equal(quotes[0].s,'ok');assert.ok(quotes[0].v.description.includes('延迟 30 分钟'));
  assert.ok(quotes[0].v.description.includes('UTC'));
  await frame.evaluate(ticker=>widget.activeChart().setSymbol(ticker,{doNotActivateChart:true}),'MWP:'+setup.oil.id);
  await frame.evaluate(()=>widget.activeChart().setResolution('1D',{doNotActivateChart:true}));
  await frame.waitForFunction(()=>widget.activeChart().dataReady(),null,{timeout:60000});
  await frame.evaluate(()=>widget.activeChart().getPanes()[0].getMainSourcePriceScale().setMode(1));
  await frame.evaluate(()=>widget.activeChart().setVisibleRange({from:1586908800,to:1588291200}));
  await frame.waitForFunction(()=>widget.activeChart().dataReady(),null,{timeout:60000});await page.waitForTimeout(500);
  const oil=await frame.evaluate(()=>({mode:widget.activeChart().getPanes()[0].getMainSourcePriceScale().getMode(),range:widget.activeChart().getVisibleRange(),priceRange:widget.activeChart().getPanes()[0].getMainSourcePriceScale().getVisiblePriceRange()}));
  assert.equal(oil.mode,0);assert.ok(oil.priceRange.from<0);
  await frame.waitForFunction(()=>quoteSubscriptions.size>0);
  const renderedText=(await Promise.all(page.frames().map(f=>f.locator('body').innerText()))).join('\n');
  assert.ok(!/YAHOO:[A-Fa-f0-9]{12}/.test(renderedText),'internal hashes must not be visible in any frame');
  assert.ok(renderedText.includes('CL=F') && renderedText.includes('原油期货'));
  assert.ok(renderedText.includes('UTC') && renderedText.includes('延迟 30 分钟'));
  const visiblePresentation={original_symbol:true,chinese_name:true,quote_time:true,delay:true,internal_hash_absent:true};
  const feedErrors=await page.evaluate(()=>window.acceptanceFeedErrors);
  assert.deepEqual(feedErrors,[],'visible datafeed errors must not be ignored');
  assert.ok(!(await frame.locator('[role="dialog"]').allTextContents()).some(text=>text.includes('尚未接入')));
  await page.screenshot({path:ROOT+'/negative-oil.png',fullPage:true});
  assert.ok(pages.length&&pages.every(p=>p.status===200));
  assert.ok(!requests.some(r=>r.body?.instrument?.startsWith('YAHOO:') && ['M30','H4'].includes(r.body?.timeframe)));
  assert.ok(!requests.some(r=>/\/history(?:\/|$)|\/activity$/.test(r.url)));
  assert.deepEqual(errors,[]);
  fs.writeFileSync(ROOT+'/browser.json',JSON.stringify({passed:true,started_at,completed_at:new Date().toISOString(),source_sha256,visiblePresentation,metrics,resolve,search,chineseSearch,nativeSearchText,quotes,oil,pages,errors,feedErrors},null,2));
  console.log(JSON.stringify({passed:true,metrics,oil,pages:pages.length},null,2));
 } catch(error) {
  const state=await page.frames().find(f=>f.url().startsWith(CHART+'/'))?.evaluate(()=>({symbol:widget?.activeChart().symbol(),resolution:widget?.activeChart().resolution(),pending:pending.size,transitions:globalThis.acceptanceSourceTransitions})).catch(()=>null);
  fs.writeFileSync(ROOT+'/browser-failure.json',JSON.stringify({error:String(error),pages,errors,state},null,2));
  await page.screenshot({path:ROOT+'/browser-failure.png',fullPage:true}).catch(()=>{});throw error;
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
