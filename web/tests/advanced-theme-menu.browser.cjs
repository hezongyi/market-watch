// Real local Docker UI; verify menu clicks and server-backed theme restore.
const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const APP = process.env.APP_ORIGIN || 'https://localhost:15453';
const CHART = process.env.CHART_ORIGIN || 'https://127.0.0.1:15454';
const output = process.env.THEME_MENU_OUTPUT || '/tmp/mw-theme-menu.json';
(async () => {
  const browser = await chromium.launch({headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const page = await browser.newPage({ignoreHTTPSErrors: true,
    viewport: {width: 1600, height: 950}});
  const report = {passed: false, cases: [], errors: []};
  page.on('pageerror', error => report.errors.push(error.message));
  let originalTheme, testWorkspace;
  async function api(route, body) {
    return page.evaluate(async ({route, body}) => {
      const {csrf} = await (await fetch('/api/session')).json();
      const response = await fetch('/api/' + route, {method: body ? 'POST' : 'GET',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': csrf},
        body: body ? JSON.stringify(body) : undefined});
      if (!response.ok) throw Error(route + ' HTTP ' + response.status);
      return response.json();
    }, {route, body});
  }
  async function chart() {
    await page.frameLocator('iframe[title="专业图表工作区"]').locator('#chart').waitFor();
    const frame = page.frames().find(frame => frame.url().startsWith(CHART + '/'));
    await frame.waitForFunction(() => typeof ready !== 'undefined' && ready, null, {timeout: 60000});
    return {frame, ui: frame.childFrames()[0]};
  }
  try {
    await page.goto(APP + '/');
    await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(
      process.env.MARKET_WATCH_TEST_CREDENTIALS ||
      path.resolve(__dirname, '../../../market-watch/artifacts/local-credentials.json'))).password);
    await page.getByRole('button', {name: '登录工作台'}).click();
    await page.waitForFunction(() => !document.querySelector('input[type="password"]'));
    const preferences = await api('advanced-charts/preferences');
    originalTheme = preferences.find(row => row.kind === 'setting' && row.name === 'mw.theme');
    testWorkspace = await api('advanced-charts/workspaces', {name: '主题菜单验证'});
    await api('advanced-charts/workspaces/' + testWorkspace.id + '/save', {
      name: testWorkspace.name, revision: testWorkspace.revision,
      document: {engine: 'tv31', schemaVersion: 1, symbol: 'MWP:BTCUSDT',
        series_kind: 'provider', interval: '5'}});
    await page.goto(APP + '/advanced-charts');
    for (const [label, theme] of [['浅色主题', 'Light'], ['暗色主题', 'Dark']]) {
      let {frame, ui} = await chart();
      const menu = ui.getByRole('button', {name: /图表菜单/}).filter({visible: true});
      assert.equal(await menu.count(), 1);
      const box = await menu.boundingBox();
      await menu.click();
      await ui.getByText(label, {exact: true}).click();
      await frame.waitForFunction(theme => widget.getTheme().toLowerCase() === theme.toLowerCase(), theme);
      await page.waitForFunction(async theme => {
        const rows = await (await fetch('/api/advanced-charts/preferences')).json();
        return rows.find(row => row.name === 'mw.theme')?.content.value === theme;
      }, theme);
      await menu.click();
      await page.screenshot({path: output.replace(/\.json$/, '-' + theme.toLowerCase() + '.png')});
      await page.keyboard.press('Escape');
      await page.reload();
      ({frame, ui} = await chart());
      assert.equal((await frame.evaluate(() => widget.getTheme())).toLowerCase(), theme.toLowerCase());
      report.cases.push({theme,menu_box:box,clicked:true,server_saved:true,reloaded:true});
    }
    // Exercise the same menu without a mouse, including Escape dismissal.
    const {ui} = await chart();
    const menu = ui.getByRole('button', {name: /图表菜单/}).filter({visible: true});
    await menu.focus();
    await page.keyboard.press('Enter');
    await ui.getByText('浅色主题', {exact: true}).waitFor();
    await page.keyboard.press('Escape');
    await ui.getByText('浅色主题', {exact: true}).waitFor({state: 'hidden'});
    report.keyboard_open_and_escape = true;
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) {
    report.error = String(error);
    throw error;
  } finally {
    await page.goto(APP + '/').catch(() => {});
    const preferences = await api('advanced-charts/preferences').catch(() => []);
    const current = preferences.find(row => row.name === 'mw.theme' && row.kind === 'setting');
    if (current) {
      if (originalTheme) await api('advanced-charts/preferences/save', {
        kind: originalTheme.kind, name: originalTheme.name, tool: originalTheme.tool,
        content: originalTheme.content, revision: current.revision});
      else await api('advanced-charts/preferences/' + current.id + '/delete', {revision: current.revision});
    }
    if (testWorkspace) {
      const rows = await api('advanced-charts/workspaces');
      const row = rows.find(row => row.id === testWorkspace.id);
      if (row) await api('advanced-charts/workspaces/' + row.id + '/delete', {revision: row.revision});
    }
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
    await browser.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
