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
  let originalTheme, originalGrid, originalAuto, testWorkspace, testStyle;
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
    originalAuto = preferences.find(row => row.kind === 'setting' && row.name === 'mw.autoSave');
    originalGrid = preferences.find(row => row.kind === 'setting' && row.name === 'mw.gridStyle');
    originalTheme = preferences.find(row => row.kind === 'setting' && row.name === 'mw.theme');
    testWorkspace = await api('advanced-charts/workspaces', {name: '主题菜单验证'});
    await api('advanced-charts/workspaces/' + testWorkspace.id + '/save', {
      name: testWorkspace.name, revision: testWorkspace.revision,
      document: {engine: 'tv31', schemaVersion: 1, symbol: 'MWP:BTCUSDT',
        series_kind: 'provider', interval: '5'}});
    await page.goto(APP + '/advanced-charts');
    let {frame,ui}=await chart();
    await ui.locator('[data-name="save-load-menu"]').filter({visible:true}).click();
    const toggle=ui.getByRole('switch',{name:'自动保存',exact:true});
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'),'false','default off');
    assert.equal(await ui.locator('[data-name="mw-layout-create"]').count(),1);
    await page.keyboard.press('Escape');
    let writes=[];
    page.on('request',r=>{
      if(r.method()==='POST'&&r.url().endsWith('/advanced-charts/native-charts/save'))
        writes.push({at:Date.now(),args:r.postDataJSON()});
    });
    await frame.evaluate(()=>widget.activeChart().setChartType(0));
    await frame.evaluate(()=>widget.activeChart().setChartType(1));
    await frame.waitForFunction(()=>dirty===true);
    await page.waitForTimeout(33000);
    assert.equal(writes.length,0,'disabled autosave must not write changed layout');
    report.disabled_no_writes_for_ms=33000;
    await ui.locator('[data-name="save-load-menu"]').filter({visible:true}).click();
    const preferenceSaved=page.waitForResponse(r=>r.url().endsWith('/advanced-charts/preferences/save')&&r.request().postDataJSON()?.name==='mw.autoSave');
    const enabledAt=Date.now();
    await toggle.click();assert.equal((await preferenceSaved).status(),200);
    await toggle.waitFor();assert.equal(await toggle.getAttribute('aria-checked'),'true');
    await page.screenshot({path:output.replace(/\.json$/,'-menu.png')});
    await page.keyboard.press('Escape');
    const automatic=page.waitForResponse(r=>r.url().endsWith('/advanced-charts/native-charts/save')&&r.status()===200,{timeout:45000});
    await automatic;
    assert.equal(writes.length,1,'one timer-driven layout save');
    assert.ok(writes[0].at-enabledAt>=29500,'must wait 30s');
    report.auto_save_delay_ms=writes[0].at-enabledAt;
    await page.reload();({frame,ui}=await chart());
    await ui.locator('[data-name="save-load-menu"]').filter({visible:true}).click();
    const restoredToggle=ui.getByRole('switch',{name:'自动保存',exact:true});
    assert.equal(await restoredToggle.getAttribute('aria-checked'),'true');
    const disabledSaved=page.waitForResponse(r=>r.url().endsWith('/advanced-charts/preferences/save')&&r.request().postDataJSON()?.name==='mw.autoSave');
    await restoredToggle.click();await disabledSaved;
    await page.keyboard.press('Escape');
    await frame.evaluate(()=>widget.activeChart().setChartType(0));
    await frame.waitForFunction(()=>dirty===true);
    writes=[];
    const manuallySaved=page.waitForResponse(r=>r.url().endsWith('/advanced-charts/native-charts/save')&&r.status()===200);
    await ui.locator('[data-name="save-load-menu"]').filter({visible:true}).click();
    await ui.locator('[data-name="save-load-menu-item-save"]').click();
    await manuallySaved;assert.equal(writes.length,1,'manual save works when off');
    await ui.locator('[data-name="save-load-menu"]').filter({visible:true}).click();
    const createEntry=ui.locator('[data-name="mw-layout-create"]');
    await createEntry.waitFor();
    page.once('dialog',dialog=>dialog.dismiss());
    await createEntry.click();
    await createEntry.waitFor({state:'hidden'});
    report.layout_create_click=true;
    report.manual_save_while_off=true;report.preference_reloads=true;
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
    const autoCurrent=preferences.find(row=>row.kind==='setting'&&row.name==='mw.autoSave');
    if(autoCurrent){
      if(originalAuto)await api('advanced-charts/preferences/save',{kind:originalAuto.kind,name:originalAuto.name,tool:originalAuto.tool,content:originalAuto.content,revision:autoCurrent.revision});
      else await api('advanced-charts/preferences/'+autoCurrent.id+'/delete',{revision:autoCurrent.revision});
    }
    if(testStyle){const liveStyle=preferences.find(row=>row.id===testStyle.id);if(liveStyle)await api('advanced-charts/preferences/'+liveStyle.id+'/delete',{revision:liveStyle.revision});}
    const gridCurrent=preferences.find(row=>row.name==='mw.gridStyle'&&row.kind==='setting');
    if(gridCurrent && report.grid_initial !== undefined) {
      if(originalGrid)await api('advanced-charts/preferences/save',{kind:originalGrid.kind,name:originalGrid.name,tool:originalGrid.tool,content:originalGrid.content,revision:gridCurrent.revision});
      else await api('advanced-charts/preferences/'+gridCurrent.id+'/delete',{revision:gridCurrent.revision});
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
