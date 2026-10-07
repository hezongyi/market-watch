// Full application smoke test, restricted to this task's Ubuntu Compose ports.
const { chromium } = require("@playwright/test");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const APP = process.env.MAXIMIZE_APP || "https://localhost:17443";
const CHART = process.env.MAXIMIZE_CHART || "https://127.0.0.1:17444";
assert.ok(["https://localhost:17443", "https://192.168.7.232:17443"].includes(APP));
assert.ok(["https://127.0.0.1:17444", "https://192.168.7.232:17444"].includes(CHART));
const report = { environment:"Ubuntu Docker project mw-chart-maximize-20261007", app:APP, chart:CHART, cases:[], errors:[], chartCredentialLeaks:[] };
const out = process.env.MAXIMIZE_PRODUCT_OUTPUT || "/tmp/mw-chart-maximize-20261007/product-browser.json";
(async()=>{
  const browser = await chromium.launch({
    executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
      "/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",args:["--no-sandbox", "--no-proxy-server"],
  });
  try {
    const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1600,height:1000}});
    if(APP === "https://192.168.7.232:17443")await context.addCookies([
      {name:'session',value:'legacy-root-cookie',domain:'192.168.7.232',path:'/',secure:true,httpOnly:true,sameSite:'Strict'}
    ]);
    const login=await context.request.post(APP+'/api/login',{
      data:JSON.parse(fs.readFileSync('/tmp/mw-chart-maximize-20261007/login.json','utf8')),
    });
    assert.ok(login.ok());
    const identity=await login.json();
    if(APP === "https://192.168.7.232:17443"){
      const sessions=(await context.cookies()).filter(c=>c.name==='session');
      assert.equal(sessions.length,1);assert.equal(sessions[0].path,'/api');
      assert.ok(sessions[0].secure&&sessions[0].httpOnly);
      report.cookieScope='/api';report.legacyRootCookieCleared=true;
    }
    const page=await context.newPage();
    page.on('pageerror',e=>report.errors.push(e.message));
    page.on('request',async request=>{
      if(new URL(request.url()).origin===CHART){
        const headers=await request.allHeaders();
        if(headers.cookie||headers.authorization||headers['x-csrf-token'])report.chartCredentialLeaks.push(new URL(request.url()).pathname);
      }
    });
    await page.goto(APP+'/advanced-charts');
    await page.frameLocator('iframe').locator('#chart').waitFor();
    let host=page.frames().find(f=>f.url().startsWith(CHART+'/'));
    assert.ok(host);
    const settle=async()=>{
      await host.waitForFunction(()=>ready&&!loading&&!nativeSaving&&!MWNativeNavigation.busy()
        && !rangeGuard.busy()&&!edgeGuard.busy()&&!MWChartMaximize.resizing()
        && Array.from({length:widget.chartsCount()},(_,i)=>widget.chart(i).dataReady()).every(Boolean));
      await host.evaluate(()=>new Promise(resolve=>{
        let previous,stable=0;
        const sample=()=>{
          const current=JSON.stringify(Array.from({length:widget.chartsCount()},(_,i)=>{
            const c=widget.chart(i);return [c.getTimeScale().width(),c.getVisibleRange(),c.getTimeScale().barSpacing()];
          }));
          stable=current===previous?stable+1:0;previous=current;
          if(stable>=3)resolve();else requestAnimationFrame(sample);
        };requestAnimationFrame(sample);
      }));
    };
    await settle();
    assert.equal(await host.evaluate(()=>widget.activeChart().symbol()),'MAXFIXTURE');
    await host.evaluate(()=>widget.setLayout('4'));
    await settle();
    await host.evaluate(()=>{
      const c=widget.chart(3);
      if(!c.getAllStudies().some(s=>s.name==='Relative Strength Index'))
        return c.createStudy('Relative Strength Index',false,false);
    });
    await settle();
    let native=page.frames().find(f=>f.parentFrame()===host);
    const state=()=>host.evaluate(()=>({
      layout:widget.layout(),sync:MWSyncCoordinator.snapshot(),
      charts:Array.from({length:widget.chartsCount()},(_,i)=>{
        const c=widget.chart(i);return {symbol:c.symbol(),resolution:c.resolution(),
          range:c.getVisibleRange(),spacing:c.getTimeScale().barSpacing(),max:c.isMaximized(),
          studies:c.getAllStudies(),shapes:c.getAllShapes()};
      }),
    }));
    const double=async i=>{
      const p=await host.evaluate(i=>{
        const pane=widget.chart(i)._chartWidget.paneWidgets().find(p=>p.containsMainSeries());
        const r=pane.canvasElement().getBoundingClientRect();
        for(let y=60;y<r.height-30;y+=10)for(let x=80;x<r.width-30;x+=10)
          if(pane._dataSourceAtPoint(x,y)===null&&pane.canvasElement().ownerDocument.elementFromPoint(r.x+x,r.y+y)?.tagName==='CANVAS')
            return {x:r.x+x,y:r.y+y};
        throw Error('No blank native canvas coordinate');
      },i);
      const b=await (await native.frameElement()).boundingBox();
      await page.mouse.dblclick(p.x+b.x,p.y+b.y);
      await settle();
    };
    for(const mode of ['none','barWidth','date']) {
      await host.evaluate(mode=>MWSyncCoordinator.configure({date:mode==='date',barWidth:mode==='barWidth',time:false}),mode);
      await settle();
      const before=await state();
      await double(3);
      assert.ok((await state()).charts[3].max);
      await page.waitForTimeout(550);
      await double(3);
      const restored=await state();
      assert.ok(restored.charts.every(c=>!c.max));
      assert.deepEqual(restored,before);
      report.cases.push({name:mode+' full application double-click round trip'});
    }
    await host.evaluate(()=>new Promise((resolve,reject)=>widget.saveChartToServer(resolve,reject)));
    page.on('dialog',dialog=>dialog.accept());
    await page.reload();
    await page.frameLocator('iframe').locator('#chart').waitFor();
    host=page.frames().find(f=>f.url().startsWith(CHART+'/'));
    assert.ok(host);
    await settle();
    native=page.frames().find(f=>f.parentFrame()===host);
    const saved=await state();
    assert.equal(saved.layout,'4');
    assert.ok(saved.charts.every(c=>c.symbol==='MAXFIXTURE'&&c.range&&c.range.to>c.range.from&&!c.max));
    assert.equal(saved.charts[3].studies[0].name,'Relative Strength Index');
    await double(1);
    assert.ok((await state()).charts[1].max);
    await page.waitForTimeout(550);
    await double(1);
    assert.deepEqual(await state(),saved);
    report.cases.push({name:'real API and PostgreSQL workspace save, reload, and double-click round trip'});
    report.hostAsset=await host.evaluate(()=>[...document.scripts].map(s=>s.src).find(s=>/host\.[a-f0-9]+\.js$/.test(s))?.split('/').at(-1));
    assert.ok(report.hostAsset);
    assert.deepEqual(report.errors,[]);
    assert.deepEqual(report.chartCredentialLeaks,[]);
    assert.equal((await context.request.post(APP+'/api/logout',{data:{},headers:{'X-CSRF-Token':identity.csrf}})).status(),200);
    assert.equal((await context.request.get(APP+'/api/session')).status(),401);
    report.logoutVerified=true;
    console.log('PASS: isolated application, synthetic PG data, four charts + RSI, sync round trips, saved workspace reload');
  } finally {
    fs.writeFileSync(out,JSON.stringify(report,null,2));
    await browser.close();
  }
})().catch(e=>{console.error(e);process.exitCode=1});
