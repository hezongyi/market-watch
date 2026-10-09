// Real task-owned Ubuntu API/worker/PostgreSQL + licensed native callbacks.
// Only database fixture inputs are synthetic; no mocked HTTP/SSE responses.
const {chromium, expect} = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync, execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {createHash} = require('node:crypto');
const run = promisify(execFile);
const root = path.resolve(__dirname, '../..');
const task = 'mw-unified-sse-20261008';
const app = 'http://127.0.0.1:15643';
const secondApp = 'http://127.0.0.1:15646';
const chart = 'http://127.0.0.1:15644';
const symbol = 'SSEFIXTURE';
const directory = path.join(root, 'artifacts/unified-sse');
const compose = ['compose', '--env-file', path.join(directory, 'compose.env'),
  '-p', task, '-f', path.join(root, 'compose.unified-sse.acceptance.yaml')];
const fixtureSource = fs.readFileSync(path.join(root, 'scripts/unified_sse_acceptance_fixture.py'), 'utf8');
const samples = [], checks = [], errors = [], requests = [];
let persistReport = ()=>{};
const sharing = process.argv.includes('--sharing');
const matrix = process.argv.includes('--matrix');
const costOnly = process.argv.includes('--cost-only');
const polling = process.argv.includes('--polling');
assert.ok(!polling || costOnly, 'Legacy polling is only used for the matched cost comparison');
const matrixResolutions = ['1','5','15','30','60','240','1W','1M'];
const matrixFrames = ['M1','M5','M15','M30','H1','H4','W1','MN'];

async function instrumentCallbacks(frame) {
  await frame.evaluate(() => {
    window.__nativeBars = [];
    window.__nativeHistory = [];
    const wrap = (cb, ticker, res) => bar => {
      cb(bar); // Observe after the actual library callback returns.
      window.__nativeBars.push({at:Date.now(), ticker, res, ...bar});
    };
    for (const sub of subscriptions.values()) sub.cb = wrap(sub.cb, sub.symbol, sub.res);
    const original = feed.subscribeBars;
    feed.subscribeBars = (s, res, cb, id, reset) => original(s, res, wrap(cb, s.ticker, res), id, reset);
    const getBars=feed.getBars;
    feed.getBars=(s,res,period,cb,error)=>getBars(s,res,period,(bars,meta)=>{
      const accepted=cb(bars,meta);
      window.__nativeHistory.push({at:Date.now(),ticker:s.ticker,res,bars});
      return accepted;
    },error);
  });
}
let gatewayStopped = false;
let primaryStopped = false;
let successorStarted = false;

async function gateway(online) {
  await run('docker', [...compose, ...(online ? ['start', 'web'] : ['stop', '-t', '1', 'web'])],
    {cwd:root, timeout:30000, maxBuffer:1024*1024});
  gatewayStopped = !online;
}

async function service(action, name) {
  assert.ok(['start','stop','restart'].includes(action));
  assert.ok(['api','market-stream-worker','market-stream-successor'].includes(name));
  await run('docker', [...compose, action, name], {cwd:root, timeout:30000, maxBuffer:1024*1024});
}

function preflight() {
  assert.match(fs.readFileSync('/etc/os-release', 'utf8'), /^ID=ubuntu$/m, 'Ubuntu is required');
  assert.ok(!process.env.DOCKER_HOST || process.env.DOCKER_HOST === 'unix:///var/run/docker.sock', 'Local Docker socket required');
  const context = JSON.parse(execFileSync('docker', ['context', 'inspect'], {encoding:'utf8'}))[0];
  assert.equal(context.Endpoints.docker.Host, 'unix:///var/run/docker.sock');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd:root, encoding:'utf8'}).trim();
  for (const service of ['api', 'market-stream-worker', 'web', 'chart-origin',
    ...(sharing ? ['api-second', 'web-second'] : [])]) {
    const id = execFileSync('docker', [...compose, 'ps', '-q', service], {cwd:root, encoding:'utf8'}).trim();
    assert.ok(id && !id.includes('\n'), `Exactly one running task ${service} is required`);
    const container = JSON.parse(execFileSync('docker', ['inspect', id], {encoding:'utf8'}))[0];
    assert.equal(container.Config.Labels['com.docker.compose.project'], task);
    assert.equal(container.Config.Labels['com.docker.compose.service'], service);
    const image = JSON.parse(execFileSync('docker', ['image', 'inspect', container.Image], {encoding:'utf8'}))[0];
    const labels = image.Config.Labels || {};
    // Label names are the lifecycle tool's public contract.
    assert.equal(labels['io.market-watch.managed'], 'true');
    assert.equal(labels['io.market-watch.task'], task);
    assert.equal(labels['io.market-watch.project'], task);
    assert.equal(labels['io.market-watch.purpose'], 'acceptance');
    assert.equal(labels['io.market-watch.commit'], commit, `Rebuild ${service} at current HEAD`);
  }
  return commit;
}

