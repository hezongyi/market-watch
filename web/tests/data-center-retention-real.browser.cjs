// Actual isolated supplier/PG/UI flow; deletes only this script's UTC dataset payload.
const { chromium, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const base = process.env.MW_CENTER_URL || 'http://127.0.0.1:16629';
const credentials = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/data-integration/three-layer-login.json')));
(async () => {
  const browser = await chromium.launch({headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  const checks = [], errors = [];
  page.on('pageerror', e => errors.push(e.message));
  async function get(p) {const r = await page.request.get(base + p); expect(r.ok()).toBe(true); return r.json();}
  let csrf;
  async function post(p, data, status = 200) {
    const r = await page.request.post(base + p, {data, headers: {'X-CSRF-Token': csrf}});
    expect(r.status()).toBe(status);
    return r.json();
  }
  try {
    await expect.poll(async () => (await page.request.get(base + '/readyz')).status(), {timeout: 60000}).toBe(200);
    await page.goto(base + '/market-data');
    await page.getByLabel('管理员密码').fill(credentials.password);
    const login = page.waitForResponse(r => r.url().endsWith('/api/login') && r.request().method() === 'POST');
    await page.getByRole('button', {name: '登录工作台'}).click();
    csrf = (await (await login).json()).csrf;
    const before = await get('/api/market-data/center/datasets?source=dukascopy&page_size=100');
    const original = before.items.find(d => d.logical_symbol === 'EURUSD' && d.aggregation_calendar === 'ny17');
    expect(original?.usable_timeframes).toContain('M1');
    // Refuse to modify any pre-existing UTC fixture or user-owned dataset.
    expect(before.items.some(d => d.logical_symbol === 'EURUSD' && d.aggregation_calendar === 'utc0')).toBe(false);
    const boundary = await get('/api/market-data/date-boundary?date=2026-10-06&calendar=utc0');
    const created = await post('/api/market-data/center/datasets', {
      request_id: 'retention-acceptance-' + Date.now(),
      dataset: {source: 'dukascopy', logical_symbol: 'EURUSD', provider_symbol: 'EUR/USD', asset_class: 'forex', precision: 5, aggregation_calendar: 'utc0'},
      maintenance: {target_start: boundary.start, timeframes: ['M1','H4','D1'], frequency: 'once'},
    }, 201);
    const id = created.dataset.id, version = created.task.id;
    const detail = '/api/market-data/center/datasets/' + id;
    await expect.poll(async () => (await get(detail)).maintenance.last_success != null, {timeout: 180000, intervals: [1000,3000,5000]}).toBe(true);
    checks.push('real supplier M1/period publication for disposable isolated UTC history');
    let workspace = await post('/api/charts/workspaces', {name: 'retention isolated reference acceptance'});
    workspace = await post(`/api/charts/workspaces/${workspace.id}/save`, {
      name: workspace.name, revision: workspace.revision,
      document: {...workspace.document, panels: [{...workspace.document.panels[0], instrument: created.dataset.instrument_id, timeframe: 'M1'}]},
    });
    await post(`/api/market-data/datasets/${id}/maintenance/control`, {action: 'pause'});
    await post(`/api/market-data/datasets/${id}/maintenance/control`, {action: 'archive'});
    const refs = await get(`/api/market-data/datasets/${id}/references`);
    expect(refs.items.some(r => r.kind === 'workspace' && r.id === workspace.id)).toBe(true);
    await post(`/api/market-data/datasets/${id}/reclaim`, {request_id: 'blocked-by-saved-workspace'}, 409);
    expect((await get(`/api/market-data/versions/${version}/chart?count=2`)).bars).toHaveLength(2);
    await post(`/api/charts/workspaces/${workspace.id}/delete`, {revision: workspace.revision});
    checks.push('actual saved workspace reference blocks reclamation and preserves readable history');
    await page.goto(base + `/market-data/datasets/${id}?section=references`);
    await page.getByRole('button', {name: '查看回收影响', exact: true}).click();
    const deletion = page.waitForResponse(r => r.url().endsWith(`/datasets/${id}/reclaim`) && r.request().method() === 'POST');
    await page.getByRole('button', {name: '回收无引用历史价格', exact: true}).click();
    const removed = await deletion;
    expect(removed.status()).toBe(200);
    const result = await removed.json();
    expect(result.versions).toBe(1);
    await expect(page.getByText(/已回收 1 个版本的价格数据/)).toBeVisible();
    expect((await get(`/api/market-data/versions/${version}`)).payload_available).toBe(false);
    expect((await get(detail)).usable_timeframes).toEqual([]);
    expect((await get('/api/market-data/center/datasets/' + original.id)).usable_timeframes).toContain('M1');
    await page.getByRole('button', {name: '发布版本', exact: true}).click();
    await expect(page.getByText('价格已回收 · 清单保留')).toBeVisible();
    checks.push('reviewable UI reclamation retains immutable manifest and preserves other NY17 dataset');
    // Rebuilding reuses the identity but never resurrects the old fixed version.
    await post(`/api/market-data/datasets/${id}/maintenance/control`, {action: 'unarchive'});
    const rebuilt = await post(`/api/market-data/datasets/${id}/tasks`, {request_id: 'rebuild-after-reclamation-' + Date.now()}, 201);
    expect(rebuilt.id).not.toBe(version);
    await expect.poll(async () => (await get(detail)).maintenance.active_version_id == null, {timeout:180000, intervals:[1000,3000,5000]}).toBe(true);
    expect((await get(detail)).usable_timeframes).toContain('M1');
    expect((await get(`/api/market-data/versions/${version}`)).payload_available).toBe(false);
    checks.push('new maintenance restores availability using a new version and leaves old payload reclaimed');
    expect(errors).toEqual([]);
    await page.screenshot({path: path.join(root,'artifacts/data-integration/data-center-retention-real.png'), fullPage:true});
    fs.writeFileSync(path.join(root,'artifacts/data-integration/data-center-retention-real.json'), JSON.stringify({passed:true,base,checks,errors,reclamation:result,old_version:version,new_version:rebuilt.id},null,2));
    console.log(JSON.stringify({passed:true,checks}));
  } finally {
    await browser.close();
  }
})().catch(e => {console.error(e); process.exit(1);});
