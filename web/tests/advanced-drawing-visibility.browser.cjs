// Native category ranges, synchronization, undo and old layout compatibility.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../advanced-host'),origin='https://mw-periods.invalid';
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 try {
  const page=await browser.newPage({viewport:{width:1500,height:950}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const html=fs.readFileSync(path.join(__dirname,'fixtures/native-history.html'),'utf8')
   .replace('enabled_features:[',"enabled_features:['support_multicharts',")
   .replaceAll("supported_resolutions:['5','1D']","supported_resolutions:['1','5','15','30','60','240','1D','1W','1M']")
   .replace("intraday_multipliers:['5']","intraday_multipliers:['1','5','15','30','60','240']");
  await page.route('**/*',route=>{
   const u=new URL(route.request().url());if(u.origin!==origin)return route.fulfill({status:204,body:''});
   if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:html});
   const file=path.resolve(root,'.'+u.pathname);
   if(!file.startsWith(root+'/')||!fs.existsSync(file))return route.fulfill({status:404});
   return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream',body:fs.readFileSync(file)});
  });
  const read=()=>page.evaluate(()=>[0,1,2].map(i=>widget.chart(i).getAllShapes().map(s=>{
   const source=widget.chart(i)._chartWidget.model().model().dataSourceForId(s.id);
   return {id:s.id,hidden:source.isSourceHidden(),ranges:source.properties().childs().intervalsVisibilities.state()};
  })));
  await page.goto(origin+'/?initialCount=1000');await page.waitForFunction(()=>ready&&widget.activeChart().dataReady());
  await page.evaluate(()=>{widget.setLayout('3h');widget.activeChart().drawOnAllCharts(true);});
  await page.waitForFunction(()=>widget.chartsCount()===3);
  await page.evaluate(()=>Promise.all(['1','5','15'].map((r,i)=>new Promise(ok=>widget.chart(i).setResolution(r,ok)))));
  await page.waitForFunction(()=>[0,1,2].every(i=>widget.chart(i).dataReady()));
  const id=await page.evaluate(()=>widget.chart(0).createShape({time:widget.chart(0).getVisibleRange().to-600,price:105},{shape:'horizontal_line'}));
  await page.waitForFunction(()=>[0,1,2].every(i=>widget.chart(i).getAllShapes().length===1));
  const ui=page.frames().find(f=>f!==page.mainFrame());
  await page.evaluate(id=>widget.chart(0).showPropertiesDialog(id),id);
  await ui.getByText('可见范围',{exact:true}).click();
  for(const category of ['Minutes','Hours','Days','Weeks','Months'])await expect(ui.locator(`[data-qa-id="property-dialog-item IntervalsVisibilities${category}"]`).first()).toBeVisible();
  assert.equal(await ui.locator('[data-qa-id*="MWDrawing"]').count(),0);
  for(const label of ['M1','M5','M15','M30','H1','H4','D1','W1','MN'])assert.equal(await ui.getByLabel(label,{exact:true}).count(),0);
  const minutes=ui.locator('[data-qa-id="property-dialog-item IntervalsVisibilitiesMinutes"]');
  await minutes.locator('input[name=from-input]').fill('5');await minutes.locator('input[name=from-input]').press('Tab');
  await minutes.locator('input[name=to-input]').fill('15');await minutes.locator('input[name=to-input]').press('Tab');
  await ui.getByRole('button',{name:'确认',exact:true}).click();
  await page.waitForFunction(()=>widget.chart(0)._chartWidget.model().model().dataSourceForId(widget.chart(0).getAllShapes()[0].id).isSourceHidden());
  const edited=await read();assert.deepEqual(edited.map(s=>s[0].hidden),[true,false,false]);
  assert.ok(edited.every(s=>s[0].ranges.minutesFrom===5&&s[0].ranges.minutesTo===15));
  await page.evaluate(()=>{widget.undo();widget.undo();});assert.deepEqual((await read()).map(s=>s[0].hidden),[false,false,false]);
  await page.evaluate(()=>{widget.redo();widget.redo();});assert.deepEqual((await read()).map(s=>s[0].hidden),[true,false,false]);
  await page.evaluate(id=>widget.chart(0).showPropertiesDialog(id),id);await ui.getByText('可见范围',{exact:true}).click();
  await minutes.locator('input[name=from-input]').fill('10');await minutes.locator('input[name=from-input]').press('Tab');
  await ui.getByRole('button',{name:'取消',exact:true}).click();
  assert.ok((await read()).every(s=>s[0].ranges.minutesFrom===5));
  // A saved custom mwMask must not override native category fields on reload.
  await page.evaluate(()=>new Promise(ok=>widget.save(layout=>{
   window.savedVisibility=layout;
   for(const chart of layout.charts)for(const pane of chart.panes)for(const source of pane.sources)
    if(source.type==='LineToolHorzLine')source.state.intervalsVisibilities.mwMask=1;
   widget.load(layout);ok();
  })));
  await page.waitForFunction(()=>widget.chartsCount()===3&&[0,1,2].every(i=>widget.chart(i).dataReady()&&widget.chart(i).getAllShapes().length===1));
  assert.deepEqual((await read()).map(s=>s[0].hidden),[true,false,false]);
  for(const [resolution,visible] of [['1',false],['5',true],['15',true],['30',false],['60',true],['240',true],['1D',true],['1W',true],['1M',true]]){
   await page.evaluate(r=>new Promise(ok=>widget.chart(0).setResolution(r,ok)),resolution);
   assert.equal((await read())[0][0].hidden,!visible,resolution);
  }
  const multi=await page.evaluate(async()=>{
   const win=widget._innerWindow();let req;win.webpackChunktradingview.push([['native-ranges-test'],{},r=>{req=r}]);
   const chart=widget.chart(0),undo=chart._chartWidget.model(),model=undo.model();
   await chart.createShape({time:chart.getVisibleRange().to-86400,price:103},{shape:'horizontal_line',overrides:{intervalsVisibilities:{minutes:true,minutesFrom:1,minutesTo:59}}});
   const objects=chart.getAllShapes().map(s=>model.dataSourceForId(s.id).properties().childs().intervalsVisibilities.childs());
   const collected=Object.fromEntries(Object.keys(objects[0]).map(k=>[k,objects.map(o=>o[k])]));
   const definitions=req(887608).getSelectionIntervalsVisibilitiesPropertiesDefinition(collected,undo).definitions;
   const range=definitions.find(d=>d.id==='IntervalsVisibilitiesMinutes');
   const before=objects.map(o=>o.minutesFrom.value());range.properties.from.setValue(10);
   return {before,after:objects.map(o=>o.minutesFrom.value())};
  });
  assert.deepEqual(multi.before,[5,1]);assert.deepEqual(multi.after,[10,10]);
  await page.evaluate(()=>widget.undo());assert.deepEqual((await read())[0].map(s=>s.ranges.minutesFrom),multi.before);
  await page.evaluate(()=>widget.redo());assert.ok((await read())[0].every(s=>s.ranges.minutesFrom===10));
  await page.setViewportSize({width:430,height:800});
  await page.evaluate(()=>widget.chart(0).showPropertiesDialog(widget.chart(0).getAllShapes()[0].id));
  await ui.getByText('可见范围',{exact:true}).click();await expect(minutes.locator('input[name=from-input]')).toBeVisible();
  await ui.getByRole('button',{name:'取消',exact:true}).click();
  assert.deepEqual(errors,[]);console.log('PASS original native drawing visibility: ranges, pane sync, undo/redo, cancel, old layouts, resolutions and multi-selection');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
