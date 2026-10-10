// Real deployed SSE message and native quote callback; no response interception.
const fs = require('node:fs'), path = require('node:path');
const {expect} = require('@playwright/test');
const f = require('./chart-data-center-fixture.cjs');
(async () => {
  const browser = await f.launch();
  const page = await browser.newPage({ignoreHTTPSErrors: true});
  const {host} = f.frames(page);
  const report = {environment: 'Ubuntu isolated Docker; real Yahoo snapshot over SSE', passed: false};
  try {
    await page.goto(f.base + '/advanced-charts');
    await f.login(page);
    await expect.poll(() => !!host(), {timeout: 30000}).toBe(true);
    await host().waitForFunction(() => ready, null, {timeout: 60000});
    const result = await page.request.get(f.base + '/api/market-data/center/platform?source=yahoo&query=AAPL');
    expect(result.ok()).toBe(true);
    const catalog = await result.json();
    const item = catalog.items.find(row => row.provider_symbol === 'AAPL');
    expect(item).toBeTruthy();
    const ticker = 'MWP:' + item.id;
    await host().evaluate(async ticker => {
      await new Promise((resolve, reject) => feed.resolveSymbol(ticker, resolve, reject));
      window.pr27SseQuotes = [];
      feed.subscribeQuotes([ticker], [], rows => {
        // Chromium exposes the currently dispatched event synchronously. This
        // excludes initial HTTP/naming callbacks and checks the real SSE path.
        const event = window.event;
        if (event?.source === parent && event.data?.type === "market-event" && event.data.event?.type === "quotes")
          window.pr27SseQuotes.push({event: event.data.event, rows});
      }, 'pr27-precision');
    }, ticker);
    await expect.poll(() => host().evaluate(() => pr27SseQuotes.some(item => item.rows.some(row => Number.isFinite(row.v.lp)))), {timeout: 20000}).toBe(true);
    const delivered = await host().evaluate(() => pr27SseQuotes.find(item => item.rows.some(row => Number.isFinite(row.v.lp))));
    const row = delivered.rows.find(row => Number.isFinite(row.v.lp));
    const source = delivered.event.quotes.find(row => Number.isFinite(row.v.lp));
    expect(row.n).toBe(ticker);
    expect(row.v.lp).toBe(source.v.lp);
    expect(row.v.mw_display_pricescale).toBe(100);
    report.passed = true;
    report.ticker = ticker;
    report.sequence = delivered.event.sequence;
    report.price = row.v.lp;
    report.displayPricescale = row.v.mw_display_pricescale;
    console.log('PASS real SSE Yahoo AAPL native callback keeps source price and display scale 100');
  } catch (error) { report.error = error.message; throw error; }
  finally {
    if (host()) await host().evaluate(() => {feed.unsubscribeQuotes('pr27-precision');}).catch(() => {});
    const dir = path.join(f.root, 'artifacts/pr27-review');
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'sse-precision-report.json'), JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
