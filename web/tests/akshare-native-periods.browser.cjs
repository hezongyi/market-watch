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
const cert = new crypto.X509Certificate(fs.readFileSync(credentials.ca_file));
const spki = crypto.createHash('sha256').update(cert.publicKey.export({format:'der', type:'spki'})).digest('base64');
const frames = {M1:'1', M5:'5', M15:'15', M30:'30', H1:'60', D1:'1D', W1:'1W', MN:'1M'};
const cases = [
  {prefix:'SINA-NATIVE:', symbols:['SSE:600519','SZSE:000001'], frames:Object.keys(frames)},
  {prefix:'TENCENT-NATIVE:', symbols:['SSE:600519','SZSE:000001'], frames:Object.keys(frames)},
  {prefix:'TENCENT-NATIVE:', symbols:['HKEX:00700','HKEX:02318'], frames:['D1','W1','MN']},
];
const report = {started_at:new Date().toISOString(), base, scope:'real isolated application and native UI',
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
      const widget = Reflect.construct(target,args,newTarget);
      window.__nativeAcceptanceWidget = widget;
      return widget;
    }});
  },true));
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  let csrf;
  const api = async (endpoint,data) => {
    const result = data === undefined ? await page.request.get(base+'/api'+endpoint)
      : await page.request.post(base+'/api'+endpoint,{data,headers:{'X-CSRF-Token':csrf || ''},timeout:90000});
    assert(result.ok(),`${endpoint}: HTTP ${result.status()} ${(await result.text()).slice(0,150)}`);
    return result.json();
  };
  const native = () => page.frames().find(frame=>frame.url().startsWith('blob:'));
  const waitChart = async (ticker,resolution) => {
    await page.waitForFunction(({ticker,resolution})=>{
      const chart=window.__nativeAcceptanceWidget?.activeChart();
      const range=chart?.getVisibleRange();
      return chart?.symbol().toUpperCase()===ticker.toUpperCase() && chart.resolution()===resolution &&
        chart.dataReady() && range?.to > range?.from;
    },{ticker,resolution},{timeout:120000});
  };
  try {
    await api('/login',{password:credentials.login_password});
    csrf = (await api('/session')).csrf;
    for(const group of cases) for(const symbol of group.symbols) for(const frame of group.frames) {
      const ticker='MWP:'+group.prefix+symbol;
      const result=await api('/charts/data',{instrument:ticker,series_kind:'provider',timeframe:frame,limit:80});
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
      await expect(row).toContainText('不复权');
      await row.getByRole('button',{name:'详情',exact:true}).click();
      await expect(native().locator('.dc-window')).toContainText('价格口径：不复权');
      await expect(native().locator('.dc-window').getByRole('link',{name:'添加为自建行情',exact:true})).toHaveCount(0);
      await page.screenshot({path:path.join(out,id.replace(/:/g,'-')+'-directory.png')});
      await row.getByRole('button',{name:'打开图表',exact:true}).click();
      for(const frame of group.frames) {
        const resolution=frames[frame];
        await page.evaluate(resolution=>window.__nativeAcceptanceWidget.activeChart().setResolution(resolution),resolution);
        await waitChart(ticker,resolution);
        const state=await page.evaluate(()=>{
          const chart=window.__nativeAcceptanceWidget.activeChart();
          return {ticker:chart.symbol(),resolution:chart.resolution(),ready:chart.dataReady(),range:chart.getVisibleRange()};
        });
        report.charts.push({ticker,frame,...state});
      }
      await page.screenshot({path:path.join(out,id.replace(/:/g,'-')+'-chart.png')});
      await page.evaluate(()=>new Promise((resolve,reject)=>window.__nativeAcceptanceWidget.saveChartToServer(resolve,reject,
        {defaultChartName:'原生周期恢复验收'})));
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
