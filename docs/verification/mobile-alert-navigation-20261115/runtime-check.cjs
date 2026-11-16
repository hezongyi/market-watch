// Read-only check of the deployed Ubuntu instance; auth is read from a private file.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium, expect } = require(path.resolve(__dirname, '../../../web/node_modules/@playwright/test'));
const base = 'https://127.0.0.1:18447', root = __dirname;
fs.mkdirSync(root + '/runtime', { recursive: true });
(async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 375, height: 880 }, isMobile: true, hasTouch: true });
    const credentials = JSON.parse(fs.readFileSync('/home/quant/.local/share/market-watch-docker/previews/mw-managed-live-rollover-20261113/credentials.json'));
    assert((await context.request.post(base + '/api/login', { data: { password: credentials.login_password } })).ok());
    const page = await context.newPage(), errors = [], writes = [], samples = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', route => {
      if (route.request().method() !== 'GET') {
        writes.push({ method: route.request().method(), path: new URL(route.request().url()).pathname });
        return route.abort();
      }
      return route.continue();
    });
    const style = async () => page.locator('.mobile-page-tabs-nav:visible').evaluate(nav => {
      const tab = nav.querySelector('[role="tab"][aria-selected="true"]');
      const css = getComputedStyle(tab), line = getComputedStyle(tab, '::after');
      return { fontSize: css.fontSize, fontWeight: css.fontWeight, color: css.color, minHeight: css.minHeight, paddingInline: css.paddingInline, height: tab.getBoundingClientRect().height, gap: getComputedStyle(tab.parentElement).gap, line: { height: line.height, bottom: line.bottom, left: line.left, right: line.right, color: line.backgroundColor, opacity: line.opacity }, border: getComputedStyle(nav).borderBottom };
    });
    const shot = async name => {
      await page.waitForTimeout(350);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: root + '/runtime/' + name + '.png' });
    };
    await page.goto(base + '/m/alerts');
    for (const theme of ['light', 'dark']) for (const width of [375, 412]) for (const font of [14, 21]) {
      await page.setViewportSize({ width, height: 880 });
      await page.evaluate(size => document.documentElement.style.fontSize = size + 'px', font);
      await page.getByRole('link', { name: '更多', exact: true }).click();
      if (await page.locator('.mobile-app').getAttribute('data-theme') !== theme)
        await page.getByRole('button', { name: /显示主题/ }).click();
      await page.getByRole('link', { name: /^告警/ }).click();
      await page.getByRole('tab', { name: '规则', exact: true }).click();
      const filter = page.locator('.alert-title').getByRole('button', { name: '筛选规则', exact: true });
      const plus = page.locator('.alert-title').getByRole('button', { name: '创建告警', exact: true });
      const f = await filter.boundingBox(), p = await plus.boundingBox();
      assert(f.width >= 44 && f.height >= 44 && f.x + f.width <= p.x && Math.abs(f.y - p.y) < 1);
      assert.equal((await filter.innerText()).trim(), '');
      const key = `${theme}-${width}-${font}`, alertStyle = await style();
      await shot('alerts-' + key);
      await filter.click();
      const dialog = page.getByRole('dialog', { name: '筛选规则', exact: true });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await page.getByRole('tab', { name: '事件记录', exact: true }).click();
      await expect(filter).toHaveCount(0);
      await expect(page.getByRole('button', { name: '异常/恢复', exact: true })).toBeVisible();
      await page.getByRole('tab', { name: '规则', exact: true }).click();
      await page.getByRole('link', { name: '数据', exact: true }).click();
      await expect(page.locator('.data-category-nav [role="tab"][aria-selected="true"]')).toBeVisible();
      await expect(page.locator('.data-managed-row').first()).toBeVisible({ timeout: 30000 });
      const dataStyle = await style();
      assert.deepEqual(alertStyle, dataStyle, 'matching navigation styles: ' + key);
      await shot('data-' + key);
      samples.push({ key, filter: f, create: p, style: alertStyle });
    }
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    fs.writeFileSync(root + '/runtime-proof.json', JSON.stringify({ passed: true, host: 'Ubuntu local Docker', project: 'mw-managed-live-rollover-20261113', readOnly: true, samples, screenshots: samples.length * 2, errors, writes }, null, 2));
    console.log(JSON.stringify({ passed: true, comparisons: samples.length, screenshots: samples.length * 2, errors, writes }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
