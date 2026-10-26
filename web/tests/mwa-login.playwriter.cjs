// Execute with Playwriter -s SESSION -f this-file --timeout 180000.
// Set state.mwaLoginCheck = {baseURL, chartOrigin, authFile, reportDir} first.
// authFile stays outside the repository; only its password field is read.
const assert = require('node:assert');
const fs = require('node:fs');
const cfg = state.mwaLoginCheck;
assert(cfg?.baseURL && cfg.chartOrigin && cfg.authFile && cfg.reportDir,
  'Set state.mwaLoginCheck before running this deployment regression');
assert.notEqual(new URL(cfg.baseURL).origin, new URL(cfg.chartOrigin).origin);
fs.mkdirSync(cfg.reportDir, {recursive: true});
const report = {passed: false, observed_at_utc: new Date().toISOString(),
  ignoreHTTPSErrors: false, baseURL: cfg.baseURL, chartOrigin: cfg.chartOrigin,
  loginResponses: [], phases: [], pageErrors: [], badResponses: [], anonymousSessionChecks: []};
const isolated = await context.browser().newContext({
  ignoreHTTPSErrors: false, viewport: {width: 1440, height: 900}
});
let page;
let failures = [];
let quoteResponses = [];
let networkEvents = [];
try {
  page = await isolated.newPage();
  await page.bringToFront();
  const cdp = await getCDPSession({page});
  cdp.on('Network.requestWillBeSent', e => {
    if (e.request.url.startsWith(cfg.chartOrigin)) networkEvents.push({
      event: 'request', id: e.requestId, url: e.request.url,
      type: e.type, initiator: e.initiator
    });
  });
  cdp.on('Network.loadingFailed', e => networkEvents.push({event: 'failed', ...e}));
  cdp.on('Network.responseReceived', e => networkEvents.push({event: 'response',
    id: e.requestId, url: e.response.url, status: e.response.status, protocol: e.response.protocol}));
  cdp.on('Log.entryAdded', e => networkEvents.push({event: 'log', entry: e.entry}));
  await cdp.send('Network.enable');
  await cdp.send('Log.enable');
  await page.addInitScript(({chartOrigin}) => {
    window.__mwaLoginTransport = [];
    window.addEventListener('message', event => {
      if (event.origin !== chartOrigin) return;
      const m = event.data;
      if (m?.type === 'market' || m?.type === 'cancel-request')
        window.__mwaLoginTransport.push({type: m.type, id: m.id, op: m.query?.op});
    });
  }, {chartOrigin: cfg.chartOrigin});
  page.on('pageerror', error => report.pageErrors.push(String(error)));
  page.on('requestfailed', request => failures.push({
    url: request.url(), error: request.failure()?.errorText
  }));
  page.on('response', response => {
    const url = response.url();
    if (new URL(url).pathname === '/api/login')
      report.loginResponses.push(response.status());
    if (new URL(url).pathname === '/api/market-data/quotes')
      quoteResponses.push(response.status());
    if (response.status() === 401 && new URL(url).pathname === '/api/session' &&
        report.loginResponses.length === 0) {
      report.anonymousSessionChecks.push({url, status: response.status()});
      return;
    }
    if (response.status() >= 400)
      report.badResponses.push({url, status: response.status()});
  });
  const checkChart = async name => {
    await page.waitForURL('**/advanced-charts/**', {timeout: 20000});
    await page.locator('.advanced-status').filter({hasText: '已加载'})
      .waitFor({state: 'visible', timeout: 60000});
    const chart = page.frames().find(f => f.url().startsWith(cfg.chartOrigin + '/'));
    assert(chart, 'Expected the configured, independently trusted chart iframe');
    assert.equal(new URL(chart.url()).searchParams.get('parent'), new URL(cfg.baseURL).origin);
    report.stage = name + ': dataReady';
    await chart.waitForFunction(() => typeof widget === 'object' &&
      widget.chartsCount() > 0 && Array.from({length: widget.chartsCount()},
        (_, i) => widget.chart(i).dataReady()).every(Boolean), undefined, {timeout: 20000});
    const native = page.frames().find(f => f.url().startsWith('blob:' + cfg.chartOrigin + '/'));
    assert(native, 'Native chart frame must load');
    report.stage = name + ': OHLC';
    await native.waitForFunction(() => /开=\s*[\d,.]+/.test(document.body.innerText),
      undefined, {timeout: 15000});
    const nativeUI = await native.locator('body').ariaSnapshot();
    assert.match(nativeUI, /开=\s*[\d,.]+ 高=\s*[\d,.]+ 低=\s*[\d,.]+ 收=\s*[\d,.]+/,
      'Visible native OHLC must be populated');
    // Native startup may save its widgetbar layout. Wait for that durable
    // write before refreshing so the check does not manufacture a recovered
    // draft by interrupting its own request.
    await page.waitForFunction(() => !Object.keys(localStorage).some(key =>
      key.startsWith('mw-preference-draft:v1:admin:')), undefined, {timeout: 20000});
    assert.equal(await page.locator('.preference-draft-banner').count(), 0);
    const charts = await chart.evaluate(() => Array.from({length: widget.chartsCount()},
      (_, i) => ({symbol: widget.chart(i).symbol(), resolution: widget.chart(i).resolution(),
        ready: widget.chart(i).dataReady()})));
    const transport = await page.evaluate(() => window.__mwaLoginTransport);
    const canceledReads = transport.filter(m => m.type === 'cancel-request').map(m => ({
      ...m, op: transport.find(q => q.type === 'market' && q.id === m.id)?.op
    }));
    const canceledMarketReads = failures.filter(f => f.error === 'net::ERR_ABORTED' &&
      ['/api/market-data/quotes', '/api/market-data/resolve'].includes(new URL(f.url).pathname));
    // Notification observation uploads have a separate two-second budget
    // (notifications/runtime.ts). Record those aborts without calling them
    // chart resource failures or proof of notification delivery.
    const observationAborts = failures.filter(f => f.error === 'net::ERR_ABORTED' &&
      new URL(f.url).pathname === '/api/notification-center/observations');
    const closedStreams = failures.filter(f => f.error === 'net::ERR_ABORTED' &&
      new URL(f.url).pathname === '/api/charts/stream/events' &&
      networkEvents.some(e => e.event === 'response' && e.url === f.url && e.status === 200));
    const cleanupAborts = failures.filter(f => f.error === 'net::ERR_ABORTED' &&
      /^\/api\/charts\/history-loads\/[^/]+\/cancel$/.test(new URL(f.url).pathname));
    // Native initialization may replace a bundle request. Only accept a failed
    // attempt if the browser itself subsequently receives that exact URL as 200.
    // Never accept a permanent resource/certificate failure.
    const recoveredResources = failures.filter(f => f.error === 'net::ERR_FAILED' &&
      f.url.startsWith(cfg.chartOrigin + '/charting_library_') &&
      networkEvents.some((event, index) => event.event === 'failed' &&
        networkEvents.some(req => req.event === 'request' && req.id === event.requestId && req.url === f.url) &&
        networkEvents.slice(index + 1).some(res => res.event === 'response' && res.url === f.url && res.status === 200)));
    const styles = await native.evaluate(() => Array.from(document.querySelectorAll('link[rel=stylesheet]'),
      link => ({href: link.href, loaded: Boolean(link.sheet)})));
    assert(styles.length > 0 && styles.every(style => style.loaded),
      'Every stylesheet in the final native frame must have loaded');
    const unexpected = failures.filter(f => !canceledMarketReads.includes(f) &&
      !observationAborts.includes(f) && !closedStreams.includes(f) &&
      !cleanupAborts.includes(f) && !recoveredResources.includes(f));
    const recoveredURLs = new Set(recoveredResources.map(f => f.url));
    const recoveredIDs = new Set(networkEvents.filter(e => e.event === 'request' &&
      recoveredURLs.has(e.url)).map(e => e.id));
    const resourceRecoveryEvidence = networkEvents.filter(e =>
      recoveredURLs.has(e.url) || e.event === 'failed' && recoveredIDs.has(e.requestId))
      .map(({initiator, ...event}) => event);
    const phase = {name, url: page.url(), frames: page.frames().map(f => f.url()),
      status: await page.locator('.advanced-status').innerText(), charts,
      failures: failures.slice(), quoteResponses: quoteResponses.slice(),
      canceledReadMessages: canceledReads, recoveredResources, resourceRecoveryEvidence, styles, nativeUI,
      logs: await getLatestLogs({page, count: 30, sinceLastCall: true})};
    report.phases.push(phase);
    assert.deepEqual(unexpected, [], 'No certificate, resource or transport failures');
    for (const op of ['quotes', 'resolve']) {
      const aborts = canceledMarketReads.filter(f => new URL(f.url).pathname.endsWith('/' + op));
      if (!aborts.length) continue;
      assert(canceledReads.filter(m => m.op === op).length >= aborts.length,
        'Every allowed market abort needs a matching chart cancellation message');
      if (op === 'quotes') assert(quoteResponses.includes(200),
        'Canceled quote reads must be followed by a successful read');
    }
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.badResponses, []);
    await page.screenshot({path: cfg.reportDir + '/' + name + '.png', scale: 'css'});
  };
  await page.goto(cfg.baseURL + '/login', {waitUntil: 'domcontentloaded'});
  console.log(await getLatestLogs({page, count: 15, sinceLastCall: true}));
  await page.getByRole('button', {name: '登录并进入图表', exact: true})
    .waitFor({state: 'visible', timeout: 10000});
  const password = page.locator('input[type=password]');
  await password.click();
  await password.fill(JSON.parse(fs.readFileSync(cfg.authFile, 'utf8')).password);
  await page.getByRole('button', {name: '登录并进入图表', exact: true}).click();
  console.log(await getLatestLogs({page, count: 15, sinceLastCall: true}));
  await checkChart('regression-login');
  assert.deepEqual(report.loginResponses, [200]);
  failures = [];
  quoteResponses = [];
  await page.reload({waitUntil: 'domcontentloaded'});
  console.log(await getLatestLogs({page, count: 15, sinceLastCall: true}));
  await checkChart('regression-refresh');
  report.passed = true;
} catch (error) {
  report.error = String(error);
  if (page) {
    report.failureState = {url: page.url(), failures: failures.slice(), networkEvents: networkEvents.slice(), frames: page.frames().map(f => f.url()),
      visibility: await page.evaluate(() => document.visibilityState).catch(() => ''),
      body: await page.locator('body').ariaSnapshot().catch(() => ''),
      logs: await getLatestLogs({page, count: 80, sinceLastCall: true}).catch(() => [])};
    report.failureState.frameBodies = [];
    for (const frame of page.frames().slice(1)) {
      report.failureState.frameBodies.push(await frame.locator('body').ariaSnapshot().catch(() => ''));
    }
  }
  throw error;
} finally {
  fs.writeFileSync(cfg.reportDir + '/regression.json', JSON.stringify(report, null, 2));
  await isolated.close();
  console.log({passed: report.passed, phases: report.phases.length,
    pageErrors: report.pageErrors.length, badResponses: report.badResponses.length});
}
