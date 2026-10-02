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
  let originalTheme, originalGrid, testWorkspace, testStyle;
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
    originalGrid = preferences.find(row => row.kind === 'setting' && row.name === 'mw.gridStyle');
    originalTheme = preferences.find(row => row.kind === 'setting' && row.name === 'mw.theme');
    testWorkspace = await api('advanced-charts/workspaces', {name: '主题菜单验证'});
    await api('advanced-charts/workspaces/' + testWorkspace.id + '/save', {
      name: testWorkspace.name, revision: testWorkspace.revision,
      document: {engine: 'tv31', schemaVersion: 1, symbol: 'MWP:BTCUSDT',
        series_kind: 'provider', interval: '5'}});
    await page.goto(APP + '/advanced-charts');
    let {frame, ui} = await chart();
    // Observe real native canvas rendering without replacing data or vendor code.
    await ui.evaluate(()=>{
      window.__timerDraws=[];window.__gridDraws=[];
      const original=CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText=function(text,x,y,...rest){
        if (/^\d{2}:\d{2}(?::\d{2})?$/.test(String(text))) {
          const b=this.canvas.getBoundingClientRect();
          window.__timerDraws.push({text:String(text),x:b.x+x,y:b.y+y,at:Date.now(),canvasWidth:b.width});
        }
        return original.call(this,text,x,y,...rest);
      };
      const dash=CanvasRenderingContext2D.prototype.setLineDash;
      CanvasRenderingContext2D.prototype.setLineDash=function(value){
        if(value.length)window.__gridDraws.push([...value]);return dash.call(this,value);
      };
    });
    await frame.evaluate(()=>widget.applyOverrides({'mainSeriesProperties.showCountdown':true}));
    await frame.evaluate(()=>new Promise(resolve=>feed.getServerTime(resolve))).then(time=>{
      assert.ok(Number.isSafeInteger(time)&&time>1e9&&time<1e11);report.server_time_seconds=time;
    });
    await page.waitForTimeout(7000);
    report.native_time_draws=await ui.evaluate(()=>window.__timerDraws.slice(-30));
    report.datafeed=await frame.evaluate(()=>({resolution:widget.activeChart().resolution(),
      subscriptions:[...subscriptions.values()].map(s=>({symbol:s.symbol,last:s.last,res:s.res})),
      histories:[...lastHistory.entries()].map(([key,value])=>({key,value}))}));
    assert.ok(report.native_time_draws.some(draw=>draw.canvasWidth<180), 'countdown rendered on price-axis canvas');
    const axis=report.native_time_draws.filter(draw=>draw.canvasWidth<180);
    assert.ok(new Set(axis.map(draw=>draw.text)).size>1,'countdown must change each second');
    assert.equal(await ui.getByText('导出 CSV',{exact:true}).count(),0);
    assert.equal(await ui.getByText('使用说明',{exact:true}).count(),0);
    assert.equal(await ui.getByText('返回守望',{exact:true}).count(),0);
    await ui.getByRole('button',{name:'图表菜单',exact:true}).click();
    for (const name of ['守望主页','保存样式','维护历史','刷新历史','历史任务'])
      await ui.getByRole('button',{name,exact:true}).waitFor({state:'visible'});
    let grid=ui.getByLabel('网格线样式');
    report.grid_initial=await grid.inputValue();
    for(const value of ['solid','dotted']) {
      const saved=page.waitForResponse(r=>r.url().endsWith('/advanced-charts/preferences/save')&&r.request().postDataJSON()?.name==='mw.gridStyle');
      await grid.selectOption(value);assert.equal((await saved).status(),200);
      await grid.waitFor({state:'visible'});
      await page.waitForTimeout(500);
      if(value==='solid'){
        await page.reload();({frame,ui}=await chart());
        await ui.getByRole('button',{name:'图表菜单',exact:true}).click();
        grid=ui.getByLabel('网格线样式');
        assert.equal(await grid.inputValue(),'solid','solid style survives reload');
        report.grid_solid_reload=true;
      }
    }
    await page.keyboard.press('Escape');
    report.grid_persistence=true;
    await page.screenshot({path:output.replace(/\.json$/,'-chart.png')});
    await ui.getByRole('button',{name:'图表菜单',exact:true}).click();
    assert.equal(await ui.locator('[data-name="custom-tradingview-styled-button"]').filter({hasText:'保存样式'}).count(),0);
    const templateName='菜单样式验证-'+Date.now();
    const styleSaved=page.waitForResponse(r=>r.url().endsWith('/advanced-charts/preferences/save')&&r.request().postDataJSON()?.kind==='chart'&&r.request().postDataJSON()?.name===templateName);
    page.once('dialog',dialog=>dialog.accept(templateName));
    await ui.getByRole('button',{name:'保存样式',exact:true}).click();
    assert.equal((await styleSaved).status(),200);
    await ui.getByText('样式已保存',{exact:true}).waitFor();
    await page.keyboard.press('Escape');
    const style= testStyle = (await api('advanced-charts/preferences')).find(row=>row.kind==='chart'&&row.name===templateName);
    assert.ok(style?.content.value.mainSourceProperties);
    assert.equal(style?.content.value.mainSourceProperties.symbol,undefined);
    await frame.evaluate(()=>widget.activeChart().executeActionById('chartProperties'));
    await ui.getByText('模板',{exact:true}).click();
    await ui.getByText(templateName,{exact:true}).waitFor();
    await ui.getByText(templateName,{exact:true}).click();
    await page.keyboard.press('Escape');
    report.menu_style_save_and_apply=true;
    await api('advanced-charts/preferences/'+style.id+'/delete',{revision:style.revision});
    const before=await page.locator('iframe[title="专业图表工作区"]').boundingBox();
    await page.evaluate(()=>{
      const f=document.querySelector('iframe[title="专业图表工作区"]');
      f.contentWindow.postMessage({channel:'mw-chart-v1',type:'notifications',draftBlocked:true,
        notices:[{id:'draft',text:'草稿验证：是否复制恢复为独立工作区？',recover:true}]},new URL(f.src).origin);
    });
    await ui.getByText('草稿验证：是否复制恢复为独立工作区？',{exact:true}).waitFor();
    const after=await page.locator('iframe[title="专业图表工作区"]').boundingBox();
    assert.deepEqual(before,after,'native notice must not shift chart');
    await ui.getByRole('button',{name:/^(取消|Cancel|否|No)$/i}).click();
    await page.evaluate(()=>{
      const f=document.querySelector('iframe[title="专业图表工作区"]');
      f.contentWindow.postMessage({channel:'mw-chart-v1',type:'notifications',draftBlocked:true,
        notices:[{id:'draft',text:'草稿验证：是否复制恢复为独立工作区？',recover:true}]},new URL(f.src).origin);
    });
    await page.waitForTimeout(500);
    assert.equal(await ui.getByText('草稿验证：是否复制恢复为独立工作区？',{exact:true}).count(),0);
    await ui.getByRole('button',{name:'图表菜单',exact:true}).click();
    await ui.getByRole('button',{name:'复制恢复草稿',exact:true}).waitFor({state:'visible'});
    await page.keyboard.press('Escape');
    report.notification={native:true,deduplicated:true,iframe_before:before,iframe_after:after};
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
