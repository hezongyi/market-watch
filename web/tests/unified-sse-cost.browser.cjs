// Old 6fd9273 web/API versus optimized unified SSE on separate Ubuntu projects.
// Identical synthetic inputs; real HTTP, PostgreSQL, workers and native chart callbacks.
const {chromium, expect} = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync, execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {createHash} = require('node:crypto');
const run = promisify(execFile);
const root = path.resolve(__dirname, '../..');
const arm = process.argv.includes('--baseline') ? 'baseline' : 'optimized';
const matrix = process.argv.includes('--matrix');
const project = arm === 'baseline' ? 'mw-unified-sse-baseline-20261009' : 'mw-unified-sse-lease-optimization';
const port = arm === 'baseline' ? 17643 : 17743;
const app = `http://127.0.0.1:${port}`, chart = `http://127.0.0.1:${port + 1}`;
const privateDir = path.join(root, `artifacts/unified-sse/cost-${arm}`);
const directory = path.join(root, 'artifacts/unified-sse');
const compose = ['compose', '--env-file', path.join(privateDir, 'compose.env'), '-p', project,
  '-f', path.join(root, 'compose.unified-sse.cost.yaml')];
const fixtureSource = fs.readFileSync(path.join(root, 'scripts/unified_sse_cost_fixture.py'), 'utf8');
const seedAt = Number(process.env.MW_COST_SEED_AT);
assert.ok(Number.isSafeInteger(seedAt) && seedAt > 0, 'Both arms require the same MW_COST_SEED_AT');
const resolutions = matrix ? ['1','5','15','30','60','240','1W','1M'] : ['1'];
const frames = matrix ? ['M1','M5','M15','M30','H1','H4','W1','MN'] : ['M1'];
const scenario = `${arm}-${matrix ? 'eight-periods' : 'single-period'}`;
const output = path.join(directory, `cost-old-new-${scenario}.json`);
const readyFile = path.join(directory, `cost-probe-ready-${project}-${process.pid}`);
const report = {passed:false, environment:'Ubuntu local Docker', project, arm, app, chart,
  seed_at:seedAt, frames, synthetic:true, input_interval_ms:matrix ? 12000 : 5000,
  duration_ms:60000, inputs:[], requests:[], errors:[], stage:'preflight',
  harness_sha256:createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
  fixture_sha256:createHash('sha256').update(fixtureSource).digest('hex'),
  limits:['Single host, short synthetic window, not a production capacity or supplier SLA.',
    'Polling coalesces intermediate updates; every SSE update and the final polling value are checked.',
    'Browser/fixture host costs are outside container counters. Both use identical harness inputs.']};
