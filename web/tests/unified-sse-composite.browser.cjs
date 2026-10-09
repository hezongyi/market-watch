// Real isolated worker + PostgreSQL + licensed native composite callbacks.
// Synthetic inputs only; supplier responses and HTTP/SSE are never mocked.
const {chromium,expect} = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {execFileSync,execFile} = require('node:child_process');
const {promisify} = require('node:util');
const run = promisify(execFile);
const root = path.resolve(__dirname,'../..');
const directory = path.join(root,'artifacts/unified-sse');
const task = 'mw-unified-sse-20261008';
const app = 'http://127.0.0.1:15643';
const chart = 'http://127.0.0.1:15644';
const compose = ['compose','--env-file',path.join(directory,'compose.env'),'-p',task,
  '-f',path.join(root,'compose.unified-sse.acceptance.yaml')];
const managed = fs.readFileSync(path.join(root,'scripts/unified_sse_acceptance_fixture.py'),'utf8');
const composite = fs.readFileSync(path.join(root,'scripts/unified_sse_composite_fixture.py'),'utf8');
const fixtureSource = `import types,sys\nm=types.ModuleType('unified_sse_acceptance_fixture')\nsys.modules[m.__name__]=m\nexec(${JSON.stringify(managed)},m.__dict__)\n` + composite;
const reportPath = path.join(directory,'unified-sse-composite-browser.json');
const report = {passed:false,synthetic:true,environment:'Ubuntu local Docker',task,app,chart,
  samples:[],checks:[],errors:[],stage:'preflight'};
const frames = ['M1','W1','MN','D1'];
const resolutions = ['1','1W','1M','1D'];
let keeper, keeping, bid = '1.12000', browser;
const indicators = process.argv.includes('--indicators');
const resources = process.argv.includes('--resources');
assert.ok(!resources || !process.argv.includes('--lifecycle'), 'Resource windows require ordinary updates');

function resourceProbe(scenario, seconds) {
  return run('python',[path.join(root,'scripts/unified_sse_resources.py'),
    '--scenario',scenario,'--seconds',String(seconds),'--interval','2'],
    {cwd:root,timeout:(seconds+30)*1000,maxBuffer:1024*1024}).then(result=>JSON.parse(result.stdout));
}

async function fixture(action,...args) {
  const child = run('docker',[...compose,'exec','-T','api','python','-',action,...args],
    {cwd:root,timeout:60000,maxBuffer:1024*1024});
  child.child.stdin.end(fixtureSource);
  return JSON.parse((await child).stdout.trim());
}

function preflight() {
  assert.match(fs.readFileSync('/etc/os-release','utf8'),/^ID=ubuntu$/m);
  assert.ok(!process.env.DOCKER_HOST || process.env.DOCKER_HOST === 'unix:///var/run/docker.sock');
  assert.equal(JSON.parse(execFileSync('docker',['context','inspect'],{encoding:'utf8'}))[0]
    .Endpoints.docker.Host,'unix:///var/run/docker.sock');
  const commit = execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  for (const service of ['api','market-stream-worker','web','chart-origin']) {
    const id = execFileSync('docker',[...compose,'ps','-q',service],{cwd:root,encoding:'utf8'}).trim();
    assert.ok(id && !id.includes('\n'));
    const container = JSON.parse(execFileSync('docker',['inspect',id],{encoding:'utf8'}))[0];
    assert.equal(container.Config.Labels['com.docker.compose.project'],task);
    const labels = JSON.parse(execFileSync('docker',['image','inspect',container.Image],{encoding:'utf8'}))[0].Config.Labels;
    for (const [key,value] of Object.entries({managed:'true',task,project:task,purpose:'acceptance',commit}))
      assert.equal(labels['io.market-watch.'+key],value);
  }
  return commit;
}

