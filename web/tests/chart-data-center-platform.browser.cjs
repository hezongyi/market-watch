const { expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('./chart-data-center-fixture.cjs');
const { art, base } = fixture;
const report = { environment: 'Ubuntu isolated Docker; enabled Yahoo and legacy Binance directory; real chart resolve', project: 'mw-data-center-review-20261008', passed: false, checks: [], errors: [] };

(async () => {
  const browser = await fixture.launch();
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const { native, host, center } = fixture.frames(page);
  page.on('pageerror', error => report.errors.push(error.message));
  const record = (name, data = {}) => { report.checks.push({ name, ...data }); console.log('PASS', name); };
  try {
    await page.goto(base + '/market-data?tab=platform');
    await fixture.login(page);
    await expect.poll(() => !!center(), { timeout: 30000 }).toBeTruthy();
    await expect(center().getByRole('heading', { name: '平台品种', exact: true })).toBeVisible();
    for (const [source, symbol] of [['binance', 'BTCUSDT'], ['yahoo', 'AAPL']]) {
      const response = await page.request.get(base + '/api/market-data/center/platform?source=' + source);
      expect(response.ok()).toBeTruthy();
      const directory = await response.json();
      expect(directory.total).toBeGreaterThan(0);
      const selected = directory.items.find(row => row.provider_symbol === symbol);
      expect(selected?.available).toBe(true);
      await center().getByLabel('来源', { exact: true }).selectOption(source);
      await center().getByLabel('搜索品种', { exact: true }).fill(symbol);
      const row = center().locator('tbody tr').filter({ hasText: selected.display_symbol || symbol });
      await expect(row).toHaveCount(1);
      await expect(row.getByRole('button', { name: '打开平台图表', exact: true })).toBeVisible();
      await page.screenshot({ path: path.join(art, 'platform-' + source + '.png') });
      await row.getByRole('button', { name: '打开平台图表', exact: true }).click();
      await expect.poll(() => !!center(), { timeout: 60000 }).toBeFalsy();
      expect((await host().evaluate(() => widget.activeChart().symbol())).toLowerCase()).toBe(('MWP:' + selected.id).toLowerCase());
      expect(await host().evaluate(() => widget.activeChart().resolution())).toBe('60');
      await expect(native().getByRole('button', { name: '数据中心', exact: true })).toBeFocused();
      record(source + ' directory/filter and exact chart identity', { total: directory.total, symbol, id: selected.id });
      await native().getByRole('button', { name: '数据中心', exact: true }).click();
      await expect.poll(() => !!center()).toBeTruthy();
    }
    expect(report.errors).toEqual([]);
    report.passed = true;
  } catch (error) {
    report.errors.push(error.message);
    await page.screenshot({ path: path.join(art, 'platform-failed.png') }).catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(path.join(art, 'platform-report.json'), JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
