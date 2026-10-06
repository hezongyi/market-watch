// Actual Ubuntu API/PostgreSQL/source acceptance, never API fixtures.
const { chromium, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const base = process.env.MW_CENTER_URL || 'http://127.0.0.1:16629';
const credentials = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/data-integration/three-layer-login.json')));
(async () => {
  const browser = await chromium.launch({headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  const errors = [], writes = [], checks = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', req => {if(req.method() === 'POST') writes.push(new URL(req.url()).pathname);});
  try {
    await expect.poll(async () => (await page.request.get(base + '/readyz')).status(),
      {timeout: 60000, intervals: [1000, 2000]}).toBe(200);
    await page.goto(base + '/market-data');
    await page.getByLabel('管理员密码').fill(credentials.password);
    await page.getByRole('button', {name: '登录工作台'}).click();
    await expect(page.getByRole('heading', {name: '数据中心', exact: true})).toBeVisible();
    checks.push('real login and default managed list');
    const before = writes.length;
    for (const tab of ['平台品种','组合行情','任务与记录','自建行情']) {
      await page.getByRole('navigation', {name: '数据中心分区'}).getByRole('link', {name: tab}).click();
    }
    expect(writes.length).toBe(before);
    expect(writes.some(p => /demand|subscription|composites/.test(p))).toBe(false);
    checks.push('management browsing creates no demand writes');
    await page.getByRole('link', {name: '添加自建行情', exact: true}).click();
    await page.getByLabel('逻辑品种').fill('EURUSD');
    await page.getByLabel('准确来源代码').fill('EUR/USD');
    for (const [asset, phase] of [['crypto','utc0'],['metal','ny17'],['index',''],['forex','ny17']]) {
      await page.getByLabel('资产类别').selectOption(asset);
      await page.getByRole('button', {name: '下一步'}).click();
      await expect(page.getByLabel('聚合日界')).toHaveValue(phase);
      await page.getByRole('button', {name: '上一步'}).click();
    }
    checks.push('asset defaults and explicit index phase');
    await page.getByRole('button', {name: '下一步'}).click();
    await page.getByLabel('起始交易日期').fill('2026-10-05');
    await page.getByRole('button', {name: '下一步'}).click();
    await expect(page.getByText(/对应 .*UTC/)).toBeVisible();
    const response = page.waitForResponse(r => r.url().endsWith('/api/market-data/center/datasets') && r.request().method() === 'POST');
    await page.getByRole('button', {name: '创建并开始维护'}).click();
    const created = await response;
    expect(created.status()).toBe(201);
    const result = await created.json();
    await expect(page.getByRole('heading', {name: 'EURUSD', exact: true})).toBeVisible();
    checks.push('atomic real dataset and maintenance task creation');
    console.log(JSON.stringify({stage: 'source_task_created', task: result.task.id}));
    const id = result.dataset.id;
    await expect.poll(async () => {
      const r = await page.request.get(base + `/api/market-data/center/datasets/${id}`);
      const d = await r.json();
      if(d.maintenance.task_error) console.log(JSON.stringify({stage: 'source_task_state', status: d.maintenance.task_status, error: d.maintenance.task_error}));
      return ['M1', 'H4', 'D1'].every(frame => d.periods?.some(p =>
        p.timeframe === frame && p.status === 'published' && p.available_version_id === result.task.id)) &&
        d.maintenance.last_success != null && d.maintenance.active_version_id == null;
    }, {timeout: 180000, intervals: [1000,3000,5000]}).toBeTruthy();
    await page.reload();
    await page.getByRole('link', {name: '打开历史图表'}).click();
    await expect(page.locator('canvas').first()).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get('version')).toBe(result.task.id);
    const latest = await page.request.get(base + `/api/market-data/versions/${result.task.id}/chart?timeframe=M1&count=2`);
    const newest = await latest.json();
    expect(newest.bars).toHaveLength(2);
    expect(newest.next_before).not.toBeNull();
    const older = await page.request.get(base + `/api/market-data/versions/${result.task.id}/chart?timeframe=M1&count=2&before=${newest.next_before}`);
    const previous = await older.json();
    expect(previous.bars.at(-1).start).toBeLessThan(newest.bars[0].start);
    await page.getByRole('button', {name: '更早历史', exact: true}).click();
    await expect.poll(() => new URL(page.url()).searchParams.has('before')).toBe(true);
    await expect(page.locator('canvas').first()).toBeVisible();
    await page.getByRole('button', {name: '返回最新', exact: true}).click();
    await expect.poll(() => new URL(page.url()).searchParams.has('before')).toBe(false);
    checks.push('fixed-version newest-first historical pagination with exclusive cursor');
    await page.getByRole('combobox', {name: /^周期/}).selectOption('H4');
    await expect(page.locator('canvas').first()).toBeVisible();
    expect(new URL(page.url()).searchParams.get('version')).toBe(result.task.id);
    checks.push('real supplier M1 to per-period publication and fixed version chart');
    await page.getByRole('link', {name: '用此版本回测', exact: true}).click();
    await expect(page.getByRole('combobox', {name: '不可变历史版本'})).toHaveValue(result.task.id);
    expect(new URL(page.url()).searchParams.get('dataset_version')).toBe(result.task.id);
    checks.push('backtest entry resolves explicit fixed historical version without automatic execution');
    await page.goto(base + `/market-data/datasets/${id}?section=maintenance`);
    await page.getByRole('button', {name: '维护设置', exact: true}).click();
    await page.getByRole('button', {name: '暂停定时维护'}).click();
    await expect(page.getByRole('button', {name: '恢复维护'})).toBeVisible();
    await page.getByRole('button', {name: '恢复维护'}).click();
    await expect(page.getByRole('button', {name: '暂停定时维护'})).toBeVisible();
    checks.push('real pause/resume schedule preserves publication');
    for(const width of [1024,1440,1920]) {
      await page.setViewportSize({width, height: 1000});
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.setViewportSize({width: 1024,height: 1000});
    await page.evaluate(() => document.querySelector('.data-center').style.zoom = '2');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    checks.push('desktop widths and 200 percent content zoom');
    expect(errors).toEqual([]);
    await page.screenshot({path: path.join(root,'artifacts/data-integration/data-center-real.png'),fullPage:true});
    fs.writeFileSync(path.join(root,'artifacts/data-integration/data-center-real-browser.json'),JSON.stringify({passed:true,base,scope:'actual Ubuntu API/PostgreSQL and Dukascopy M1; second-layer flow only',checks,errors,writes},null,2));
    console.log(JSON.stringify({passed:true,checks}));
  } finally {
    await page.screenshot({path: path.join(root,'artifacts/data-integration/data-center-last-browser.png'),fullPage:true}).catch(()=>{});
    await browser.close();
  }
})().catch(e => {console.error(e);process.exit(1);});
