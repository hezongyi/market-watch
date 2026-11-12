// Real development deployment: no fixture writes or external notifications.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium, expect } = require('@playwright/test');

(async () => {
  const credentials = JSON.parse(fs.readFileSync(process.env.MW_ACCEPTANCE_CREDENTIALS_FILE));
  const base = credentials.base_url;
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const errors = [], failedResources = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (response.status() >= 400 && /\/(?:charting_library_|chart\.|chart-assets\.json|data-center-native)/.test(response.url())) {
      failedResources.push({ status: response.status(), url: response.url() });
    }
  });
  try {
    await page.goto(base);
    await page.getByLabel('管理员密码').fill(credentials.login_password);
    const loginResult = page.waitForResponse(response => response.url().endsWith('/api/login') && response.status() === 200);
    await page.getByRole('button', { name: /登录并/ }).click();
    const csrf = (await (await loginResult).json()).csrf;
    await expect(page).toHaveURL(/advanced-charts/);
    const manifestResponse = await context.request.get(base + '/chart-assets.json');
    assert.equal(manifestResponse.status(), 200);
    const manifest = await manifestResponse.json();
    for (const asset of [manifest.script, manifest.libraryDirectory + '/charting_library.js']) {
      const response = await context.request.get(base + '/' + asset);
      assert.equal(response.status(), 200, asset + ' must be reachable inside the deployed container');
      assert.match(response.headers()['content-type'], /javascript/);
    }
    await expect.poll(() => page.frames().filter(frame => frame.url().startsWith('blob:')).length, { timeout: 60000 }).toBe(1);
    const chart = page.frames().find(frame => frame.url().startsWith('blob:'));
    await expect(chart.getByRole('button', { name: '数据中心', exact: true })).toBeVisible({ timeout: 30000 });
    // Saved workspaces can receive their initial bars through SSE. Verify
    // visible OHLC below and independently read the same live provider.
    const search = await context.request.get(base + '/api/market-data/series/search?kind=provider&query=USDJPY&source=oanda&limit=25');
    const catalog = await search.json();
    const instrument = (Array.isArray(catalog) ? catalog : catalog.items).find(row => row.source === 'oanda' && row.available !== false);
    assert.ok(instrument);
    const data = await context.request.post(base + '/api/charts/data', { headers: { 'x-csrf-token': csrf }, data: { instrument: instrument.id, series_kind: 'provider', timeframe: 'H1', limit: 40, firstDataRequest: true } });
    assert.equal(data.status(), 200);
    const bars = (await data.json()).bars.length;
    assert.ok(bars > 0);
    await expect(chart.getByText('开=', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await chart.getByRole('button', { name: '数据中心', exact: true }).click();
    await expect(chart.locator('[data-name="mw-data-center-dialog"]')).toBeVisible({ timeout: 30000 });
    await chart.locator('[data-name="mw-data-center-dialog"]').press('Escape');
    const healthResponse = await context.request.get(base + '/api/health');
    assert.equal(healthResponse.status(), 200, 'authenticated health endpoint');
    const health = await healthResponse.json();
    const runtime = Object.fromEntries(['market_runtime', 'data_runtime', 'notification_runtime'].map(group => [group,
      health[group].map(row => ({ role: row.role, state: row.state, error: row.error_type }))]));
    for (const rows of Object.values(runtime)) {
      assert.ok(rows.length > 0);
      for (const row of rows) {
        assert.ok(!['missing', 'stale', 'degraded', 'failed'].includes(row.state), JSON.stringify(row));
        assert.ok(!row.error, JSON.stringify(row));
      }
    }
    assert.deepEqual(failedResources, []);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ base_url: base, chart: true, bars, data_center: true, health: 200, runtime, errors, failedResources }, null, 2));
    if (process.env.MW_SCREENSHOT_FILE) await page.screenshot({ path: process.env.MW_SCREENSHOT_FILE });
  } finally {
    await context.close();
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
