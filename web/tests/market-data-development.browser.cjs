// Actual mw-dev assets/APIs, no routes or suppliers are mocked. Only a
// disposable workspace is created; saved user documents and switches stay put.
const {chromium, expect, request} = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'docs/verification/market-data-consolidation-20261113');
const credentials = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.local/share/market-watch-dev/credentials.json')));
const base = credentials.base_url;
const report = {environment: 'Ubuntu mw-dev actual TLS/React/licensed chart/assets/API', passed: false, checks: [], errors: []};

(async () => {
  const agent = await request.newContext({ignoreHTTPSErrors: true});
  const login = await (await agent.post(base + '/api/login', {data: {password: credentials.login_password}})).json();
  const headers = {'X-CSRF-Token': login.csrf};
  const browser = await chromium.launch({headless: true});
  const context = await browser.newContext({ignoreHTTPSErrors: true, viewport: {width: 1440, height: 1000}});
  await context.addCookies((await agent.storageState()).cookies);
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  let workspace;
  const get = async route => {
    const response = await agent.get(base + '/api/' + route);
    expect(response.ok()).toBeTruthy(); return response.json();
  };
  const originalWidgetbar = (await get('advanced-charts/preferences')).find(row => row.name === 'widgetbar.layout-settings');
  const record = name => {report.checks.push(name); console.log('PASS', name);};
  const native = () => page.frames().find(frame => frame.url().startsWith('blob:'));
  const center = () => native().locator('.dc-window');
  const visit = async route => {
    await page.goto(base + '/advanced-charts/' + workspace.id + '?data_center=' + encodeURIComponent(route));
    await expect.poll(() => !!native(), {timeout: 30000}).toBeTruthy();
    await expect(center()).toBeVisible({timeout: 30000});
  };
  const applies = async (button, ticker) => {
    const response = page.waitForResponse(response => {
      if (!response.url().endsWith('/api/charts/data') || response.request().method() !== 'POST') return false;
      const body = response.request().postDataJSON();
      return [ticker, ticker.slice(4)].includes(body.instrument);
    }, {timeout: 60000});
    await button.click();
    await expect(center()).toHaveCount(0, {timeout: 15000});
    const loaded = await response;
    expect(loaded.ok()).toBeTruthy();
    expect((await loaded.json()).bars.length).toBeGreaterThan(0);
    await expect(native().locator('canvas').first()).toBeVisible();
  };
  try {
    workspace = await (await agent.post(base + '/api/advanced-charts/workspaces',
      {headers, data: {name: '行情整合验收临时图表'}})).json();
    expect(workspace.id).toBeTruthy();
    const saved = (await get('market-data/center/composites?page_size=100')).items;
    await visit('/market-data?tab=managed');
    const nav = native().getByRole('navigation', {name: '数据中心分区'});
    for (const name of ['自建行情', '原生行情', '任务与记录', '来源状态', '交易日历'])
      await expect(nav.getByRole('button', {name, exact: true})).toBeVisible();
    await expect(nav.getByRole('button', {name: '组合行情', exact: true})).toHaveCount(0);
    await expect(center().locator('.dc-market-row')).toHaveCount(3);
    for (const row of saved)
      await expect(center().locator(`[id="dataset-${row.dataset_id}"]`)).toHaveAttribute('data-composite-ids', new RegExp(row.id));
    record('two market entrances and all three legacy source datasets remain discoverable');
    await page.screenshot({path: path.join(output, 'dev-managed.png')});

    const row = saved.find(row => row.logical_symbol === 'EURUSD') || saved[0];
    const article = center().locator(`[id="dataset-${row.dataset_id}"]`);
    await article.getByRole('button', {name: '查看详情', exact: true}).click();
    await native().getByRole('link', {name: '管理行情', exact: true}).click();
    await center().getByRole('button', {name: '实时接续', exact: true}).click();
    await expect(center().getByRole('switch', {name: '实时接续', exact: true})).toHaveAttribute('aria-checked', 'true');
    const continuation = await get('market-data/datasets/' + row.dataset_id + '/continuation');
    expect(continuation.status).toBe('attention');
    await expect(center().getByText(continuation.reason, {exact: true})).toBeVisible();
    await expect(center().getByText('已有接续配置与旧引用', {exact: true})).toBeVisible();
    await center().getByText('已有接续配置与旧引用', {exact: true}).click();
    const oldLink = center().getByRole('link').filter({hasText: row.id.slice(0, 8)});
    await expect(oldLink).toBeVisible();
    await page.screenshot({path: path.join(output, 'dev-continuation.png')});
    record('continuation intent, review warning and original configuration entry are visible without writes');
    await oldLink.click();
    await expect(center().getByRole('heading', {name: /实时接续/})).toBeVisible();
    await applies(center().getByRole('button', {name: '打开组合图表', exact: true}), 'MWC:' + row.id);
    record('original immutable MWC opens a real licensed chart with nonempty bars');

    await visit('/market-data/datasets/' + row.dataset_id + '?section=chart&version=' + row.revision.history_version_id + '&frame=H1');
    await applies(center().getByRole('button', {name: '打开此版本', exact: true}), 'MWH:' + row.revision.history_version_id);
    record('fixed MWH opens independently while continuation remains enabled');

    await visit('/market-data?tab=composite');
    await expect(center().getByRole('heading', {name: '自建行情', exact: true})).toBeVisible();
    await expect(center().locator('.dc-market-row')).toHaveCount(3);
    record('legacy composite list route resolves to the self-built continuation view');
    await native().getByRole('navigation', {name: '数据中心分区'}).getByRole('button', {name: '原生行情', exact: true}).click();
    await expect(center().getByRole('heading', {name: '原生行情', exact: true})).toBeVisible();
    await expect(center().locator('[id^="platform-"]').first()).toBeVisible({timeout: 30000});
    await page.screenshot({path: path.join(output, 'dev-native.png')});
    record('native directory renders through actual supplier catalogue');
    await native().getByRole('navigation', {name: '数据中心分区'}).getByRole('button', {name: '自建行情', exact: true}).click();
    await expect(center().locator('.dc-market-row')).toHaveCount(3);
    record('tab return restores the managed list');
    expect(report.errors).toEqual([]);
    report.passed = true;
  } finally {
    await browser.close();
    // The licensed host may register its alerts sidebar on a new workspace.
    // Remove only that verified test addition, using optimistic revision.
    const widgetbar = (await get('advanced-charts/preferences')).find(row => row.id === originalWidgetbar.id);
    if (JSON.stringify(widgetbar.content) !== JSON.stringify(originalWidgetbar.content)) {
      const original = JSON.parse(originalWidgetbar.content.value), current = JSON.parse(widgetbar.content.value);
      expect(original.widgets.alerts).toBeUndefined();
      expect(current.widgets.alerts).toHaveLength(1);
      delete current.widgets.alerts;
      expect(current).toEqual(original);
      const restored = await agent.post(base + '/api/advanced-charts/preferences/save',
        {headers, data: {...widgetbar, content: originalWidgetbar.content}});
      expect(restored.ok()).toBeTruthy();
      report.test_sidebar_registration_removed = true;
    }
    if (workspace?.id) {
      const latest = await get('advanced-charts/workspaces/' + workspace.id);
      const cleanup = await agent.post(base + '/api/advanced-charts/workspaces/' + workspace.id + '/delete',
        {headers, data: {revision: latest.revision}});
      expect(cleanup.ok()).toBeTruthy();
      report.disposable_workspace_removed = true;
    }
    await agent.dispose();
    fs.writeFileSync(path.join(output, 'dev-browser.json'), JSON.stringify(report, null, 2) + '\n');
  }
})().catch(error => {console.error(error.message); process.exitCode = 1;});
