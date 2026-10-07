// Actual Ubuntu API/native chart frame. No data or HTTP response fixtures.
const { chromium, expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '../..'), artifacts = path.join(root, 'artifacts/data-integration');
const base = 'http://127.0.0.1:16629';
(async () => {
  const browser = await chromium.launch({headless:true});
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[], requests=[], checks=[], failures=[];
  await page.addInitScript(() => {
    window.__chartNotices = [];
    window.addEventListener('message', event => {
      if (event.data?.type === 'notifications')
        window.__chartNotices.push(...(event.data.notices || []).map(row => row.text));
    });
  });
  page.on('pageerror', e=>errors.push(e.message));
  page.on('response', async r=>{if(r.url().includes('/api/') && r.status()>=400 &&
      !(new URL(r.url()).pathname==='/api/session' && r.status()===401)) {
    const failure={path:new URL(r.url()).pathname,status:r.status(),query:r.request().postDataJSON(),body:await r.json().catch(()=>null)};
    failures.push(failure); console.log(JSON.stringify({chart_error:failure}));
  }});
  page.on('request', r=>{if(r.url().includes('/api/charts/data')) requests.push(r.postDataJSON());});
  try {
    await page.goto(base+'/market-data');
    await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(path.join(artifacts,'three-layer-login.json'))).password);
    const login=page.waitForResponse(r=>r.url().endsWith('/api/login') && r.request().method()==='POST');
    await page.getByRole('button',{name:'登录工作台'}).click();
    expect((await login).status()).toBe(200);
    const rows=await (await page.request.get(base+'/api/market-data/series/search?query=EURUSD')).json();
    const history=rows.find(r=>r.series_kind==='history' && r.historical_source==='oanda' && r.calendar==='ny17');
    const composite=rows.find(r=>r.series_kind==='composite' && r.historical_source==='oanda' && r.calendar==='ny17');
    expect(history).toBeTruthy(); expect(composite).toBeTruthy();
    // Save an actual separate workspace with an explicit fixed-history ticker.
    const created=await page.evaluate(async (symbol)=>{
      const {csrf}=await (await fetch('/api/session')).json();
      const headers={'Content-Type':'application/json','X-CSRF-Token':csrf};
      const r=await fetch('/api/advanced-charts/workspaces',{method:'POST',
        headers,body:JSON.stringify({name:'三层真实图表验收'})});
      if(!r.ok)throw Error('Workspace create failed '+r.status);
      const row=await r.json();
      const saved=await fetch(`/api/advanced-charts/workspaces/${row.id}/save`,{method:'POST',headers,
        body:JSON.stringify({name:row.name,revision:row.revision,document:{engine:'tv31',schemaVersion:1,
          symbol,series_kind:'history',interval:'1'}})});
      if(!saved.ok)throw Error('Workspace save failed '+saved.status);return saved.json();
    },history.ticker);
    await page.goto(base+'/advanced-charts');
    await page.locator('iframe[title="专业图表工作区"]').waitFor({timeout:30000});
    await expect.poll(()=>page.frames().some(f=>f.url().startsWith('http://127.0.0.1:16630/'))).toBeTruthy();
    const frame=page.frames().find(f=>f.url().startsWith('http://127.0.0.1:16630/'));
    await frame.waitForFunction(()=>typeof ready!=='undefined' && ready && !loading && widget.activeChart().dataReady(),null,{timeout:60000});
    expect(await frame.evaluate(()=>MWSeries.same(widget.activeChart().symbol(), savedDoc.symbol))).toBeTruthy();
    expect(requests.some(q=>q.series_kind==='history' && q.instrument===history.id)).toBeTruthy();
    expect(requests.filter(q=>q.series_kind==='history').every(q=>q.instrument===history.id)).toBeTruthy();
    checks.push('actual fixed-history native chart and explicit version routing');
    const search=await frame.evaluate(()=>new Promise(resolve=>feed.searchSymbols('EURUSD','','',resolve)));
    expect(search.some(r=>r.ticker.startsWith('MWP:'))).toBeTruthy();
    expect(search.some(r=>r.ticker.startsWith('MWH:'))).toBeTruthy();
    expect(search.some(r=>r.ticker.startsWith('MWC:'))).toBeTruthy();
    checks.push('native symbol search exposes all three qualified kinds');
    await frame.evaluate(ticker=>widget.activeChart().setSymbol(ticker),composite.ticker);
    await frame.waitForFunction(ticker=>MWSeries.same(widget.activeChart().symbol(),ticker) && widget.activeChart().dataReady(),composite.ticker,{timeout:60000});
    expect(requests.some(q=>q.series_kind==='composite' && q.instrument===composite.id && q.client)).toBeTruthy();
    await frame.evaluate(()=>widget.activeChart().setResolution('240'));
    await frame.waitForFunction(()=>widget.activeChart().resolution()==='240' && widget.activeChart().dataReady(),null,{timeout:60000});
    expect(requests.some(q=>q.series_kind==='composite' && q.timeframe==='H4')).toBeTruthy();
    await frame.evaluate(()=>snapshot());
    await expect.poll(async()=>{
      const row=await (await page.request.get(base+`/api/advanced-charts/native-charts/${created.id}`)).json();
      return row.series_kind==='composite';
    },{timeout:30000}).toBeTruthy();
    await page.reload();
    await page.locator('iframe[title="专业图表工作区"]').waitFor({timeout:30000});
    await expect.poll(()=>page.frames().some(f=>f.url().startsWith('http://127.0.0.1:16630/'))).toBeTruthy();
    const reloaded=page.frames().find(f=>f.url().startsWith('http://127.0.0.1:16630/'));
    await reloaded.waitForFunction(ticker=>typeof ready!=='undefined' && ready && !loading && MWSeries.same(widget.activeChart().symbol(),ticker)
      && widget.activeChart().dataReady(),composite.ticker,{timeout:60000});
    checks.push('actual composite M1/H4 native chart uses shared stitched reader and chart client demand');
    checks.push('composite native save and reload retain qualified series identity');
    await page.screenshot({path:path.join(artifacts,'three-layer-native-chart-real.png'),fullPage:true});
    const lists=await reloaded.evaluate(async()=>(await widget.watchList()).getAllLists());
    const watched=new Set(Object.values(lists).flatMap(list=>list.symbols));
    expect(failures.every(f=>f.path==='/api/market-data/resolve' && f.status===422 &&
      f.query?.series_kind==='provider' && watched.has('MWP:'+f.query.instrument))).toBeTruthy();
    expect(await reloaded.evaluate(()=>window.__chartNotices)).toEqual([]);
    const ui=reloaded.frameLocator('iframe').first();
    await expect(ui.locator('body')).not.toContainText('ApiError:');
    await expect(ui.locator('#header-toolbar-symbol-search').filter({visible:true})).toContainText('EURUSD');
    const names=await reloaded.evaluate(ticker=>seriesPresentationRows([ticker]),composite.ticker);
    expect(names[0].v.short_name).toBe('EURUSD');
    const {csrf}=await (await page.request.get(base+'/api/session')).json();
    const historyResponse=await page.request.post(base+'/api/charts/data',{
      headers:{'X-CSRF-Token':csrf},
      data:{instrument:history.ticker,timeframe:'M1',limit:2}});
    expect(historyResponse.status()).toBe(200);
    const fixedPage=await historyResponse.json();
    expect(fixedPage.bars.length).toBeGreaterThan(0);
    const exported=await page.request.post(base+'/api/charts/export',{
      headers:{'X-CSRF-Token':csrf},data:{instrument:history.ticker,timeframe:'M1',
        start:fixedPage.bars[0].start,end:fixedPage.bars.at(-1).end,published:true}});
    expect(exported.status()).toBe(200);
    expect(exported.headers()['content-type']).toContain('text/csv');
    expect(await exported.text()).toContain(history.id);
    checks.push('actual fixed-history CSV export retains the selected immutable version');
    const reviewed=await page.request.post(base+'/api/charts/data',{
      headers:{'X-CSRF-Token':csrf},data:{instrument:composite.id,series_kind:'composite',
        timeframe:'H4',limit:3,track_history:true,provisional:false}});
    expect(reviewed.status()).toBe(200);
    const review=await reviewed.json();
    expect(review.history_check.before).toBe(review.bars.at(-1).start);
    expect(review.history_check.revision).toMatch(/^[a-f0-9]{64}$/);
    checks.push('actual composite history review uses fixed input and raw UTC bucket boundaries');
    checks.push('unavailable saved watchlist entries retain their identities without blocking the valid chart');
    checks.push('composite human name preserves the qualified ticker without fabricating a quote');
    const normal=await page.evaluate(async instrument=>{
      const {csrf}=await (await fetch('/api/session')).json();
      const headers={'Content-Type':'application/json','X-CSRF-Token':csrf};
      const response=await fetch('/api/charts/workspaces',{method:'POST',headers,
        body:JSON.stringify({name:'普通图表固定历史验收'})});
      const row=await response.json();
      const saved=await fetch(`/api/charts/workspaces/${row.id}/save`,{method:'POST',headers,
        body:JSON.stringify({name:row.name,revision:row.revision,document:{schemaVersion:1,layout:'1',sync:false,
          panels:[{id:'fixed-history',instrument,timeframe:'M1',timezone:'Etc/UTC',indicators:[],follow:true}],drawings:{}}})});
      if(!saved.ok)throw Error('Ordinary workspace save failed '+saved.status);return saved.json();
    },history.ticker);
    await page.goto(base+'/chart-workspaces/'+normal.id);
    await expect(page.locator('canvas').first()).toBeVisible({timeout:30000});
    await expect.poll(()=>requests.some(q=>q.instrument===history.ticker)).toBeTruthy();
    checks.push('ordinary chart workspace reads and saves the same fixed historical input');
    expect(errors).toEqual([]);
    expect(failures.every(f=>f.path==='/api/market-data/resolve' && f.status===422 &&
      f.query?.series_kind==='provider' && watched.has('MWP:'+f.query.instrument))).toBeTruthy();
    fs.writeFileSync(path.join(artifacts,'three-layer-charts-real.json'),JSON.stringify({passed:true,
      environment:'Ubuntu market-watch-three-layer',base,workspace_id:created.id,checks,errors,
      failures,request_kinds:[...new Set(requests.map(q=>q.series_kind))]},null,2));
    console.log(JSON.stringify({passed:true,checks:checks.length}));
  } finally {await page.screenshot({path:path.join(artifacts,'three-layer-chart-last.png'),fullPage:true}).catch(()=>{});await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
