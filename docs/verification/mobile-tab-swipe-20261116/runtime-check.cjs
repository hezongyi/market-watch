// Read-only checks on the task's Ubuntu Docker acceptance instance.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium, expect } = require('../../../web/node_modules/@playwright/test');
const { swipeContent, verifySwipeTabs } = require('../../../web/tests/mobile-tab-swipe.helper.cjs');
const base = 'https://127.0.0.1:18447';
const output = __dirname;
(async () => {
  const browser = await chromium.launch();
  const proof = { host: 'Ubuntu local Docker', url: 'https://192.168.7.232:18447/m/data', errors: [], blockedWrites: [], checks: [], screenshots: [] };
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    const credentials = JSON.parse(fs.readFileSync('/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/credentials.json'));
    assert((await context.request.post(base + '/api/login', { data: { password: credentials.login_password } })).ok());
    await context.route('**/api/**', route => {
      const request = route.request(), url = new URL(request.url());
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) || /\/api\/(?:market-stream|charts\/stream|market-data\/(?:quotes|sparklines|resolve|live\/demand))/.test(url.pathname)) return route.continue();
      proof.blockedWrites.push({ path: url.pathname, method: request.method() });
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => proof.errors.push(error.message));
    async function shot(name) {
      await page.waitForTimeout(400);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name + ' overflow');
      await page.screenshot({ path: path.join(output, name + '.png') });
      proof.screenshots.push(name + '.png');
    }
    await page.goto(base + '/m/data');
    await expect(page.locator('.data-managed-row').first()).toBeVisible();
    const data = page.locator('.data-category-tabs');
    await verifySwipeTabs({ page, context, root: data, full: true });
    const categories = await data.getByRole('tab').allTextContents();
    for (let index = 1; index < categories.length; index++) {
      await swipeContent(page, context, data, -100);
      await expect(data.getByRole('tab').nth(index)).toHaveAttribute('aria-selected', 'true');
    }
    await swipeContent(page, context, data, -100);
    await expect(data.getByRole('tab').last()).toHaveAttribute('aria-selected', 'true');
    proof.checks.push({ action: 'all actual categories reachable by swipe; no wrap', categories });
    await data.getByRole('tab').first().click();
    for (const theme of ['light', 'dark']) for (const width of [375, 412]) for (const font of [14, 21]) {
      await page.getByRole('link', { name: '更多', exact: true }).click();
      if (await page.locator('.mobile-app').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: /显示主题/ }).click();
      await page.getByRole('link', { name: '数据', exact: true }).click();
      await page.setViewportSize({ width, height: 880 });
      await page.evaluate(font => document.documentElement.style.fontSize = font + 'px', font);
      await verifySwipeTabs({ page, context, root: data });
      await shot(`data-${theme}-${width}-${font}`);
    }
    proof.checks.push('375/412px, light/dark, 100%/150% text real-touch swipe matrix');
    await page.setViewportSize({ width: 412, height: 915 });
    await page.evaluate(() => document.documentElement.style.fontSize = '14px');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await verifySwipeTabs({ page, context, root: data });
    proof.checks.push('reduced motion gesture, click and keyboard alternatives');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.getByRole('link', { name: '告警', exact: true }).click();
    await verifySwipeTabs({ page, context, root: page.locator('.alert-main-tabs'), full: true });
    await swipeContent(page, context, page.locator('.alert-main-tabs'), -100);
    await shot('alerts-records');
    await page.getByRole('button', { name: '异常/恢复', exact: true }).click();
    const records = page.getByRole('dialog', { name: '事件记录', exact: true });
    await expect(records).toBeVisible();
    await page.waitForTimeout(400);
    await verifySwipeTabs({ page, context, root: records.locator('.mobile-record-tabs'), full: true });
    await shot('records-drawer');
    await records.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(records).toHaveCount(0);
    proof.checks.push('alert rules/records and event drawer category swipes; drawer stays open');
    await page.getByRole('link', { name: '自选', exact: true }).click();
    await page.getByRole('button', { name: '选择自选分组', exact: true }).click();
    await page.getByRole('button', { name: '管理自选', exact: true }).click();
    await page.waitForTimeout(400);
    await verifySwipeTabs({ page, context, root: page.locator('.watch-manage-tabs') });
    await shot('watch-management');
    await page.getByRole('dialog', { name: '管理自选', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    proof.checks.push('watch management swipes do not change data or mark form dirty');
    assert.deepEqual(proof.errors, []);
    assert.deepEqual(proof.blockedWrites, []);
    proof.passed = true;
  } finally {
    fs.writeFileSync(path.join(output, 'runtime-proof.json'), JSON.stringify(proof, null, 2) + '\n');
    await browser.close();
  }
  console.log(JSON.stringify(proof));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
