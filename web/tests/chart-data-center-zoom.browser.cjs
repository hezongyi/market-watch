const { chromium, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('./chart-data-center-fixture.cjs');
const { art, base } = fixture;
const extension = path.join(art, 'zoom-extension');
const report = { environment: 'Ubuntu Docker; Chrome tabs.setZoom real browser zoom; composite row-count layout fixture', passed: false, checks: [], errors: [] };

(async () => {
  fs.mkdirSync(extension, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Local acceptance zoom', version: '1.0', permissions: ['tabs'], background: { service_worker: 'worker.js' } }));
  fs.writeFileSync(path.join(extension, 'worker.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
  const context = await chromium.launchPersistentContext('', {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
    ignoreHTTPSErrors: true, viewport: null,
    args: ['--no-sandbox', '--window-size=1440,1000', '--disable-extensions-except=' + extension, '--load-extension=' + extension],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = context.pages()[0];
  page.on('pageerror', error => report.errors.push(error.message));
  const { host, native, center } = fixture.frames(page);
  const record = (name, data) => { console.log('PASS', name); report.checks.push({ name, ...data }); };
  const zoom = value => worker.evaluate(async ({ base, value }) => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url?.startsWith(base));
    await chrome.tabs.setZoom(tab.id, value);
    return chrome.tabs.getZoom(tab.id);
  }, { base, value });
  const compositePattern = /\/api\/market-data\/center\/(composites|composite-candidates)\?/;
  const fixtureRows = async route => {
    const seedUrl = new URL(route.request().url());
    seedUrl.searchParams.set('query', '');
    const response = await route.fetch({ url: seedUrl.href }), body = await response.json();
    expect(body.items.length).toBeGreaterThan(0);
    const seed = body.items[0];
    body.items = Array.from({ length: 25 }, (_, index) => 'dataset' in seed
      ? { ...seed, dataset: { ...seed.dataset, id: seed.dataset.id + '-' + index, logical_symbol: '组合候选布局验收-' + index } }
      : { ...seed, id: seed.id + '-' + index, logical_symbol: '已建立组合布局验收-' + index });
    body.total = 50;
    await route.fulfill({ json: body });
  };
  const closeFilters = async () => {
    const filter = center().getByRole('button', { name: '筛选与搜索', exact: true });
    if (await filter.isVisible()) {
      if (await filter.getAttribute('aria-expanded') !== 'true') await filter.click();
      await page.keyboard.press('Escape');
      await expect(filter).toHaveAttribute('aria-expanded', 'false');
      await expect(filter).toBeFocused();
      expect(!!center()).toBeTruthy();
    }
  };
  try {
    await page.goto(base + '/market-data?query=EURUSD&status=available');
    await fixture.login(page);
    await expect.poll(() => !!center(), { timeout: 30000 }).toBeTruthy();
    await center().getByRole('button', { name: '关闭数据中心' }).click();
    await page.route(compositePattern, fixtureRows);
    const session = await context.newCDPSession(page);
    const target = await session.send('Target.getTargetInfo');
    const { windowId } = await session.send('Browser.getWindowForTarget', { targetId: target.targetInfo.targetId });
    const screenshot = async name => {
      const shot = await session.send('Page.captureScreenshot', { format: 'png', fromSurface: false });
      fs.writeFileSync(path.join(art, name), Buffer.from(shot.data, 'base64'));
    };
    for (const width of [1024, 1440, 1920]) {
      await zoom(1);
      await session.send('Browser.setWindowBounds', { windowId, bounds: { width, height: 1000 } });
      expect(await zoom(2)).toBe(2);
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(Math.floor(width / 2));
      expect(await page.evaluate(() => devicePixelRatio)).toBe(2);
      await page.reload();
      await expect.poll(() => !!host() && !!native(), { timeout: 30000 }).toBeTruthy();
      await expect(native().getByRole('button', { name: '数据中心', exact: true })).toBeVisible({ timeout: 30000 });
      await native().getByRole('button', { name: '数据中心', exact: true }).click();
      await expect.poll(() => !!center()).toBeTruthy();
      await expect(center().getByRole('button', { name: '关闭数据中心' })).toBeInViewport();
      await center().getByRole('button', { name: '自建行情', exact: true }).click();
      const filter = center().getByRole('button', { name: '筛选与搜索', exact: true });
      if (await filter.isVisible()) await filter.click();
      await center().getByLabel('搜索品种', { exact: true }).fill('EURUSD');
      await center().getByRole('button', { name: '可用', exact: true }).click();
      if (await filter.isVisible()) await filter.click();
      const action = center().getByRole('button', { name: '在当前图表打开', exact: true }).first();
      await action.scrollIntoViewIfNeeded();
      await expect(action).toBeInViewport();
      expect(await center().evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
      await expect(center().getByRole('heading', { name: '自建行情', exact: true })).toBeInViewport();
      await expect(center().getByRole('navigation', { name: '列表分页' })).toBeInViewport();
      await closeFilters();
      await screenshot(`browser-zoom200-${width}.png`);
      // Switching with the previous filter open must not leave an empty overlay.
      if (await filter.isVisible()) await filter.click();
      await center().getByRole('button', { name: '组合行情', exact: true }).click();
      await expect.poll(() => center().locator('.dc-table tbody tr').count()).toBe(25);
      await expect(center().locator('.dc-filter-toggle')).toHaveCount(1);
      for (const mode of ['已建立组合', '可建立候选']) {
        const comboFilter = center().getByRole('button', { name: '筛选与搜索', exact: true });
        if (await comboFilter.isVisible() && await comboFilter.getAttribute('aria-expanded') !== 'true') await comboFilter.click();
        await center().getByRole('button', { name: mode, exact: true }).click();
        const search = center().getByLabel('搜索品种', { exact: true });
        await search.fill(mode === '已建立组合' ? '布局验收' : '');
        // Filtering within a section must retain input focus after rendering.
        await center().evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await expect(search).toBeFocused();
        await closeFilters();
        await expect(center().locator('.dc-table tbody tr').last().locator('td').first()).toContainText(`${mode === '已建立组合' ? '已建立组合' : '组合候选'}布局验收-24`);
        const table = center().locator('.dc-table');
        const heading = center().getByRole('heading', { name: '组合行情', exact: true });
        const before = await heading.boundingBox();
        await table.evaluate(element => { element.scrollTop = element.scrollHeight; });
        expect(await table.evaluate(element => element.scrollHeight > element.clientHeight && element.scrollTop > 0)).toBeTruthy();
        expect((await heading.boundingBox()).y).toBe(before.y);
        await expect(heading).toBeInViewport();
        await expect(center().getByRole('navigation', { name: '列表分页' })).toBeInViewport();
        expect(await center().evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
      }
      await screenshot(`browser-zoom200-composite-${width}.png`);
      await center().getByRole('button', { name: '关闭数据中心' }).click();
      await expect(native().getByRole('button', { name: '数据中心', exact: true })).toBeFocused();
      record('real 200% browser zoom retains native entry, primary actions and both composite lists at ' + width, { physicalWidth: width, cssWidth: await page.evaluate(() => innerWidth), dpr: await page.evaluate(() => devicePixelRatio) });
    }
    expect(report.errors).toEqual([]);
    report.passed = true;
  } catch (error) {
    report.errors.push(error.message);
    throw error;
  } finally {
    if (!report.passed && center()) report.content = await center().locator('body').innerText().catch(() => '');
    if (!report.passed) await page.screenshot({ path: path.join(art, 'browser-zoom-failed.png') }).catch(() => {});
    fs.writeFileSync(path.join(art, 'zoom-report.json'), JSON.stringify(report, null, 2));
    await context.close();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
