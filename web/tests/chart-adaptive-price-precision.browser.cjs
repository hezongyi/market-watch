const { expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('./chart-data-center-fixture.cjs');
const { art, base } = fixture;
const metadataMode = process.env.MW_PRECISION_METADATA || 'normal';
const report = { environment: 'Ubuntu isolated Docker; native public price formatter', project: 'mw-data-center-review-20261008', metadataMode, passed: false, checks: [], errors: [] };

(async () => {
  const browser = await fixture.launch();
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const { host, native, center } = fixture.frames(page);
  page.on('pageerror', error => report.errors.push(error.message));
  try {
    const adaptMetadata = meta => {
      if (metadataMode === 'legacy') delete meta.display_precision;
      else meta.display_precision = 8;
    };
    if (metadataMode !== 'normal') {
      await page.route('**/api/market-data/resolve', async route => {
        const response = await route.fetch();
        const meta = await response.json();
        adaptMetadata(meta);
        await route.fulfill({ response, json: meta });
      });
      await page.route('**/api/advanced-charts/workspaces?*', async route => {
        const response = await route.fetch();
        const rows = await response.json();
        for (const row of rows) if (row.initial_symbol?.metadata) adaptMetadata(row.initial_symbol.metadata);
        await route.fulfill({ response, json: rows });
      });
    }
    await page.goto(base + '/advanced-charts');
    await fixture.login(page);
    await expect.poll(() => !!native(), { timeout: 30000 }).toBeTruthy();
    await native().getByRole('button', { name: '数据中心', exact: true }).click();
    await expect.poll(() => !!center(), { timeout: 30000 }).toBeTruthy();
    await center().getByRole('button', { name: '平台品种', exact: true }).click();
    await expect(center().getByRole('heading', { name: '平台品种', exact: true })).toBeVisible();
    await center().getByLabel('来源', { exact: true }).selectOption('yahoo');
    await center().getByLabel('搜索品种', { exact: true }).fill('AAPL');
    await expect(center().locator('tbody tr')).toHaveCount(1);
    await expect(center().getByRole('heading', { name: '平台品种', exact: true })).toBeVisible();
    await center().getByRole('button', { name: '打开平台图表', exact: true }).click();
    await expect.poll(() => !!center(), { timeout: 30000 }).toBeFalsy();
    await expect.poll(() => host().evaluate(() =>
      new Promise((resolve, reject) => feed.resolveSymbol(widget.activeChart().symbol(), resolve, reject)).then(info => info.name)
    ), { timeout: 60000 }).toBe('AAPL');
    await expect.poll(() => host().evaluate(() => ready && widget.activeChart().dataReady()), { timeout: 60000 }).toBeTruthy();
    await expect(native().locator('.mw-data-center-load')).toHaveCount(0, { timeout: 60000 });
    const actual = await host().evaluate(async () => {
      const chart = widget.activeChart();
      const info = await new Promise((resolve, reject) => feed.resolveSymbol(chart.symbol(), resolve, reject));
      return { symbol: info.name, source: info.mw_range_source, pricescale: info.pricescale,
        displayPrecision: info.mw_display_precision,
        formatted: chart.priceFormatter().format(252.29456789) };
    });
    report.checks.push({ name: 'AAPL automatic native price axis uses cents', ...actual });
    console.log(JSON.stringify(actual));
    expect(actual.symbol).toBe('AAPL');
    expect(actual.pricescale).toBe(100000000);
    if (metadataMode === 'legacy') expect(actual.displayPrecision).toBeUndefined();
    else if (metadataMode === 'excessive') expect(actual.displayPrecision).toBe(8);
    expect(actual.formatted).toBe('252.29');
    const quote = await host().evaluate(async () => {
      const ticker = widget.activeChart().symbol();
      const rows = await new Promise((resolve, reject) => feed.getQuotes([ticker], resolve, reject));
      return rows.find(row => row.n === ticker);
    });
    expect(quote.s).toBe('ok');
    expect(quote.v.mw_display_pricescale).toBe(100);
    const quoteDisplay = await host().evaluate(value => chartPriceFormatter({ type: 'stock' }, 'default').format(value), quote.v.lp);
    await expect(native().locator('[class*="priceWrapper"] [class*="price-"]')).toHaveText(quoteDisplay, { timeout: 30000 });
    report.checks.push({ name: 'native quote details use automatic display scale; raw price stays unrounded', displayScale: quote.v.mw_display_pricescale, raw: quote.v.lp, displayed: quoteDisplay });
    await page.screenshot({ path: path.join(art, 'adaptive-precision-aapl.png') });
    const small = await host().evaluate(() => {
      const format = widget.activeChart().priceFormatter();
      return { low: format.format(0.001234), tiny: format.format(0.00000001),
        highAgain: format.format(252.29456789), change: format.formatChange(252.30, 252.29) };
    });
    expect(small).toEqual({ low: '0.00123', tiny: '0.00000001', highAgain: '252.29', change: '0.01' });
    report.checks.push({ name: 'automatic precision adapts at render time without rounding source data', ...small });
    for (const [tick, expected] of [['10000,1,false', '252.2946'], ['100000000,1,false', '252.29456789'], ['default', '252.29']]) {
      await host().evaluate(tick => widget.applyOverrides({ 'mainSeriesProperties.minTick': tick }), tick);
      await expect.poll(() => host().evaluate(() => widget.activeChart().priceFormatter().format(252.29456789))).toBe(expected);
    }
    report.checks.push({ name: 'manual four/eight decimals remain available; returning to automatic restores cents' });
    await expect.poll(() => host().evaluate(() => !globalThis.MWNativeNavigation?.busy() &&
      !rangeGuard?.busy() && !edgeGuard?.busy()), { timeout: 60000 }).toBeTruthy();
    await host().evaluate(() => new Promise((resolve, reject) => widget.saveChartToServer(resolve,
      error => reject(new Error(JSON.stringify(error))))));
    await page.reload();
    await expect.poll(() => !!host() && !!native(), { timeout: 30000 }).toBeTruthy();
    await expect.poll(() => host().evaluate(() => ready && widget.activeChart().dataReady()), { timeout: 60000 }).toBeTruthy();
    const restored = await host().evaluate(() => new Promise((resolve, reject) => feed.resolveSymbol(widget.activeChart().symbol(), resolve, reject)));
    expect(restored.name).toBe('AAPL');
    await expect.poll(() => host().evaluate(() => widget.activeChart().priceFormatter().format(252.29456789))).toBe('252.29');
    report.checks.push({ name: 'saved automatic chart restores cents with startup metadata' });
    expect(report.errors).toEqual([]);
    report.passed = true;
  } catch (error) {
    report.errors.push(error.message);
    await page.screenshot({ path: path.join(art, 'adaptive-precision-failed.png') }).catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(path.join(art, `adaptive-precision-${metadataMode}-report.json`), JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
