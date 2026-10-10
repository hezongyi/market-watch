// Actual Ubuntu API and source catalogue. No fixture routes or live subscriptions.
const { chromium, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const base = process.env.MW_CENTER_URL || 'http://127.0.0.1:16629';
const artifacts = path.join(root, 'artifacts/data-integration');
const credentials = JSON.parse(fs.readFileSync(path.join(artifacts, 'three-layer-login.json')));
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], writes = [], checks = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'POST') writes.push(new URL(request.url()).pathname);
  });
  try {
    await page.goto(base + '/market-data');
    await page.getByLabel('管理员密码').fill(credentials.password);
    await page.getByRole('button', { name: '登录工作台' }).click();
    await expect(page.getByRole('heading', { name: '数据中心', exact: true })).toBeVisible();
    await page.getByRole('link', { name: '添加自建行情', exact: true }).click();
    await page.getByLabel('搜索来源目录').fill('EURUSD');
    await page.getByRole('button', { name: '选择 EURUSD', exact: true }).click();
    await expect(page.getByLabel('准确来源代码')).toHaveValue('EUR/USD');
    await expect(page.getByLabel('逻辑品种')).toHaveValue('EURUSD');
    await expect(page.getByLabel('小数位数')).toHaveValue('');
    expect(await page.getByLabel('准确来源代码').getAttribute('readonly')).not.toBeNull();
    await page.getByRole('button', { name: '下一步' }).click();
    await expect(page.getByRole('alert')).toContainText('明确填写0–10');
    await page.getByLabel('小数位数').fill('5');
    await page.getByRole('button', { name: '下一步' }).click();
    await expect(page.getByLabel('聚合日界')).toHaveValue('ny17');
    checks.push('SDK exact symbol selection, explicit unknown precision and NY17 forex default');
    await page.getByRole('button', { name: '上一步' }).click();
    await page.getByLabel(/^来源/).selectOption('oanda');
    const refreshed = page.waitForResponse(response => response.url().endsWith('/history-catalog/refresh') &&
      response.request().method() === 'POST');
    await page.getByRole('button', { name: '刷新当前账户目录', exact: true }).click();
    expect((await refreshed).status()).toBe(200);
    await page.getByLabel('搜索来源目录').fill('EUR_USD');
    await page.getByRole('button', { name: '选择 EUR_USD', exact: true }).click();
    await expect(page.getByLabel('准确来源代码')).toHaveValue('EUR_USD');
    await expect(page.getByLabel('小数位数')).toHaveValue('5');
    expect(await page.getByLabel('小数位数').getAttribute('readonly')).not.toBeNull();
    await page.getByLabel('搜索来源目录').fill('not-a-real-instrument');
    await expect(page.getByText('未找到品种；可调整搜索或手工登记。', { exact: true })).toBeVisible();
    checks.push('explicit actual account refresh, source precision, empty search does not require refresh');
    const datasets = await (await page.request.get(base + '/api/market-data/center/datasets?status=available')).json();
    const requestEvidenceFile = path.join(artifacts, 'history-request-real-supplier.json');
    const evidence = fs.existsSync(requestEvidenceFile) ? JSON.parse(fs.readFileSync(requestEvidenceFile)) : null;
    const dataset = datasets.items.find(item => evidence ? item.id === evidence.dataset_id : item.latest_version_id);
    expect(dataset).toBeTruthy();
    await page.goto(base + `/market-data/datasets/${dataset.id}?section=coverage`);
    const selector = page.getByLabel('覆盖固定版本');
    await expect(selector).toHaveValue(dataset.latest_version_id);
    await expect(page.getByRole('columnheader', { name: '证据冲突', exact: true })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: '已证实闭市', exact: true })).toBeVisible();
    if (evidence) {
      await expect(page.getByRole('heading', { name: '历史读取记录', exact: true })).toBeVisible();
      await expect(page.getByRole('cell', { name: '上游请求', exact: true })).toBeVisible();
      await expect(page.getByRole('cell', { name: '父版本复用', exact: true })).toBeVisible();
      checks.push('actual supplier and parent reuse request evidence shown independently from coverage');
    }
    const versions = await selector.locator('option').evaluateAll(nodes => nodes.map(node => node.value).filter(Boolean));
    for (const version of versions.slice(-2)) {
      const before = await selector.inputValue();
      const coverage = before !== version ? page.waitForResponse(response => response.url().includes(`/versions/${version}/coverage`)) : null;
      await selector.selectOption(version);
      if (coverage) expect((await coverage).status()).toBe(200);
      await expect.poll(() => new URL(page.url()).searchParams.get('version')).toBe(version);
      const report = await (await page.request.get(base + `/api/market-data/versions/${version}/coverage`)).json();
      expect(report.version_id).toBe(version);
    }
    checks.push('coverage table selects explicit published version and separates evidence conflicts');
    for (const width of [1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    expect(writes.filter(url => url !== '/api/login' && url !== '/api/market-data/history-catalog/refresh')).toEqual([]);
    expect(errors).toEqual([]);
    checks.push('desktop widths, no dataset creation, subscriptions or demand writes');
    await page.screenshot({ path: path.join(artifacts, 'history-center-catalog-real.png'), fullPage: true });
    fs.writeFileSync(path.join(artifacts, 'history-center-catalog-real.json'), JSON.stringify({
      environment: 'Ubuntu isolated market-watch-three-layer', base, checks, errors, passed: true,
    }, null, 2));
    console.log(JSON.stringify({ checks: checks.length, passed: true }));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
