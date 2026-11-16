const assert = require('node:assert/strict');
module.exports = async ({ page, context, expect, shot, choose, close }) => {
  const checks = [];
  await page.setViewportSize({ width: 375, height: 812 });
  await page.evaluate(() => document.documentElement.style.fontSize = '14px');
  const scroll = page.locator('.mobile-alerts [data-slot="tabs-content"]:not([hidden]) .alert-list-scroll');
  const indicator = page.locator('.mobile-alerts .mobile-pull-refresh[data-refreshing]');
  const touch = await context.newCDPSession(page);
  async function pull(dy = 155, dx = 0) {
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 160, y: 180 }] });
    for (const portion of [0.2, 0.4, 0.6, 0.8, 1])
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 160 + dx * portion, y: 180 + dy * portion }] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  let gate, release, fail = false, calls = 0;
  const paths = ['**/api/chart-alerts/page?**', '**/api/chart-alerts/events/page?**'];
  const handler = async route => {
    calls++;
    if (gate) await gate;
    try {
      if (fail) return await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: '刷新测试失败' }) });
      await route.continue();
    } catch { /* tab/network changes can cancel a held read */ }
  };
  for (const pattern of paths) await page.route(pattern, handler);
  const hold = () => { gate = new Promise(resolve => release = resolve); };
  const unblock = () => { gate = undefined; release?.(); };
  async function filters(value) {
    await page.getByRole('button', { name: '搜索规则', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '搜索规则', exact: true });
    await dialog.getByRole('searchbox', { name: '搜索规则', exact: true }).fill('');
    await choose(dialog, '规则范围', value);
    await dialog.getByRole('button', { name: '查看规则', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  try {
    await filters('当前规则');
    await expect(page.locator('.alert-rule').first()).toBeVisible();
    await page.waitForTimeout(250);
    await scroll.evaluate(el => el.scrollTop = 0);
    const count = await page.locator('.alert-rule').count();
    hold(); await pull(); await expect(indicator).toBeVisible();
    await shot('pull-rules-refreshing');
    const during = calls;
    await pull(); assert.equal(calls, during, 'no duplicate pull while refreshing');
    unblock(); await expect(indicator).toHaveCount(0);
    await expect(page.locator('.alert-rule')).toHaveCount(count);
    await shot('pull-rules-settled');
    checks.push('real Chromium touch: slow rules refresh waits and retracts, retains rows, prevents duplicate pull');
    for (const [dy, dx] of [[50, 0], [150, 180]]) { await pull(dy, dx); await expect(indicator).toHaveCount(0); }
    await page.setViewportSize({ width: 375, height: 600 });
    await scroll.evaluate(el => el.scrollTop = 120);
    assert(await scroll.evaluate(el => el.scrollTop > 0));
    await pull(); await expect(indicator).toHaveCount(0);
    checks.push('short pull, horizontal gesture and non-top scroll do not refresh');
    await page.setViewportSize({ width: 375, height: 812 });
    await scroll.evaluate(el => el.scrollTop = 0);
    fail = true; await pull();
    await expect(page.locator('.alert-read-error')).toBeVisible();
    await expect(indicator).toHaveCount(0);
    await expect(page.locator('.alert-rule')).toHaveCount(count);
    await shot('pull-rules-failed');
    fail = false; await pull();
    await expect(page.locator('.alert-read-error')).toHaveCount(0);
    await expect(indicator).toHaveCount(0);
    checks.push('failure retracts, keeps rules and shows inline error; next pull recovers');
    await filters('已归档');
    await expect(page.locator('.alert-rule').first()).toBeVisible();
    await page.waitForTimeout(250);
    hold(); await pull(); await expect(indicator).toBeVisible();
    unblock(); await expect(indicator).toHaveCount(0);
    await expect(page.locator('.alert-query')).toContainText('已归档');
    checks.push('archived refresh uses archived endpoint and retains filter');
    await filters('当前规则');
    await page.getByRole('tab', { name: '事件记录', exact: true }).click();
    await expect(page.locator('.alert-event-row').first()).toBeVisible();
    await page.waitForTimeout(300);
    const search = page.getByRole('searchbox', { name: '搜索触发记录', exact: true });
    await search.fill('EURUSD');
    await scroll.evaluate(el => el.scrollTop = 0);
    hold(); await pull(); await expect(indicator).toBeVisible();
    await shot('pull-records-refreshing');
    unblock(); await expect(indicator).toHaveCount(0);
    assert.equal(await search.inputValue(), 'EURUSD');
    await expect(page.locator('.alert-event-row').first()).toBeVisible();
    checks.push('record refresh awaits actual paginated read and preserves search');
    await scroll.evaluate(el => el.scrollTop = 0);
    hold(); await pull(); await expect(indicator).toBeVisible();
    await page.getByRole('tab', { name: '规则', exact: true }).click();
    await expect(indicator).toHaveCount(0);
    unblock(); await page.waitForTimeout(200); await expect(indicator).toHaveCount(0);
    checks.push('view switch retracts; late completion does not reopen indicator');
    await scroll.evaluate(el => el.scrollTop = 0);
    hold(); await pull(); await expect(indicator).toBeVisible();
    await context.setOffline(true); await expect(indicator).toHaveCount(0);
    unblock(); await pull(); await expect(indicator).toHaveCount(0);
    const resumed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/chart-alerts/page');
    await context.setOffline(false); await (await resumed).finished(); await page.waitForTimeout(300);
    checks.push('offline immediately retracts and disables gesture; reconnect remains usable');
    await scroll.evaluate(el => el.scrollTop = 0);
    hold(); await pull(); await expect(indicator).toBeVisible();
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    await expect(indicator).toHaveCount(0); unblock();
    await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(300);
    checks.push('background retracts; foreground reads resume');
    await page.getByRole('button', { name: '搜索规则', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '搜索规则', exact: true });
    await expect(dialog).toBeVisible(); await expect(indicator).toHaveCount(0); await close(dialog);
    checks.push('drawer does not leave underlying refresh active');
    await shot('pull-final');
    return checks;
  } finally {
    unblock(); await context.setOffline(false);
    for (const pattern of paths) await page.unroute(pattern, handler);
    await touch.detach();
  }
};
