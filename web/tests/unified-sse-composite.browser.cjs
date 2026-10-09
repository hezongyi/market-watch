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
    report.stage = 'seed';
    await fixture('seed');
    await expect.poll(async()=> (await fixture('state')).artifacts_ready,{timeout:120000}).toBe(true);
    const initial = await fixture('activate');
    report.composite = initial.composite;
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
    page = await context.newPage();
    const requests = [];
    page.on('pageerror',error=>report.errors.push(error.message));
    page.on('request',request=>{
      const url = new URL(request.url());
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
      const wrap = (cb,res)=>bar=>{cb(bar);window.__nativeBars.push({at:Date.now(),res,...bar});};
      for (const sub of subscriptions.values()) sub.cb=wrap(sub.cb,sub.res);
      const original = feed.subscribeBars;
      feed.subscribeBars=(s,res,cb,id,reset)=>original(s,res,wrap(cb,res),id,reset);
    });
    report.checks.push('real composite first screen and four native periods M1/D1/W1/MN');
    await page.waitForTimeout(2000);
    report.stage = 'updates';
    const started = Date.now();
    for (let index=1;index<=12;index++) {
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
    }
    await page.waitForTimeout(Math.max(0,16000-(Date.now()-started)));
    assert.ok(!requests.some(row=>row.at>=started && ['/api/charts/data','/api/market-data/quotes',
      '/api/charts/provider/latest'].includes(row.path)),'Ordinary composite updates must not poll or reload history');
    const expected = (await fixture('state')).expected;
    const callbacks = await frame.evaluate(()=>window.__nativeBars);
    for (let index=0;index<frames.length;index++) {
      const bar = callbacks.filter(bar=>bar.res===resolutions[index]).at(-1);
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
    report.passed = true;
  } catch (error) {
    report.error = String(error);
    if (frame) report.nativeBars=await frame.evaluate(()=>window.__nativeBars || []).catch(()=>[]);
    if (page) await page.screenshot({path:path.join(directory,'unified-sse-composite-failed.png')}).catch(()=>{});
    throw error;
  } finally {
    clearInterval(keeper);
    await keeping;
    await fixture('expire').catch(()=>{});
    if (browser) await browser.close();
    fs.writeFileSync(reportPath,JSON.stringify(report,null,2),{mode:0o600});
  }
  console.log(JSON.stringify({passed:report.passed,p95_ms:report.p95_ms,checks:report.checks,synthetic:true}));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