async function fixture(action, ...args) {
  const child = run('docker', [...compose, 'exec', '-T', 'api', 'python', '-', action, ...args],
    {cwd:root, timeout:30000, maxBuffer:1024*1024});
  child.child.stdin.end(fixtureSource);
  const {stdout} = await child;
  return JSON.parse(stdout.trim());
}

(async () => {
  // Fail before credentials, browser or fixture writes if Docker is unavailable.
  fs.mkdirSync(directory, {recursive:true, mode:0o700});
  let runtimeCommit;
  try {
    runtimeCommit = preflight();
  } catch (error) {
    fs.writeFileSync(path.join(directory, 'unified-sse-browser.json'), JSON.stringify({
      passed:false, stage:'preflight', environment:'Ubuntu local Docker', task,
      synthetic:true, browser_started:false, fixture_written:false, error:error.message,
    }, null, 2), {mode:0o600});
    throw error;
  }
  fs.writeFileSync(path.join(directory, 'unified-sse-browser.json'), JSON.stringify({
    passed:false, stage:'starting', environment:'Ubuntu local Docker', task,
    synthetic:true, started_at:Date.now(),
  }, null, 2), {mode:0o600});
  const initial = await fixture('seed');
  const browser = await chromium.launch({headless:true,
    executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const context = await browser.newContext({viewport:{width:1440,height:1000}});
  const page = await context.newPage();
  let frame, secondFrame, secondPage;
  const report = {passed:false, environment:'Ubuntu local Docker', task, app, chart,
    runtime_image_commit:runtimeCommit,
    harness_sha256:createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
    fixture_sha256:createHash('sha256').update(fixtureSource).digest('hex'),
    synthetic:true, checks, samples, errors};
  persistReport=()=>fs.writeFileSync(path.join(directory,'unified-sse-browser.json'),
    JSON.stringify(report,null,2),{mode:0o600});
  page.on('pageerror', error => errors.push(error.message));
  const initialRequests = new Set();
  const initialPath = url => ['/api/charts/data', '/api/market-data/quotes'].includes(new URL(url).pathname);
  page.on('requestfinished', request => initialRequests.delete(request));
  page.on('requestfailed', request => initialRequests.delete(request));
  page.on('request', request => {
    const url = new URL(request.url());
    if (initialPath(request.url())) initialRequests.add(request);
    if (/^\/api\/(charts|market-data)\//.test(url.pathname))
      requests.push({at:Date.now(), path:url.pathname, method:request.method(),
        body:request.method() === 'POST' ? request.postDataJSON() : null});
  });
  await context.addInitScript(() => {
    window.__sseTrace = {opens:0, errors:0, events:[]};
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(url, options) {
        super(url, options);
        if (!String(url).includes('/charts/stream/events')) return;
        this.addEventListener('open', () => window.__sseTrace.opens++);
        this.addEventListener('error', () => window.__sseTrace.errors++);
        this.addEventListener('message', event => {
          const value = JSON.parse(event.data);
          window.__sseTrace.events.push({at:Date.now(), type:value.type,
            reason:value.reason, listener:value.listener, generation:value.generation,
            sequence:value.sequence, bars:value.bars, indicators:value.indicators});
        });
      }
    };
  });
  try {
    await page.goto(app + '/');
    await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(path.join(directory, 'login.json'))).password);
    const login = page.waitForResponse(response => response.url().endsWith('/api/login'));
    await page.getByRole('button', {name:'登录工作台'}).click();
    assert.equal((await login).status(), 200);
    await page.goto(app + '/advanced-charts' + (polling ? '?marketPolling=1' : ''));
    await page.locator('iframe[title="专业图表工作区"]').waitFor();
    await expect.poll(() => page.frames().some(item => item.url().startsWith(chart + '/'))).toBe(true);
    frame = page.frames().find(item => item.url().startsWith(chart + '/'));
    await frame.waitForFunction(({expected,legacy}) => typeof ready !== 'undefined' && ready && !loading &&
      widget.activeChart().dataReady() && widget.activeChart().symbol() === expected &&
      widget.activeChart().resolution() === '1' &&
      [...subscriptions.values()].some(sub => sub.symbol === expected && (sub.marketListener || legacy)),
      {expected:symbol,legacy:polling}, {timeout:60000});
    if (sharing) {
      await frame.evaluate(() => widget.setLayout('4'));
      await frame.waitForFunction(expected => widget.chartsCount() === 4 &&
        Array.from({length:4}, (_,index) => widget.chart(index)).every(chart =>
          chart.dataReady() && chart.symbol() === expected && chart.resolution() === '1'), symbol,
        {timeout:60000});
      secondPage = await context.newPage();
      secondPage.on('pageerror', error => errors.push(error.message));
      await secondPage.goto(secondApp + '/advanced-charts');
      await secondPage.locator('iframe[title="专业图表工作区"]').waitFor();
      await expect.poll(() => secondPage.frames().some(item => item.url().startsWith(chart + '/'))).toBe(true);
      secondFrame = secondPage.frames().find(item => item.url().startsWith(chart + '/'));
      await secondFrame.waitForFunction(expected => typeof ready !== 'undefined' && ready && !loading &&
        widget.activeChart().dataReady() && widget.activeChart().symbol() === expected &&
        [...subscriptions.values()].some(sub => sub.symbol === expected && sub.marketListener), symbol,
        {timeout:60000});
      await instrumentCallbacks(secondFrame);
      await expect.poll(async () => {
        const tasks = (await fixture('state')).tasks.filter(task => task.kind === 'bars' && task.indicator_count === 0);
        return tasks.length === 1 && tasks[0].active_consumers >= 2;
      }, {timeout:15000}).toBe(true);
      report.sharing = {charts:4, connections:2, api_processes:2, second_app:secondApp};
    }
    if (matrix) {
      assert.ok(!sharing, 'Run sharing and period matrix as separate scenarios');
      await frame.evaluate(() => widget.setLayout('8'));
      await frame.waitForFunction(() => widget.chartsCount() === 8 &&
        Array.from({length:8},(_,index)=>widget.chart(index)).every(chart=>chart.dataReady()),
        null,{timeout:60000});
      await frame.evaluate(async resolutions => {
        for (let index = 0; index < resolutions.length; index++)
          await widget.chart(index).setResolution(resolutions[index], {doNotActivateChart:true});
      }, matrixResolutions);
      await frame.waitForFunction(({symbol,resolutions}) => widget.chartsCount() === resolutions.length &&
        resolutions.every((resolution,index) => widget.chart(index).dataReady() &&
          widget.chart(index).resolution() === resolution && widget.chart(index).symbol() === symbol),
        {symbol,resolutions:matrixResolutions}, {timeout:90000});
      report.matrix = {charts:8, frames:matrixFrames, samples:[]};
    }
    await instrumentCallbacks(frame);
    assert.ok(requests.some(item => item.path === '/api/charts/data' &&
      item.body?.instrument === symbol), 'First screen must use real HTTP history');
    checks.push('native first screen and '+(polling ? 'explicit polling fallback' : 'unified subscription'));
    let indicatorTicker;
    if (process.argv.includes('--indicators')) {
      const study = await frame.evaluate(() => widget.activeChart().createStudy(
        '守望 Python EMA', false, false, {period:31}));
      assert.ok(study, 'Native Python EMA study was created');
      await frame.waitForFunction(() => [...subscriptions.values()].some(sub =>
        decode(sub.symbol).spec?.name === 'EMA' && sub.marketListener && sub.last),
        null, {timeout:60000});
      indicatorTicker = await frame.evaluate(() => [...subscriptions.values()].find(sub =>
        decode(sub.symbol).spec?.name === 'EMA').symbol);
      report.indicator = {name:'EMA', period:31, ticker:indicatorTicker};
    }
    // dataReady can fire before native details/watchlist snapshot requests.
    // Wait for those finite first reads; SSE itself must remain connected.
    await expect.poll(() => initialRequests.size === 0 && Date.now() - Math.max(0,
      ...requests.filter(item => initialPath(app + item.path)).map(item => item.at)) >= 1500,
      {timeout:30000}).toBe(true);
    const measurementStart = Date.now();
    report.database_before = (await fixture('state')).database_stats;
    report.resources_before = (await run('docker', ['stats', '--no-stream', '--format',
      '{{.Name}} {{.CPUPerc}} {{.MemUsage}} {{.NetIO}} {{.BlockIO}}',
      ...['api','api-second','market-stream-worker','postgres'].map(name=>`${task}-${name}-1`)],
      {cwd:root,timeout:10000})).stdout.trim().split('\n');
    if (costOnly) {
      report.stage='cost-consumer-drain'; persistReport();
      await frame.evaluate(()=>{
        for (const [id,sub] of quoteSubscriptions)
          if(sub.symbols.some(ticker=>ticker!=='SSEFIXTURE')) feed.unsubscribeQuotes(id);
      });
      if(secondFrame) await secondFrame.evaluate(()=>{
        for (const [id,sub] of quoteSubscriptions)
          if(sub.symbols.some(ticker=>ticker!=='SSEFIXTURE')) feed.unsubscribeQuotes(id);
      });
      const ownClients=[await frame.evaluate(()=>clientId),...(secondFrame ? [await secondFrame.evaluate(()=>clientId)] : [])];
      await expect.poll(async()=> (await fixture('state')).all_consumers.every(consumer=>
        ownClients.includes(consumer.client)),{timeout:130000}).toBe(true);
      assert.ok(!polling || !sharing,'Mixed SSE/polling sharing is not a comparable baseline');
      const scenario = (polling ? 'polling' : 'sse') + (matrix ? '-eight-periods' :
        sharing ? '-four-charts-two-connections' : '-single-period');
      const probe = run('python',[path.join(root,'scripts/unified_sse_resources.py'),
        '--scenario',scenario,'--seconds','60','--interval','5'],{cwd:root,timeout:90000,maxBuffer:1024*1024});
      const costStart = Date.now();
      const inputInterval = matrix ? 12000 : 5000;
      const inputCount = matrix ? 4 : 10;
      report.cost = {scenario,input_interval_ms:inputInterval,inputs:[],duration_ms:60000,
        limits:'Same new-image fallback comparison; includes idle unified worker in both modes. Not an old-release baseline.'};
      report.stage='cost-measurement'; persistReport();
      for (let index=1;index<=inputCount;index++) {
        await page.waitForTimeout(Math.max(0,costStart+index*inputInterval-Date.now()));
        const close=(107+index/100).toFixed(2);
        const updates=await Promise.all((matrix ? matrixFrames : ['M1']).map(async period=>{
          const committed=await fixture('update','--timeframe',period,'--close',close);
          return {period,close,committed_at:committed.committed_at};
        }));
        report.cost.inputs.push(...updates);
      }
      assert.ok(Date.now()-costStart<=60000,'Scheduled inputs exceeded resource measurement window');
      await page.waitForTimeout(Math.max(0,costStart+60000-Date.now()));
      report.cost.resources=JSON.parse((await probe).stdout);
      persistReport();
      const latest=report.cost.inputs.at(-1);
      await frame.waitForFunction(({price,at})=>window.__nativeBars.some(bar=>bar.close===price && bar.at>=at),
        {price:Number(latest.close),at:latest.committed_at},{timeout:20000});
      report.nativeBars=await frame.evaluate(()=>window.__nativeBars);
      report.cost.callbacks=report.cost.inputs.flatMap(input=>{
        const res=matrixResolutions[matrixFrames.indexOf(input.period)] || '1';
        const bar=report.nativeBars.find(bar=>bar.res===res && bar.close===Number(input.close) && bar.at>=input.committed_at);
        return bar ? [{period:input.period,committed_at:input.committed_at,callback_at:bar.at,
          latency_ms:bar.at-input.committed_at}] : [];
      });
      if(secondFrame) {
        report.cost.second_callbacks=await secondFrame.evaluate(()=>window.__nativeBars);
        for (const input of report.cost.inputs) assert.ok(report.cost.second_callbacks.some(bar=>
          bar.close===Number(input.close) && bar.at>=input.committed_at),
          'Second API connection must actually receive each scheduled input');
        const shared=(await fixture('state')).tasks.filter(task=>task.kind==='bars' && task.indicator_count===0);
        assert.equal(shared.length,1,'Cost sharing retains one bar task across both API processes');
        report.sharing.task_count=shared.length;
        report.sharing.active_consumers=shared[0].active_consumers;
      }
      report.requests=requests.filter(row=>row.at>=costStart);
      if (!polling) assert.ok(!report.requests.some(row=>['/api/charts/data','/api/market-data/quotes',
        '/api/charts/provider/latest'].includes(row.path)),'Cost window must not poll');
      else assert.ok(report.requests.some(row=>row.path==='/api/charts/data'),'Fallback must actually poll');
      assert.deepEqual(errors,[]);
      checks.push('same scheduled inputs for 60-second resource comparison with actual native delivery');
      report.passed=true;
      return;
    }
    for (let index = 1; index <= 12; index++) {
      const close = (101 + index / 100).toFixed(2), high = index % 2 ? '140' : '110';
      const callbackCount = await frame.evaluate(() => window.__nativeBars.length);
      const committed = await fixture('update', '--close', close, '--high', high);
      await frame.waitForFunction(({time,close,high,callbackCount}) => window.__nativeBars.slice(callbackCount).some(bar =>
        bar.time === time && bar.close === close && bar.high === high),
        {time:committed.bar.start, close:Number(close), high:Number(high),callbackCount}, {timeout:15000});
      const delivered = await frame.evaluate(({time,close,callbackCount}) => window.__nativeBars.slice(callbackCount).find(bar =>
        bar.time === time && bar.close === close), {time:committed.bar.start, close:Number(close),callbackCount});
      samples.push({committed_at:committed.committed_at, callback_at:delivered.at,
        latency_ms:delivered.at-committed.committed_at, close:delivered.close, high:delivered.high});
      if (secondFrame) {
        await secondFrame.waitForFunction(({time,close,high}) => window.__nativeBars.some(bar =>
          bar.time === time && bar.close === close && bar.high === high),
          {time:committed.bar.start, close:Number(close), high:Number(high)}, {timeout:15000});
      }
      if (indicatorTicker) {
        const tail = committed.bar.start;
        await expect.poll(async () => {
          const event = await page.evaluate(({tail,close}) => [...window.__sseTrace.events].reverse().find(event =>
            event.type === 'bars' && event.bars?.some(bar => bar.start === tail && Number(bar.close) === close) &&
            event.indicators?.some(indicator => indicator.name === 'EMA' || indicator.spec?.name === 'EMA')),
            {tail, close:Number(close)});
          const value = event?.indicators?.[0]?.series?.[0]?.values?.find(item => item.time === tail)?.value;
          if (!Number.isFinite(value)) return false;
          return frame.evaluate(({ticker,time,value}) => window.__nativeBars.some(bar =>
            bar.ticker === ticker && bar.time === time && bar.close === value),
            {ticker:indicatorTicker, time:tail, value});
        }, {timeout:15000}).toBe(true);
      }
    }
    checks.push('same-bar updates and authoritative high contraction');
    if (secondFrame) {
      const state = (await fixture('state')).tasks.filter(task => task.kind === 'bars' && task.indicator_count === 0);
      assert.equal(state.length, 1, 'Both APIs and four same-period charts retain one shared bar task');
      report.sharing.task_count = state.length;
      report.sharing.active_consumers = state[0].active_consumers;
      report.sharing.second_callbacks = await secondFrame.evaluate(() => window.__nativeBars.slice());
      checks.push('four same-period charts and two browsers on distinct API processes share one bar task');
    }
    if (indicatorTicker) checks.push('Python EMA worker output reaches native study callbacks for every update');
    if (matrix) {
      for (let iteration = 1; iteration <= 3; iteration++) {
        for (let index = 0; index < matrixFrames.length; index++) {
          const close = (104 + iteration/100 + index/1000).toFixed(3);
          const callbackCount = await frame.evaluate(() => window.__nativeBars.length);
          const committed = await fixture('update', '--timeframe', matrixFrames[index], '--close', close);
          await frame.waitForFunction(({resolution,close,callbackCount}) => window.__nativeBars.slice(callbackCount).some(bar =>
            bar.res === resolution && bar.close === close),
            {resolution:matrixResolutions[index],close:Number(close),callbackCount}, {timeout:15000});
          const callback = await frame.evaluate(({resolution,close,callbackCount}) => window.__nativeBars.slice(callbackCount).find(bar =>
            bar.res === resolution && bar.close === close), {resolution:matrixResolutions[index],close:Number(close),callbackCount});
          report.matrix.samples.push({frame:matrixFrames[index],latency_ms:callback.at-committed.committed_at});
        }
      }
      const sorted = report.matrix.samples.map(item => item.latency_ms).sort((a,b)=>a-b);
      assert.ok(sorted.every(value=>value>=0), 'Only fresh callbacks can form latency samples');
      report.matrix.p95_ms = sorted[Math.ceil(sorted.length*.95)-1];
      assert.ok(report.matrix.p95_ms <= 3000);
      const tasks = (await fixture('state')).tasks.filter(task => task.kind === 'bars' && task.indicator_count === 0);
      assert.deepEqual([...new Set(tasks.map(task=>task.timeframe))].sort(), [...matrixFrames].sort());
      checks.push('eight native periods including W1/MN each receive authoritative published updates');
    }
    const disconnects = await page.evaluate(() => window.__sseTrace.errors);
    const opens = await page.evaluate(() => window.__sseTrace.opens);
    // Chromium's offline emulation leaves established localhost SSE sockets
    // alive on this host. Stop this task's gateway to sever the real TCP stream.
    await gateway(false);
    await page.waitForFunction(previous => window.__sseTrace.errors > previous, disconnects, {timeout:15000});
    const offlineCount = await frame.evaluate(() => window.__nativeBars.length);
    let latest;
    for (const close of ['102.01', '102.02', '102.03']) latest = await fixture('append', '--close', close);
    await page.waitForTimeout(1000);
    if (process.argv.includes('--long-outage')) {
      report.stage='long-disconnect'; persistReport();
      const outageStart=Date.now();
      for (let interval=0;interval<13;interval++) await page.waitForTimeout(10000);
      report.long_outage_ms=Date.now()-outageStart;
    }
    assert.equal(await frame.evaluate(() => window.__nativeBars.length), offlineCount,
      'Disconnected browser must not receive fixture updates');
    await gateway(true);
    await page.waitForFunction(previous => window.__sseTrace.opens > previous, opens, {timeout:30000});
    await frame.waitForFunction(({time,close,longOutage}) => [...window.__nativeBars,
      ...(longOutage ? window.__nativeHistory.flatMap(row=>row.bars) : [])].some(bar =>
      bar.time === time && bar.close === close),
      {time:latest.bar.start, close:Number(latest.bar.close),longOutage:process.argv.includes('--long-outage')},
      {timeout:30000});
    const recovered = await frame.evaluate(() => window.__nativeBars.slice());
    const recoveredHistory=await frame.evaluate(()=>window.__nativeHistory.flatMap(row=>row.bars));
    for (let offset = 1; offset <= 3; offset++) assert.ok([...recovered,...recoveredHistory].some(bar =>
      bar.time === initial.bar.start + offset * 60000), 'Recover every disconnected bucket');
    checks.push('real EventSource reconnect after gateway outage across three appended buckets');
    if (process.argv.includes('--takeover')) {
      const before = (await fixture('state')).tasks.filter(task => task.kind === 'bars' && task.indicator_count === 0 && task.timeframe === 'M1');
      assert.equal(before.length, 1, 'One shared synthetic bar task before takeover');
      const existing = await run('docker', [...compose, '--profile', 'takeover', 'ps', '-q', 'market-stream-successor'], {cwd:root});
      assert.equal(existing.stdout.trim(), '', 'Takeover harness requires its successor to be stopped');
      await run('docker', [...compose, '--profile', 'takeover', 'up', '-d', '--no-build', 'market-stream-successor'],
        {cwd:root, timeout:30000, maxBuffer:1024*1024});
      successorStarted = true;
      await service('stop', 'market-stream-worker');
      primaryStopped = true;
      const committed = await fixture('update', '--close', '103.01');
      await frame.waitForFunction(time => window.__nativeBars.some(bar =>
        bar.time === time && bar.close === 103.01), committed.bar.start, {timeout:60000});
      const after = (await fixture('state')).tasks.find(task => task.id === before[0].id);
      assert.ok(after && after.owner && after.owner !== before[0].owner, 'Another process owns the same durable task');
      assert.ok(after.sequence > before[0].sequence);
      report.takeover = {task_id:after.id, owner_changed:true,
        previous_sequence:before[0].sequence, recovered_sequence:after.sequence};
      checks.push('actual worker process stop and successor takeover of the same task');
    }
    if (process.argv.includes('--takeover') || process.argv.includes('--restart-api')) {
      const priorOpens = await page.evaluate(() => window.__sseTrace.opens);
      const restartAt = Date.now();
      await service('restart', 'api');
      await page.waitForFunction(previous => window.__sseTrace.opens > previous, priorOpens, {timeout:60000});
      report.api_reconnect_ms = Date.now() - restartAt;
      const next = await fixture('update', '--close', '103.02');
      await frame.waitForFunction(time => window.__nativeBars.some(bar =>
        bar.time === time && bar.close === 103.02), next.bar.start, {timeout:15000});
      checks.push('API process restart reconnects and preserves native delivery');
    }
    // Include at least one legacy 15-second tick in the observation window.
    await page.waitForTimeout(Math.max(0, 16000 - (Date.now()-measurementStart)));
    const normal = requests.filter(item => item.at >= measurementStart);
    assert.ok(!normal.some(item => ['/api/market-data/quotes', '/api/charts/provider/latest'].includes(item.path)),
      'Default mode must not poll bars or quotes');
    if (!process.argv.includes('--long-outage')) assert.ok(!normal.some(item => item.path === '/api/charts/data'),
      'Ordinary updates and short replay must not poll/reload historical bars');
    else {
      const restoredWithHistory=normal.some(item=>item.path==='/api/charts/data');
      if (restoredWithHistory) assert.ok(await page.evaluate(()=>window.__sseTrace.events.some(event=>event.type==='reset')),
        'Historical restoration must follow an explicit reset');
      report.long_outage_recovery=restoredWithHistory ? 'reset-and-history' : 'durable-replay';
      checks.push('real gateway outage beyond 120-second lease restores all three buckets through verified replay or explicit reset/history');
    }
    assert.deepEqual(errors, []);
    if (process.argv.includes('--visibility')) {
      report.stage = 'visibility-release';
      assert.ok(matrix, 'Visibility scenario requires --matrix');
      // Native single layout retains the active pane; choose M1 explicitly.
      await frame.evaluate(() => widget.setActiveChart(0));
      await frame.evaluate(() => widget.setLayout('s'));
      await frame.waitForFunction(() => widget.chartsCount() === 1 && widget.activeChart().dataReady());
      const ownClient = await frame.evaluate(() => clientId);
      assert.equal(await frame.evaluate(() => widget.activeChart().resolution()), '1');
      report.visibility = {retained_resolution:'1'};
      await expect.poll(async () => {
        const tasks = (await fixture('state')).tasks.filter(task => task.kind === 'bars' && task.indicator_count === 0);
        return tasks.filter(task => task.timeframe !== 'M1').every(task =>
          !task.consumers.some(consumer => consumer.client === ownClient));
      }, {timeout:15000}).toBe(true);
      await frame.evaluate(() => {
        window.__nativeHistory = [];
        const original = feed.getBars;
        feed.getBars = (symbol, resolution, period, cb, error) => original(symbol, resolution, period,
          (bars, meta) => { const accepted = cb(bars, meta);
            window.__nativeHistory.push({resolution,bars}); return accepted; }, error);
      });
      const hidden = await fixture('update', '--timeframe', 'M5', '--close', '105.19');
      await frame.evaluate(() => widget.setLayout('8'));
      await frame.waitForFunction(() => widget.chartsCount() === 8 &&
        Array.from({length:8},(_,index)=>widget.chart(index)).every(chart=>chart.dataReady()),
        null,{timeout:60000});
      await frame.waitForFunction(time => [...subscriptions.values()].some(sub => sub.res === '5' &&
        !sub.marketPaused && sub.last >= time), hidden.bar.start,{timeout:60000});
      await frame.waitForFunction(time => window.__nativeHistory.some(result => result.resolution === '5' &&
        result.bars.some(bar => bar.time === time && bar.close === 105.19)), hidden.bar.start,{timeout:60000});
      await expect.poll(async () => {
        const tasks = (await fixture('state')).tasks.filter(task => task.kind === 'bars' && task.indicator_count === 0);
        return matrixFrames.every(period => tasks.some(task => task.timeframe === period &&
          task.consumers.some(consumer => consumer.client === ownClient)));
      }, {timeout:15000}).toBe(true);
      checks.push('layout reduction releases hidden period consumers and restoration reloads missed data');
      report.visibility.restored_close = 105.19;
    }
    if (process.argv.includes('--quotes-only')) {
      report.stage = 'quote-only';
      assert.ok(!sharing, 'Quote-only scenario needs one browser');
      const ownClient = await frame.evaluate(() => clientId);
      await frame.evaluate(() => {
        window.__nativeQuotes = [];
        for (const sub of quoteSubscriptions.values()) {
          const original = sub.cb;
          sub.cb = rows => {original(rows);window.__nativeQuotes.push({at:Date.now(),rows});};
        }
        for (const id of [...subscriptions.keys()]) feed.unsubscribeBars(id);
      });
      await expect.poll(async () => {
        const tasks = (await fixture('state')).tasks;
        return tasks.filter(task => task.kind === 'bars').every(task =>
          !task.consumers.some(consumer => consumer.client === ownClient)) &&
          tasks.some(task => task.kind === 'quotes' &&
            task.consumers.some(consumer => consumer.client === ownClient));
      }, {timeout:15000}).toBe(true);
      const count = await frame.evaluate(() => window.__nativeBars.length);
      for (const close of ['106.01','106.02','106.03']) {
        const quoteCount = await frame.evaluate(() => window.__nativeQuotes.length);
        const committed = await fixture('update','--close',close);
        await frame.waitForFunction(({close,quoteCount}) => window.__nativeQuotes.slice(quoteCount).some(
          sample => sample.rows.some(row => row.n === 'SSEFIXTURE' && row.v.lp === close)),
          {close:Number(close),quoteCount},{timeout:15000});
        report.quote_only = {last_close:Number(close),committed_at:committed.committed_at};
      }
      assert.equal(await frame.evaluate(() => window.__nativeBars.length), count);
      await frame.evaluate(() => {
        for (const id of [...quoteSubscriptions.keys()]) feed.unsubscribeQuotes(id);
      });
      await expect.poll(async () => (await fixture('state')).tasks.every(task =>
        !task.consumers.some(consumer => consumer.client === ownClient)),
        {timeout:15000}).toBe(true);
      checks.push('native quote callbacks continue after all bar subscriptions are released and last quote cancellation releases consumers');
    }
    report.nativeBars = await frame.evaluate(() => window.__nativeBars.slice());
    report.stream = await page.evaluate(() => window.__sseTrace);
    report.requests = normal;
    report.database_after = (await fixture('state')).database_stats;
    report.resources_after = (await run('docker', ['stats', '--no-stream', '--format',
      '{{.Name}} {{.CPUPerc}} {{.MemUsage}} {{.NetIO}} {{.BlockIO}}',
      ...['api','api-second','market-stream-worker','postgres'].map(name=>`${task}-${name}-1`)],
      {cwd:root,timeout:10000})).stdout.trim().split('\n');
    const sorted = samples.map(item => item.latency_ms).sort((a,b) => a-b);
    assert.ok(sorted.every(value => value >= 0), 'Only fresh callbacks can form latency samples');
    report.p95_ms = sorted[Math.ceil(sorted.length*.95)-1];
    report.latency_scope = '12 sequential synthetic managed M1 updates; not the full load matrix';
    assert.ok(report.p95_ms <= 3000, `Smoke callback P95 ${report.p95_ms}ms exceeds 3000ms`);
    await page.screenshot({path:path.join(directory, 'unified-sse-browser.png'), fullPage:true});
    report.passed = true;
  } catch (error) {
    report.error = String(error);
    report.requests = requests;
    if (frame) report.nativeBars = await frame.evaluate(() => window.__nativeBars || []).catch(() => []);
    if (frame) report.visibility = await frame.evaluate(() => ({
      charts:Array.from({length:widget.chartsCount()},(_,index)=>({
        symbol:widget.chart(index).symbol(), resolution:widget.chart(index).resolution(),
      })), subscriptions:[...subscriptions.values()].map(sub=>({
        symbol:sub.symbol,res:sub.res,paused:sub.marketPaused,listener:sub.marketListener,
      })),
    })).catch(() => null);
    report.tasks = (await fixture('state').catch(() => ({}))).tasks;
    report.stream = await page.evaluate(() => window.__sseTrace).catch(() => null);
    await page.screenshot({path:path.join(directory, 'unified-sse-browser-failed.png'), fullPage:true}).catch(() => {});
    throw error;
  } finally {
    if (costOnly && frame) await frame.evaluate(()=>{
      for (const id of [...subscriptions.keys()]) feed.unsubscribeBars(id);
      for (const id of [...quoteSubscriptions.keys()]) feed.unsubscribeQuotes(id);
    }).catch(()=>{});
    if (costOnly && secondFrame) await secondFrame.evaluate(()=>{
      for (const id of [...subscriptions.keys()]) feed.unsubscribeBars(id);
      for (const id of [...quoteSubscriptions.keys()]) feed.unsubscribeQuotes(id);
    }).catch(()=>{});
    fs.writeFileSync(path.join(directory, 'unified-sse-browser.json'), JSON.stringify(report, null, 2), {mode:0o600});
    if (gatewayStopped) await gateway(true);
    if (primaryStopped) await service('start', 'market-stream-worker');
    if (successorStarted) await service('stop', 'market-stream-successor');
    await browser.close();
  }
  console.log(JSON.stringify({passed:report.passed, checks, p95_ms:report.p95_ms, synthetic:true}));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
