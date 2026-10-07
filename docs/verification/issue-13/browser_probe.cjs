// Actual built UI + private native chart + authenticated isolated PG API.
const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const APP = 'https://192.168.7.232:19615';
const CHART = 'https://192.168.7.232:19616';
const OUT = '/results/browser/result.json';
assert.ok(!fs.existsSync(OUT), 'Existing browser evidence retained');
const report = { synthetic_market_data: true, upstream_isolated: true,
  scope: 'Built product UI and real native chart with full API lifespan, one publisher and one Chromium instance',
  phases: [], page_errors: [], requests: [], failed_requests: [], checkpoints: [] };
const started = Date.now();
function quantiles(values) {
  const rows = [...values].sort((a,b)=>a-b);
  return Object.fromEntries([['p50',.5],['p95',.95],['p99',.99]].map(([k,p])=>
    [k, rows.length ? rows[Math.ceil(rows.length*p)-1] : null]));
}
(async()=>{
  let browser,page,frame;
  try {
    browser=await chromium.launch({headless:true,
      executablePath:'/browsers/chromium-1243/chrome-linux64/chrome',
      args:['--disable-dev-shm-usage']});
    const context=await browser.newContext({viewport:{width:1600,height:950},ignoreHTTPSErrors:true});
    page=await context.newPage();
    page.on('pageerror',e=>report.page_errors.push(e.message));
    page.on('dialog',d=>d.type()==='beforeunload'?d.accept():d.dismiss());
    const timings=new Map();
    page.on('request',request=>{
      if (request.url().startsWith(APP+'/api/'))timings.set(request,Date.now());
    });
    page.on('requestfinished',async request=>{
      if (!timings.has(request))return;
      const response=await request.response();
      report.requests.push({path:new URL(request.url()).pathname,method:request.method(),
        status:response?.status(),milliseconds:Date.now()-timings.get(request)});
      timings.delete(request);
    });
    page.on('requestfailed',request=>{
      report.failed_requests.push({path:new URL(request.url()).pathname,error:request.failure()?.errorText});
      timings.delete(request);
    });
    await page.goto(APP+'/');
    await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync('/private/login.json')).password);
    const login=page.waitForResponse(r=>r.url()===APP+'/api/login'&&r.request().method()==='POST');
    await page.getByRole('button',{name:'登录工作台'}).click();
    assert.equal((await login).status(),200);
    await page.waitForFunction(()=>!document.querySelector('input[type=password]'));
    async function api(route,body) {
      return page.evaluate(async ({route,body})=>{
        const session=await(await fetch('/api/session')).json();
        const response=await fetch('/api/'+route,{method:body?'POST':'GET',
          headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},
          ...(body?{body:JSON.stringify(body)}:{})});
        if(!response.ok)throw Error(route+' HTTP '+response.status());
        return response.json();
      },{route,body});
    }
    const workspace=await api('advanced-charts/workspaces',{name:'Issue13 synthetic browser '+Date.now()});
    await api('advanced-charts/workspaces/'+workspace.id+'/save',{name:workspace.name,
      revision:workspace.revision,document:{engine:'tv31',schemaVersion:1,symbol:'BTCUSDT',series_kind:'managed',interval:'1'}});
    await page.goto(APP+'/advanced-charts');
    const handle=await page.locator('iframe[data-workspace-id="'+workspace.id+'"]').elementHandle({timeout:60000});
    frame=await handle.contentFrame();
    assert.ok(frame);
    await frame.waitForURL(CHART+'/**',{timeout:60000});
    const ready=()=>frame.waitForFunction(()=>typeof ready!=='undefined'&&ready&&!loading&&widget.activeChart().dataReady(),null,{timeout:90000});
    await ready();
    async function checkpoint(label) {
      const state=await frame.evaluate(()=>({symbol:widget.activeChart().symbol(),
        resolution:widget.activeChart().resolution(),ready:widget.activeChart().dataReady(),
        range:widget.activeChart().getVisibleRange(),chart_count:widget.chartsCount()}));
      assert.ok(state.ready&&state.range?.from>0&&state.range?.to>state.range.from);
      report.checkpoints.push({label,...state});
      console.log(JSON.stringify({checkpoint:label,...state}));
      return state;
    }
    await checkpoint('M1 initial');
    const phase=async (label,fn)=>{
      const at=Date.now();console.log('PHASE '+label);await fn();report.phases.push({label,milliseconds:Date.now()-at});
    };
    await phase('M1 idle 30s',()=>page.waitForTimeout(30000));
    await phase('M5 period switch',async()=>{
      await frame.evaluate(()=>new Promise(resolve=>widget.activeChart().setResolution('5',resolve)));
      await ready();await checkpoint('M5');
    });
    await phase('EURUSD identity switch',async()=>{
      await frame.evaluate(()=>new Promise(resolve=>widget.activeChart().setSymbol('EURUSD',resolve)));
      await ready();await checkpoint('EURUSD');
    });
    await phase('two-chart native layout',async()=>{
      await frame.evaluate(()=>widget.setLayout('2h'));
      await frame.waitForFunction(()=>widget.chartsCount()===2&&widget.chart(0).dataReady()&&widget.chart(1).dataReady(),null,{timeout:90000});
      await frame.evaluate(()=>new Promise(resolve=>widget.chart(1).setSymbol('XAUUSD',resolve)));
      await frame.waitForFunction(()=>widget.chart(1).symbol()==='XAUUSD'&&widget.chart(1).dataReady(),null,{timeout:90000});
      await checkpoint('two chart EURUSD/XAUUSD');
      await page.waitForTimeout(30000);
    });
    await phase('manual save',async()=>{
      const saved=page.waitForResponse(r=>r.url()===APP+'/api/advanced-charts/native-charts/save'&&r.request().method()==='POST',{timeout:60000});
      await page.keyboard.press('Control+s');
      assert.equal((await saved).status(),200);
    });
    await phase('reload persisted layout',async()=>{
      await page.reload();
      const h=await page.locator('iframe[data-workspace-id="'+workspace.id+'"]').elementHandle({timeout:60000});
      const f=await h.contentFrame();
      await f.waitForURL(CHART+'/**',{timeout:60000});
      await f.waitForFunction(()=>typeof ready!=='undefined'&&ready&&widget.chartsCount()===2&&widget.chart(0).dataReady()&&widget.chart(1).dataReady(),null,{timeout:90000});
      report.persisted=await f.evaluate(()=>({count:widget.chartsCount(),symbols:[widget.chart(0).symbol(),widget.chart(1).symbol()]}));
      assert.deepEqual(report.persisted.symbols,['EURUSD','XAUUSD']);
      await page.waitForTimeout(15000);
    });
    await page.screenshot({path:'/results/browser/product.png',fullPage:true});
    assert.deepEqual(report.page_errors,[]);
    const data=report.requests.filter(r=>r.path==='/api/charts/data'&&r.status===200);
    assert.ok(data.length>0,'actual authenticated published chart reads observed');
    report.data_request_count=data.length;
    report.data_latency=quantiles(data.map(r=>r.milliseconds));
    report.outcome='passed';
  } catch(error) {
    report.outcome='failed';
    report.failure=String(error.message);
    if(page){
      report.status_text=await page.locator('[role=status]').allTextContents().catch(()=>[]);
      await page.screenshot({path:'/results/browser/failure.png',fullPage:true}).catch(()=>{});
    }
    if(frame)report.frame_failure_state=await frame.evaluate(()=>({
      ready:typeof ready!=='undefined'?ready:null,loading:typeof loading!=='undefined'?loading:null,
      symbol:typeof widget!=='undefined'?widget?.activeChart().symbol():null,
      dataReady:typeof widget!=='undefined'?widget?.activeChart().dataReady():null,
      range:typeof widget!=='undefined'?widget?.activeChart().getVisibleRange():null
    })).catch(()=>null);
    process.exitCode=1;
  } finally {
    report.duration_seconds=(Date.now()-started)/1000;
    if(browser)await browser.close();
    fs.mkdirSync('/results/browser',{recursive:true});
    fs.writeFileSync(OUT,JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({outcome:report.outcome,phases:report.phases,
      failure:report.failure,data_latency:report.data_latency,page_errors:report.page_errors}));
  }
})();
