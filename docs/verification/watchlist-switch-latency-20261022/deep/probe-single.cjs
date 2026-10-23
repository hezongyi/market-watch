// Single H1 price diagnosis. The workspace response is replaced only in this
// temporary context; persisted workspace/preferences/notice writes are blocked.
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { chromium } = require(require.resolve('playwright', { paths: [process.cwd() + '/web'] }));
const { readOnlyAcceptance } = require(process.cwd() + '/web/tests/helpers/readOnlyAcceptance.cjs');
const base = 'https://192.168.7.232:18280', origin = 'https://192.168.7.232:18281';
const workspace = '/api/advanced-charts/workspaces/7d72eead-6be5-41a4-b3d5-bfdfff98b2bb';
const composite = 'MWC:8c490df00408ed7102d9106e2ad6d3991d3e6488de0b0905d92a2ec052343cbb';
const initialSymbol = 'MWP:XAUUSD';
const output = process.env.MW_SINGLE_OUT;
assert.ok(output && process.env.MW_ACCEPTANCE_PASSWORD, 'Private output and login environment required');
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const report = { started: new Date().toISOString(), viewport: { width: 1600, height: 1000 },
  mode: 'single-H1-price-no-studies', trials: [], requests: [], errors: [], httpErrors: [], blockedWrites: [] };