(async()=>{
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  fs.writeFileSync(reportPath,JSON.stringify(report),{mode:0o600});
  let frame,page;
  try {
    report.runtime_image_commit = preflight();
    report.harness_sha256 = createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
    report.fixture_sha256 = createHash('sha256').update(fixtureSource).digest('hex');
    report.stage = 'seed';
    await fixture('seed');
    await expect.poll(async()=> (await fixture('state')).artifacts_ready,{timeout:120000}).toBe(true);
    const initial = await fixture('activate');
    report.composite = initial.composite;
    report.history_version = initial.version;
    await fixture('quote','--bid',bid);
    // Maintain owner/freshness through native startup without a supplier client.
    keeper = setInterval(()=>{
      if (keeping) return;
      keeping = fixture('quote','--bid',bid).catch(error=>report.errors.push(error.message))
        .finally(()=>{keeping=null;});
    },5000);
    browser = await chromium.launch({headless:true,
      executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
    const context = await browser.newContext({viewport:{width:1440,height:1000}});
    await context.addInitScript(()=>{
      window.__compositeStream = [];
      const Native = window.EventSource;
      window.EventSource = class extends Native {
        constructor(url,options) {
          super(url,options);
          if (String(url).includes('/charts/stream/events')) this.addEventListener('message',event=>{
            const value=JSON.parse(event.data);
            window.__compositeStream.push({at:Date.now(),type:value.type,reason:value.reason,
              listener:value.listener,sequence:value.sequence,bars:value.bars,indicators:value.indicators,
              indicator_progress:value.indicator_progress});
          });
        }
      };
    });
    page = await context.newPage();
    const requests = [];
    report.requests = requests;
    const pendingInitial = new Set();
    const initialPath = url => ['/api/charts/data','/api/market-data/quotes'].includes(new URL(url).pathname);
    page.on('requestfinished',request=>pendingInitial.delete(request));
    page.on('requestfailed',request=>pendingInitial.delete(request));
    page.on('pageerror',error=>report.errors.push(error.message));
    page.on('request',request=>{
      const url = new URL(request.url());
      if (initialPath(request.url())) pendingInitial.add(request);
      if (/^\/api\/(charts|market-data)\//.test(url.pathname)) requests.push({at:Date.now(),path:url.pathname});
    });
    await page.goto(app+'/');
    await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(path.join(directory,'login.json'))).password);
    const logged = page.waitForResponse(response=>response.url().endsWith('/api/login'));
    await page.getByRole('button',{name:'登录工作台'}).click();
    assert.equal((await logged).status(),200);
    await page.goto(app+'/advanced-charts');
    await expect.poll(()=>page.frames().some(item=>item.url().startsWith(chart+'/'))).toBe(true);
    frame = page.frames().find(item=>item.url().startsWith(chart+'/'));
    await frame.waitForFunction(expected=>typeof ready !== 'undefined' && ready && !loading &&
      widget.activeChart().dataReady() && decode(widget.activeChart().symbol()).symbol === expected,
      initial.composite,{timeout:120000});
    await frame.evaluate(()=>widget.setLayout('4'));
    await frame.waitForFunction(()=>widget.chartsCount()===4 &&
      Array.from({length:4},(_,index)=>widget.chart(index)).every(item=>item.dataReady()),null,{timeout:60000});
    await frame.evaluate(async resolutions=>{
      for (let index=0;index<resolutions.length;index++)
        await widget.chart(index).setResolution(resolutions[index],{doNotActivateChart:true});
    },resolutions);
    await frame.waitForFunction(resolutions=>resolutions.every((res,index)=>
      widget.chart(index).dataReady() && widget.chart(index).resolution()===res),resolutions,{timeout:120000});
    await frame.evaluate(()=>{
      window.__nativeBars = [];
      const wrap = (cb,res,ticker)=>bar=>{cb(bar);window.__nativeBars.push({at:Date.now(),res,ticker,...bar});};
      for (const sub of subscriptions.values()) sub.cb=wrap(sub.cb,sub.res,sub.symbol);
      const original = feed.subscribeBars;
      feed.subscribeBars=(s,res,cb,id,reset)=>original(s,res,wrap(cb,res,s.ticker),id,reset);
    });
    let indicatorTicker;
    let initializationProbe;
    if (indicators) {
      if (resources) initializationProbe = resourceProbe('composite-ema-study-initialization',10);
      await frame.evaluate(()=>{widget.setActiveChart(0);});
      assert.ok(await frame.evaluate(()=>widget.activeChart().createStudy('守望 Python EMA',false,false,{period:31})));
      await frame.waitForFunction(()=>[...subscriptions.values()].some(sub=>
        decode(sub.symbol).spec?.name==='EMA' && sub.marketListener && sub.last),null,{timeout:120000});
      indicatorTicker = await frame.evaluate(()=>[...subscriptions.values()].find(sub=>decode(sub.symbol).spec?.name==='EMA').symbol);
      report.indicator = {name:'EMA',period:31};
    }
    if (initializationProbe) report.initialization_resources = await initializationProbe;
    if (resources) {
      // Measure chart demand alone; do not include the native default watchlist.
      await frame.evaluate(()=>{
        for (const id of [...quoteSubscriptions.keys()]) feed.unsubscribeQuotes(id);
      });
      const ownClient = await frame.evaluate(()=>clientId);
      await expect.poll(async()=>{
        const sql = "SELECT coalesce(json_agg(DISTINCT c.client),'[]'::json) FROM market_stream_subscriptions s JOIN market_stream_clients c ON c.id=s.client_id WHERE s.active AND s.expires>extract(epoch FROM clock_timestamp())*1000";
        const result = await run('docker',['exec',task+'-postgres-1','psql','-U','alerts','-d','alerts',
          '-X','-A','-t','-v','ON_ERROR_STOP=1','-c',sql],{cwd:root,timeout:20000});
        return JSON.parse(result.stdout).every(client=>client===ownClient);
      },{timeout:130000}).toBe(true);
    }
    report.checks.push('real composite first screen and four native periods M1/D1/W1/MN');
    if (!process.argv.includes('--lifecycle')) {
    // Confirmed/provisional boundary transitions are separate recovery cases.
    // Keep this ordinary quote-cost window inside one actual source minute.
    report.measurement_windows = [];
    async function beginOrdinaryWindow() {
      report.stage = 'boundary-confirmation';
      fs.writeFileSync(reportPath,JSON.stringify(report,null,2),{mode:0o600});
      const phase = Date.now()%60000;
      await page.waitForTimeout(phase<6000 ? 6000-phase : 66000-phase);
      clearInterval(keeper);
      await keeping;
      const boundary = await fixture('quote','--bid',bid);
      const sourceMinute = Math.floor(boundary.committed_at/60000)*60000;
      report.boundary_confirmation = boundary.committed_at;
      await frame.waitForFunction(minute=>[...subscriptions.values()].some(sub=>
        sub.res==='1' && !decode(sub.symbol).spec && sub.last===minute && !sub.marketRecovering),
        sourceMinute,{timeout:30000});
      if (indicators) {
        await page.waitForFunction(minute=>{
          const event=[...window.__compositeStream].reverse().find(event=>event.indicators?.length);
          const last=event?.indicators[0]?.series[0]?.values.at(-1);
          return last?.time===minute && Number.isFinite(last.value) &&
            event.indicator_progress?.every(progress=>progress.status==='complete' &&
              progress.cursor===minute && progress.target_end===minute);
        },sourceMinute,{timeout:30000});
        await frame.waitForFunction(ticker=>[...subscriptions.values()].some(sub=>sub.symbol===ticker &&
          sub.marketListener && !sub.marketRecovering && !sub.initialIndicatorPending &&
          fixedIndicatorPending.get(sub.symbol+'|'+sub.res)===false),indicatorTicker,{timeout:120000});
      }
      await expect.poll(()=>pendingInitial.size===0 && Date.now()-boundary.committed_at>=4000 &&
        Date.now()-Math.max(0,...requests.filter(row=>initialPath(app+row.path)).map(row=>row.at))>=3000,
        {timeout:30000}).toBe(true);
      await frame.waitForFunction(()=>[...subscriptions.values()].every(sub=>
        sub.marketPaused || !sub.marketRecovering),null,{timeout:15000});
      report.stage = 'updates';
      const started = Date.now();
      assert.equal(Math.floor(started/60000)*60000,sourceMinute,'Boundary preparation crossed another minute');
      report.measurement_start ??= started;
      const window = {start:started,source_minute:sourceMinute};
      report.measurement_windows.push(window);
      fs.writeFileSync(reportPath,JSON.stringify(report,null,2),{mode:0o600});
      return window;
    }
    function finishOrdinaryWindow(window) {
      window.end = Date.now();
      assert.equal(Math.floor(window.end/60000)*60000,window.source_minute,
        'Ordinary quote measurement crossed a confirmed-minute boundary');
      assert.ok(!requests.some(row=>row.at>=window.start && row.at<=window.end &&
        ['/api/charts/data','/api/market-data/quotes','/api/charts/provider/latest'].includes(row.path)),
        'Ordinary composite updates must not poll or reload history');
    }
    let measurement = await beginOrdinaryWindow();
    let ordinaryProbe = resources ? resourceProbe(indicators ? 'composite-ema-stable-quotes' :
      'composite-stable-quotes',16) : null;
    for (let index=1;index<=12;index++) {
      if (index===7) {
        if (ordinaryProbe) measurement.resources = await ordinaryProbe;
        finishOrdinaryWindow(measurement);
        measurement = await beginOrdinaryWindow();
        ordinaryProbe = resources ? resourceProbe(indicators ? 'composite-ema-stable-quotes' :
          'composite-stable-quotes',16) : null;
      }
      await keeping;
      clearInterval(keeper);
      const count = await frame.evaluate(()=>window.__nativeBars.length);
      bid = (1.12+index/100000).toFixed(5);
      const committed = await fixture('quote','--bid',bid);
      await frame.waitForFunction(({count,resolutions,price})=>resolutions.every(res=>
        window.__nativeBars.slice(count).some(bar=>bar.res===res && bar.close===price)),
        {count,resolutions,price:Number(bid)},{timeout:15000});
      const callbacks = await frame.evaluate(({count,resolutions,price})=>resolutions.map(res=>
        window.__nativeBars.slice(count).find(bar=>bar.res===res && bar.close===price)),
        {count,resolutions,price:Number(bid)});
      callbacks.forEach((bar,offset)=>report.samples.push({frame:frames[offset],
        committed_at:committed.committed_at,callback_at:bar.at,latency_ms:bar.at-committed.committed_at}));
      if (indicatorTicker) {
        await expect.poll(async()=>{
          const event=await page.evaluate(({at,price})=>[...window.__compositeStream].reverse().find(event=>
            event.at>=at && event.bars?.some(bar=>Number(bar.close)===price) && event.indicators?.length),
            {at:committed.committed_at,price:Number(bid)});
          const series=event?.indicators?.[0]?.series?.[0]?.values;
          const last=series?.at(-1);
          if (!last || !Number.isFinite(last.value)) return false;
          return frame.evaluate(({count,ticker,last})=>window.__nativeBars.slice(count).some(bar=>
            bar.ticker===ticker && bar.time===last.time && bar.close===last.value),
            {count,ticker:indicatorTicker,last});
        },{timeout:15000}).toBe(true);
      }
    }
    await page.waitForTimeout(Math.max(0,16000-(Date.now()-measurement.start)));
    if (ordinaryProbe) measurement.resources = await ordinaryProbe;
    finishOrdinaryWindow(measurement);
    report.measurement_end = Date.now();
    const expected = (await fixture('state')).expected;
    const callbacks = await frame.evaluate(()=>window.__nativeBars);
    for (let index=0;index<frames.length;index++) {
      const bar = callbacks.filter(bar=>bar.res===resolutions[index] && !bar.ticker.startsWith('MWPY_')).at(-1);
      const authoritative = expected[frames[index]];
      for (const field of ['open','high','low','close']) assert.equal(bar[field],Number(authoritative[field]));
      assert.equal(bar.time,authoritative.chart_time ?? authoritative.start);
    }
    const sorted = report.samples.map(item=>item.latency_ms).sort((a,b)=>a-b);
    assert.ok(sorted.every(value=>value>=0));
    report.p95_ms = sorted[Math.ceil(sorted.length*.95)-1];
    assert.ok(report.p95_ms<=3000,`Composite P95 ${report.p95_ms}ms exceeds 3000ms`);
    assert.deepEqual(report.errors,[]);
    report.checks.push('48 fresh actual callbacks for 12 source quotes, authoritative OHLC/time labels, no market polling');
    if (indicators) report.checks.push('composite EMA31 shared worker values reach each actual native study callback');
    }
    if (process.argv.includes('--lifecycle')) {
      report.stage = 'fixed-history-and-navigation';
      fs.writeFileSync(reportPath,JSON.stringify(report,null,2),{mode:0o600});
      clearInterval(keeper);
      await keeping;
      await fixture('expire');
      await frame.evaluate(()=>{
        widget.setActiveChart(0); widget.setLayout('s');
        window.__nativeHistory = [];
        const original=feed.getBars;
        feed.getBars=(symbol,res,period,cb,error)=>original(symbol,res,period,(bars,meta)=>{
          const accepted=cb(bars,meta);
          window.__nativeHistory.push({at:Date.now(),ticker:symbol.ticker,res,period,bars,meta});
          return accepted;
        },error);
      });
      await frame.waitForFunction(()=>widget.chartsCount()===1 && widget.activeChart().dataReady());
      const fixedTicker='MWH:'+initial.version;
      await frame.evaluate(async ticker=>{
        await widget.activeChart().setResolution('1');
        await widget.activeChart().setSymbol(ticker);
      },fixedTicker);
      await frame.waitForFunction(ticker=>widget.activeChart().dataReady() &&
        MWSeries.same(widget.activeChart().symbol(),ticker) && [...subscriptions.values()].some(sub=>
          MWSeries.same(sub.symbol,ticker) && sub.marketListener),fixedTicker,{timeout:60000});
      await frame.waitForFunction(()=>widget.activeChart().getVisibleRange()!==null,null,{timeout:30000});
      await frame.waitForFunction(()=>[...subscriptions.values()].every(sub=>
        sub.marketPaused || !sub.marketRecovering),null,{timeout:30000});
      await expect.poll(()=>pendingInitial.size===0 && Date.now()-Math.max(0,...requests.filter(row=>
        initialPath(app+row.path)).map(row=>row.at))>=3000,{timeout:30000}).toBe(true);
      await frame.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const first=await frame.evaluate(ticker=>window.__nativeHistory.find(row=>MWSeries.same(row.ticker,ticker)),fixedTicker);
      assert.ok(first?.bars.length,'Fixed first screen reached native getBars callback');
      const oldest = first.bars[0].time;
      const desired={from:initial.history_bounds.start/1000,to:(initial.history_bounds.start+250*60000)/1000};
      assert.ok(desired.to*1000<oldest,'Navigation must request data older than native first screen');
      await frame.evaluate(range=>widget.activeChart().setVisibleRange(range,{rejectByTimeout:30000}),desired);
      await frame.waitForFunction(({ticker,oldest})=>window.__nativeHistory.some(row=>
        MWSeries.same(row.ticker,ticker) && row.bars.some(bar=>bar.time<oldest)),
        {ticker:fixedTicker,oldest},{timeout:60000});
      report.checks.push('fixed immutable history first screen and actual native older-page navigation');
      report.stage = 'fixed-indicator';
      fs.writeFileSync(reportPath,JSON.stringify(report,null,2),{mode:0o600});
      await frame.evaluate(()=>widget.activeChart().createStudy('守望 Python EMA',false,false,{period:31}));
      await frame.waitForFunction(()=>window.__nativeHistory.some(row=>decode(row.ticker).spec?.name==='EMA' &&
        decode(row.ticker).series_kind==='history' && row.bars.some(bar=>bar.volume===1 && Number.isFinite(bar.close))),
        null,{timeout:120000});
      const authoritative=await frame.evaluate(version=>request({instrument:version,series_kind:'history',
        timeframe:'M1',limit:2000,indicators:[{name:'EMA',params:{period:31}}]}),initial.version);
      const values=authoritative.indicators[0].series[0].values;
      const native=await frame.evaluate(()=>window.__nativeHistory.filter(row=>decode(row.ticker).spec?.name==='EMA' &&
        decode(row.ticker).series_kind==='history').flatMap(row=>row.bars));
      const matches=values.filter(value=>native.some(bar=>bar.time===value.time && bar.close===value.value && bar.volume===1));
      assert.ok(matches.length>0,'Fixed EMA native history values agree with authoritative worker output');
      const authoritativeValues=new Map(values.filter(value=>Number.isFinite(value.value)).map(value=>[value.time,value.value]));
      const overlapping=native.filter(bar=>bar.volume===1 && authoritativeValues.has(bar.time));
      assert.ok(overlapping.length>=30,'Check a full EMA period in the overlapping history');
      for (const bar of overlapping) assert.equal(bar.close,authoritativeValues.get(bar.time));
      report.checks.push('fixed EMA31 background completion recovers actual native history and matches authoritative values');
      report.stage = 'period-switch';
      fs.writeFileSync(reportPath,JSON.stringify(report,null,2),{mode:0o600});
      await frame.evaluate(()=>widget.activeChart().setResolution('5'));
      await frame.waitForFunction(()=>widget.activeChart().dataReady() && widget.activeChart().resolution()==='5');
      await frame.waitForFunction(()=>[...subscriptions.values()].every(sub=>sub.marketPaused ||
        sub.res==='5' && !sub.marketRecovering) && window.__nativeHistory.some(row=>row.res==='5' &&
          decode(row.ticker).spec?.name==='EMA' && row.bars.some(bar=>bar.volume===1 && Number.isFinite(bar.close))),
        null,{timeout:120000});
      await expect.poll(()=>pendingInitial.size===0 && Date.now()-Math.max(0,...requests.filter(row=>
        initialPath(app+row.path)).map(row=>row.at))>=1500,{timeout:30000}).toBe(true);
      const retired=await frame.evaluate(()=>[...subscriptions.values()].filter(sub=>!sub.marketPaused).map(sub=>({symbol:sub.symbol,res:sub.res})));
      assert.ok(retired.every(sub=>sub.res==='5'),'Old M1 subscriptions retired on native period switch');
      const noChangeStart=Date.now();
      await page.waitForTimeout(16000);
      assert.ok(!requests.some(row=>row.at>=noChangeStart && initialPath(app+row.path)),
        'Stable fixed history must not poll market data');
      report.checks.push('native period switch releases old period; unchanged fixed history has no market polling');
      const epoch=await frame.evaluate(()=>workspaceEpoch);
      report.stage = 'workspace-switch';
      fs.writeFileSync(reportPath,JSON.stringify(report,null,2),{mode:0o600});
      report.native_history=await frame.evaluate(()=>window.__nativeHistory);
      await frame.evaluate(()=>new Promise((resolve,reject)=>widget.saveChartToServer(resolve,
        error=>reject(Error(JSON.stringify(error))))));
      await frame.waitForFunction(()=>!dirty && !nativeSaving,null,{timeout:30000});
      await frame.evaluate(()=>{void widget.loadChartFromServer({id:'unified-sse-synthetic',name:'统一 SSE · 合成输入'});});
      await expect.poll(()=>page.locator('iframe[title="专业图表工作区"]').getAttribute('data-workspace-id'),{timeout:60000})
        .toBe('unified-sse-synthetic');
      frame=page.frames().find(item=>item.url().startsWith(chart+'/'));
      await frame.waitForFunction(()=>typeof ready!=='undefined' && ready && !loading &&
        widget.activeChart().dataReady() && widget.activeChart().symbol()==='SSEFIXTURE' &&
        [...subscriptions.values()].some(sub=>sub.symbol==='SSEFIXTURE' && sub.marketListener),null,{timeout:60000});
      report.workspace_switch={previous_epoch:epoch,current_epoch:await frame.evaluate(()=>workspaceEpoch)};
      assert.ok(await frame.evaluate(()=>[...subscriptions.values()].every(sub=>
        decode(sub.symbol).series_kind==='managed')),'Old fixed/composite callbacks are retired after workspace switch');
      report.checks.push('native workspace load switches to managed series and retires previous fixed/composite subscriptions');
    }
    report.passed = true;
    report.stream=await page.evaluate(()=>window.__compositeStream);
  } catch (error) {
    report.error = String(error);
    if (frame) report.nativeBars=await frame.evaluate(()=>window.__nativeBars || []).catch(()=>[]);
    if (frame) report.native_history=await frame.evaluate(()=>window.__nativeHistory || []).catch(()=>[]);
    if (frame) report.native_state=await frame.evaluate(()=>({dirty,loading,ready,nativeSaving,
      symbol:widget.activeChart().symbol(),resolution:widget.activeChart().resolution(),
      subscriptions:[...subscriptions.values()].map(sub=>({symbol:sub.symbol,res:sub.res,last:sub.last,
        recovering:sub.marketRecovering,paused:sub.marketPaused,pending:sub.initialIndicatorPending,
        fixed_pending:fixedIndicatorPending.get(sub.symbol+'|'+sub.res)}))})).catch(()=>null);
    if (page) report.stream=await page.evaluate(()=>window.__compositeStream).catch(()=>[]);
    if (page) await page.screenshot({path:path.join(directory,'unified-sse-composite-failed.png')}).catch(()=>{});
    throw error;
  } finally {
    clearInterval(keeper);
    await keeping;
    if (frame) await frame.evaluate(()=>{
      for (const id of [...subscriptions.keys()]) feed.unsubscribeBars(id);
      for (const id of [...quoteSubscriptions.keys()]) feed.unsubscribeQuotes(id);
    }).catch(()=>{});
    await fixture('expire').catch(()=>{});
    if (browser) await browser.close();
    fs.writeFileSync(reportPath,JSON.stringify(report,null,2),{mode:0o600});
  }
  console.log(JSON.stringify({passed:report.passed,p95_ms:report.p95_ms,checks:report.checks,synthetic:true}));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
