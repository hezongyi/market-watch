const { expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('./chart-data-center-fixture.cjs');
const { art, base } = fixture;
const report = { environment: 'Ubuntu isolated Docker; native chart with deterministic slow validation/candle requests',
  project: 'mw-data-center-review-20261008', passed: false, checks: [], errors: [] };

(async () => {
  const browser = await fixture.launch();
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(() => {
    window.dcOpeningCommands = [];
    window.dcOpeningHolding = false;
    addEventListener('message', event => {
      if (window.dcOpeningHolding && event.data?.channel === 'mw-data-center-v1' && event.data.type === 'apply') {
        event.stopImmediatePropagation();
        window.dcOpeningCommands.push({ data: event.data, source: event.source, origin: event.origin });
      }
    });
  });
  const { host, native, center } = fixture.frames(page);
  page.on('pageerror', error => report.errors.push(error.message));
  const record = (name, data = {}) => { report.checks.push({ name, ...data }); console.log('PASS', name, data); };
  let release;
  let held = new Promise(resolve => { release = resolve; });
  let blocked = false;
  const candles = /\/api\/charts\/(?:data|reserve|history-loads)(?:\/|\?|$)/;
  const slow = async route => {
    blocked = true;
    await held;
    await route.continue().catch(() => {});
  };
  try {
    await page.goto(base + '/market-data?tab=platform&source=yahoo&query=');
    await fixture.login(page);
    await expect.poll(() => !!center() && !!native(), { timeout: 30000 }).toBeTruthy();
    await expect(center().getByRole('heading', { name: '平台品种', exact: true })).toBeVisible();
    const buttons = center().getByRole('button', { name: '打开平台图表', exact: true });
    await expect.poll(() => buttons.count()).toBeGreaterThan(1);
    const originalCount = await buttons.count();
    // Hold only the command acknowledgement to inspect the React list state.
    await host().evaluate(() => { window.dcOpeningHolding = true; });
    await page.route('**/api/market-data/resolve', slow);
    await page.route(candles, slow);
    const clickedAt = Date.now();
    await buttons.first().click();
    // State must belong to one selected row, even before command acceptance.
    await expect(center().getByRole('button', { name: '正在打开…', exact: true })).toHaveCount(1);
    expect(await buttons.count()).toBe(originalCount - 1);
    await expect(center().getByRole('button', { name: '正在打开…', exact: true })).toHaveAttribute('aria-busy', 'true');
    expect(await buttons.evaluateAll(nodes => nodes.every(node => !node.disabled))).toBeTruthy();
    await buttons.first().evaluate(button => { button.click(); button.click(); });
    await expect.poll(() => host().evaluate(() => window.dcOpeningCommands.length)).toBe(1);
    record('only selected row changes; other labels/style remain and rapid duplicate clicks are ignored', { originalCount });
    await host().evaluate(() => {
      window.dcOpeningHolding = false;
      for (const command of window.dcOpeningCommands) dispatchEvent(new MessageEvent('message', command));
    });
    await expect.poll(() => !!center(), { timeout: 1500, intervals: [50, 100] }).toBeFalsy();
    record('dialog closes before the held source responds', { closeMs: Date.now() - clickedAt, blocked });
    await expect(native().getByRole('button', { name: '数据中心', exact: true })).toBeFocused();
    await expect(native().locator('.mw-data-center-load')).toHaveAttribute('role', 'status');
    await expect.poll(() => blocked).toBeTruthy();
    release();
    await page.unroute('**/api/market-data/resolve', slow);
    await page.unroute(candles, slow);
    await expect.poll(() => host().evaluate(() => widget.activeChart().dataReady()), { timeout: 60000 }).toBeTruthy();
    await expect(native().locator('.mw-data-center-load')).toHaveCount(0, { timeout: 60000 });
    record('loading feedback stays on the chart and clears after the native callback');
    // Separately hold candles while allowing the source metadata to resolve.
    blocked = false;
    held = new Promise(resolve => { release = resolve; });
    await native().getByRole('button', { name: '数据中心', exact: true }).click();
    await expect.poll(() => !!center()).toBeTruthy();
    await center().getByLabel('搜索品种', { exact: true }).fill('MSFT');
    await expect(center().locator('tbody strong')).toHaveText('MSFT');
    await page.route(candles, slow);
    const candleClick = Date.now();
    await center().getByRole('button', { name: '打开平台图表', exact: true }).click();
    await expect.poll(() => !!center(), { timeout: 1500, intervals: [50, 100] }).toBeFalsy();
    const candleCloseMs = Date.now() - candleClick;
    await expect.poll(() => blocked, { timeout: 30000 }).toBeTruthy();
    await expect(native().locator('.mw-data-center-load')).toContainText('正在加载');
    expect(await host().evaluate(() => widget.activeChart().dataReady())).toBe(false);
    await page.screenshot({ path: path.join(art, 'opening-candles-dark.png') });
    record('slow candles load behind the closed dialog with visible chart feedback', { closeMs: candleCloseMs });
    await expect(native().locator('.mw-data-center-load')).toHaveAttribute('role', 'alert', { timeout: 25000 });
    await expect(native().locator('.mw-data-center-load')).toContainText('可继续操作图表或重试');
    await native().locator('.mw-data-center-load').getByRole('button', { name: '重试', exact: true }).click();
    await expect(native().locator('.mw-data-center-load')).toHaveAttribute('role', 'status');
    record('long load explains the wait and retry stays on the chart without reopening data center');
    release(); await page.unroute(candles, slow);
    await expect(native().locator('.mw-data-center-load')).toHaveCount(0, { timeout: 60000 });
    expect(report.errors).toEqual([]);
    report.passed = true;
  } catch (error) {
    report.errors.push(error.message);
    await page.screenshot({ path: path.join(art, 'opening-failed.png') }).catch(() => {});
    throw error;
  } finally {
    release();
    fs.writeFileSync(path.join(art, 'opening-report.json'), JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
