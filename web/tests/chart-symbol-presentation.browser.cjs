const { expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('./chart-data-center-fixture.cjs');
const { art, base } = fixture;
const report = { environment: 'Ubuntu isolated Docker; authenticated directories and native chart datafeed',
  project: process.env.MW_ACCEPTANCE_PROJECT || 'mw-symbol-display-20261010', passed: false, checks: [], errors: [] };

(async () => {
  const browser = await fixture.launch();
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const { host, native } = fixture.frames(page);
  const center = () => native().locator('.dc-window');
  page.on('pageerror', error => report.errors.push(error.message));
  const record = (name, data = {}) => { report.checks.push({ name, ...data }); console.log('PASS', name); };
  const get = async route => {
    const response = await page.request.get(base + '/api/' + route);
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const open = async route => {
    await host().evaluate(route => dataCenter.open(route), route);
    await expect(center()).toBeVisible({ timeout: 20000 });
  };
  const closeAfterApply = async () => expect.poll(() => center().count(), { timeout: 30000 }).toBe(0);
  const chartInfo = async () => host().evaluate(() => new Promise((resolve, reject) =>
    feed.resolveSymbol(widget.activeChart().symbol(), resolve, reject)));

  try {
    await page.goto(base + '/advanced-charts');
    await fixture.login(page);
    await expect.poll(() => !!host() && !!native(), { timeout: 30000 }).toBeTruthy();
    await host().waitForFunction(() => ready, null, { timeout: 60000 });
    await host().evaluate(() => new Promise(resolve => widget.activeChart().dataReady(resolve)));

    for (const source of ['yahoo', 'oanda', 'dukascopy']) {
      const ids = [];
      for (const query of ['eurusd', 'EUR_USD', 'EUR/USD']) {
        const catalog = await get(`market-data/center/platform?source=${source}&query=${encodeURIComponent(query)}`);
        const pair = catalog.items.find(row => row.display_symbol === 'EURUSD');
        expect(pair).toBeTruthy();
        ids.push(pair.id);
        const search = await get(`market-data/series/search?kind=provider&source=${source}&query=${encodeURIComponent(query)}`);
        const selected = search.find(row => row.id === pair.id);
        expect(selected.display_symbol).toBe('EURUSD');
        expect(selected.symbol).toBe(pair.provider_symbol);
        expect(selected.ticker).toBe('MWP:' + pair.id);
        const resolved = await host().evaluate(ticker => new Promise((resolve, reject) =>
          feed.resolveSymbol(ticker, resolve, reject)), selected.ticker);
        expect(resolved.name).toBe('EURUSD');
        expect(resolved.ticker).toBe(selected.ticker);
      }
      expect(new Set(ids).size).toBe(1);
      record(source + ': three query formats share one identity and native chart name', { ticker: 'MWP:' + ids[0] });
    }

    await open('/market-data?tab=platform&source=oanda&query=EUR/USD');
    await expect(center().locator('.dc-platform')).toContainText('EURUSD');
    await expect(center().getByRole('button', { name: '来源', exact: true })).toContainText('OANDA');
    await page.screenshot({ path: path.join(art, 'symbol-oanda.png') });
    await center().getByRole('button', { name: '打开图表', exact: true }).click();
    await closeAfterApply();
    await expect.poll(() => host().evaluate(() => widget.activeChart().symbol()), { timeout: 30000 }).toBe('MWP:EURUSD');
    await expect.poll(() => host().evaluate(() => widget.activeChart().dataReady()), { timeout: 60000 }).toBeTruthy();
    const oanda = await chartInfo();
    expect(oanda.name).toBe('EURUSD');
    expect(oanda.exchange).toBe('OANDA');
    await page.screenshot({ path: path.join(art, 'symbol-oanda-chart.png') });
    record('OANDA platform row opens a ready chart with native OANDA identity', { ticker: oanda.ticker, exchange: oanda.exchange });

    await open('/market-data?tab=platform&source=binance&query=BTC/USDT');
    await expect(center().locator('.dc-platform')).toContainText('BTCUSDT');
    await center().getByRole('button', { name: '打开图表', exact: true }).click();
    await closeAfterApply();
    await expect.poll(() => host().evaluate(() => widget.activeChart().symbol()), { timeout: 30000 }).toBe('MWP:BTCUSDT');
    await expect.poll(() => host().evaluate(() => widget.activeChart().dataReady()), { timeout: 60000 }).toBeTruthy();
    const binance = await chartInfo();
    expect(binance.name).toBe('BTCUSDT');
    expect(binance.ticker).toBe('MWP:BTCUSDT');
    const btc = await get('market-data/center/platform?source=binance&query=BTC%2FUSDT');
    expect(btc.items[0].provider_symbol).toBe('BTCUSDT');
    await page.screenshot({ path: path.join(art, 'symbol-binance-chart.png') });
    record('BTCUSDT opens with the original Binance provider code');

    expect(report.errors).toEqual([]);
    report.passed = true;
  } catch (error) {
    report.errors.push(error.message);
    await page.screenshot({ path: path.join(art, 'symbol-presentation-failed.png') }).catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(path.join(art, 'symbol-presentation-report.json'), JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