const persist = () => fs.writeFileSync(output, JSON.stringify(report,null,2), {mode:0o600});
async function fixture(action, ...args) {
  const child = run('docker', [...compose,'exec','-T','api','python','-',action,
    '--project',project,'--seed-at',String(seedAt),'--frames',frames.join(','),...args],
    {cwd:root, timeout:45000, maxBuffer:1024*1024});
  child.child.stdin.end(fixtureSource);
  return JSON.parse((await child).stdout);
}
function preflight() {
  assert.match(fs.readFileSync('/etc/os-release','utf8'), /^ID=ubuntu$/m);
  assert.ok(!process.env.DOCKER_HOST || process.env.DOCKER_HOST === 'unix:///var/run/docker.sock');
  const ctx = JSON.parse(execFileSync('docker',['context','inspect'],{encoding:'utf8'}))[0];
  assert.equal(ctx.Endpoints.docker.Host,'unix:///var/run/docker.sock');
  const commit = arm === 'baseline' ? execFileSync('git',['rev-parse','6fd9273'],{cwd:root,encoding:'utf8'}).trim() :
    execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  report.runtime_images = {};
  for (const service of ['api','web','chart-origin',...(arm === 'optimized' ? ['market-stream-worker'] : [])]) {
    const id = execFileSync('docker',[...compose,'--profile','unified','ps','-q',service],{cwd:root,encoding:'utf8'}).trim();
    assert.ok(id && !id.includes('\n'),`One running ${service} required`);
    const c = JSON.parse(execFileSync('docker',['inspect',id],{encoding:'utf8'}))[0];
    assert.equal(c.Config.Labels['com.docker.compose.project'],project);
    const labels = JSON.parse(execFileSync('docker',['image','inspect',c.Image],{encoding:'utf8'}))[0].Config.Labels;
    for (const [key,value] of Object.entries({managed:'true',task:project,project,purpose:'acceptance',commit}))
      assert.equal(labels['io.market-watch.'+key],value);
    report.runtime_images[service] = {id:c.Image, labels};
  }
  report.runtime_image_commit = commit;
  report.source_diff_sha256 = createHash('sha256').update(execFileSync('git',['diff','--','backend/alerts/market_stream.py'],{cwd:root})).digest('hex');
}
let browser, frame, probe;
(async () => {
  try {
    preflight(); persist();
    report.seed = await fixture('seed');
    browser = await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
    const context = await browser.newContext({viewport:{width:1440,height:1000}});
    const page = await context.newPage();
    page.on('pageerror',e=>report.errors.push(e.message));
    const pending = new Set();
    page.on('requestfinished',r=>pending.delete(r));
    page.on('requestfailed',r=>pending.delete(r));
    page.on('request',r=>{
      const pathname = new URL(r.url()).pathname;
      if (['/api/charts/data','/api/market-data/quotes'].includes(pathname)) pending.add(r);
      if (/^\/api\/(charts|market-data)\//.test(pathname)) report.requests.push({at:Date.now(),path:pathname});
    });
    report.stage = 'native-first-screen'; persist();
    await page.goto(app+'/');
    await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(path.join(privateDir,'login.json'))).password);
    await page.getByRole('button',{name:'登录工作台'}).click();
    await page.waitForFunction(()=>!document.querySelector('input[type="password"]'));
    await page.goto(app+'/advanced-charts');
    await expect.poll(()=>page.frames().some(f=>f.url().startsWith(chart+'/')),{timeout:30000}).toBe(true);
    frame = page.frames().find(f=>f.url().startsWith(chart+'/'));
    await frame.waitForFunction(()=>typeof ready!=='undefined' && ready && !loading &&
      widget.activeChart().dataReady() && widget.activeChart().symbol()==='SSECOST',null,{timeout:90000});
    if (matrix) {
      await frame.evaluate(()=>widget.setLayout('8'));
      await frame.waitForFunction(()=>widget.chartsCount()===8,null,{timeout:30000});
      await frame.evaluate(async resolutions=>{
        for(let i=0;i<resolutions.length;i++) await widget.chart(i).setResolution(resolutions[i],{doNotActivateChart:true});
      },resolutions);
    }
    await frame.waitForFunction(resolutions=>resolutions.every((res,i)=>widget.chart(i).dataReady() &&
      widget.chart(i).symbol()==='SSECOST' && widget.chart(i).resolution()===res),resolutions,{timeout:90000});
    await frame.evaluate(()=>{
      for (const [id,sub] of quoteSubscriptions) if(sub.symbols.some(s=>s!=='SSECOST')) feed.unsubscribeQuotes(id);
      window.__costBars = [];
      for(const sub of subscriptions.values()) {
        const cb=sub.cb; sub.cb=b=>{cb(b);window.__costBars.push({at:Date.now(),res:sub.res,...b});};
      }
    });
    await expect.poll(()=>pending.size===0,{timeout:60000}).toBe(true);
    // Drain previous browser leases and stabilize warm caches, equally in both arms.
    report.stage='warmup'; persist();
    await page.waitForTimeout(125000);
    probe = run(path.join(root,'.venv/bin/python'),[path.join(root,'scripts/unified_sse_resources.py'),
      '--project',project,'--scenario',scenario,'--seconds','60','--interval','5','--ready-file',readyFile,
      ...(arm === 'optimized' ? ['--include-stream'] : [])],{cwd:root,timeout:90000,maxBuffer:2*1024*1024});
    // Attach a rejection handler immediately; errors are still rethrown at await probe.
    probe.catch(()=>{});
    await expect.poll(()=>fs.existsSync(readyFile),{timeout:20000}).toBe(true);
    const start = Date.now(); report.measurement_start=start; report.stage='measurement'; persist();
    for(let i=1;i<=(matrix ? 4 : 10);i++) {
      await page.waitForTimeout(Math.max(0,start+i*report.input_interval_ms-Date.now()));
      const close=(107+i/100).toFixed(2);
      const update=await fixture('update','--close',close);
      report.inputs.push(...update.inputs.map(input=>({period:input.period,close,
        bar:input.bar,committed_at:update.committed_at})));
    }
    assert.ok(Date.now()-start<60000,'Inputs must finish within the measurement window');
    await page.waitForTimeout(Math.max(0,start+60000-Date.now()));
    report.measurement_end=Date.now();
    report.resources=JSON.parse((await probe).stdout);
    const latest=Number(report.inputs.at(-1).close);
    await frame.waitForFunction(({latest,resolutions})=>resolutions.every(res=>
      window.__costBars.some(b=>b.res===res && b.close===latest)),{latest,resolutions},{timeout:25000});
    report.native_bars=await frame.evaluate(()=>window.__costBars);
    report.callbacks=report.inputs.flatMap(input=>{
      const res=resolutions[frames.indexOf(input.period)];
      const bar=report.native_bars.find(b=>b.res===res && b.close===Number(input.close) && b.at>=input.committed_at);
      return bar ? [{period:input.period,close:input.close,latency_ms:bar.at-input.committed_at}] : [];
    });
    report.window_requests=report.requests.filter(r=>r.at>=start && r.at<=report.measurement_end);
    const marketRequests=report.window_requests.filter(r=>['/api/charts/data','/api/market-data/quotes','/api/charts/provider/latest'].includes(r.path));
    if (arm==='baseline') assert.ok(marketRequests.some(r=>r.path==='/api/charts/data'),'Old bridge must really poll');
    else {
      assert.equal(marketRequests.length,0,'Optimized window must not poll');
      assert.equal(report.callbacks.length,report.inputs.length,'Each SSE input needs a native callback');
    }
    assert.deepEqual(report.errors,[]);
    report.passed=true; report.stage='passed';
  } catch (error) { report.error=error.stack; process.exitCode=1; }
  finally {
    if (frame) await frame.evaluate(()=>{
      for(const id of [...subscriptions.keys()]) feed.unsubscribeBars(id);
      for(const id of [...quoteSubscriptions.keys()]) feed.unsubscribeQuotes(id);
    }).catch(()=>{});
    if(browser) await browser.close();
    if(probe) await probe.catch(()=>{});
    fs.rmSync(readyFile,{force:true});
    persist(); console.log(JSON.stringify({passed:report.passed,stage:report.stage,report:output,error:report.error}));
  }
})();
