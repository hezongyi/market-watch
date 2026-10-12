// Actual Docker native controls and data-center; no intercepted responses.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),assert=require('node:assert/strict');
const base='http://127.0.0.1:20271',origin='http://127.0.0.1:20272',out='/tmp/mw-pending-fixes-20261013-private';
(async()=>{
 const browser=await chromium.launch({executablePath:chromium.executablePath(),args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1600,height:1100}}),errors=[],checks=[];
 page.on('pageerror',e=>errors.push(e.message));
 try {
  await page.goto(base+'/advanced-charts');await page.getByLabel('管理员密码').fill(fs.readFileSync(out+'/password','utf8'));
  await page.getByRole('button',{name:'登录工作台'}).click();
  await expect.poll(()=>page.frames().some(f=>f.url().startsWith(origin+'/?')),{timeout:30000}).toBe(true);
  const host=page.frames().find(f=>f.url().startsWith(origin+'/?'));
  await host.waitForFunction(()=>ready&&!loading&&widget.activeChart().dataReady(),null,{timeout:60000});
  await host.evaluate(()=>widget.setLayout('1'));await host.waitForFunction(()=>widget.chartsCount()===1&&widget.activeChart().dataReady());
  const native=()=>page.frames().find(f=>f.url().startsWith('blob:'));
  await host.evaluate(async()=>{
   const chart=widget.activeChart();window.uiShape=await chart.createShape({time:chart.getVisibleRange().to-600,price:84000},{shape:'horizontal_line'});
   chart.showPropertiesDialog(uiShape);
  });
  const ui=native();await ui.getByText('可见范围',{exact:true}).click();
  const minute=ui.locator('[data-qa-id="property-dialog-item MWDrawingRangeminutes"]');
  await minute.locator('input[name=from-input]').fill('5');await minute.locator('input[name=from-input]').press('Tab');
  await ui.getByLabel('M15',{exact:true}).uncheck();
  await expect(ui.getByText('自定义周期：M5、M30',{exact:true})).toBeVisible();
  await ui.getByRole('button',{name:'确认',exact:true}).click();
  await host.evaluate(()=>widget.activeChart().showPropertiesDialog(uiShape));
  await ui.getByRole('button',{name:'模板',exact:true}).click();
  await ui.getByText('保存为…',{exact:true}).click();
  const templateName='Pending native range '+Date.now();
  await ui.locator('[data-qa-id=ui-lib-Input-input]').last().fill(templateName);
  await ui.locator('[data-qa-id=save-btn]').click();
  await expect.poll(async()=>{
    const templates=await (await page.request.get(base+'/api/advanced-charts/preferences')).json();
    return templates.some(t=>t.kind==='drawing'&&t.name===templateName);
  }).toBe(true);
  await ui.getByRole('button',{name:'确认',exact:true}).click();
  await host.evaluate(async()=>{
    const chart=widget.activeChart();chart.removeEntity(uiShape);
    uiShape=await chart.createShape({time:chart.getVisibleRange().to-600,price:84000},{shape:'horizontal_line'});
    chart.showPropertiesDialog(uiShape);
  });
  await ui.getByRole('button',{name:'模板',exact:true}).click();
  await ui.getByText(templateName,{exact:true}).click();
  await ui.getByText('可见范围',{exact:true}).click();
  await expect(ui.getByLabel('M15',{exact:true})).not.toBeChecked();
  await expect(ui.getByLabel('M5',{exact:true})).toBeChecked();
  await expect(ui.getByLabel('M30',{exact:true})).toBeChecked();
  await ui.getByRole('button',{name:'确认',exact:true}).click();
  assert.equal(await host.evaluate(()=>widget.activeChart()._chartWidget.model().model().dataSourceForId(uiShape).properties().childs().intervalsVisibilities.state().mwMask),506);
  checks.push('native drawing template UI save/apply with real persisted preferences preserves non-contiguous mask');
  const properties=await host.evaluate(()=>widget.activeChart()._chartWidget.model().model().dataSourceForId(uiShape).properties().state());
  const visibility=await host.evaluate(()=>widget.activeChart()._chartWidget.model().model().dataSourceForId(uiShape).properties().childs().intervalsVisibilities.state());
  assert.equal(visibility.mwMask,506);
  const session=await (await page.request.get(base+'/api/session')).json();
  const existing=await (await page.request.get(base+'/api/advanced-charts/preferences')).json();
  const previous=existing.find(r=>r.kind==='drawing'&&r.name==='Pending range template');
  const template=await page.request.post(base+'/api/advanced-charts/preferences/save',{headers:{'X-CSRF-Token':session.csrf},data:{kind:'drawing',tool:'LineToolHorzLine',name:'Pending range template',revision:previous?.revision || 0,content:{value:JSON.stringify(properties)}}});
  assert.ok(template.ok(),await template.text());
  const stored=await template.json();
  await host.evaluate(async properties=>{
    const chart=widget.activeChart();chart.removeEntity(uiShape);
    uiShape=await chart.createShape({time:chart.getVisibleRange().to-600,price:84000},{shape:'horizontal_line',overrides:properties});
  },JSON.parse(stored.content.value));
  await host.evaluate(()=>widget.activeChart().showPropertiesDialog(uiShape));
  await ui.getByText('可见范围',{exact:true}).click();await expect(ui.getByLabel('M15',{exact:true})).not.toBeChecked();
  await ui.getByRole('button',{name:'取消',exact:true}).click();
  checks.push('native drawing range controls in Docker','non-contiguous mask survives persisted drawing property template');
  await host.evaluate(()=>dataCenter.open('/market-data?tab=composite'));
  await expect(ui.locator('.dc-window')).toBeVisible();
  await ui.getByRole('button',{name:'已建立组合',exact:true}).click();
  const row=ui.locator('.dc-market-row').first();await expect(row).toBeVisible();
  await row.getByRole('button',{name:'查看详情',exact:true}).click();
  await expect(ui.locator('.dc-detail-panel')).toBeVisible();
  const geometry=await row.evaluate(n=>({main:n.querySelector('.dc-market-main').getBoundingClientRect().width,row:n.getBoundingClientRect().width,overflow:n.scrollWidth>n.clientWidth+1,mode:document.querySelector('.dc-window-content').getAttribute('data-detail-mode')}));
  const responsive=[];
  for(const theme of ['Light','Dark']){
    await host.evaluate(theme=>widget.changeTheme(theme),theme);
    for(const width of [1600,1250,980,720]){
      await page.setViewportSize({width,height:1100});
      await expect(ui.locator('.dc-detail-panel')).toBeVisible();
      await expect.poll(()=>ui.locator('.dc-window').evaluate(n=>n.scrollWidth<=n.clientWidth+1)).toBe(true);
      const layout=await ui.locator('.dc-window-content').getAttribute('data-detail-mode');
      if(layout==='side'){
        await expect(row).toBeVisible();
        await expect.poll(()=>row.evaluate(n=>n.scrollWidth<=n.clientWidth+1&&n.querySelector('.dc-market-main').getBoundingClientRect().width>150)).toBe(true);
      }
      responsive.push({theme,width,mode:layout});
    }
  }
  await page.setViewportSize({width:1600,height:1100});
  await page.screenshot({path:out+'/composite-detail-list.png'});
  if(geometry.mode==='side'){assert.ok(geometry.main>=250);assert.equal(geometry.overflow,false);}
  await page.keyboard.press('Escape');await expect(ui.locator('.dc-detail-panel')).toHaveCount(0);
  await expect(row.getByRole('button',{name:'查看详情',exact:true})).toBeFocused();
  const composites=await (await page.request.get(base+'/api/market-data/center/composites')).json();
  assert.ok(composites.items.length);
  const id=composites.items[0].id;
  await page.keyboard.press('Escape');await expect(ui.locator('.dc-detail-panel')).toHaveCount(0);
  await page.keyboard.press('Escape');await expect(ui.locator('.dc-window')).toHaveCount(0);
  await host.evaluate(id=>dataCenter.open('/market-data/composites/'+id+'?section=seam&tab=composite'),id);
  await ui.getByText('复核来源缺分钟',{exact:true}).first().click();
  const revisions=await (await page.request.get(base+'/api/market-data/composites/'+id+'/revisions')).json(),revision=revisions.items[0];
  const utc=t=>new Date(t).toISOString().slice(0,16);
  await ui.getByLabel('复核开始（UTC）').first().fill(utc(revision.seam));
  await ui.getByLabel('复核结束（UTC）').first().fill(utc(revision.seam+60000));
  await ui.getByRole('button',{name:'复核此区间',exact:true}).first().click();
  const status=ui.getByRole('status').filter({hasText:'核对状态'}),quota=ui.getByRole('alert').filter({hasText:'来源复核每修订每天最多3次'});
  await expect(status.or(quota)).toBeVisible({timeout:30000});
  if(await status.count()){
    await expect(status).toContainText('缺失分钟仍为未知');await expect(status).toContainText('configuration_error');
  }else checks.push('repeat acceptance correctly reaches the three-read quota; no new source read');
  const audit=await (await page.request.get(base+'/api/market-data/composites/'+id+'/requests')).json();
  assert.ok(audit.items.some(r=>r.read_kind==='gap_recheck'&&r.result==='configuration_error'&&!r.accepted));
  checks.push('real composite list detail/focus','real Docker detail at widths 1600/1250/980/720 in light/dark','source-recheck form through real HTTP and audited provider configuration failure','failed source response preserves unknown');
  await page.keyboard.press('Escape');await expect(ui.locator('.dc-detail-panel')).toHaveCount(0);
  await page.keyboard.press('Escape');await expect(ui.locator('.dc-window')).toHaveCount(0);
  await page.evaluate(origin=>document.querySelector('iframe').contentWindow.postMessage({channel:'mw-chart-v1',type:'notifications',notices:[{id:'test-network',text:'Synthetic transient network check'}]},origin),origin);
  await expect(host.locator('.mw-chart-notice')).toHaveCount(1);
  assert.ok((await host.locator('.mw-chart-notices').boundingBox()).x>800);
  await host.getByRole('button',{name:'关闭图表提示'}).click();
  assert.deepEqual(errors,[]);checks.push('non-modal right-bottom notice in deployed host');
  const evidence={environment:'Ubuntu task-owned Docker mw-pending-fixes-20261013; actual native host, data-center and HTTP',passed:true,checks,geometry,responsive,errors};
  fs.writeFileSync(out+'/docker-ui.json',JSON.stringify(evidence,null,2));console.log('PASS Docker native UI',JSON.stringify(evidence));
 }catch(error){console.error('UI_STATE',JSON.stringify({errors,body:await page.locator('body').innerText(),frames:page.frames().map(f=>f.url().split('?')[0])}));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
