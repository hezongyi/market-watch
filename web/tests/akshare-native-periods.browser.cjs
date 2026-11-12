// Real task-owned UI/API acceptance. No intercepted or synthetic market data.
// MW_BASE_URL, MW_ACCEPTANCE_CREDENTIALS_FILE, MW_OUTPUT are required.
// Credentials: {login_password, ca_file}; task-local certificate trust only.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {chromium, expect} = require('@playwright/test');
const base = process.env.MW_BASE_URL;
const out = process.env.MW_OUTPUT;
assert(base && out && process.env.MW_ACCEPTANCE_CREDENTIALS_FILE, 'provide private task configuration');
const credentials = JSON.parse(fs.readFileSync(process.env.MW_ACCEPTANCE_CREDENTIALS_FILE));
const cert = new crypto.X509Certificate(fs.readFileSync(credentials.tls_cert_file || credentials.ca_file));
const spki = crypto.createHash('sha256').update(cert.publicKey.export({format:'der', type:'spki'})).digest('base64');
const frames = {M1:'1', M5:'5', M15:'15', M30:'30', H1:'60', D1:'1D', W1:'1W', MN:'1M'};
const cases = [
  {prefix:'SINA-NATIVE:', symbols:['SSE:600519','SZSE:000001'], frames:Object.keys(frames)},
  {prefix:'TENCENT-NATIVE:', symbols:['SSE:600519','SZSE:000001'], frames:Object.keys(frames)},
  {prefix:'TENCENT-NATIVE:', symbols:['HKEX:00700','HKEX:02318'], frames:['D1','W1','MN']},
];
const report = {started_at:new Date().toISOString(), base, scope:'real application and native UI',
  api:[], charts:[], errors:[], passed:false};
