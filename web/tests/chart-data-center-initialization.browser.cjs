const { expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('./chart-data-center-fixture.cjs');
const { base, art } = fixture;
const report = { environment: 'Ubuntu Docker; injected first native save conflict', passed: false, checks: [], errors: [] };

(async () => {
  const browser = await fixture.launch();
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const { native, center } = fixture.frames(page);
  let workspace;
  try {
    await page.goto(base + '/market-data');
    await fixture.login(page);
    await expect.poll(() => !!center(), { timeout: 30000 }).toBeTruthy();
    const session = await (await page.request.get(base + '/api/session')).json();
    const response = await page.request.post(base + '/api/advanced-charts/workspaces', {
      data: { name: '初始化失败恢复验收' }, headers: { 'X-CSRF-Token': session.csrf },
    });
    expect(response.ok()).toBeTruthy();
    workspace = await response.json();
    await page.route('**/api/advanced-charts/workspaces?limit=1', route => route.fulfill({ json: [workspace] }));
    let failed = false;
    await page.route('**/api/advanced-charts/native-charts/save', async route => {
      if (!failed) {
        failed = true;
        await route.fulfill({ status: 409, json: { detail: '验收注入：工作区版本已改变' } });
      } else await route.continue();
    });
    await page.goto(base + '/market-data?tab=sources');
    await expect.poll(() => failed, { timeout: 30000 }).toBeTruthy();
    await expect.poll(() => !!native()).toBeTruthy();
    await expect(native().getByRole('button', { name: '数据中心', exact: true })).toBeVisible({ timeout: 5000 });
    await expect.poll(() => !!center(), { timeout: 10000 }).toBeTruthy();
    await expect(center().getByRole('heading', { name: '来源与能力', exact: true })).toBeVisible();
    await center().getByRole('button', { name: '关闭数据中心' }).click();
    await expect(native().getByRole('button', { name: '数据中心', exact: true })).toBeFocused();
    await native().getByRole('button', { name: '否', exact: true }).click();
    await expect(native().getByText(/工作区初始化失败/)).toBeVisible();
    const notices = await native().locator('body').innerText();
    expect(notices).toContain('工作区初始化失败');
    expect(notices).toContain('工作区版本已改变');
    expect(notices).not.toContain('[object Object]');
    report.checks.push({ name: 'first native save failure retains management toolbar, precise error and draft recovery', workspace: workspace.id });
    report.passed = true;
  } catch (error) {
    report.errors.push(error.message);
    await page.screenshot({ path: path.join(art, 'initialization-failed.png') }).catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(path.join(art, 'initialization-report.json'), JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
