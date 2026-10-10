const { expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('./chart-data-center-fixture.cjs');
const { art, base } = fixture;
const report = { environment: 'Ubuntu isolated Docker; native multi-chart API, delayed/failed source fixtures',
  project: 'mw-data-center-review-20261008', passed: false, checks: [], errors: [] };

(async () => {
  const browser = await fixture.launch();
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const { host, native, center } = fixture.frames(page);
  page.on('pageerror', error => { report.errors.push(error.stack || error.message); console.log('PAGEERROR', error.stack || error.message); });
  const record = (name, data = {}) => { report.checks.push({ name, ...data }); console.log('PASS', name, data); };
  const open = async () => {
    await native().getByRole('button', { name: '数据中心', exact: true }).click();
    await expect.poll(() => !!center()).toBeTruthy();
    await expect(center().getByRole('heading', { name: '平台品种', exact: true })).toBeVisible();
    await expect(center().getByRole('button', { name: '打开平台图表', exact: true })).toBeVisible();
  };
  const close = async () => {
    await center().getByRole('button', { name: '关闭数据中心' }).click();
    await expect.poll(() => !!center()).toBeFalsy();
  };
  const snapshot = () => host().evaluate(() => ({ symbols: Array.from({ length: widget.chartsCount() }, (_, i) => widget.chart(i).symbol()),
    resolutions: Array.from({ length: widget.chartsCount() }, (_, i) => widget.chart(i).resolution()), active: widget.activeChartIndex() }));
  let release = () => {};
  try {
    await page.goto(base + '/market-data?tab=platform&source=yahoo&query=MSFT');
    await fixture.login(page);
    await expect.poll(() => !!center() && !!native(), { timeout: 30000 }).toBeTruthy();
    await expect(center().getByRole('button', { name: '打开平台图表', exact: true })).toBeVisible();
    const directory = await (await page.request.get(base + '/api/market-data/center/platform?source=yahoo&query=MSFT')).json();
    const ticker = 'MWP:' + directory.items[0].id;
    // A stale target is refused before acknowledgement and retains its list.
    await host().evaluate(() => widget.setLayout('2h'));
    await expect.poll(() => host().evaluate(() => widget.chartsCount())).toBe(2);
    await center().getByRole('button', { name: '打开平台图表', exact: true }).click();
    await expect(center().locator('.dc-window-content > [role=alert]')).toContainText('目标图格');
    await expect(center().getByRole('button', { name: '打开平台图表', exact: true })).toHaveAttribute('aria-disabled', 'false');
    await close();
    record('stale layout is rejected before closing the dialog; selected action resets');

    await host().evaluate(() => widget.changeTheme('Light'));
    await open();
    const original = await snapshot();
    const fail = route => route.fulfill({ status: 503, json: { detail: '验收注入：来源暂不可用' } });
    await page.route('**/api/market-data/resolve', fail);
    await center().getByRole('button', { name: '打开平台图表', exact: true }).click();
    await expect.poll(() => !!center(), { timeout: 1500 }).toBeFalsy();
    const notice = native().locator('.mw-data-center-load');
    await expect(notice).toHaveAttribute('role', 'alert');
    await expect(notice).toContainText('来源暂不可用');
    await expect(notice).not.toContainText('ApiError');
    await expect(notice).toHaveAttribute('data-theme', 'light');
    expect(await snapshot()).toEqual(original);
    await page.screenshot({ path: path.join(art, 'opening-source-error-light.png') });
    await page.unroute('**/api/market-data/resolve', fail);
    await notice.getByRole('button', { name: '重试', exact: true }).click();
    await expect.poll(() => host().evaluate(() => widget.activeChart().symbol().toLowerCase()), { timeout: 30000 }).toBe(ticker.toLowerCase());
    await expect(notice).toHaveCount(0, { timeout: 60000 });
    expect(!!center()).toBeFalsy();
    record('source failure is shown on the chart; retry succeeds without reopening the dialog');

    await host().evaluate(() => widget.changeTheme('Dark'));
    await open();
    await expect(center().getByLabel('搜索品种', { exact: true })).toHaveValue('MSFT');
    let blocked = false;
    const held = new Promise(resolve => { release = resolve; });
    const slow = async route => { blocked = true; await held; await route.continue().catch(() => {}); };
    await page.route('**/api/market-data/resolve', slow);
    await center().getByRole('button', { name: '打开平台图表', exact: true }).click();
    await expect.poll(() => !!center(), { timeout: 1500 }).toBeFalsy();
    await expect.poll(() => blocked).toBeTruthy();
    const activeBefore = await host().evaluate(() => widget.activeChartIndex());
    await host().evaluate(index => widget.setActiveChart(index), 1 - activeBefore);
    const switched = await snapshot();
    release(); await page.unroute('**/api/market-data/resolve', slow);
    await expect(notice).toHaveCount(0);
    // The held validation settles; it must not apply to the newly active chart.
    await host().evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));
    expect(await snapshot()).toEqual(switched);
    record('changing active chart cancels delayed validation without replacing the newer target');

    await open();
    await host().evaluate(() => { widget.symbolSync().setValue(true); widget.intervalSync().setValue(true); });
    const before = await snapshot();
    await center().getByRole('button', { name: '打开平台图表', exact: true }).click();
    await expect.poll(() => !!center(), { timeout: 1500 }).toBeFalsy();
    await expect.poll(() => host().evaluate(() => widget.activeChart().symbol().toLowerCase()), { timeout: 30000 }).toBe(ticker.toLowerCase());
    await expect.poll(() => host().evaluate(() => widget.activeChart().resolution())).toBe('60');
    await expect(notice).toHaveCount(0, { timeout: 60000 });
    const after = await snapshot();
    expect(after.symbols[1 - before.active]).toBe(before.symbols[1 - before.active]);
    expect(after.resolutions[1 - before.active]).toBe(before.resolutions[1 - before.active]);
    expect(await host().evaluate(() => [widget.symbolSync().value(), widget.intervalSync().value()])).toEqual([false, false]);
    record('symbol/period command affects only captured chart with both sync locks initially enabled');

    await open();
    await host().evaluate(() => {
      const chart = widget.activeChart();
      window.dcOpeningOriginal = chart.setSymbol;
      window.dcOpeningCallback = null;
      chart.setSymbol = function(...args) {
        return new Promise((resolve, reject) => {
          Promise.resolve(window.dcOpeningOriginal.apply(chart, args)).then(result => {
            window.dcOpeningCallback = () => resolve(result);
          }, reject);
        });
      };
    });
    await center().getByLabel('搜索品种', { exact: true }).fill('AAPL');
    await expect(center().locator('tbody strong')).toHaveText('AAPL');
    await center().getByRole('button', { name: '打开平台图表', exact: true }).click();
    await expect.poll(() => !!center(), { timeout: 1500 }).toBeFalsy();
    await expect.poll(() => host().evaluate(() => !!window.dcOpeningCallback), { timeout: 60000 }).toBeTruthy();
    const lateBefore = await snapshot();
    await host().evaluate(() => { workspaceEpoch++; window.dcOpeningCallback(); widget.activeChart().setSymbol = window.dcOpeningOriginal; });
    await expect(notice).toHaveCount(0);
    expect(await snapshot()).toEqual(lateBefore);
    record('late native callback cannot re-open a dialog or advance an older workspace command');
    await open();
    await center().getByLabel('搜索品种', { exact: true }).fill('TSLA');
    await expect(center().locator('tbody strong')).toHaveText('TSLA');
    await host().evaluate(() => {
      const chart = widget.activeChart();
      window.dcOpeningOriginal = chart.setSymbol;
      window.dcOpeningCallback = null;
      chart.setSymbol = function(...args) {
        return new Promise((resolve, reject) => {
          Promise.resolve(window.dcOpeningOriginal.apply(chart, args)).then(result => {
            window.dcOpeningCallback = () => resolve(result);
          }, reject);
        });
      };
    });
    await center().getByRole('button', { name: '打开平台图表', exact: true }).click();
    await expect.poll(() => !!center(), { timeout: 1500 }).toBeFalsy();
    await expect.poll(() => host().evaluate(() => !!window.dcOpeningCallback), { timeout: 60000 }).toBeTruthy();
    await host().evaluate(async () => {
      await widget.activeChart().setResolution('15', { doNotActivateChart: true });
      window.dcOpeningCallback(); widget.activeChart().setSymbol = window.dcOpeningOriginal;
    });
    await expect(notice).toHaveCount(0);
    expect(await host().evaluate(() => widget.activeChart().resolution())).toBe('15');
    record('a newer user period survives the late symbol callback without reverting to requested H1');
    expect(report.errors).toEqual([]);
    report.passed = true;
  } catch (error) {
    report.errors.push(error.message);
    await page.screenshot({ path: path.join(art, 'opening-guards-failed.png') }).catch(() => {});
    throw error;
  } finally {
    release();
    fs.writeFileSync(path.join(art, 'opening-guards-report.json'), JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
