const { expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('./chart-data-center-fixture.cjs');
const { art, base } = fixture;
const report = { environment: 'Ubuntu isolated Docker; real Yahoo symbols and native public price formatter', project: 'mw-data-center-review-20261008', passed: false, checks: [], errors: [] };

(async () => {
  const browser = await fixture.launch();
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const { host, native, center } = fixture.frames(page);
  page.on('pageerror', error => report.errors.push(error.message));
  const record = (name, data = {}) => { report.checks.push({ name, ...data }); console.log('PASS', name); };
  try {
    await page.goto(base + '/market-data?tab=platform&source=yahoo&query=MSFT');
    await fixture.login(page);
    await expect.poll(() => !!center(), { timeout: 30000 }).toBeTruthy();
    await expect(center().getByRole('heading', { name: '平台品种', exact: true })).toBeVisible();
    await center().getByRole('button', { name: '打开平台图表', exact: true }).click();
    await expect.poll(() => !!center(), { timeout: 60000 }).toBeFalsy();
    await expect.poll(() => host().evaluate(() => widget.activeChart().dataReady()), { timeout: 60000 }).toBeTruthy();
    const actual = await host().evaluate(async () => {
      const chart = widget.activeChart();
      const info = await new Promise((resolve, reject) => feed.resolveSymbol(chart.symbol(), resolve, reject));
      return { symbol: info.name, pricescale: info.pricescale, displayPrecision: info.mw_display_precision,
        formatted: chart.priceFormatter().format(530.82456789), smallChange: chart.priceFormatter().format(0.01456789) };
    });
    expect(actual.symbol).toBe('MSFT');
    expect(actual.pricescale).toBe(100000000);
    expect(actual.formatted).toBe('530.82');
    expect(actual.smallChange).toBe('0.01');
    record('MSFT native price axis defaults to cents while symbol data precision remains eight', actual);
    await page.screenshot({ path: path.join(art, 'yahoo-precision-msft.png') });
    // Explicit native precision settings must still use the library's formatter.
    await host().evaluate(() => widget.applyOverrides({ 'mainSeriesProperties.minTick': '10000,1,false' }));
    await expect.poll(() => host().evaluate(() => widget.activeChart().priceFormatter().format(530.82456789))).toBe('530.8246');
    await host().evaluate(() => widget.applyOverrides({ 'mainSeriesProperties.minTick': 'default' }));
    await expect.poll(() => host().evaluate(() => widget.activeChart().priceFormatter().format(530.82456789))).toBe('530.82');
    record('manual native precision overrides automatic default and can return to automatic');
    const catalog = await (await page.request.get(base + '/api/market-data/center/platform?source=yahoo')).json();
    for (const [symbol, precisions] of [['EURUSD=X', [4, 5]], ['CL=F', [2]]]) {
      const row = catalog.items.find(row => row.provider_symbol === symbol);
      expect(row).toBeTruthy();
      const info = await host().evaluate(ticker => new Promise((resolve, reject) => feed.resolveSymbol(ticker, resolve, reject)), 'MWP:' + row.id);
      expect(info.pricescale).toBe(100000000);
      expect(precisions).toContain(info.mw_display_precision);
      record(symbol + ' adapts by source/type rather than using stock precision', { precision: info.mw_display_precision });
    }
    const legacy = await host().evaluate(() => new Promise((resolve, reject) => feed.resolveSymbol('MWP:BTCUSDT', resolve, reject)));
    expect(legacy.pricescale).toBe(100);
    expect(legacy.mw_display_precision).toBeUndefined();
    record('existing Binance datafeed price scale remains unchanged');
    await host().evaluate(() => new Promise((resolve, reject) => widget.saveChartToServer(resolve, reject)));
    await page.reload();
    await expect.poll(() => !!host() && !!native(), { timeout: 30000 }).toBeTruthy();
    await expect.poll(() => host().evaluate(() => widget.activeChart().dataReady()), { timeout: 60000 }).toBeTruthy();
    expect(await host().evaluate(() => new Promise((resolve, reject) => feed.resolveSymbol(widget.activeChart().symbol(), resolve, reject)).then(info => info.name))).toBe('MSFT');
    expect(await host().evaluate(() => widget.activeChart().priceFormatter().format(530.82456789))).toBe('530.82');
    record('existing workspace reload retains automatic MSFT formatting');
    expect(report.errors).toEqual([]);
    report.passed = true;
  } catch (error) {
    report.errors.push(error.message);
    await page.screenshot({ path: path.join(art, 'yahoo-precision-failed.png') }).catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(path.join(art, 'yahoo-precision-report.json'), JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
