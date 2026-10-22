// V2 isolated R1 acceptance: two-step OANDA selection, server verified rules,
// standard save-only, gold product difference, and responsive native controls.
const { chromium, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const base = process.env.MW_MAPPING_URL || 'https://localhost:18481';
const creds = JSON.parse(fs.readFileSync(process.env.MW_MAPPING_CREDENTIALS || '/home/quant/.local/share/market-watch-docker/previews/mw-composite-mapping-20261021/credentials.json'));
if (new URL(base).hostname !== 'localhost') throw Error('v2 R1 accepts loopback only');
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const report = { base, checks: [], errors: [], writes: [], passed: false };
  page.on('pageerror', e => report.errors.push(e.message));
  page.on('request', r => { if (r.method() === 'POST' && !r.url().endsWith('/login')) report.writes.push(new URL(r.url()).pathname); });
  const host = () => page.frames().find(f => f.url().startsWith(base.replace('https://localhost:18481', 'https://localhost:18482') + '/?'));
  const native = () => page.frames().find(f => f.url().startsWith('blob:'));
  const dc = () => native().locator('.dc-window');
  const apiGet = async endpoint => { const r = await page.request.get(base + '/api' + endpoint); expect(r.ok(), await r.text()).toBe(true); return r.json(); };
  const record = name => { report.checks.push(name); console.log('PASS', name); };
  const closeCenter = async () => { if (!await dc().count()) return; await dc().getByRole('button', { name: '关闭数据中心', exact: true }).click(); if (await dc().getByRole('button', { name: '放弃修改', exact: true }).count()) await dc().getByRole('button', { name: '放弃修改', exact: true }).click(); };
  const openMapping = async id => {
    await host().evaluate(() => dataCenter.open('/market-data?tab=composite&view=candidates'));
    await expect(dc().getByText('建立条件', { exact: true })).toBeVisible({ timeout: 20000 });
    await dc().locator(`a[href*="/datasets/${id}/mapping"]`).click();
    await expect(dc().getByRole('heading', { name: /^配置实时来源/ })).toBeVisible({ timeout: 20000 });
  };
  const choose = async code => {
    await dc().getByRole('searchbox', { name: '搜索品种' }).fill(code);
    const row = (await apiGet(`/market-data/history-catalog?source=oanda&query=${code}&page_size=50`)).items.find(x => x.provider_symbol === code);
    expect(row).toBeTruthy();
    await dc().locator(`[data-symbol-name="${row.catalog_id}"]`).getByRole('button', { name: /^(选择|已选择)$/ }).click();
    await expect(dc().getByRole('button', { name: '配置实时 →', exact: true })).toBeEnabled();
  };
  try {
    await page.goto(base + '/advanced-charts/D1_EURUSD');
    await page.getByLabel('管理员密码').fill(creds.login_password);
    await page.locator('button.auth-submit').click();
    await expect.poll(() => !!host() && !!native(), { timeout: 60000 }).toBe(true);
    await host().waitForFunction(() => typeof ready !== 'undefined' && ready && !loading, null, { timeout: 60000 });
    await host().evaluate(() => dataCenter.open('/market-data?tab=composite'));
    await expect(dc().getByRole('heading', { name: '组合行情', exact: true })).toBeVisible();
    await dc().getByRole('button', { name: '可建立候选', exact: true }).click();
    await expect(dc().getByText('建立条件', { exact: true })).toBeVisible();
    record('actual composite candidate navigation and no mutation before selection');
    const datasets = (await apiGet('/market-data/center/datasets?source=dukascopy&page_size=100')).items;
    const eur = datasets.find(x => x.logical_symbol === 'EURUSD'), gold = datasets.find(x => x.logical_symbol === 'XAUUSD'),
      usd = datasets.find(x => x.logical_symbol === 'USDCAD');
    expect(eur && gold && usd).toBeTruthy();
    const writesBefore = report.writes.length;
    await openMapping(eur.id);
    await choose('EUR_USD');
    await expect(dc().getByText('① 选择实时品种', { exact: true })).toBeVisible();
    await dc().getByRole('button', { name: '配置实时 →', exact: true }).click();
    await expect(dc().getByText('② 配置并创建', { exact: true })).toBeVisible();
    await expect(dc().getByRole('status').filter({ hasText: '可以创建' })).toBeVisible({ timeout: 30000 });
    expect(await dc().getByLabel('补充历史产品资料（选填）', { exact: true }).count()).toBe(0);
    expect(await dc().getByRole('checkbox').count()).toBe(0);
    const save = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith(`/datasets/${eur.id}/mappings`));
    await dc().getByRole('button', { name: '仅保存配置', exact: true }).click();
    expect((await save).status()).toBe(201);
    await expect(dc().getByRole('heading', { name: '组合行情', exact: true })).toBeVisible();
    expect(report.writes.slice(writesBefore).some(p => p.endsWith('/composites/use'))).toBe(false);
    record('EURUSD auto-fills verified rule; standard save needs no URL, 10-char note, or blanket checkbox');
    await closeCenter();
    await host().evaluate(() => widget.setLayout('2h'));
    await expect.poll(() => host().evaluate(() => widget.chartsCount())).toBe(2);
    const before = await host().evaluate(() => ({ active: widget.activeChartIndex(),
      charts: Array.from({ length: widget.chartsCount() }, (_, i) => ({ symbol: widget.chart(i).symbol(), resolution: widget.chart(i).resolution() })) }));
    await openMapping(usd.id);
    await choose('USD_CAD');
    await dc().getByRole('button', { name: '配置实时 →', exact: true }).click();
    await expect(dc().getByRole('status').filter({ hasText: '可以创建' })).toBeVisible();
    const used = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/composites/use'));
    await dc().getByRole('button', { name: /^(创建并打开图表|打开已有组合)$/ }).click();
    const useResponse = await used;
    expect(useResponse.status()).toBe(201);
    const composite = await useResponse.json();
    await expect(dc()).toHaveCount(0, { timeout: 30000 });
    await expect.poll(() => host().evaluate(() => widget.activeChart().symbol().toLowerCase()), { timeout: 30000 }).toBe('mwc:' + composite.id);
    await expect.poll(() => host().evaluate(() => widget.activeChart().dataReady()), { timeout: 45000 }).toBe(true);
    const other = 1 - before.active;
    expect(await host().evaluate(i => ({ symbol: widget.chart(i).symbol(), resolution: widget.chart(i).resolution() }), other)).toEqual(before.charts[other]);
    record('USDCAD verified defaults create/open the real composite, dataReady, and preserve the other pane');

    // Lose the reply after the real save committed. Reconcile then retry an
    // injected open failure, reusing the saved identity without a second save.
    const savePattern = `**/api/market-data/datasets/${eur.id}/mappings`;
    let saveAttempts = 0, useAttempts = 0;
    const lostSave = async route => {
      if (route.request().method() !== 'POST') return route.continue();
      saveAttempts++;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      await route.fulfill({ status: 503, json: { detail: 'R1 injected lost save reply after commit' } });
    };
    const failedUse = async route => { useAttempts++; await route.fulfill({ status: 503, json: { detail: 'R1 injected open failure' } }); };
    await page.route(savePattern, lostSave);
    await page.route('**/api/market-data/composites/use', failedUse);
    await openMapping(eur.id);
    await choose('EUR_USD');
    await dc().getByRole('button', { name: '配置实时 →', exact: true }).click();
    await dc().getByLabel('备注（选填）', { exact: true }).fill('v2 lost-response acceptance');
    await expect(dc().getByRole('button', { name: /^(创建并打开图表|打开已有组合)$/ })).toBeEnabled();
    await dc().getByRole('button', { name: /^(创建并打开图表|打开已有组合)$/ }).click();
    await expect(dc().getByRole('button', { name: '核查保存结果', exact: true })).toBeVisible();
    await expect(dc().getByLabel('备注（选填）', { exact: true })).toBeDisabled();
    await dc().getByRole('button', { name: '核查保存结果', exact: true }).click();
    await expect(dc().getByText(/已确认配置保存成功/)).toBeVisible();
    await dc().getByRole('button', { name: /^(创建并打开图表|打开已有组合)$/ }).click();
    await expect(dc().getByRole('button', { name: '重试打开图表', exact: true })).toBeEnabled();
    await dc().getByRole('button', { name: '重试打开图表', exact: true }).click();
    await expect.poll(() => useAttempts).toBe(2);
    expect(saveAttempts).toBe(1);
    await expect(dc().getByRole('button', { name: '重试打开图表', exact: true })).toBeEnabled();
    await closeCenter();
    await page.unroute(savePattern, lostSave);
    await page.unroute('**/api/market-data/composites/use', failedUse);
    record('committed save with lost reply reconciles; open retries reuse mapping without another save');

    // Review regressions: a delayed suggestion must never replace manual edits.
    const noMappings = route => route.request().method() === 'GET' ? route.fulfill({ json: { items: [] } }) : route.continue();
    await page.route(savePattern, noMappings);
    let releaseCheck, checkArrived;
    const arrived = new Promise(r => { checkArrived = r; });
    const delayed = new Promise(r => { releaseCheck = r; });
    const checkPattern = `**/api/market-data/datasets/${eur.id}/mapping-check`;
    const heldCheck = async route => {
      if (route.request().postDataJSON().match !== null) return route.continue();
      const response = await route.fetch(); checkArrived(); await delayed;
      await route.fulfill({ response }).catch(() => {});
    };
    await page.route(checkPattern, heldCheck);
    await openMapping(eur.id);
    await choose('EUR_USD');
    await arrived;
    await dc().getByRole('button', { name: '配置实时 →', exact: true }).click();
    await dc().getByLabel('标的代码', { exact: true }).fill('GBP');
    const validated = page.waitForResponse(r => r.url().endsWith('/mapping-check') && r.request().postDataJSON().match?.underlying === 'GBP');
    releaseCheck();
    await validated;
    await expect(dc().getByLabel('标的代码', { exact: true })).toHaveValue('GBP');
    await expect(dc().getByRole('button', { name: '仅保存配置', exact: true })).toBeDisabled();
    await closeCenter();
    await page.unroute(checkPattern, heldCheck);
    await page.unroute(savePattern, noMappings);
    record('late initial suggestion preserves manual edits and conflicting products stay blocked');

    let precisionChanged = false, checkedAgain;
    const checked = new Promise(r => { checkedAgain = r; });
    const changedCheck = async route => {
      const response = await route.fetch(), body = await response.json();
      if (precisionChanged) { body.snapshot.precision += 1; body.status = 'needs_information'; body.errors.relationship = '当前目录精度与已登记实时数据集冲突'; checkedAgain(); }
      await route.fulfill({ json: body });
    };
    await page.route(checkPattern, changedCheck);
    await openMapping(eur.id);
    await choose('EUR_USD');
    await dc().getByRole('button', { name: '配置实时 →', exact: true }).click();
    await expect(dc().getByRole('button', { name: '仅保存配置', exact: true })).toBeEnabled();
    precisionChanged = true;
    await checked;
    await expect(dc().getByText(/精度或产品属性已变化/)).toBeVisible();
    await expect(dc().getByRole('button', { name: '仅保存配置', exact: true })).toBeDisabled();
    await expect(dc().getByRole('status').filter({ hasText: '目录精度' })).toBeVisible();
    await closeCenter();
    await page.unroute(checkPattern, changedCheck);
    record('changed catalogue precision clears old binding and blocks immutable target conflicts');

    await openMapping(gold.id);
    await expect(dc().getByRole('heading', { name: /^配置实时来源/ })).toBeVisible();
    await choose('XAU_USD');
    await dc().getByRole('button', { name: '配置实时 →', exact: true }).click();
    await expect(dc().getByText(/Dukascopy 滚动黄金 CFD/)).toBeVisible({ timeout: 30000 });
    await expect(dc().getByRole('checkbox', { name: /确认.*黄金报价产品差异/ })).toBeVisible();
    await expect(dc().getByRole('button', { name: '仅保存配置', exact: true })).toBeDisabled();
    record('XAUUSD shows known CFD versus OANDA metal quote difference and targeted confirmation');
    await dc().getByRole('checkbox', { name: /确认.*黄金报价产品差异/ }).check();
    await expect(dc().getByRole('button', { name: '仅保存配置', exact: true })).toBeEnabled();
    await dc().getByRole('button', { name: '查看匹配详情', exact: true }).click();
    await expect(dc().getByText(/Dukascopy 历史报价来源/)).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
    await page.screenshot({ path: path.join(root, 'artifacts/composite-mapping-v2-mobile.png') });
    record('390px layout keeps fixed action bar and no horizontal overflow');
    expect(report.errors).toEqual([]);
    report.passed = true;
  } catch (error) { report.errors.push(error.message); await page.screenshot({ path: path.join(root, 'artifacts/composite-mapping-v2-failure.png') }).catch(() => {}); throw error; }
  finally { fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true }); fs.writeFileSync(path.join(root, 'artifacts/composite-mapping-v2-report.json'), JSON.stringify(report, null, 2)); await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
