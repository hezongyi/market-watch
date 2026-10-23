// Read-only real-browser repro. One browser, original five charts, no saved writes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { chromium } = require(require.resolve('playwright', { paths: [process.cwd() + '/web'] }));
const { readOnlyAcceptance } = require(process.cwd() + '/web/tests/helpers/readOnlyAcceptance.cjs');
const base = 'https://192.168.7.232:18280', origin = 'https://192.168.7.232:18281';
const workspace = '7d72eead-6be5-41a4-b3d5-bfdfff98b2bb';
const out = process.env.MW_ACCEPTANCE_OUT;
assert.ok(out && process.env.MW_ACCEPTANCE_PASSWORD, 'Private output and login environment required');
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const hash = x => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const report = { started: new Date().toISOString(), rounds: [], http: [], errors: [], samples: [], blockedWrites: [] };
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
// Reuse the existing observation-only queue probe, without executing its workflow.
const probeSource = fs.readFileSync(path.join(__dirname, 'probe-queue.cjs'), 'utf8');
const hooks = probeSource.match(/const hooks=String.raw`([\s\S]*?)`;\n/)[1];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
  await context.route('**/host.*.js', async route => {
    const response = await route.fetch(), source = await response.text();
    const bridge = fs.readFileSync('advanced-host/bridge.js', 'utf8');
    let observed=source;
    if(process.env.MW_RAPID_BRIDGE_BASELINE) {
      const baseline=execFileSync('git',['show',process.env.MW_RAPID_BRIDGE_BASELINE+':advanced-host/bridge.js'],{encoding:'utf8'});
      assert.ok(source.includes(baseline),'Diagnostic overlay matches the fixed running bridge');
      observed=source.replace(baseline,bridge);
      report.browserOnlyBridgeOverlay=true;
    } else assert.ok(source.includes(bridge), 'Running bridge matches this worktree');
    const anchor = 'let initialHistoryGate;';
    assert.equal(observed.split(anchor).length, 2);
    await route.fulfill({ response, body: observed.replace(anchor, anchor + '\n' + hooks) });
  });
  const reads = new Set(['/api/login', '/api/market-data/resolve', '/api/charts/data', '/api/charts/reserve',
    '/api/market-data/viewport-session', '/api/market-data/history/cache', '/api/market-data/history/demand',
    '/api/market-data/quotes', '/api/charts/stream/subscribe', '/api/charts/stream/unsubscribe', '/api/charts/stream/accept']);
  await context.route('**/api/**', route => {
    const req = route.request(), pathname = new URL(req.url()).pathname;
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method()) || reads.has(pathname) ||
        pathname.startsWith('/api/charts/history-loads') || pathname.startsWith('/api/charts/indicator-demands/')) return route.continue();
    report.blockedWrites.push({ path: pathname, method: req.method() });
    return route.fulfill({ status: 409, json: { detail: 'Read-only rapid-switch diagnosis' } });
  });
  await readOnlyAcceptance(context, report);
  const page = await context.newPage(), requests = new WeakMap(), responses = new Set();
  let host;
  page.on('pageerror', e => report.errors.push(e.message));
  page.on('request', req => {
    const pathname = new URL(req.url()).pathname;
    if (!pathname.startsWith('/api/charts/')) return;
    let raw; try { raw = req.postDataJSON(); } catch {}
    const q = raw?.query || raw;
    const row = { path: pathname, method: req.method(), at: Date.now(), requestId: raw?.request_id,
      query: q && { instrument: q.instrument, kind: q.series_kind, timeframe: q.timeframe, limit: q.limit,
        from: q.from, before: q.before, indicators: q.indicators?.map(i => i.name), native: q.native_history } };
    requests.set(req, row); report.http.push(row);
  });
  page.on('requestfailed', req => { const r = requests.get(req); if (r) { r.ended = Date.now(); r.failure = req.failure(); } });
  page.on('response', res => {
    const row = requests.get(res.request()); if (!row) return;
    const p = (async () => {
      row.headers = Date.now(); row.status = res.status();
      if (row.path.includes('history-loads') || row.path === '/api/charts/data') {
        const body = await res.json().catch(() => ({})), load = body.load || body;
        row.load = { id: load.id, state: load.state, pages: load.pages, error: load.error };
        const result = body.result || body;
        row.result = { bars: result.bars?.length, cacheHit: result.cache_hit, timings: result.timings_ms,
          indicators: result.indicators?.map(i => ({ name: i.name, rows: i.series?.map(s => s.values?.length) })) };
      }
      row.ended = Date.now();
    })(); responses.add(p); p.finally(() => responses.delete(p));
  });
  const get = async p => { const r = await context.request.get(base + p); assert.equal(r.status(), 200); return r.json(); };
  const snapshot = async label => {
    const [parent, chart] = await Promise.all([
      page.evaluate(() => window.MWHistoryLoadDiagnostics?.()).catch(e => ({ error: e.message })),
      host?.evaluate(() => ({ loading, active: widget.activeChartIndex(),
        charts: Array.from({ length: widget.chartsCount() }, (_, i) => {
          const c = widget.chart(i);
          return { index: i, symbol: c.symbol(), resolution: c.resolution(), ready: c.dataReady(), range: c.getVisibleRange(),
            studies: c.getAllStudies().map(({ id, name }) => {
              let rows = 0, finite = 0;
              c._chartWidget.model().model().dataSourceForId(id)?.data()?.each((_, r) => { rows++; if (r.slice(1).some(Number.isFinite)) finite++; });
              return { name, rows, finite };
            }) };
        }),
        queued: requests.map(e => ({ type: e.type, query: e.query, scheduling: e.scheduling, current: e.isCurrent ? e.isCurrent() : true })),
        pending: [...pending].map(([id, e]) => ({ id, purpose: e.purpose, native: e.nativeHistory,
          background: e.background, management: e.management, quote: e.quote })),
        records: __MWLAT.records, feed: globalThis.__MWRAPIDFeed,
      })).catch(e => ({ error: e.message })),
    ]);
    const sample = { label, at: Date.now(), parent, chart };
    report.samples.push(sample); save(); return sample;
  };
  try {
    await page.goto(base + '/advanced-charts/' + workspace, { waitUntil: 'domcontentloaded' });
    await page.locator('input[type=password]').fill(process.env.MW_ACCEPTANCE_PASSWORD);
    await page.locator('button.auth-submit').click();
    await page.locator('iframe').first().waitFor({ timeout: 30000 });
    report.before = { workspace: hash(await get('/api/advanced-charts/workspaces/' + workspace)),
      preferences: hash(await get('/api/advanced-charts/preferences')) };
    for (let i = 0; i < 300; i++) {
      host = page.frames().find(f => f.url().startsWith(origin + '/')); if (host) break;
      await page.waitForTimeout(100);
    }
    assert.ok(host);
    await host.waitForFunction(() => typeof ready !== 'undefined' && ready && !loading && widget.chartsCount() === 5 &&
      Array.from({ length: 5 }, (_, i) => widget.chart(i)).every(c => c.dataReady()), null, { timeout: 90000 });
    await host.evaluate(() => {
      globalThis.__MWRAPIDFeed = [];
      const original = feed.getBars;
      feed.getBars = function(s, res, period, ok, fail) {
        const r = { at: Date.now(), ticker: s.ticker, res, first: period.firstDataRequest, countBack: period.countBack };
        __MWRAPIDFeed.push(r);
        return original.call(this, s, res, period, (bars, ...args) => {
          r.completed = Date.now(); r.bars = bars.length; r.current = s.mw_current?.(); return ok(bars, ...args);
        }, e => { r.failed = Date.now(); r.error = String(e); return fail?.(e); });
      };
    });
    const ui = host.childFrames()[0];
    await ui.locator('[data-symbol-full="MWP:EURUSD"]').waitFor();
    const tickers = await ui.locator('[data-symbol-full]').evaluateAll(es => es.map(e => e.dataset.symbolFull));
    const history = tickers.find(t => t.startsWith('MWH:'));
    const composite = tickers.find(t => t.toLowerCase() === 'mwc:8c490df00408ed7102d9106e2ad6d3991d3e6488de0b0905d92a2ec052343cbb');
    assert.ok(history && composite);
    await snapshot('initial');
    const rounds = Number(process.env.MW_RAPID_ROUNDS || 4);
    for (let n = 0; n < rounds; n++) {
      const round = { n, start: Date.now(), clicks: [] }; report.rounds.push(round);
      for (const ticker of [history, composite, 'MWP:EURUSD', history, 'MWP:EURUSD']) {
        await ui.locator('[data-symbol-full="' + ticker + '"]').first().click();
        round.clicks.push({ ticker, at: Date.now() });
        await page.waitForTimeout(Number(process.env.MW_RAPID_INTERVAL || 200));
      }
      await snapshot('round-' + n + '-clicked');
      const settled = () => host.evaluate(() => !loading && Array.from({ length: widget.chartsCount() }, (_, i) => widget.chart(i))
        .every(c => c.symbol().toUpperCase() === 'MWP:EURUSD' && c.dataReady()));
      for (let elapsed = 0; elapsed < Number(process.env.MW_RAPID_TIMEOUT_MS || 90000); elapsed += 1000) {
        if (await settled()) { round.ready = Date.now(); break; }
        await page.waitForTimeout(1000);
        if ([4000, 14000, 29000, 59000].includes(elapsed)) await snapshot('round-' + n + '-wait-' + (elapsed + 1000));
      }
      const end = await snapshot('round-' + n + '-end');
      round.ms = Date.now() - round.start;
      console.log(JSON.stringify({ round: n, passed: !!round.ready, ms: round.ms, history: end.parent,
        ready: end.chart?.charts?.map(c => c.ready), queue: end.chart?.queued?.length, pending: end.chart?.pending?.length }));
      assert.ok(round.ready, 'After five rapid watchlist switches, final five price charts must become ready within 90 seconds');
      await page.waitForTimeout(700);
    }
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (e) {
    report.failure = e.stack; process.exitCode = 1;
    await snapshot('failure-before-browser-close');
    await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  } finally {
    report.after = { workspace: hash(await get('/api/advanced-charts/workspaces/' + workspace)),
      preferences: hash(await get('/api/advanced-charts/preferences')) };
    report.stateUnchanged = JSON.stringify(report.before) === JSON.stringify(report.after);
    if (!report.stateUnchanged) { report.passed = false; process.exitCode = 1; }
    await Promise.race([Promise.allSettled([...responses]), new Promise(r => setTimeout(r, 3000))]);
    report.ended = new Date().toISOString(); save(); await browser.close();
    console.log(JSON.stringify({ passed: report.passed === true, rounds: report.rounds.length,
      stateUnchanged: report.stateUnchanged, failure: report.failure }));
  }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
