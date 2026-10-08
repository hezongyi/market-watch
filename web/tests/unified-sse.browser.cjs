// Real task-owned Ubuntu API/worker/PostgreSQL + licensed native callbacks.
// Only database fixture inputs are synthetic; no mocked HTTP/SSE responses.
const {chromium, expect} = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync, execFile} = require('node:child_process');
const {promisify} = require('node:util');
const run = promisify(execFile);
const root = path.resolve(__dirname, '../..');
const task = 'mw-unified-sse-20261008';
const app = 'http://127.0.0.1:15643';
const chart = 'http://127.0.0.1:15644';
const symbol = 'SSEFIXTURE';
const directory = path.join(root, 'artifacts/unified-sse');
const compose = ['compose', '--env-file', path.join(directory, 'compose.env'),
  '-p', task, '-f', path.join(root, 'compose.unified-sse.acceptance.yaml')];
const fixtureSource = fs.readFileSync(path.join(root, 'scripts/unified_sse_acceptance_fixture.py'), 'utf8');
const samples = [], checks = [], errors = [], requests = [];

function preflight() {
  assert.match(fs.readFileSync('/etc/os-release', 'utf8'), /^ID=ubuntu$/m, 'Ubuntu is required');
  assert.ok(!process.env.DOCKER_HOST || process.env.DOCKER_HOST === 'unix:///var/run/docker.sock', 'Local Docker socket required');
  const context = JSON.parse(execFileSync('docker', ['context', 'inspect'], {encoding:'utf8'}))[0];
  assert.equal(context.Endpoints.docker.Host, 'unix:///var/run/docker.sock');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd:root, encoding:'utf8'}).trim();
  for (const service of ['api', 'market-stream-worker', 'web', 'chart-origin']) {
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
  try {
    preflight();
  } catch (error) {
    fs.writeFileSync(path.join(directory, 'unified-sse-browser.json'), JSON.stringify({
      passed:false, stage:'preflight', environment:'Ubuntu local Docker', task,
      synthetic:true, browser_started:false, fixture_written:false, error:error.message,
    }, null, 2), {mode:0o600});
    throw error;
  }
  const initial = await fixture('seed');
  const browser = await chromium.launch({headless:true,
    executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const context = await browser.newContext({viewport:{width:1440,height:1000}});
  const page = await context.newPage();
  let frame;
  const report = {passed:false, environment:'Ubuntu local Docker', task, app, chart,
    synthetic:true, checks, samples, errors};
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
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
            sequence:value.sequence, bars:value.bars});
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
    await page.goto(app + '/advanced-charts');
    await page.locator('iframe[title="专业图表工作区"]').waitFor();
    await expect.poll(() => page.frames().some(item => item.url().startsWith(chart + '/'))).toBe(true);
    frame = page.frames().find(item => item.url().startsWith(chart + '/'));
    await frame.waitForFunction(expected => typeof ready !== 'undefined' && ready && !loading &&
      widget.activeChart().dataReady() && widget.activeChart().symbol() === expected &&
      widget.activeChart().resolution() === '1' &&
      [...subscriptions.values()].some(sub => sub.symbol === expected && sub.marketListener),
      symbol, {timeout:60000});
    await frame.evaluate(() => {
      window.__nativeBars = [];
      const wrap = (cb, ticker, res) => bar => {
        cb(bar); // Observe only after the actual library callback accepts it.
        window.__nativeBars.push({at:Date.now(), ticker, res, ...bar});
      };
      for (const sub of subscriptions.values()) sub.cb = wrap(sub.cb, sub.symbol, sub.res);
      const original = feed.subscribeBars;
      feed.subscribeBars = (s, res, cb, id, reset) => original(s, res, wrap(cb, s.ticker, res), id, reset);
    });
    assert.ok(requests.some(item => item.path === '/api/charts/data' &&
      item.body?.instrument === symbol), 'First screen must use real HTTP history');
    checks.push('native first screen and unified subscription');
    const measurementStart = Date.now();
    for (let index = 1; index <= 12; index++) {
      const close = (101 + index / 100).toFixed(2), high = index % 2 ? '140' : '110';
      const committed = await fixture('update', '--close', close, '--high', high);
      await frame.waitForFunction(({time,close,high}) => window.__nativeBars.some(bar =>
        bar.time === time && bar.close === close && bar.high === high),
        {time:committed.bar.start, close:Number(close), high:Number(high)}, {timeout:15000});
      const delivered = await frame.evaluate(({time,close}) => window.__nativeBars.find(bar =>
        bar.time === time && bar.close === close), {time:committed.bar.start, close:Number(close)});
      samples.push({committed_at:committed.committed_at, callback_at:delivered.at,
        latency_ms:delivered.at-committed.committed_at, close:delivered.close, high:delivered.high});
    }
    checks.push('same-bar updates and authoritative high contraction');
    const disconnects = await page.evaluate(() => window.__sseTrace.errors);
    const opens = await page.evaluate(() => window.__sseTrace.opens);
    await context.setOffline(true);
    await page.waitForFunction(previous => window.__sseTrace.errors > previous, disconnects, {timeout:15000});
    const offlineCount = await frame.evaluate(() => window.__nativeBars.length);
    let latest;
    for (const close of ['102.01', '102.02', '102.03']) latest = await fixture('append', '--close', close);
    await page.waitForTimeout(1000);
    assert.equal(await frame.evaluate(() => window.__nativeBars.length), offlineCount,
      'Disconnected browser must not receive fixture updates');
    await context.setOffline(false);
    await page.waitForFunction(previous => window.__sseTrace.opens > previous, opens, {timeout:30000});
    await frame.waitForFunction(({time,close}) => window.__nativeBars.some(bar =>
      bar.time === time && bar.close === close),
      {time:latest.bar.start, close:Number(latest.bar.close)}, {timeout:30000});
    const recovered = await frame.evaluate(() => window.__nativeBars.slice());
    for (let offset = 1; offset <= 3; offset++) assert.ok(recovered.some(bar =>
      bar.time === initial.bar.start + offset * 60000), 'Recover every disconnected bucket');
    checks.push('real EventSource reconnect across three appended buckets');
    // Include at least one legacy 15-second tick in the observation window.
    await page.waitForTimeout(Math.max(0, 16000 - (Date.now()-measurementStart)));
    const normal = requests.filter(item => item.at >= measurementStart);
    assert.ok(!normal.some(item => ['/api/market-data/quotes', '/api/charts/provider/latest'].includes(item.path)),
      'Default mode must not poll bars or quotes');
    assert.ok(!normal.some(item => item.path === '/api/charts/data'),
      'Ordinary updates and short replay must not poll/reload historical bars');
    assert.deepEqual(errors, []);
    report.nativeBars = recovered;
    report.stream = await page.evaluate(() => window.__sseTrace);
    report.requests = normal;
    const sorted = samples.map(item => item.latency_ms).sort((a,b) => a-b);
    report.p95_ms = sorted[Math.ceil(sorted.length*.95)-1];
    report.latency_scope = '12 sequential synthetic managed M1 updates; not the full load matrix';
    assert.ok(report.p95_ms <= 3000, `Smoke callback P95 ${report.p95_ms}ms exceeds 3000ms`);
    report.passed = true;
    await page.screenshot({path:path.join(directory, 'unified-sse-browser.png'), fullPage:true});
  } catch (error) {
    report.error = String(error);
    report.requests = requests;
    if (frame) report.nativeBars = await frame.evaluate(() => window.__nativeBars || []).catch(() => []);
    report.stream = await page.evaluate(() => window.__sseTrace).catch(() => null);
    await page.screenshot({path:path.join(directory, 'unified-sse-browser-failed.png'), fullPage:true}).catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(path.join(directory, 'unified-sse-browser.json'), JSON.stringify(report, null, 2), {mode:0o600});
    await context.setOffline(false).catch(() => {});
    await browser.close();
  }
  console.log(JSON.stringify({passed:report.passed, checks, p95_ms:report.p95_ms, synthetic:true}));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
