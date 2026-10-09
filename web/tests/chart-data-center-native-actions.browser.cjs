const fs=require('fs'),path=require('path');const {expect}=require('@playwright/test');const f=require('./chart-data-center-fixture.cjs');
const out=path.join(f.root,'artifacts/native-ui-implementation'),report={environment:'Ubuntu isolated Docker; real native UI, scoped fault injection',passed:false,checks:[],errors:[]};
(async()=>{const b=await f.launch(),p=await b.newPage({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}});const {host,native}=f.frames(p);const dc=()=>native().locator('.dc-window');
 p.on('pageerror',e=>{report.errors.push(e.message);console.log('PAGEERROR',e.message)});
 const record=(name,data={})=>{report.checks.push({name,...data});console.log('PASS',name)};
 const get=async url=>{const r=await p.request.get(f.base+'/api'+url);expect(r.ok(),await r.text()).toBeTruthy();return r.json()};
 const open=async route=>{await host().evaluate(route=>dataCenter.open(route),route);await expect(dc()).toBeVisible({timeout:20000})};
 const close=async()=>{await native().getByRole('button',{name:'关闭数据中心',exact:true}).click();await expect(dc()).toHaveCount(0)};
 let release=()=>{};
 try{
  if(process.env.LOCAL) await f.localNativeAssets(p);
  await p.goto(f.base+'/advanced-charts');await f.login(p);await expect.poll(()=>!!native(),{timeout:40000}).toBeTruthy();await expect(native().getByRole('button',{name:'数据中心',exact:true})).toBeVisible({timeout:30000});
  await host().waitForFunction(()=>ready,null,{timeout:60000});
  await open('/market-data?tab=platform&source=yahoo&query=MSFT');await expect(dc().locator('tbody tr')).toHaveCount(1);
  await host().evaluate(()=>widget.setLayout('2h'));await expect.poll(()=>host().evaluate(()=>widget.chartsCount())).toBe(2);
  await dc().getByRole('button',{name:'打开平台图表',exact:true}).click();await expect(dc().locator('.dc-window-content > [role=alert]')).toContainText('目标图格');await expect(dc()).toBeVisible();await close();
  record('stale layout is rejected without closing or changing chart');
  const before=await host().evaluate(()=>Array.from({length:widget.chartsCount()},(_,i)=>({symbol:widget.chart(i).symbol(),resolution:widget.chart(i).resolution()})));
  await open('/market-data?tab=platform&source=yahoo&query=MSFT');await expect(dc().locator('tbody tr')).toHaveCount(1);
  const fail=r=>r.fulfill({status:503,json:{detail:'验收注入：行情来源暂不可用'}});await p.route('**/api/market-data/resolve',fail);
  const t=Date.now();await dc().getByRole('button',{name:'打开平台图表',exact:true}).click();await expect(dc()).toHaveCount(0,{timeout:1500});expect(Date.now()-t).toBeLessThan(1500);
  const notice=native().locator('.mw-data-center-load');await expect(notice).toContainText('行情来源暂不可用');await expect(notice).toHaveAttribute('role','alert');
  expect(await host().evaluate(()=>Array.from({length:widget.chartsCount()},(_,i)=>({symbol:widget.chart(i).symbol(),resolution:widget.chart(i).resolution()})))).toEqual(before);
  await p.unroute('**/api/market-data/resolve',fail);
  if(await notice.count()) await notice.getByRole('button',{name:'关闭行情加载提示',exact:true}).click();
  record('accepted open closes immediately; failure is reported on chart and leaves all chart identities intact');
  // Hold one resolve, then select another pane before releasing it. The old
  // accepted command must not mutate either the old pane or the new one.
  let blocked=false;const held=new Promise(r=>release=r);const slow=async r=>{blocked=true;await held;await r.continue().catch(()=>{})};
  await open('/market-data?tab=platform&source=yahoo&query=MSFT');await expect(dc().locator('tbody tr')).toHaveCount(1);await p.route('**/api/market-data/resolve',slow);
  await dc().getByRole('button',{name:'打开平台图表',exact:true}).click();await expect(dc()).toHaveCount(0);await expect.poll(()=>blocked).toBe(true);
  await host().evaluate(()=>widget.setActiveChart(widget.activeChartIndex()===0?1:0));release();await p.unroute('**/api/market-data/resolve',slow);
  await expect(notice).toHaveCount(0);expect(await host().evaluate(()=>Array.from({length:widget.chartsCount()},(_,i)=>({symbol:widget.chart(i).symbol(),resolution:widget.chart(i).resolution()})))).toEqual(before);
  record('late resolve after active-pane switch cannot mutate any chart');
  // Real provider configuration, invalid number/required validation and scoped
  // native Select labels; the request itself is an isolated test fixture.
  await open('/market-data/platform/configure?instrument=EURUSD');await expect(dc().getByRole('heading',{name:'配置原生行情'})).toBeVisible();await expect(dc().getByRole('button',{name:'价格口径',exact:true})).toBeEnabled({timeout:15000});
  await dc().getByRole('button',{name:'价格口径',exact:true}).click();await native().getByRole('option',{name:'Mid（中间价）',exact:true}).click();
  const number=dc().getByLabel('日对齐小时',{exact:true});expect(await number.evaluate(n=>n.required)).toBe(true);await number.fill('99');expect(await number.evaluate(n=>n.checkValidity())).toBe(false);await number.fill('17');
  const zone=dc().getByLabel('对齐时区',{exact:true});await zone.fill('');expect(await zone.evaluate(n=>n.checkValidity())).toBe(false);await zone.fill('UTC');
  let saved=0;const configure=async r=>{saved++;const body=r.request().postDataJSON();expect(body.parameters.price).toBe('M');await r.fulfill({json:{ticker:'MWP:EURUSD',metadata:{name:'验收原生配置'}}})};await p.route('**/api/charts/provider/configure',configure);
  await dc().getByRole('button',{name:'保存原生配置',exact:true}).click();await expect(dc().getByText('配置已保存：验收原生配置')).toBeVisible();expect(saved).toBe(1);await p.unroute('**/api/charts/provider/configure',configure);await close();
  record('native form Select/Input preserve labels, range/required validation and correct saved values');
  // Current backend cursor search + public vendor pagination callback.
  const pages=await host().evaluate(async()=>{const fetch=(start)=>new Promise(resolve=>feed.searchSymbolsPaginated({userInput:'',exchange:'DUKASCOPY',symbolType:'forex',start},(items,remaining)=>resolve({items,remaining})));const a=await fetch(0),b=await fetch(a.items.length);return {a,b}});
  expect(pages.a.items).toHaveLength(50);expect(pages.b.items.length).toBeGreaterThan(0);expect(pages.a.remaining).toBeGreaterThan(0);expect(new Set([...pages.a.items,...pages.b.items].map(r=>r.ticker)).size).toBe(pages.a.items.length+pages.b.items.length);expect(pages.a.items.every(r=>r.exchange==='DUKASCOPY'&&r.type==='forex')).toBe(true);
  record('native main search genuinely pages beyond the first results and applies source/type before paging');
  // Opening the real search dialog uses the same datafeed; cancel is pure.
  const symbol=await host().evaluate(()=>widget.activeChart().symbol());await host().evaluate(()=>widget.activeChart().executeActionById('symbolSearch'));
  const search=native().locator('[role=dialog]').filter({has:native().getByRole('searchbox')});await expect(search).toBeVisible();await search.getByRole('searchbox').fill('MSFT');await expect(search.getByText('MSFT',{exact:true}).first()).toBeVisible({timeout:15000});await p.keyboard.press('Escape');await expect(search).toHaveCount(0);expect(await host().evaluate(()=>widget.activeChart().symbol())).toBe(symbol);
  record('actual native main search uses unified results; cancelling keeps the chart');
  expect(report.errors).toEqual([]);report.passed=true;
 }catch(e){report.errors.push(e.message);await p.screenshot({path:path.join(out,'native-actions-failed.png')}).catch(()=>{});throw e;}
 finally{release();fs.writeFileSync(path.join(out,'native-actions-report.json'),JSON.stringify(report,null,2));await b.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1});
