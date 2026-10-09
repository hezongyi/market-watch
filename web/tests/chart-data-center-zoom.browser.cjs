const { chromium, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('./chart-data-center-fixture.cjs');
const base = fixture.base, art = path.join(fixture.root, 'artifacts/native-ui-implementation');
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
  const onError = error => report.errors.push(error.message);
  let workspace;
  const get = async route => { const r=await page.request.get(base+'/api'+route);expect(r.ok()).toBe(true);return r.json(); };
  if (process.env.LOCAL) await fixture.localNativeAssets(page);
  const { host, native } = fixture.frames(page);
  const center = () => native()?.locator('.dc-window');
  const record = (name, data) => { console.log('PASS', name); report.checks.push({ name, ...data }); };
  const zoom = value => worker.evaluate(async ({ base, value }) => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url?.startsWith(base));
    await chrome.tabs.setZoom(tab.id, value);
    return chrome.tabs.getZoom(tab.id);
  }, { base, value });
  const compositePattern = /\/api\/market-data\/center\/(composites|composite-candidates)\?/;
  const fixtureSeeds = new Map();
  const fixtureRows = async route => {
    const seedUrl = new URL(route.request().url());
    seedUrl.searchParams.set('query', '');
    const key = seedUrl.pathname;
    if (!fixtureSeeds.has(key)) fixtureSeeds.set(key, route.fetch({ url: seedUrl.href }).then(r => r.json()));
    const body = structuredClone(await fixtureSeeds.get(key));
    expect(body.items.length).toBeGreaterThan(0);
    const seed = body.items[0];
    body.items = Array.from({ length: 25 }, (_, index) => 'dataset' in seed
      ? { ...seed, dataset: { ...seed.dataset, id: seed.dataset.id + '-' + index, logical_symbol: '组合候选布局验收-' + index, display_symbol: '组合候选布局验收-' + index } }
      : { ...seed, id: seed.id + '-' + index, logical_symbol: '已建立组合布局验收-' + index, display_symbol: '已建立组合布局验收-' + index });
    body.total = 25;
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
    const {csrf}=await get('/session'),created=await page.request.post(base+'/api/advanced-charts/workspaces',{data:{name:'数据中心详情实际200%缩放验收',symbol:'MWP:EURUSD'},headers:{'X-CSRF-Token':csrf}});
    expect(created.ok()).toBe(true);workspace=await created.json();
    await page.goto(base+'/market-data?query=EURUSD&status=available');
    await expect.poll(() => !!native(), { timeout: 30000 }).toBeTruthy();
    await expect(center()).toBeVisible({ timeout: 20000 });
    await native().getByRole('button', { name: '关闭数据中心' }).click();
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
      page.off("pageerror", onError);
      await page.reload();
      await expect.poll(() => !!host() && !!native(), { timeout: 30000 }).toBeTruthy();
      await host().waitForFunction(()=>ready && widget.activeChart().dataReady(),null,{timeout:60000});
      page.on('pageerror',onError);
      await expect(native().getByRole('button', { name: '数据中心', exact: true })).toBeVisible({ timeout: 30000 });
      await native().getByRole('button', { name: '数据中心', exact: true }).click();
      await expect(center()).toBeVisible({ timeout: 20000 });
      await expect(native().getByRole('button', { name: '关闭数据中心' })).toBeInViewport();
      await center().getByRole('button', { name: '自建行情', exact: true }).click();
      const filter = center().getByRole('button', { name: '筛选与搜索', exact: true });
      if (await filter.isVisible()) await filter.click();
      await center().getByLabel('搜索品种', { exact: true }).fill('EURUSD');
      await center().getByRole('button', { name: '可用', exact: true }).click();
      if (await filter.isVisible()) await filter.click();
      const action = center().getByRole('button', { name: '打开图表', exact: true }).first();
      await action.scrollIntoViewIfNeeded();
      await expect(action).toBeInViewport();
      expect(await center().evaluate(n => n.scrollWidth <= n.clientWidth + 1)).toBeTruthy();
      await expect(center().getByRole('heading', { name: '自建行情', exact: true })).toBeInViewport();
      await expect(center().getByRole('navigation', { name: '列表分页' })).toHaveCount(0);
      await closeFilters();
      await screenshot(`browser-zoom200-${width}.png`);
      const detail = center().locator('.dc-market-row').first().getByRole('button', {name:'查看详情', exact:true});
      await detail.click();
      await expect(center().locator('.dc-detail-panel').getByRole('button', {name:'关闭详情',exact:true})).toBeInViewport();
      expect(await center().locator('.dc-detail-panel').evaluate(n=>n.scrollWidth<=n.clientWidth+1)).toBe(true);
      await screenshot(`browser-zoom200-panel-${width}.png`);
      await page.keyboard.press('Escape');
      await expect(center().locator('.dc-detail-panel')).toHaveCount(0);
      await expect(detail).toBeFocused();

      // Switching with the previous filter open must not leave an empty overlay.
      if (await filter.isVisible()) await filter.click();
      await center().getByRole('button', { name: '组合行情', exact: true }).click();
      await expect.poll(() => center().locator('.dc-market-row').count(), { timeout: 20000 }).toBe(25);
      await expect(center().locator('.dc-filter-toggle')).toHaveCount(0);
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
        await expect(center().locator('.dc-market-row').last().locator('.dc-market-main')).toContainText(`${mode === '已建立组合' ? '已建立组合' : '组合候选'}布局验收-24`);
        const table = center().locator('.dc-market-list');
        const heading = center().getByRole('heading', { name: '组合行情', exact: true });
        const before = await heading.boundingBox();
        await table.evaluate(element => { element.scrollTop = element.scrollHeight; });
        expect(await table.evaluate(element => element.scrollHeight > element.clientHeight && element.scrollTop > 0)).toBeTruthy();
        expect((await heading.boundingBox()).y).toBe(before.y);
        await expect(heading).toBeInViewport();
        await expect(center().getByRole('navigation', { name: '列表分页' })).toHaveCount(0);
        expect(await center().evaluate(n => n.scrollWidth <= n.clientWidth + 1)).toBeTruthy();
      }
      await screenshot(`browser-zoom200-composite-${width}.png`);
      await native().getByRole('button', { name: '关闭数据中心' }).click();
      await host().evaluate(() => dataCenter.open('/market-data?tab=platform&source=yahoo&query=MSFT'));
      await expect(center().locator('[data-name="symbol-search-dialog-content-item"]')).toHaveCount(1, { timeout: 15000 });
      await expect(center().getByRole('heading', { name: '平台行情', exact: true })).toBeInViewport();
      await expect(center().getByRole('searchbox', { name: '搜索品种', exact: true })).toBeInViewport();
      await expect(center().getByRole('button', { name: '来源', exact: true })).toBeInViewport();
      await expect(center().getByRole('button', { name: '打开图表', exact: true })).toBeInViewport({ ratio: 1 });
      await expect(center().getByRole('navigation', { name: '列表分页' })).toHaveCount(0);
      expect(await center().locator('.dc-platform').evaluate(n => n.scrollWidth <= n.clientWidth + 1)).toBeTruthy();
      await screenshot(`browser-zoom200-platform-${width}.png`);
      await native().getByRole('button', { name: '关闭数据中心' }).click();
      await expect(native().getByRole('button', { name: '数据中心', exact: true })).toBeFocused();
      await host().evaluate(()=>indicatorPicker.open());
      const indicators=native().locator('[data-name="indicators-dialog"]');
      await expect(indicators).toBeVisible();
      await indicators.getByLabel('搜索指标',{exact:true}).fill('SMA');
      await indicators.locator('[data-study-name="守望 Python SMA"]').getByRole('button',{name:/查看.*详情/}).click();
      const indicatorPanel=indicators.locator('.mw-native-indicator-detail');
      await expect(indicatorPanel.getByRole('button',{name:'关闭指标详情',exact:true})).toBeInViewport();
      expect(await indicators.locator('.mw-native-indicator-content').evaluate(n=>n.scrollWidth<=n.clientWidth+1)).toBe(true);
      expect(await indicatorPanel.evaluate(n=>n.scrollWidth<=n.clientWidth+1)).toBe(true);
      await screenshot(`browser-zoom200-indicators-${width}.png`);
      await page.keyboard.press('Escape');
      await expect(indicatorPanel).toBeHidden();
      await indicators.getByRole('button',{name:'关闭指标窗口',exact:true}).click();
      await expect(indicators).toHaveCount(0);
      record('real 200% browser zoom retains native entry, data center lists and indicator detail panel at ' + width, { physicalWidth: width, cssWidth: await page.evaluate(() => innerWidth), dpr: await page.evaluate(() => devicePixelRatio) });
    }
    expect(report.errors).toEqual([]);
    report.passed = true;
  } catch (error) {
    report.errors.push(error.message);
    throw error;
  } finally {
    page.off('pageerror',onError);
    if(workspace){const before=await get('/advanced-charts/workspaces'),owned=before.find(row=>row.id===workspace.id);if(owned){const {csrf}=await get('/session'),removed=await page.request.post(base+'/api/advanced-charts/workspaces/'+owned.id+'/delete',{data:{revision:owned.revision},headers:{'X-CSRF-Token':csrf}});expect(removed.ok()).toBe(true);const after=await get('/advanced-charts/workspaces');expect(after.map(row=>row.id).sort()).toEqual(before.filter(row=>row.id!==workspace.id).map(row=>row.id).sort());report.cleanup={onlyOwnedWorkspaceDeleted:true}}}
    if (!report.passed && center()) report.content = await center().innerText().catch(() => '');
    if (!report.passed) await page.screenshot({ path: path.join(art, 'browser-zoom-failed.png') }).catch(() => {});
    fs.writeFileSync(path.join(art, 'zoom-report.json'), JSON.stringify(report, null, 2));
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await context.close();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
