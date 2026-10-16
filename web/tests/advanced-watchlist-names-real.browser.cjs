// Opt-in R1 acceptance: real isolated instance only; no intercepted market data.
// MW_BASE, MW_CHART, MW_CREDENTIALS and MW_OUTPUT must be supplied by the runner.
const {chromium}=require('@playwright/test');
const fs=require('node:fs'),assert=require('node:assert/strict');
const base=process.env.MW_BASE,chart=process.env.MW_CHART,out=process.env.MW_OUTPUT;
assert(base&&chart&&out&&process.env.MW_CREDENTIALS,'provide private real-instance configuration');
fs.mkdirSync(out,{recursive:true});
(async()=>{
  const browser=await chromium.launch({headless:true,
    executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage']});
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1600,height:950}});
  const page=await context.newPage();
  const flashes=[],errors=[],runs=[],samples=[],details=[];
  let originalActive,originalSymbol,tempId,outer,loadingCapture;
  await page.exposeBinding('mwNameFrame',async(_,event)=>{
    if(event.bad.length)flashes.push(event);
    if(event.loading&&!loadingCapture){
      loadingCapture=page.screenshot({path:out+'/loading.png'}).catch(()=>{});
    }
  });
  await page.addInitScript(()=>{
    const timeline=[];window.__mwNameTimeline=timeline;let previous='';
    const internal=/MW[CPH]:|(?:DUKA|YAHOO|NATIVE|MD|OANDA|BINANCE):|\b[a-f\d]{32,64}\b|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}/i;
    const tick=()=>{
      // The library writes its same-origin child document with document.write;
      // observe it from the host rAF, which survives that document replacement.
      const docs=[document];
      for(const doc of docs)for(const iframe of doc.querySelectorAll('iframe')){
        try{if(iframe.contentDocument)docs.push(iframe.contentDocument);}catch{}
      }
      const root=docs.map(d=>d.querySelector('[data-test-id-widget-type="watchlist"]')).find(Boolean);
      if(root){
        const rows=[...root.querySelectorAll('[data-symbol-full]')].filter(r=>r.getClientRects().length).map(r=>{
          const name=r.querySelector('[class*="symbolNameText-"]');
          const style=name&&name.ownerDocument.defaultView.getComputedStyle(name);
          const overlay=name&&name.ownerDocument.defaultView.getComputedStyle(name,'::after').content;
          const display=style?.visibility==='hidden' ? (overlay?.startsWith('"') ? JSON.parse(overlay) : '') : name?.innerText;
          return {ticker:r.dataset.symbolFull,text:r.innerText,display,loading:display==='加载中…'};
        });
        const encoded=JSON.stringify(rows);
        if(encoded!==previous){
          previous=encoded;const event={time:performance.now(),rows};timeline.push(event);
          const bad=rows.filter(r=>internal.test(r.text)||internal.test(r.display));
          if(bad.length||rows.some(r=>r.loading))window.mwNameFrame({...event,bad,loading:rows.some(r=>r.loading)}).catch(()=>{});
        }
      }
      requestAnimationFrame(tick);
    };requestAnimationFrame(tick);
  });
  page.on('pageerror',e=>errors.push(e.message));
  const host=async()=>{
    await page.locator('iframe[title="专业图表工作区"]').waitFor();
    for(let i=0;i<200;i++){
      const f=page.frames().find(f=>f.url().startsWith(chart));
      if(f)return f;await page.waitForTimeout(100);
    }
    throw Error('chart host missing');
  };
  const capture=async(label)=>{
    console.log('Capture '+label);
    outer=await host();
    await outer.waitForFunction(()=>typeof ready!=='undefined'&&ready&&!loading&&widget.activeChart().dataReady(),null,{timeout:60000});
    // Real mixed-supplier snapshots may take longer than a fixed sleep. Start
    // click acceptance only after native has subscribed and real prices exist.
    await outer.waitForFunction(()=>{
      const doc=document.querySelector('iframe')?.contentDocument;
      const providers=[...doc?.querySelectorAll('[data-test-id-widget-type="watchlist"] [data-symbol-full]')||[]]
        .map(r=>r.dataset.symbolFull).filter(t=>t.startsWith('MWP:'));
      return providers.length&&quoteSubscriptions.size&&providers.every(ticker=>
        [...quoteSnapshotRows].some(([key,row])=>key.toUpperCase()===ticker.toUpperCase()&&row.s==='ok'&&row.v?.lp>0));
    },null,{timeout:90000});
    const frames=await Promise.all(page.frames().map(async f=>({url:f.url(),timeline:await f.evaluate(()=>window.__mwNameTimeline||[])})));
    const state=await outer.evaluate(()=>({ready,loading,symbol:widget.activeChart().symbol(),
      quotes:[...quoteSnapshotRows.entries()],subscriptions:[...quoteSubscriptions.values()].map(s=>s.symbols)}));
    const native=outer.childFrames()[0];
    const rows=await native.locator('[data-test-id-widget-type="watchlist"] [data-symbol-full]').evaluateAll(nodes=>nodes.map(r=>({
      ticker:r.dataset.symbolFull,text:r.innerText,name:r.querySelector('[class*="symbolNameText-"]')?.innerText,
      ready:r.dataset.mwNameReady,short:r.dataset.symbolShort})));
    runs.push({label,frames,state,rows});
    await page.screenshot({path:out+'/'+label+'.png'});
    return rows;
  };
  try{
    await page.goto(base);
    await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(process.env.MW_CREDENTIALS)).login_password);
    const login=page.waitForResponse(r=>r.url().endsWith('/api/login')&&r.request().method()==='POST');
    await page.getByRole('button',{name:'登录工作台'}).click();assert.equal((await login).status(),200);
    await page.goto(base+'/advanced-charts');
    await capture('01-startup');
    await page.reload();await capture('02-reload');
    originalSymbol=await outer.evaluate(()=>widget.activeChart().symbol());
    await outer.evaluate(()=>{
      window.__mwDetails=[];window.__mwQuoteCallbacks=[];window.__mwQuoteRequests=[];
      const getQuotes=feed.getQuotes;
      feed.getQuotes=(symbols,callback,...args)=>{
        const entry={time:performance.now(),symbols};__mwQuoteRequests.push(entry);
        return getQuotes(symbols,rows=>{entry.delivered=performance.now();callback(rows)},...args);
      };
      const subscribe=feed.subscribeQuotes;
      feed.subscribeQuotes=(symbols,fast,callback,id)=>subscribe(symbols,fast,rows=>{
        __mwQuoteCallbacks.push({time:performance.now(),id,rows:rows.map(r=>({n:r.n,s:r.s,
          description:r.v?.description,lp:r.v?.lp,session:r.v?.market_session,read_at:r.v?.read_at}))});
        callback(rows);
      },id);
      let previous='';const tick=()=>{
        const root=document.querySelector('iframe')?.contentDocument?.querySelector('[data-test-id-widget-type="detail"]');
        const text=root?.innerText||'';
        if(text!==previous){previous=text;__mwDetails.push({time:performance.now(),text});}
        requestAnimationFrame(tick);
      };requestAnimationFrame(tick);
    });
    const native=outer.childFrames()[0];
    for(let i=0;i<6;i++){
      const symbol=i%2?'XAUUSD':'EURUSD';
      console.log('Click details '+i+' '+symbol);
      await native.locator('[data-test-id-widget-type="watchlist"] [data-symbol-full="MWP:'+symbol+'"]').click();
      await native.locator('[data-test-id-widget-type="detail"]').filter({hasText:symbol+' · 平台行情'}).waitFor({timeout:60000});
      await page.waitForTimeout(1800);
      const price=await native.locator('[data-test-id-widget-type="detail"] [data-qa-id="details-element price"]').innerText();
      assert(/\d/.test(price),'real detail price missing for '+symbol);
      if(i<2)await page.screenshot({path:out+'/detail-'+symbol+'.png'});
    }
    details.push(await outer.evaluate(()=>({timeline:__mwDetails,callbacks:__mwQuoteCallbacks,requests:__mwQuoteRequests})));
    assert(details[0].timeline.some(e=>e.text.includes('EURUSD · 平台行情')));
    assert(details[0].timeline.some(e=>e.text.includes('XAUUSD · 平台行情')));
    assert(!details[0].timeline.some(e=>e.text.includes('平台原生行情')),'details must never alternate provider wording');
    assert(!details[0].callbacks.some(e=>e.rows.some(r=>r.description?.includes('平台原生行情'))));
    for(const [source,query] of [['oanda','EURUSD'],['dukascopy','GBPUSD'],['binance','BTCUSDT'],['yahoo','AAPL']]){
      const response=await page.request.get(base+'/api/market-data/series/page',{params:{kind:'provider',source,query,page_size:5}});
      assert.equal(response.status(),200);const data=await response.json();
      assert(data.items.length,'real catalog sample missing: '+source);
      for(const item of data.items)samples.push({source,kind:'provider',ticker:item.ticker,name:item.display_symbol});
    }
    for(const kind of ['history','composite']){
      const response=await page.request.get(base+'/api/market-data/series/page',{params:{kind,page_size:250}});
      assert.equal(response.status(),200);const data=await response.json();
      assert(data.items.length,'real '+kind+' sample missing');
      for(const item of data.items)samples.push({source:item.source,kind,ticker:item.ticker,name:item.display_symbol});
    }
    // Legacy managed data is a separate supported identity route.
    samples.push({source:'oanda',kind:'managed',ticker:'EURUSD',name:'EURUSD'},
      {source:'binance',kind:'managed',ticker:'BTCUSDT',name:'BTCUSDT'});
    originalActive=await outer.evaluate(async()=> (await widget.watchList()).getActiveListId());
    tempId='name-real-'+Date.now();
    await outer.evaluate(async({id,symbols})=>{
      const api=await widget.watchList();api.saveList({id,title:'名称验收（真实数据）',symbols});api.setActiveList(id);
    },{id:tempId,symbols:[...new Set(samples.map(s=>s.ticker))]});
    await capture('03-switch-all');
    // Add/remove via native API while the mixed list is live.
    await outer.evaluate(async({id,ticker})=>{const api=await widget.watchList();api.updateList(id,api.getList(id).filter(s=>s!==ticker));},
      {id:tempId,ticker:samples.find(s=>s.source==='dukascopy').ticker});
    await page.waitForTimeout(200);
    await outer.evaluate(async({id,ticker})=>{const api=await widget.watchList();api.updateList(id,[...api.getList(id),ticker]);},
      {id:tempId,ticker:samples.find(s=>s.source==='dukascopy').ticker});
    await capture('04-add');
    await page.reload();const rows=await capture('05-mixed-reload');
    for(const sample of samples){
      const row=rows.find(r=>r.ticker.toUpperCase()===sample.ticker.toUpperCase());
      assert(row,'missing row '+sample.ticker);assert.equal(row.ready,'true');assert.equal(row.name,sample.name);
    }
    const quotes=runs.at(-1).state.quotes;
    for(const source of ['oanda','dukascopy','binance','yahoo']){
      const matching=samples.filter(s=>s.source===source&&s.kind==='provider');
      assert(matching.some(s=>quotes.some(([k,r])=>k.toUpperCase()===s.ticker.toUpperCase()&&r.s==='ok'&&r.v?.lp>0)),
        'actual supplier quote missing: '+source);
    }
    assert(runs.every(r=>r.frames.some(f=>f.timeline.some(t=>t.rows.length))), 'every run must observe painted rows');
    for(const run of runs.filter(r=>['01-startup','02-reload','05-mixed-reload'].includes(r.label))){
      const first=run.frames.flatMap(f=>f.timeline).find(t=>t.rows.length);
      assert(first.rows.every(r=>r.display&&!r.loading),'prewarmed names must display on the first painted frame: '+run.label);
    }
    assert.equal(flashes.length,0,'visible internal identity in a painted frame');
    assert.equal(errors.length,0,errors.join('\n'));
    console.log('PASS: real suppliers and series names, direct prewarmed first paint, six OANDA detail clicks with stable wording.');
  }finally{
    let restoreError;
    if(outer&&!details.length)details.push(await outer.evaluate(()=>({timeline:window.__mwDetails||[],
      callbacks:window.__mwQuoteCallbacks||[],requests:window.__mwQuoteRequests||[]})).catch(()=>({timeline:[],callbacks:[]})));
    if(tempId){
      outer=await host().catch(()=>null);
      if(outer)await outer.evaluate(async({id,active})=>{
        const api=await widget.watchList();
        if(api.getActiveListId()===id)api.setActiveList(active);
        if(Object.values(api.getAllLists()).some(l=>l.id===id))api.deleteList(id);
      },{id:tempId,active:originalActive}).catch(e=>{restoreError=e;errors.push('restore: '+e.message)});
      else {restoreError=Error('chart host unavailable during list restoration');errors.push(restoreError.message);}
      await page.waitForTimeout(1000);
    }
    if(outer&&originalSymbol)await (async()=>{
      await outer.evaluate(symbol=>widget.activeChart().setSymbol(symbol),originalSymbol);
      await outer.waitForFunction(symbol=>widget.activeChart().symbol()===symbol,originalSymbol,{timeout:15000});
    })().catch(e=>{restoreError=e;errors.push('restore symbol: '+e.message)});
    await loadingCapture;
    fs.writeFileSync(out+'/result.json',JSON.stringify({samples,runs,details,flashes,errors},null,2));
    await context.close();await browser.close();
    if(restoreError)throw restoreError;
  }
})().catch(e=>{console.error(e.stack);process.exitCode=1});
