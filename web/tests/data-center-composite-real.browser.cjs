// Actual isolated Ubuntu management, mapping save and composite chart navigation.
const { chromium, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..'), artifacts = path.join(root, 'artifacts/data-integration');
const base = process.env.MW_CENTER_URL || 'http://127.0.0.1:16629';
const credentials = JSON.parse(fs.readFileSync(path.join(artifacts, 'three-layer-login.json')));
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], writes = [], checks = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.method() === 'POST') writes.push(new URL(r.url()).pathname); });
  try {
    await page.goto(base + '/market-data?tab=composite');
    await page.getByLabel('管理员密码').fill(credentials.password);
    await page.getByRole('button', { name: '登录工作台' }).click();
    await expect(page.getByRole('heading', { name: '数据中心', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '已建立组合', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '可建立候选', exact: true }).click();
    await expect(page.getByRole('columnheader', { name: '需求与状态', exact: true })).toBeVisible();
    const data = await (await page.request.get(base + '/api/market-data/center/datasets?status=available&source=oanda')).json();
    const dataset = data.items.find(r => r.logical_symbol === 'EURUSD' && r.aggregation_calendar === 'ny17');
    expect(dataset).toBeTruthy();
    expect(writes.filter(p => p !== '/api/login')).toEqual([]);
    checks.push('list/candidate navigation creates no demand or composite');
    await page.goto(base + `/market-data/datasets/${dataset.id}/mapping`);
    for (const width of [1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
    }
    await page.setViewportSize({ width: 1024, height: 1000 });
    await page.evaluate(() => document.querySelector('.data-center').style.zoom = '2');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
    await page.evaluate(() => document.querySelector('.data-center').style.zoom = '');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByLabel('查找目标准确品种').fill('EUR_USD');
    const select = page.getByLabel('目标准确品种（OANDA Practice）');
    await expect(select.locator('option')).toHaveCount(2);
    const catalogId = await select.locator('option').last().getAttribute('value');
    expect(catalogId.startsWith('HC:')).toBeTruthy();
    await select.selectOption(catalogId);
    await page.getByLabel('标的代码', { exact: true }).fill('EUR');
    await page.getByLabel('报价币种', { exact: true }).fill('USD');
    await page.getByLabel('历史产品官方依据').fill('https://developer.oanda.com/rest-live-v20/instrument-ep/');
    await page.getByLabel('匹配复核说明').fill('Explicit EUR_USD Bid to EUR_USD Bid mapping in the same scoped Practice account');
    await page.getByLabel('已核对标的、币种、产品类型及Bid口径，接受两来源原价差异。').check();
    const saving = page.waitForResponse(r => r.url().endsWith(`/datasets/${dataset.id}/mappings`) && r.request().method() === 'POST');
    await page.getByRole('button', { name: '保存映射版本', exact: true }).click();
    expect((await saving).status()).toBe(201);
    await expect(page.getByRole('heading', { name: '数据中心', exact: true })).toBeVisible();
    expect(writes.filter(p => p.includes('/composites/use'))).toEqual([]);
    checks.push('exact scoped catalogue selection and real saved mapping without live side effects');
    const opening = page.waitForResponse(r => r.url().endsWith('/composites/use') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '打开组合行情', exact: true }).first().click();
    const response = await opening, composite = await response.json();
    expect(response.status()).toBe(201);
    await expect(page.getByRole('heading', { name: 'EURUSD 组合行情', exact: true })).toBeVisible();
    await expect(page.getByRole('img', { name: /K 线图/ })).toBeVisible({ timeout: 45000 });
    await expect(page.getByRole('columnheader', { name: '来源确认', exact: true })).toBeVisible();
    await page.getByLabel('周期', { exact: true }).focus();
    await expect(page.getByLabel('周期', { exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: '更早历史', exact: true })).toBeFocused();
    await page.getByLabel('周期', { exact: true }).selectOption('H4');
    await expect(page.getByRole('img', { name: /K 线图/ })).toBeVisible();
    checks.push('first-use command, actual fixed composite chart, H4 and separate confirmation/coverage facts');
    await page.getByRole('button', { name: '接续与修订', exact: true }).click();
    await expect(page.getByRole('heading', { name: '固定分段归属', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '补数请求记录', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '使用与健康', exact: true }).click();
    await expect(page.getByText(/暂无策略，不代表策略已就绪/)).toBeVisible();
    for (const section of ['概览', '打开组合图表', '接续与修订', '使用与健康']) {
      await page.getByRole('button', { name: section, exact: true }).click();
      if (section === '打开组合图表') await expect(page.getByRole('img', { name: /K 线图/ })).toBeVisible();
      for (const width of [1024, 1440, 1920]) {
        await page.setViewportSize({ width, height: 1000 });
        const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
        expect(layout.scroll).toBeLessThanOrEqual(layout.width + 2);
      }
      await page.setViewportSize({ width: 1024, height: 1000 });
      await page.evaluate(() => document.querySelector('.data-center').style.zoom = '2');
      const zoomLayout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
        overflow: [...document.querySelectorAll('.data-center > *, .chart-wrap, .chart')].map(e => ({
          tag: e.tagName, className: e.className, width: e.getBoundingClientRect().width,
          right: e.getBoundingClientRect().right })).filter(e => e.right > innerWidth + 2) }));
      expect(zoomLayout.scroll, JSON.stringify({ section, ...zoomLayout })).toBeLessThanOrEqual(zoomLayout.width + 2);
      await page.evaluate(() => document.querySelector('.data-center').style.zoom = '');
      await page.screenshot({ path: path.join(artifacts, `composite-center-${section}.png`), fullPage: true });
    }
    checks.push('mapping and all detail desktop widths, 200% content zoom, keyboard control and explicit no-strategy health');
    await page.goto(base + '/market-data?tab=composite');
    const final = { environment: 'Ubuntu market-watch-three-layer', base, composite_id: composite.id, dataset_id: dataset.id, checks, errors, writes, passed: errors.length === 0 };
    fs.writeFileSync(path.join(artifacts, 'composite-center-browser-real.json'), JSON.stringify(final, null, 2));
    expect(errors).toEqual([]);
    console.log(JSON.stringify({ passed: true, checks: checks.length }));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
