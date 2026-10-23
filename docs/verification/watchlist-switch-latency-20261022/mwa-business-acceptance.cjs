// Runs against the existing mwa with a fresh, temporary browser context.
// Persistent workspace, preference, alert and notification writes are blocked.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { chromium } = require(require.resolve('playwright', { paths: [process.cwd() + '/web'] }));
const { readOnlyAcceptance } = require(process.cwd() + '/web/tests/helpers/readOnlyAcceptance.cjs');

const base = 'https://192.168.7.232:18280';
const origin = 'https://192.168.7.232:18281';
const workspace = '7d72eead-6be5-41a4-b3d5-bfdfff98b2bb';
const out = process.env.MW_ACCEPTANCE_OUT;
assert.ok(out && process.env.MW_ACCEPTANCE_PASSWORD, 'Private output and login environment are required');
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const report = { started: new Date().toISOString(), viewport: { width: 1600, height: 1000 }, checks: [], errors: [], httpErrors: [], expectedHttpResponses: [], blockedWrites: [], quoteSamples: [], indicatorResponses: [] };
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: report.viewport });
  const allowed = new Set(['/api/login', '/api/market-data/resolve', '/api/charts/data', '/api/charts/reserve',
    '/api/market-data/viewport-session', '/api/market-data/history/cache', '/api/market-data/history/demand',
    '/api/market-data/quotes', '/api/charts/stream/subscribe', '/api/charts/stream/unsubscribe', '/api/charts/stream/accept']);
  await context.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url());
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method()) || allowed.has(url.pathname) ||
        url.pathname.startsWith('/api/charts/history-loads') || url.pathname.startsWith('/api/charts/indicator-demands/')) return route.continue();
    report.blockedWrites.push({ path: url.pathname, method: req.method() });
    return route.fulfill({ status: 409, json: { detail: 'Acceptance context does not persist configuration' } });
  });
  await readOnlyAcceptance(context, report);
  const page = await context.newPage();
  let host, ui;
  const responseWork = new Set();
  const simulatedNoticeIds = new Set();
  page.on('request', request => {
    if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/api/notification-center/events') return;
    try {
      const id = request.postDataJSON()?.event_id;
      if (id) simulatedNoticeIds.add(id);
    } catch {}
  });
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('response', response => {
    const pathname = new URL(response.url()).pathname;
    if (!pathname.startsWith('/api/')) return;
    const anonymousSession = pathname === '/api/session' && response.status() === 401;
    const simulatedNoticeLookup = response.status() === 404 && pathname.startsWith('/api/notification-center/events/') &&
      simulatedNoticeIds.has(decodeURIComponent(pathname.split('/').at(-1)));
    const blockedConfigurationWrite = response.status() === 409 && report.blockedWrites.some(row => row.path === pathname && row.method === response.request().method());
    if (anonymousSession || simulatedNoticeLookup) report.expectedHttpResponses.push({ path: pathname, status: response.status(), reason: anonymousSession ? 'anonymous-session-before-login' : 'notice-write-blocked-in-this-context' });
    else if (blockedConfigurationWrite) report.expectedHttpResponses.push({ path: pathname, status: 409, reason: 'configuration-write-blocked-in-this-context' });
    else if (response.status() >= 400) report.httpErrors.push({ path: pathname, status: response.status(), at: Date.now() });
    if (pathname !== '/api/charts/data') return;
    const pending = (async () => {
      let q;
      try { q = response.request().postDataJSON(); } catch { return; }
      if (!q?.indicators?.length) return;
      const d = await response.json().catch(() => ({}));
      report.indicatorResponses.push({ at: Date.now(), status: response.status(), instrument: q.instrument, kind: q.series_kind,
        timeframe: q.timeframe, progress: d.indicator_progress?.map(p => ({ status: p.status, cursor: p.cursor })),
        indicators: d.indicators?.map(i => ({ name: i.name, finite: i.series?.map(s => s.values?.filter(p => Number.isFinite(p.value)).length || 0) })) });
    })();
    responseWork.add(pending); pending.finally(() => responseWork.delete(pending));
  });
  const get = async endpoint => {
    const res = await context.request.get(base + endpoint);
    assert.equal(res.status(), 200, endpoint);
    return res.json();
  };
  const record = check => { report.checks.push(check); save(); console.log(JSON.stringify(check)); };
  try {
    await page.goto(base + '/advanced-charts/' + workspace, { waitUntil: 'domcontentloaded' });
    await page.locator('input[type=password]').fill(process.env.MW_ACCEPTANCE_PASSWORD);
    await page.locator('button.auth-submit').click();
    await page.locator('iframe').first().waitFor({ timeout: 30000 });
    const before = await get('/api/advanced-charts/workspaces/' + workspace);
    const preferences = await get('/api/advanced-charts/preferences');
    report.before = { workspaceHash: hash(before), revision: before.revision, preferencesHash: hash(preferences) };
    for (let i = 0; i < 300; i++) {
      host = page.frames().find(frame => frame.url().startsWith(origin + '/'));
      if (host) break;
      await page.waitForTimeout(100);
    }
    assert.ok(host, 'Chart host frame is present');
    await host.waitForFunction(() => typeof ready !== 'undefined' && ready && !loading && widget.chartsCount() === 5 &&
      Array.from({ length: 5 }, (_, i) => widget.chart(i)).every(c => c.dataReady()), null, { timeout: 90000 });
    ui = host.childFrames()[0];
    await ui.locator('[data-symbol-full="MWP:EURUSD"]').waitFor({ timeout: 30000 });
    const symbols = await ui.locator('[data-symbol-full]').evaluateAll(nodes => nodes.map(n => n.dataset.symbolFull));
    const history = symbols.find(s => s.startsWith('MWH:'));
    const composite = symbols.find(s => s.toLowerCase() === 'mwc:8c490df00408ed7102d9106e2ad6d3991d3e6488de0b0905d92a2ec052343cbb');
    assert.ok(history && composite, 'Original watchlist rows exist');
    report.tickers = { provider: 'MWP:EURUSD', history, composite };
    await host.evaluate(() => {
      globalThis.__MWACCEPT = { feed: [], peaks: { ordinary: 0, background: 0, quote: 0 }, samples: 0 };
      globalThis.__MWACCSnapshot = () => Array.from({ length: widget.chartsCount() }, (_, index) => {
        const c = widget.chart(index);
        return { index, symbol: c.symbol(), resolution: c.resolution(), ready: c.dataReady(), range: c.getVisibleRange(),
          studies: c.getAllStudies().map(({ id, name }) => {
            let rows = 0, finite = 0, first, last;
            c._chartWidget.model().model().dataSourceForId(id)?.data()?.each((i, row) => {
              rows++; if (row.slice(1).some(Number.isFinite)) { finite++; first ??= row[0]; last = row[0]; }
            });
            return { name, rows, finite, first, last };
          }) };
      });
      const original = feed.getBars;
      feed.getBars = function(s, res, period, callback, error) {
        const identity = decode(s.ticker);
        const row = { at: Date.now(), instrument: identity.symbol, kind: identity.series_kind, indicator: identity.spec?.name,
          resolution: res, first: period.firstDataRequest, countBack: period.countBack };
        __MWACCEPT.feed.push(row);
        return original.call(this, s, res, period, function(bars, ...rest) {
          row.completed = Date.now(); row.bars = bars.length; row.current = s.mw_current ? s.mw_current() : true;
          return callback(bars, ...rest);
        }, function(e) { row.completed = Date.now(); row.error = e?.code || String(e).slice(0, 100); return error?.(e); });
      };
      __MWACCEPT.timer = setInterval(() => {
        const entries = [...pending.values()];
        const counts = { ordinary: entries.filter(e => !e.management).length,
          background: entries.filter(e => !e.management && e.background).length, quote: entries.filter(e => e.quote).length };
        for (const key of Object.keys(counts)) __MWACCEPT.peaks[key] = Math.max(__MWACCEPT.peaks[key], counts[key]);
        __MWACCEPT.samples++;
      }, 100);
    });
    await page.evaluate(() => {
      globalThis.__MWACCLifecycles = { peaks: { admitted: 0, cleaning: 0, queued: 0 }, samples: 0 };
      __MWACCLifecycles.timer = setInterval(() => {
        const value = window.MWHistoryLoadDiagnostics?.(); if (!value) return;
        for (const key of ['admitted', 'cleaning', 'queued']) __MWACCLifecycles.peaks[key] = Math.max(__MWACCLifecycles.peaks[key], value[key]);
        __MWACCLifecycles.samples++;
      }, 100);
    });
    const sample = () => host.evaluate(() => __MWACCSnapshot());
    const initial = await sample();
    assert.deepEqual(initial.map(c => c.resolution), ['60', '5', '1W', '1D', '240']);
    assert.deepEqual(initial.map(c => c.studies.length), [0, 3, 0, 0, 1]);
    assert.equal(await host.evaluate(() => widget.activeChartIndex()), 0);
    report.originalStudyNames = initial.map(c => c.studies.map(s => s.name));
    record({ name: 'original-five-chart-layout', passed: true, charts: initial });
    const waitPlots = async () => host.waitForFunction(() => __MWACCSnapshot().every(c => c.ready && c.studies.every(s => s.finite > 0)), null, { timeout: 120000, polling: 250 });
    const quoteSample = async stage => {
      const quotes = await host.evaluate(() => [...quoteSnapshotRows.values()].map(row => ({ ticker: row.n, status: row.s,
        fetchStatus: row.v?.fetch_status, readAt: row.v?.read_at, fetchedAt: row.v?.fetched_at,
        dataStart: row.v?.data_start, dataEnd: row.v?.data_end, cacheAgeMs: row.v?.cache_age_ms, marketSession: row.v?.market_session,
        hasPrice: Number.isFinite(row.v?.lp) })));
      report.quoteSamples.push({ stage, at: Date.now(), quotes }); save();
      return quotes;
    };
    await waitPlots();
    await quoteSample('initial');
    const waitCharts = async ticker => {
      await host.waitForFunction(t => !loading && widget.activeChart().symbol().toUpperCase() === t.toUpperCase() && widget.activeChart().dataReady(), ticker, { timeout: 90000 });
      const activeMs = Date.now();
      await host.waitForFunction(t => Array.from({ length: widget.chartsCount() }, (_, i) => widget.chart(i)).every(c => c.symbol().toUpperCase() === t.toUpperCase() && c.dataReady()), ticker, { timeout: 90000 });
      return { activeAt: activeMs, allAt: Date.now() };
    };
    const switchOnce = async (ticker, name) => {
      const start = Date.now();
      await ui.locator('[data-symbol-full="' + ticker + '"]').first().click();
      const timing = await waitCharts(ticker);
      await waitPlots();
      const plotsAt = Date.now(), charts = await sample();
      assert.deepEqual(charts.map(c => c.studies.map(s => s.name)), report.originalStudyNames, 'Original studies are retained');
      const indicatorCallbacks = await host.evaluate(start => __MWACCEPT.feed.filter(r => r.at >= start && r.indicator && r.completed && r.current && r.bars > 0).map(r => ({ indicator: r.indicator, resolution: r.resolution, ms: r.completed - start, bars: r.bars })), start);
      const instrument = ticker.slice(4).toLowerCase();
      const indicatorResponses = report.indicatorResponses.filter(r => r.at >= start && r.instrument?.toLowerCase() === instrument &&
        r.indicators?.some(i => i.finite?.some(n => n > 0))).map(r => ({ timeframe: r.timeframe, ms: r.at - start, names: r.indicators.map(i => i.name) }));
      record({ name, ticker, activeMs: timing.activeAt - start, allMs: timing.allAt - start, allOriginalPlotsFiniteMs: plotsAt - start,
        indicatorCallbacks, firstFiniteIndicatorResponseMs: indicatorResponses.length ? Math.min(...indicatorResponses.map(r => r.ms)) : null,
        indicatorResponses, charts: charts.map(c => ({ index: c.index, resolution: c.resolution, studies: c.studies })), passed: true });
      await quoteSample(name);
    };
    await switchOnce('MWP:EURUSD', 'provider-prices-and-original-indicators');
    await switchOnce(history, 'fixed-history-prices-and-original-indicators');
    await switchOnce(composite, 'composite-prices-and-original-indicators');

    const pageLeft = async (ticker, name) => {
      const start = Date.now();
      const target = await host.evaluate(() => {
        const c = widget.activeChart(), old = c.getVisibleRange(), span = old.to - old.from;
        const earliest = firstHistory.get(c.symbol() + '|' + c.resolution());
        const to = Math.min(old.from - span, Number.isFinite(earliest) ? earliest / 1000 - 3600 : old.from - 3 * span);
        const target = { from: to - span, to };
        globalThis.__MWACCNavigation = { old, target, done: false };
        c.setVisibleRange(target, { rejectByTimeout: 60000 }).then(() => { __MWACCNavigation.done = true; }, e => { __MWACCNavigation.error = String(e); });
        return target;
      });
      await host.waitForFunction(() => __MWACCNavigation.done || __MWACCNavigation.error, null, { timeout: 65000 });
      const nav = await host.evaluate(() => __MWACCNavigation);
      assert.ok(!nav.error, nav.error);
      await waitCharts(ticker); await waitPlots();
      const callbacks = await host.evaluate(start => __MWACCEPT.feed.filter(r => r.at >= start && !r.indicator && r.first === false && r.completed && r.current).map(r => ({ kind: r.kind, resolution: r.resolution, bars: r.bars, ms: r.completed - start, error: r.error })), start);
      const visible = await host.evaluate(() => {
        const c = widget.activeChart(), range = c.getVisibleRange();
        let finiteBars = 0;
        c._chartWidget.model().model().mainSeries().data().each((_, row) => {
          if (row[0] >= range.from && row[0] <= range.to && row.slice(1, 5).every(Number.isFinite)) finiteBars++;
        });
        return { range, finiteBars };
      });
      assert.ok(visible.range.to < nav.old.from && visible.finiteBars > 0, 'Left navigation displays valid older OHLC bars');
      record({ name, ticker, ms: Date.now() - start, target, actualRange: visible.range, finiteVisibleBars: visible.finiteBars,
        delivery: callbacks.some(r => r.bars > 0) ? 'datafeed-page' : 'native-cache', callbacks, passed: true });
      await host.evaluate(async () => widget.activeChart().setVisibleRange(__MWACCNavigation.old, { rejectByTimeout: 20000 }));
    };
    await pageLeft(composite, 'fixed-history-left-navigation');
    await switchOnce('MWP:EURUSD', 'provider-cache-return');
    await pageLeft('MWP:EURUSD', 'provider-left-navigation');

    for(let round=0;round<Number(process.env.MW_ACCEPTANCE_RAPID_ROUNDS || 1);round++) {
    const rapidStart = Date.now(), clicks = [];
    for (const ticker of [history, composite, 'MWP:EURUSD', history, 'MWP:EURUSD']) {
      await ui.locator('[data-symbol-full="' + ticker + '"]').first().click();
      clicks.push({ ticker, ms: Date.now() - rapidStart, state: await host.evaluate(() => ({ loading, queued: requests.length, ordinary: [...pending.values()].filter(e => !e.management && !e.quote).length })) });
      await page.waitForTimeout(200);
    }
    const rapidTiming = await waitCharts('MWP:EURUSD'); await waitPlots();
    assert.ok(clicks.some(c => c.state.ordinary > 0 || c.state.loading || c.state.queued > 0), 'Rapid switches overlap unfinished work');
    record({ name: 'rapid-switches-final-symbol-and-indicators', round, ms: Date.now() - rapidStart,
      finalActiveMs: rapidTiming.activeAt - rapidStart, finalAllMs: rapidTiming.allAt - rapidStart, clicks, passed: true });
    }
    await page.waitForFunction(() => {
      const d = window.MWHistoryLoadDiagnostics?.();
      return d && d.admitted === 0 && d.cleaning === 0 && d.queued === 0;
    }, null, { timeout: 30000 });
    const resources = await page.evaluate(() => ({ current: window.MWHistoryLoadDiagnostics(), peaks: __MWACCLifecycles.peaks, samples: __MWACCLifecycles.samples }));
    const queue = await host.evaluate(() => ({ peaks: __MWACCEPT.peaks, samples: __MWACCEPT.samples, queued: requests.length, pending: pending.size, feed: __MWACCEPT.feed }));
    report.feed = queue.feed; delete queue.feed;
    assert.ok(resources.peaks.admitted <= 4 && queue.peaks.ordinary <= 4 && queue.peaks.background <= 2 && queue.peaks.quote <= 1);
    record({ name: 'bounded-admission-and-resource-return', resources, queue, passed: true });
    const quoteWaitStart = Date.now();
    await host.waitForFunction(start => {
      const q = quoteSnapshotRows.get('MWP:EURUSD');
      return q?.v?.fetch_status === 'ok' && Number.isFinite(q.v.lp) && q.v.read_at >= start;
    }, Date.parse(report.started), { timeout: 30000 });
    const finalQuotes = await quoteSample('final');
    const eur = finalQuotes.find(q => q.ticker === 'MWP:EURUSD');
    assert.ok(eur?.hasPrice && eur.fetchStatus === 'ok', 'Provider quote retains a valid non-stale price');
    assert.ok(Number.isFinite(eur.readAt) && eur.readAt >= Date.parse(report.started), 'Quote was read during this acceptance');
    record({ name: 'quote-freshness-contract', quote: eur, readAgeMs: Date.now() - eur.readAt,
      dataEndAgeMs: Number.isFinite(eur.dataEnd) ? Date.now() - eur.dataEnd : null, waitForNaturalRefreshMs: Date.now() - quoteWaitStart, passed: true });
    const after = await get('/api/advanced-charts/workspaces/' + workspace);
    const afterPreferences = await get('/api/advanced-charts/preferences');
    report.after = { workspaceHash: hash(after), revision: after.revision, preferencesHash: hash(afterPreferences) };
    assert.equal(report.before.workspaceHash, report.after.workspaceHash, 'Persistent workspace is unchanged');
    assert.equal(report.before.preferencesHash, report.after.preferencesHash, 'Persistent preferences are unchanged');
    assert.deepEqual(report.errors, [], 'No unhandled browser exception');
    assert.deepEqual(report.httpErrors, [], 'No unexpected HTTP failure');
    record({ name: 'persistent-state-and-browser-errors', workspaceUnchanged: true, preferencesUnchanged: true, passed: true });
    report.passed = true;
  } catch (error) {
    report.failure = error.stack;
    process.exitCode = 1;
    if (host) report.failureState = await host.evaluate(() => typeof __MWACCSnapshot === 'function' ? __MWACCSnapshot() : null).catch(() => null);
    report.failureResources = await page.evaluate(() => window.MWHistoryLoadDiagnostics?.()).catch(() => null);
    if(host) report.failureQueue = await host.evaluate(() => ({
      queued:requests.map(e=>({type:e.type,query:e.query,current:e.isCurrent ? e.isCurrent() : true})),
      pending:[...pending].map(([id,e])=>({id,purpose:e.purpose,native:e.nativeHistory,background:e.background})),
      feed:globalThis.__MWACCEPT?.feed,
    })).catch(() => null);
    await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  } finally {
    if(report.before && !report.after) {
      try {
        report.after={workspaceHash:hash(await get('/api/advanced-charts/workspaces/'+workspace)),
          preferencesHash:hash(await get('/api/advanced-charts/preferences'))};
        report.persistentStateUnchanged=report.before.workspaceHash===report.after.workspaceHash &&
          report.before.preferencesHash===report.after.preferencesHash;
      } catch(e) {report.stateCheckError=String(e);}
    }
    await Promise.race([Promise.allSettled([...responseWork]), new Promise(resolve => setTimeout(resolve, 5000))]);
    report.ended = new Date().toISOString(); save();
    console.log(JSON.stringify({ passed: report.passed === true, checks: report.checks.length, failure: report.failure, pageErrors: report.errors, httpErrors: report.httpErrors }));
    await browser.close();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
