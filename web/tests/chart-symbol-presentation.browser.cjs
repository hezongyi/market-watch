const { expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('./chart-data-center-fixture.cjs');
const { art, base } = fixture;
const report = { environment: 'Ubuntu isolated Docker; authenticated directories and native chart datafeed',
  project: 'mw-data-center-review-20261008', passed: false, checks: [], errors: [] };

(async () => {
  const browser = await fixture.launch();
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const { host, native, center } = fixture.frames(page);
  page.on('pageerror', error => report.errors.push(error.message));
  const record = (name, data = {}) => { report.checks.push({ name, ...data }); console.log('PASS', name); };
  const get = async route => {
    const response = await page.request.get(base + '/api/' + route);
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  try {
    await page.goto(base + '/market-data?tab=platform&source=yahoo&query=EUR%2FUSD');
    await fixture.login(page);
    await expect.poll(() => !!center() && !!native(), { timeout: 30000 }).toBeTruthy();
    for (const source of ['yahoo', 'oanda', 'dukascopy']) {
      const ids = [];
      for (const query of ['eurusd', 'EUR_USD', 'EUR/USD']) {
        const catalog = await get(`market-data/center/platform?source=${source}&query=${encodeURIComponent(query)}`);
        const pair = catalog.items.find(row => row.display_symbol === 'EUR/USD');
        expect(pair).toBeTruthy();
        ids.push(pair.id);
        const search = await get(`market-data/series/search?kind=provider&source=${source}&query=${encodeURIComponent(query)}`);
        const selected = search.find(row => row.id === pair.id);
        expect(selected.display_symbol).toBe('EUR/USD');
        expect(selected.symbol).toBe(pair.provider_symbol);
        expect(selected.ticker).toBe('MWP:' + pair.id);
      }
      expect(new Set(ids).size).toBe(1);
      await center().getByLabel('来源', { exact: true }).selectOption(source);
      await center().getByLabel('搜索品种', { exact: true }).fill('EUR/USD');
      const row = center().locator('tbody tr').filter({ has: center().locator('strong', { hasText: /^EUR\/USD$/ }) });
      await expect(row).toHaveCount(1);
      await expect(row.locator('strong')).toHaveText('EUR/USD');
      await page.screenshot({ path: path.join(art, `symbol-${source}.png`) });
      const ticker = 'MWP:' + ids[0];
      const info = await host().evaluate(ticker => new Promise((resolve, reject) => feed.resolveSymbol(ticker, resolve, reject)), ticker);
      expect(info.name).toBe('EUR/USD');
      expect(info.ticker).toBe(ticker);
      const search = await host().evaluate(query => new Promise(resolve => feed.searchSymbols(query, '', '', resolve)), 'EUR/USD');
      expect(search.some(row => row.ticker === ticker && row.symbol === 'EUR/USD')).toBeTruthy();
      record(source + ': three query formats, data center and native search/resolve share one readable name', { ticker, displayName: info.name });
    }
    await center().getByLabel('来源', { exact: true }).selectOption('binance');
    await center().getByLabel('搜索品种', { exact: true }).fill('BTC/USDT');
    await expect(center().locator('tbody strong')).toHaveText('BTC/USDT');
    await center().getByRole('button', { name: '打开平台图表', exact: true }).click();
    await expect.poll(() => !!center(), { timeout: 60000 }).toBeFalsy();
    await expect.poll(() => host().evaluate(() => widget.activeChart().symbol()), { timeout: 30000 }).toBe('MWP:BTCUSDT');
    const info = await host().evaluate(() => new Promise((resolve, reject) => feed.resolveSymbol(widget.activeChart().symbol(), resolve, reject)));
    expect(info.name).toBe('BTC/USDT');
    expect(info.ticker).toBe('MWP:BTCUSDT');
    const quotes = await get('market-data/center/platform?source=binance&query=BTC%2FUSDT');
    expect(quotes.items[0].provider_symbol).toBe('BTCUSDT');
    await expect.poll(() => host().evaluate(() => widget.activeChart().dataReady()), { timeout: 60000 }).toBeTruthy();
    await host().evaluate(() => widget.closePopupsAndDialogs());
    await page.screenshot({ path: path.join(art, 'symbol-binance-chart.png') });
    record('BTC/USDT opens the original Binance ticker without changing provider requests');
    await host().evaluate(() => new Promise((resolve, reject) => widget.saveChartToServer(resolve, reject)));
    await page.reload();
    await expect.poll(() => !!native(), { timeout: 30000 }).toBeTruthy();
    const restored = await host().evaluate(() => new Promise((resolve, reject) => feed.resolveSymbol(widget.activeChart().symbol(), resolve, reject)));
    expect(restored.name).toBe('BTC/USDT');
    expect(restored.ticker).toBe('MWP:BTCUSDT');
    record('workspace reload preserves identity and readable chart name');
    await native().getByRole('button', { name: '数据中心', exact: true }).click();
    await expect.poll(() => !!center()).toBeTruthy();
    await center().getByRole('button', { name: '自建行情', exact: true }).click();
    await center().getByLabel('搜索品种', { exact: true }).fill('EUR/USD');
    await expect(center().locator('tbody strong').first()).toHaveText('EUR/USD');
    for (const kind of ['history', 'composite']) {
      const rows = await get(`market-data/series/page?kind=${kind}&query=EUR%2FUSD`);
      expect(rows.items.length).toBeGreaterThan(0);
      expect(rows.items.every(row => row.display_symbol === 'EUR/USD' && row.symbol === 'EURUSD')).toBeTruthy();
      const resolved = await host().evaluate(ticker => new Promise((resolve, reject) => feed.resolveSymbol(ticker, resolve, reject)), rows.items[0].ticker);
      expect(resolved.name).toBe('EUR/USD');
      expect(resolved.ticker).toBe(rows.items[0].ticker);
    }
    record('self-built history and composite search/resolve use the same label with fixed identities');
    await center().getByRole('link', { name: '添加行情', exact: true }).click();
    await center().getByLabel('搜索来源目录', { exact: true }).fill('EUR/USD');
    await expect(center().getByRole('button', { name: '选择 EUR/USD', exact: true })).toBeVisible();
    await center().getByRole('button', { name: '选择 EUR/USD', exact: true }).click();
    await expect(center().getByLabel('逻辑品种', { exact: true })).toHaveValue('EURUSD');
    const providerCode = await center().getByLabel('准确来源代码', { exact: true }).inputValue();
    expect(['EUR/USD', 'EUR_USD']).toContain(providerCode);
    record('readable catalog selection retains canonical logical code and supplier input', { providerCode });
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