fs.mkdirSync(out,{recursive:true});
(async () => {
  const browser = await chromium.launch({headless:true,
    executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    args:['--no-sandbox','--ignore-certificate-errors-spki-list='+spki]});
  const context = await browser.newContext({viewport:{width:1600,height:1000}});
  // Capture the public widget constructor as the licensed script finishes.
  // This only retains a diagnostic handle, without replacing application data.
  await context.addInitScript(() => document.addEventListener('load', event => {
    if(event.target?.tagName !== 'SCRIPT' || !event.target.src.endsWith('/charting_library.js') || !window.TradingView?.widget) return;
    const ctor = TradingView.widget;
    TradingView.widget = new Proxy(ctor,{construct(target,args,newTarget) {
      const feed=args[0].datafeed, getBars=feed.getBars.bind(feed);
      window.__nativeDelivered={};
      // Observe exact real bars delivered to the chart without changing them.
      feed.getBars=(info,resolution,parameters,onResult,onError)=>getBars(info,resolution,parameters,(bars,meta)=>{
        if(bars.length) window.__nativeDelivered[info.ticker+'|'+resolution]={
          rows:bars.length,first:bars[0],last:bars.at(-1)};
        onResult(bars,meta);
      },onError);
      const widget = Reflect.construct(target,args,newTarget);
      window.__nativeAcceptanceWidget = widget;
      window.__nativeSaveAdapter = args[0].save_load_adapter;
      return widget;
    }});
  },true));
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  let csrf;
  const api = async (endpoint,data) => {
    // Browser fetch shares both session cookies and task-pinned TLS trust.
    // Playwright's separate Node request client does not inherit Chromium SPKI.
    const result = await page.evaluate(async ({endpoint,data,csrf})=>{
      const response=await fetch('/api'+endpoint,{method:data===undefined?'GET':'POST',
        headers:{'Content-Type':'application/json','X-CSRF-Token':csrf || ''},
        body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(90000)});
      return {ok:response.ok,status:response.status,body:await response.text()};
    },{endpoint,data,csrf});
    assert(result.ok,`${endpoint}: HTTP ${result.status} ${result.body.slice(0,150)}`);
    return JSON.parse(result.body);
  };
  const native = () => page.frames().find(frame=>frame.url().startsWith('blob:'));
  const waitChart = async (ticker,resolution) => {
    await page.waitForFunction(({ticker,resolution})=>{
      try {
      const chart=window.__nativeAcceptanceWidget?.activeChart();
      const range=chart?.getVisibleRange();
      return chart?.symbol().toUpperCase()===ticker.toUpperCase() && chart.resolution()===resolution &&
        chart.dataReady() && range?.to > range?.from;
      } catch { return false; }
    },{ticker,resolution},{timeout:120000});
  };
  try {
    await page.goto(base+'/login');
    await api('/login',{password:credentials.login_password});
    csrf = (await api('/session')).csrf;
    for(const group of cases) for(const symbol of group.symbols) for(const frame of group.frames) {
      const ticker='MWP:'+group.prefix+symbol;
      const result=await api('/charts/data',{instrument:group.prefix+symbol,series_kind:'provider',timeframe:frame,limit:80});
      assert(result.bars?.length>1,`${ticker} ${frame} must contain actual candles`);
      assert.equal(result.adjustment,'none');
      const starts=result.bars.map(row=>row.start);
      assert(starts.every((v,i)=>i===0 || v>starts[i-1]),'ordered unique native keys');
      report.api.push({ticker,frame,rows:result.bars.length,first:starts[0],last:starts.at(-1),
        source_warnings:result.source_warnings || [],volume_unit:result.volume_unit});
      fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
    }
    assert.equal(report.api.length,38);
    const workspace=await api('/advanced-charts/workspaces',{
      name:'原生周期验收 '+report.started_at,symbol:'MWP:SINA-NATIVE:SZSE:000001'});
    report.workspace=workspace.id;
    for(const group of cases) {
      const symbol=group.symbols.at(-1);
      const id=group.prefix+symbol,ticker='MWP:'+id;
      const directory='/market-data?tab=platform&source=akshare&query='+symbol.split(':')[1];
      await page.goto(base+'/advanced-charts/'+workspace.id+'?data_center='+encodeURIComponent(directory));
      await expect.poll(()=>!!native(),{timeout:60000}).toBe(true);
      const rowId='platform-'+id.toLowerCase().replace(/[^a-z0-9-]/g,'-');
      const row=native().locator('[id="'+rowId+'"]');
      await expect(row).toBeVisible({timeout:60000});
      await expect(row.locator('xpath=..')).toContainText('不复权');
      await native().locator('[id="'+rowId+'-details"]').click();
      await expect(native().locator('.dc-window')).toContainText('价格口径：不复权');
      await expect(native().locator('.dc-window').getByRole('link',{name:'添加为自建行情',exact:true})).toHaveCount(0);
      await page.screenshot({path:path.join(out,id.replace(/:/g,'-')+'-directory.png')});
      await native().getByRole('button',{name:'关闭详情',exact:true}).click();
      await native().locator('[id="'+rowId+'-open"]').click();
      await waitChart(ticker,frames[group.frames.includes('H1') ? 'H1' : group.frames[0]]);
      for(const frame of group.frames) {
        const resolution=frames[frame];
        await page.evaluate(resolution=>window.__nativeAcceptanceWidget.activeChart().setResolution(resolution),resolution);
        await waitChart(ticker,resolution);
        const state=await page.evaluate(()=>{
          const chart=window.__nativeAcceptanceWidget.activeChart();
          const delivered=window.__nativeDelivered[chart.symbol()+'|'+chart.resolution()];
          return {ticker:chart.symbol(),resolution:chart.resolution(),ready:chart.dataReady(),range:chart.getVisibleRange(),
            rendered_rows:delivered?.rows,first:delivered?.first,last:delivered?.last};
        });
        assert(state.rendered_rows>1,`${ticker} ${frame}: chart must contain actual series data`);
        report.charts.push({ticker,frame,...state});
        fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
      }
      await page.screenshot({path:path.join(out,id.replace(/:/g,'-')+'-chart.png')});
      await expect(async ()=>{
        await page.evaluate(id=>window.__nativeSaveAdapter.saveChart({id,name:'原生周期恢复验收'}),workspace.id);
      }).toPass({timeout:15000,intervals:[500,1000]});
      const savedUrl=page.url();
      await page.reload();
      await waitChart(ticker,frames[group.frames.at(-1)]);
      report.charts.push({ticker,restored:true,url:savedUrl});
    }
    assert.equal(report.charts.filter(row=>!row.restored).length,19);
    assert.deepEqual(report.errors,[]);
    report.passed=true;
  } catch(error) {
    report.errors.push(error.message);
    await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});
    process.exitCode=1;
  } finally {
    report.finished_at=new Date().toISOString();
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
    await context.close();await browser.close();
    console.log(JSON.stringify({passed:report.passed,api:report.api.length,charts:report.charts.length,output:out}));
  }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
