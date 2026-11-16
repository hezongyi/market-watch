// Ubuntu acceptance instance only; block business writes while exercising real built UI.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium, expect } = require('@playwright/test');
const { swipeContent, verifySwipeTabs } = require('./mobile-tab-swipe.helper.cjs');
const origin = process.env.MOBILE_ORIGIN, privateDir = process.env.MOBILE_PRIVATE_DIR;
assert(origin && privateDir, 'Set MOBILE_ORIGIN and MOBILE_PRIVATE_DIR for the isolated Ubuntu instance');
const out = process.env.MOBILE_TAB_MOTION_OUTPUT || '/tmp/mw-mobile-tab-motion-real';
fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await chromium.launch();
  const proof = { host: 'Ubuntu local Docker', origin, device: 'Chromium touch emulation; Android device still requires acceptance', errors: [], blockedWrites: [], blockedMetadataRequests: [], checks: [], screenshots: [] };
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, serviceWorkers: 'block', locale: 'zh-CN' });
  try {
    const password = JSON.parse(fs.readFileSync(path.join(privateDir, 'credentials.json'))).login_password;
    assert((await context.request.post(origin + '/api/login', { data: { password } })).ok(), 'authenticated');
    await context.route('**/api/**', route => {
      const request = route.request(), url = new URL(request.url());
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) ||
          (request.method() === 'POST' && (/^\/api\/charts\/stream\/(subscribe|unsubscribe|accept)$/.test(url.pathname) || /^\/api\/market-data\/(quotes|sparklines)$/.test(url.pathname)))) return route.continue();
      const blocked = ['/api/market-data/resolve', '/api/market-data/sparklines/prepare'].includes(url.pathname) ? proof.blockedMetadataRequests : proof.blockedWrites;
      blocked.push({ method: request.method(), path: url.pathname });
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.on('pageerror', error => proof.errors.push(error.message));
    const shot = async name => { await page.waitForTimeout(600); await page.screenshot({ path: path.join(out, name + '.png') }); proof.screenshots.push(name + '.png'); };
    await page.goto(origin + '/m/data');
    const data = page.locator('.data-category-tabs');
    await expect(data.getByRole('tab')).not.toHaveCount(1);
    await verifySwipeTabs({ page, context, root: data, full: true });
    const tabs = data.getByRole('tab'), names = await tabs.allTextContents();
    for (let i = 1; i < names.length; i++) {
      await swipeContent(page, context, data, -100);
      await expect(tabs.nth(i)).toHaveAttribute('aria-selected', 'true');
    }
    await swipeContent(page, context, data, -100);
    await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
    proof.checks.push({ action: 'all actual categories reachable by touch; no looping', categories: names });
    for (const theme of ['light', 'dark']) for (const width of [375, 412]) for (const font of [14, 21]) {
      await page.getByRole('link', { name: '更多', exact: true }).click();
      if (await page.locator('.mobile-app').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: /显示主题/ }).click();
      await page.getByRole('link', { name: '数据', exact: true }).click();
      await page.setViewportSize({ width, height: 880 });
      await page.evaluate(font => document.documentElement.style.fontSize = font + 'px', font);
      await tabs.first().click();
      await swipeContent(page, context, data, -100);
      await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
      await swipeContent(page, context, data, 100);
      await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no page overflow');
      await shot(`data-${theme}-${width}-${font}`);
    }
    // A revisited adjacent category must contain its own cached rows during drag.
    await swipeContent(page, context, data, -100, 4, true);
    await swipeContent(page, context, data, 100);
    proof.checks.push('375/412px, light/dark, 100%/150% text; follow-finger frames, visible adjacent panels, short return, cancel/multi/edge/diagonal, rapid clicks, keyboard and reduced motion');
    await page.evaluate(() => document.documentElement.style.fontSize = '14px');
    await page.getByRole('link', { name: /告警/ }).click();
    await verifySwipeTabs({ page, context, root: page.locator('.alert-main-tabs'), full: true });
    await page.getByRole('tab', { name: '事件记录', exact: true }).click();
    await shot('alerts-records');
    await page.getByRole('button', { name: '异常/恢复', exact: true }).click();
    const records = page.getByRole('dialog', { name: '事件记录', exact: true });
    await expect(records).toBeVisible();
    await verifySwipeTabs({ page, context, root: records.locator('.mobile-record-tabs'), full: true });
    await shot('records-drawer');
    await records.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(records).toHaveCount(0);
    proof.checks.push('alerts and event drawer swipes, drawer remains open; controls and nested dismissal preserved');
    // Metadata resolve is blocked too; no configuration or watchlist changes are allowed.
    await page.getByRole('link', { name: '自选', exact: true }).click();
    await page.getByRole('button', { name: '选择自选分组', exact: true }).click();
    await page.getByRole('button', { name: '管理自选', exact: true }).click();
    await verifySwipeTabs({ page, context, root: page.locator('.watch-manage-tabs'), full: true });
    await shot('watch-management');
    assert(await page.locator('[data-mobile-dirty="true"]').count() === 0, 'swiping management does not edit data');
    proof.checks.push('watch management follows finger, short return and rapid switching; no dirty form');
    assert.deepEqual(proof.errors, []);
    assert.deepEqual(proof.blockedWrites, [], 'no attempted business write');
    proof.passed = true;
    fs.writeFileSync(path.join(out, 'runtime-proof.json'), JSON.stringify(proof, null, 2) + '\n');
    console.log(JSON.stringify(proof, null, 2));
  } catch (error) {
    await context.pages()[0]?.screenshot({path:path.join(out, 'failure.png')});
    fs.writeFileSync(path.join(out, 'runtime-failure.json'), JSON.stringify(proof, null, 2));
    throw error;
  } finally { await context.close(); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
