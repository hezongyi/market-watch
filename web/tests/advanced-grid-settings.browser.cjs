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
    let {frame,ui}=await chart();
    const sample=async()=>{
      await ui.evaluate(()=>{window.__grid=[];const old=CanvasRenderingContext2D.prototype.setLineDash;
        CanvasRenderingContext2D.prototype.setLineDash=function(value){
          if(/rgba\((242|42),/.test(this.strokeStyle))window.__grid.push({dash:[...value],color:this.strokeStyle,width:this.canvas.getBoundingClientRect().width});
          return old.call(this,value);
        };
      });
      await frame.evaluate(()=>widget.activeChart().getTimeScale().setBarSpacing(widget.activeChart().getTimeScale().barSpacing()+.01));
      await page.waitForTimeout(1000);
      return ui.evaluate(()=>[...new Set(window.__grid.map(x=>JSON.stringify(x)))].map(x=>JSON.parse(x)));
    };
    report.initial=await sample();
    for(const layout of ['2h','4']){
      await frame.evaluate(layout=>widget.setLayout(layout),layout);
      await page.waitForTimeout(1500);
      report['layout_'+layout]=await sample();
    }
    await frame.evaluate(()=>widget.setLayout('s'));
    for(const theme of ['Light','Dark']){
      await frame.evaluate(theme=>widget.changeTheme(theme),theme);
      await page.waitForTimeout(1000);
      report['theme_'+theme]=await sample();
    }
    await page.reload();({frame,ui}=await chart());
    report.reload=await sample();
    const gridValue = grid => grid.getAttribute('data-value');
    const chooseGrid = async (grid, value) => {
      await grid.click();
      await ui.getByRole('option', {name:value==='solid'?'实线':'点线',exact:true}).click();
    };
    const openGrid = async () => {
      await frame.evaluate(()=>widget.activeChart().executeActionById('chartProperties'));
      await ui.getByText('版面',{exact:true}).click();
      return ui.getByRole('combobox',{name:'网格线样式',exact:true});
    };
    await frame.evaluate(()=>widget.activeChart().executeActionById('chartProperties'));
    await ui.getByText('版面',{exact:true}).click();
    let grid=ui.getByRole('combobox',{name:'网格线样式',exact:true});
    report.grid_initial=await gridValue(grid);
    report.control_skin=await grid.evaluate(e=>{
      const native=document.querySelector('[data-qa-id="property-dialog-item gridLines"] [data-name="options-dropdown"]');
      const style=e=>{const s=getComputedStyle(e);return {height:s.height,width:s.width,border:s.border,color:s.color,background:s.backgroundColor};};
      return {native:style(native),custom:style(e)};
    });
    assert.deepEqual(report.control_skin.custom,report.control_skin.native,'same native disclosure skin');
    await grid.click();
    const popup=ui.getByRole('listbox',{name:'网格线样式'});
    const popupBounds=await popup.boundingBox(),buttonBounds=await grid.boundingBox();
    assert.ok(Math.abs(popupBounds.x-buttonBounds.x)<1,'popup left aligns to control');
    assert.ok(Math.abs(popupBounds.width-buttonBounds.width)<1,'popup width aligns to control');
    assert.ok(Math.abs(popupBounds.y-(buttonBounds.y+buttonBounds.height+4))<1,'popup is directly below control');
    report.popup_alignment={button:buttonBounds,popup:popupBounds};
    await page.screenshot({path:'/tmp/mw-grid-settings-popup.png'});
    await page.keyboard.press('Escape');
    assert.equal(await popup.count(),0,'Escape closes just the popup');
    await grid.waitFor();

    assert.equal(await ui.evaluate(()=>document.querySelector('[data-qa-id="property-dialog-item gridLines"]')?.nextElementSibling?.nextElementSibling?.dataset.name),'mw-grid-style-label');
    await chooseGrid(grid, 'solid');await ui.locator('[data-name="submit-button"]').click();await page.waitForTimeout(1000);report.solid=await sample();
    await frame.evaluate(()=>new Promise((resolve,reject)=>widget.saveChartToServer(resolve,reject)));
    const rows=await api('advanced-charts/workspaces');const savedRow=rows.find(row=>row.id===testWorkspace.id);
    report.saved_grid=savedRow.document.state._mwGridStyle;assert.equal(report.saved_grid,'solid');
    // Opposite global preference must not override a saved layout.
    const pref=(await api('advanced-charts/preferences')).find(row=>row.kind==='setting'&&row.name==='mw.gridStyle');
    await api('advanced-charts/preferences/save',{kind:pref.kind,name:pref.name,tool:pref.tool,content:{value:'dotted'},revision:pref.revision});
    await page.reload();({frame,ui}=await chart());
    grid=await openGrid();assert.equal(await gridValue(grid),'solid');await page.keyboard.press('Escape');
    report.saved_layout_reload=true;
    await frame.evaluate(()=>widget.activeChart().executeActionById('chartProperties'));
    await ui.getByText('版面',{exact:true}).click();grid=ui.getByRole('combobox',{name:'网格线样式',exact:true});
    await chooseGrid(grid, 'dotted');await ui.getByRole('button',{name:'取消',exact:true}).click();
    await page.waitForTimeout(300);assert.ok((await sample()).every(row=>!row.dash.length));report.cancel_restores=true;
    await frame.evaluate(()=>widget.activeChart().executeActionById('chartProperties'));
    await ui.getByText('版面',{exact:true}).click();grid=ui.getByRole('combobox',{name:'网格线样式',exact:true});
    assert.ok(report.solid.every(row=>row.dash.length===0),'solid must be continuous');
    await chooseGrid(grid, 'dotted');await ui.locator('[data-name="submit-button"]').click();await page.waitForTimeout(1000);
    await page.keyboard.press('Escape');
    // Save a sparse template through the real hamburger entry, change to solid,
    // then apply from native settings. Metadata must travel with the template.
    const templateName='Grid metadata '+Date.now();
    await ui.getByRole('button',{name:'图表菜单',exact:true}).click();
    const templateSaved=page.waitForResponse(r=>r.url().endsWith('/advanced-charts/preferences/save')&&r.request().postDataJSON()?.kind==='chart');
    page.once('dialog',d=>d.accept(templateName));
    await ui.getByRole('button',{name:'保存样式',exact:true}).click();
    await templateSaved;await ui.getByText('样式已保存',{exact:true}).waitFor();
    await page.keyboard.press('Escape');
    testStyle=(await api('advanced-charts/preferences')).find(row=>row.name===templateName);
    assert.equal(testStyle.content.value._mwGridStyle,'dotted');
    grid=await openGrid();await chooseGrid(grid, 'solid');await ui.locator('[data-name="submit-button"]').click();await page.waitForTimeout(500);
    await frame.evaluate(()=>widget.activeChart().executeActionById('chartProperties'));
    await ui.getByText('模板',{exact:true}).click();await ui.getByText(templateName,{exact:true}).click();
    await ui.getByText('版面',{exact:true}).click();
    grid=ui.getByRole('combobox',{name:'网格线样式',exact:true});await grid.waitFor();
    await require('@playwright/test').expect(grid).toHaveAttribute('data-value','dotted');
    await ui.locator('[data-name="submit-button"]').click();
    await page.waitForTimeout(500);report.template_grid_restored=true;
    await frame.evaluate(()=>widget.setLayout('2h'));await page.waitForTimeout(1200);
    await ui.locator('[data-symbol-full]').first().click();
    await ui.locator('[data-symbol-full][data-active="true"] > [class*="indicators-"]').waitFor();
    report.selection={};
    for(const theme of ['Light','Dark']){
      await frame.evaluate(theme=>widget.changeTheme(theme),theme);await page.waitForTimeout(400);
      report.selection[theme]=await ui.evaluate(()=>({
        chart:getComputedStyle(document.querySelector('.chart-container.multiple.active'),'::after').borderColor,
        watchlist:getComputedStyle(document.querySelector('[data-symbol-full][data-active="true"] > [class*="indicators-"]'),'::after').borderColor
      }));
      const expected=theme==='Dark'?'rgb(140, 140, 140)':'rgb(0, 0, 0)';
      assert.equal(report.selection[theme].chart,expected);assert.equal(report.selection[theme].watchlist,expected);
      await page.screenshot({path:'/tmp/mw-selection-'+theme+'.png'});
    }
    await page.screenshot({path:'/tmp/mw-grid-sparse.png'});
    await ui.locator('[data-name="save-load-menu"]').filter({visible:true}).click();
    const menu=await ui.evaluate(()=>{
      const save=document.querySelector('[data-name="save-load-menu-item-save"]');
      const auto=document.querySelector('[data-name="mw-layout-autosave"]');
      const create=document.querySelector('[data-name="mw-layout-create"]');
      const rename=document.querySelector('[data-name="save-load-menu-item-rename"]');
      const textLeft=e=>{const w=document.createTreeWalker(e,NodeFilter.SHOW_TEXT);const r=document.createRange();r.selectNodeContents(w.nextNode());return r.getBoundingClientRect().x;};
      return {order:[...save.parentElement.children].map(e=>e.dataset.name||e.getAttribute('role')),create_after_rename:rename.nextElementSibling===create,save_text_x:textLeft(save),auto_text_x:textLeft(auto)};
    });
    assert.equal(menu.create_after_rename,true);assert.ok(Math.abs(menu.auto_text_x-menu.save_text_x)<1,'autosave text aligns');report.menu_alignment=menu;
    await page.screenshot({path:'/tmp/mw-menu-aligned-sparse.png'});
    await page.keyboard.press('Escape');
    for(const [name,rows] of Object.entries(report).filter(([k])=>k==='initial'||k==='reload'||k.startsWith('theme_')||k.startsWith('layout_'))){
      assert.ok(rows.length>0,name+' grid must draw');
      assert.ok(rows.every(row=>JSON.stringify(row.dash)==='[1,4]'),name+' must remain dotted: '+JSON.stringify(rows));
    }
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