const save = () => fs.writeFileSync(output + '/report.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });

(async () => {
  const browser = await chromium.launch({ headless: true });
  let context, page, host;
  const responseWork = new Set();
  const state = async () => {
    const fetch = async path => { const r = await context.request.get(base + path); assert.equal(r.status(), 200); return r.json(); };
    const w = await fetch(workspace), p = await fetch('/api/advanced-charts/preferences');
    return { revision: w.revision, workspaceHash: hash(w), preferencesHash: hash(p) };
  };
  try {
    context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: report.viewport });
    const reads = new Set(['/api/login', '/api/market-data/resolve', '/api/charts/data', '/api/charts/reserve',
      '/api/market-data/viewport-session', '/api/market-data/history/cache', '/api/market-data/history/demand',
      '/api/market-data/quotes', '/api/charts/stream/subscribe', '/api/charts/stream/unsubscribe', '/api/charts/stream/accept']);
    await context.route('**/api/**', route => {
      const r = route.request(), path = new URL(r.url()).pathname;
      if (['GET', 'HEAD', 'OPTIONS'].includes(r.method()) || reads.has(path) ||
          path.startsWith('/api/charts/history-loads') || path.startsWith('/api/charts/indicator-demands/')) return route.continue();
      report.blockedWrites.push({ path, method: r.method() });
      return route.fulfill({ status: 409, json: { detail: 'Single-chart diagnosis does not save settings' } });
    });
    await readOnlyAcceptance(context, report);
    // This route is registered last so the preference guard cannot bypass it.
    await context.route('**' + workspace, async route => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch(), body = await response.json();
      body.document = { engine: 'tv31', schemaVersion: 1, symbol: initialSymbol, series_kind: 'provider', interval: '60' };
      report.singleResponseOverrides = (report.singleResponseOverrides || 0) + 1;
      return route.fulfill({ response, json: body });
    });
    page = await context.newPage();
    page.on('pageerror', e => report.errors.push(e.message));
    const byRequest = new WeakMap();
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (!path.startsWith('/api/charts/')) return;
      let body; try { body = request.postDataJSON(); body = body?.query || body; } catch {}
      const row = { path, method: request.method(), at: Date.now() };
      if (body) row.query = { series_kind: body.series_kind, timeframe: body.timeframe,
        instrument: body.instrument, countBack: body.countBack, first: body.firstDataRequest, indicators: body.indicators?.length };
      byRequest.set(request, row); report.requests.push(row);
    });
    page.on('response', response => {
      const row = byRequest.get(response.request()); if (!row) return;
      const task = (async () => {
        row.headers = Date.now(); row.status = response.status();
        if (row.status >= 400) report.httpErrors.push({ path: row.path, status: row.status });
        if (['/api/charts/data', '/api/charts/reserve'].includes(row.path) || row.path.startsWith('/api/charts/history-loads')) {
          const body = await response.json().catch(() => ({})), data = body.result || body;
          row.bars = data.bars?.length; row.cacheHit = data.cache_hit; row.timingsMs = data.timings_ms;
          row.loadState = body.load?.state || body.state;
        }
        row.ended = Date.now();
      })(); responseWork.add(task); task.finally(() => responseWork.delete(task));
    });
    await page.goto(base + '/advanced-charts/' + workspace.split('/').at(-1), { waitUntil: 'domcontentloaded' });
    await page.locator('input[type=password]').fill(process.env.MW_ACCEPTANCE_PASSWORD);
    const loginAt = Date.now(); await page.locator('button.auth-submit').click();
    await page.locator('iframe').first().waitFor({ timeout: 30000 });
    report.before = await state();
    for (let i = 0; i < 300; i++) { host = page.frames().find(f => f.url().startsWith(origin + '/')); if (host) break; await page.waitForTimeout(100); }
    assert.ok(host, 'Chart frame is available');
    await host.waitForFunction(() => typeof ready !== 'undefined' && ready && !loading && widget.chartsCount() === 1 && widget.activeChart().dataReady(), null, { timeout: 90000 });
    report.loginToInitialSingleReadyMs = Date.now() - loginAt;
    report.initial = await host.evaluate(() => ({ charts: widget.chartsCount(), symbol: widget.activeChart().symbol(),
      resolution: widget.activeChart().resolution(), studies: widget.activeChart().getAllStudies().length }));
    assert.equal(report.initial.charts, 1); assert.equal(report.initial.resolution, '60'); assert.equal(report.initial.studies, 0);
    const ui = host.childFrames()[0]; await ui.locator('[data-symbol-full="MWP:EURUSD"]').waitFor({ timeout: 30000 });
    const rows = await ui.locator('[data-symbol-full]').evaluateAll(es => es.map(e => e.dataset.symbolFull));
    const history = rows.find(x => x.startsWith('MWH:'));
    assert.ok(history && rows.some(x => x.toUpperCase() === composite.toUpperCase()));
    await host.evaluate(() => {
      globalThis.__MWSINGLE = { feed: [] };
      const original = feed.getBars;
      feed.getBars = function(...args) {
        const row = { at: Date.now(), symbol: args[0]?.ticker, resolution: args[1], countBack: args[2]?.countBack, first: args[2]?.firstDataRequest };
        __MWSINGLE.feed.push(row); const callback = args[3], fail = args[4];
        args[3] = (...values) => { row.completed = Date.now(); row.bars = values[0]?.length; return callback(...values); };
        if (typeof fail === 'function') args[4] = error => { row.error = String(error); return fail(error); };
        return original.apply(this, args);
      };
    });
    for (let round = 0; round < Number(process.env.MW_SINGLE_ROUNDS || 1); round++) {
      if (round > 0) {
        await ui.locator('[data-symbol-full="' + initialSymbol + '"]').first().click();
        await host.waitForFunction(t => widget.activeChart().symbol().toUpperCase() === t && widget.activeChart().dataReady() && !loading, initialSymbol, { timeout: 45000 });
      }
      for (const [scenario, ticker] of [['provider-entry', 'MWP:EURUSD'], ['fixed', history], ['composite', composite], ['provider-return', 'MWP:EURUSD']]) {
        const quietAt = Date.now(); let quiet = true;
        try { await host.waitForFunction(() => !loading && !requests.length && ![...pending.values()].some(e => !e.management && !e.quote), null, { timeout: 15000 }); } catch { quiet = false; }
        await page.waitForTimeout(600);
        const fromSymbol = await host.evaluate(() => widget.activeChart().symbol());
        assert.notEqual(fromSymbol.toUpperCase(), ticker.toUpperCase(), 'Measure a switch, not a repeated click on the current symbol');
        const trial = { round, scenario, ticker, fromSymbol, quietBefore: quiet, quietWaitMs: Date.now() - quietAt, start: Date.now() };
        report.trials.push(trial);
        await ui.locator('[data-symbol-full="' + ticker + '"]').first().click(); trial.clickMs = Date.now() - trial.start;
        await host.waitForFunction(t => widget.chartsCount() === 1 && widget.activeChart().symbol().toUpperCase() === t.toUpperCase() && widget.activeChart().dataReady() && !loading, ticker, { timeout: 45000 });
        trial.priceReadyMs = Date.now() - trial.start;
        trial.chart = await host.evaluate(() => {
          const c = widget.activeChart(); let finiteBars = 0;
          c._chartWidget.model().model().mainSeries().data().each((_, row) => { if (row.slice(1, 5).every(Number.isFinite)) finiteBars++; });
          return { count: widget.chartsCount(), resolution: c.resolution(), studies: c.getAllStudies().length, finiteBars, range: c.getVisibleRange() };
        });
        assert.equal(trial.chart.count, 1); assert.equal(trial.chart.studies, 0); assert.ok(trial.chart.finiteBars > 0);
        trial.feed = await host.evaluate(t => __MWSINGLE.feed.filter(x => x.at >= t), trial.start);
        trial.foregroundHttp = report.requests.filter(x => x.at >= trial.start &&
          (x.path === '/api/charts/history-loads' || x.path === '/api/charts/data'));
        trial.pricePath = trial.feed.length ? 'datafeed' : 'native-cache';
        console.log(JSON.stringify({ round, scenario, priceReadyMs: trial.priceReadyMs, quietBefore: quiet, pricePath: trial.pricePath, foregroundHttp: trial.foregroundHttp.length })); save();
      }
    }
    await page.waitForFunction(() => { const s = window.MWHistoryLoadDiagnostics?.(); return s && !s.admitted && !s.cleaning && !s.queued; }, null, { timeout: 20000 });
    report.resources = await page.evaluate(() => window.MWHistoryLoadDiagnostics());
    const idle = await host.waitForFunction(() => !requests.length && !pending.size ? { queued: requests.length, pending: pending.size } : false, null, { timeout: 15000 });
    report.bridge = await idle.jsonValue(); await idle.dispose();
    report.after = await state(); assert.deepEqual(report.before, report.after);
    assert.deepEqual(report.errors, []); assert.deepEqual(report.httpErrors, []);
    report.passed = true;
  } catch (e) { report.failure = e.stack; process.exitCode = 1; }
  finally {
    try { if (context && report.before && !report.after) report.after = await state(); } catch (e) { report.stateCheckError = e.message; }
    await Promise.race([Promise.allSettled([...responseWork]), new Promise(resolve => setTimeout(resolve, 5000))]);
    report.ended = new Date().toISOString(); save(); await browser.close();
  }
  console.log(JSON.stringify({ passed: report.passed === true, trials: report.trials.length, failure: report.failure,
    stateUnchanged: report.before && JSON.stringify(report.before) === JSON.stringify(report.after), errors: report.errors }));
})().catch(e => { console.error(e.message); process.exitCode = 1; });
