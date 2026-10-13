// Pinned licensed engine with controlled candles: native property UI, sync,
// undo/redo, clipboard and serialized layout. Full-stack acceptance is separate.
const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../advanced-host'),origin='https://mw-periods.invalid';
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1500,height:950}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 let html=fs.readFileSync(path.join(__dirname,'fixtures/native-history.html'),'utf8')
  .replace('<script>','<script src="/drawing-visibility.js"></script><script>')
  .replace('enabled_features:[',"enabled_features:['support_multicharts',")
  .replaceAll("supported_resolutions:['5','1D']","supported_resolutions:['1','5','15','30','60','240','1D','1W','1M']")
  .replace("intraday_multipliers:['5']","intraday_multipliers:['1','5','15','30','60','240']")
  .replace('const c=widget.activeChart();\n c.onVisibleRangeChanged()', 'MWDrawingVisibility.install(widget._innerWindow());const c=widget.activeChart();\n c.onVisibleRangeChanged()');
 await page.route('**/*',route=>{
  const u=new URL(route.request().url());if(u.origin!==origin)return route.fulfill({status:204,body:''});
  if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:html});
  const file=path.resolve(root,'.'+u.pathname);if(!file.startsWith(root+'/')||!fs.existsSync(file))return route.fulfill({status:404});
  let body=fs.readFileSync(file);
  if(file.endsWith('library.e2f8b3a016c9e1a0b7a5.js')){
   body=body.toString().replace('function d(e,t){const i=t.childs();switch(e.kind())',
    'function d(e,t){const mw=globalThis.parent?.MWDrawingVisibility?.actual(e,t);if(mw!==undefined)return mw;const i=t.childs();switch(e.kind())')
    .replace('calcIsActualInterval(){const e=this._isActualInterval,t=this._properties,i=this._model.mainSeries();',
    'calcIsActualInterval(){globalThis.parent?.MWDrawingVisibility?.ensure(this._properties.childs().intervalsVisibilities);const e=this._isActualInterval,t=this._properties,i=this._model.mainSeries();');
  }
  return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream',body});
 });
 const read=()=>page.evaluate(()=>[0,1,2].map(i=>{const c=widget.chart(i);return c.getAllShapes().map(s=>{
  const n=c._chartWidget.model().model().dataSourceForId(s.id);return {id:s.id,mask:n.properties().childs().intervalsVisibilities.childs().mwMask?.value(),hidden:n.isSourceHidden()};
 });}));
 try {
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
  // Native ranges coexist with nine independent checkable definitions.
  const minuteRange=ui.locator('[data-qa-id="property-dialog-item MWDrawingRangeminutes"]');
  await expect(minuteRange.locator('input[name=from-input]')).toHaveValue('1');
  const track=await minuteRange.locator('[class^=rangeSliderMiddleWrap]').boundingBox();
  const thumb=await minuteRange.locator('[class^=pointer-]').first().boundingBox();
  await page.mouse.move(thumb.x+thumb.width/2,thumb.y+thumb.height/2);await page.mouse.down();
  await page.mouse.move(track.x+track.width*0.4,thumb.y+thumb.height/2,{steps:8});await page.mouse.up();
  await expect(minuteRange.locator('input[name=from-input]')).not.toHaveValue('1');
  await expect(ui.getByLabel('M1',{exact:true})).not.toBeChecked();
  await minuteRange.locator('input[name=from-input]').fill('1');await minuteRange.locator('input[name=from-input]').press('Tab');
  await expect(ui.getByLabel('M1',{exact:true})).toBeChecked();
  await minuteRange.locator('input[name=from-input]').fill('5');
  await minuteRange.locator('input[name=from-input]').press('Tab');
  await expect(ui.getByLabel('M1',{exact:true})).not.toBeChecked();
  await expect(ui.getByLabel('M15',{exact:true})).toBeChecked();
  await ui.getByLabel('M15',{exact:true}).uncheck();
  await expect(ui.getByText('自定义周期：M5、M30',{exact:true})).toBeVisible();
  await expect(minuteRange.locator('input[name=from-input]')).toHaveValue('5');
  await expect(minuteRange.locator('input[name=to-input]')).toHaveValue('30');
  await ui.getByRole('button',{name:'确认',exact:true}).click();
  const rangeEdited=await read();assert.ok(rangeEdited.every(s=>s[0].mask===506));
  await page.evaluate(id=>widget.chart(0).showPropertiesDialog(id),id);
  await ui.getByText('可见范围',{exact:true}).click();
  await expect(ui.getByLabel('M15',{exact:true})).not.toBeChecked();
  await expect(ui.getByText('自定义周期：M5、M30',{exact:true})).toBeVisible();
  // Reopening must not fill the hole. Restore only via explicit precision edits.
  await ui.getByLabel('M1',{exact:true}).check();await ui.getByLabel('M15',{exact:true}).check();
  for(const label of ['M1','M5','M15','M30','H1','H4','D1','W1','MN'])await expect(ui.getByLabel(label,{exact:true})).toBeChecked();
  for(const label of ['M5','M30','H1','H4','D1','W1','MN'])await ui.getByLabel(label,{exact:true}).uncheck();
  await ui.getByRole('button',{name:'确认',exact:true}).click();
  await page.waitForFunction(()=>widget.chart(1)._chartWidget.model().model().dataSourceForId(widget.chart(1).getAllShapes()[0].id).isSourceHidden());
  const edited=await read();assert.deepEqual(edited.map(s=>s[0].hidden),[false,true,false]);assert.ok(edited.every(s=>s[0].mask===5));
  await page.evaluate(()=>widget.undo());await page.waitForFunction(()=>widget.chart(1)._chartWidget.model().model().dataSourceForId(widget.chart(1).getAllShapes()[0].id).properties().childs().intervalsVisibilities.childs().mwMask.value()===261);const undone=await read();assert.ok(undone.every(s=>s[0].mask===261));
  await page.evaluate(()=>widget.redo());await page.waitForFunction(()=>widget.chart(1)._chartWidget.model().model().dataSourceForId(widget.chart(1).getAllShapes()[0].id).properties().childs().intervalsVisibilities.childs().mwMask.value()===5);assert.deepEqual((await read()).map(s=>s[0].hidden),[false,true,false]);
  await page.evaluate(id=>widget.chart(0).showPropertiesDialog(id),id);await ui.getByText('可见范围',{exact:true}).click();await ui.getByLabel('M5',{exact:true}).check();await ui.getByRole('button',{name:'取消',exact:true}).click();assert.ok((await read()).every(s=>s[0].mask===5));
  // Copy through real native keyboard clipboard, preserving the mask.
  const box=await ui.locator('.chart-container').first().boundingBox();await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
  await page.evaluate(id=>widget.chart(0).selection().add([id]),id);await page.keyboard.press('Control+c');await page.keyboard.press('Control+v');
  await page.waitForFunction(()=>widget.chart(0).getAllShapes().length===2);
  assert.ok((await read())[0].every(s=>s.mask===5));
  const saved=await page.evaluate(()=>new Promise(ok=>widget.save(s=>{window.savedVisibility=s;ok(s.charts.map(c=>c.panes.flatMap(p=>p.sources).filter(x=>x.type==='LineToolHorzLine').map(x=>x.state.intervalsVisibilities.mwMask)));})));
  assert.ok(saved.flat().every(m=>m===5));console.log('SAVED_COUNTS',saved.map(s=>s.length));await page.evaluate(()=>widget.load(window.savedVisibility));
  await page.waitForFunction(()=>widget.chartsCount()===3&&[0,1,2].every(i=>widget.chart(i).dataReady()&&widget.chart(i).getAllShapes().length===window.savedVisibility.charts[i].panes.flatMap(p=>p.sources).filter(x=>x.type==='LineToolHorzLine').length));
  const restored=await read();assert.ok(restored.every((s,i)=>s.every(n=>n.mask===5&&n.hidden===(i===1))));
  // The same synchronized object evaluates each of all nine pane intervals.
  for(const [resolution,visible] of [['1',true],['5',false],['15',true],['30',false],['60',false],['240',false],['1D',false],['1W',false],['1M',false]]){
    await page.evaluate(r=>new Promise(ok=>widget.chart(0).setResolution(r,ok)),resolution);
    assert.equal((await read())[0][0].hidden,!visible,resolution);
  }
  // Legacy objects keep their continuous category ranges until explicitly edited.
  await page.evaluate(()=>new Promise(ok=>widget.chart(0).setResolution('5',ok)));
  const legacy=await page.evaluate(()=>widget.chart(0).createShape({time:widget.chart(0).getVisibleRange().to-600,price:103},{shape:'horizontal_line',overrides:{intervalsVisibilities:{mwMask:-1,minutes:true,minutesFrom:5,minutesTo:5,hours:false,days:false,weeks:false,months:false}}}));
  await page.evaluate(id=>widget.chart(0).showPropertiesDialog(id),legacy);await ui.getByText('可见范围',{exact:true}).click();
  await expect(ui.getByLabel('M5',{exact:true})).toBeChecked();await expect(ui.getByLabel('M1',{exact:true})).not.toBeChecked();await expect(ui.getByLabel('H1',{exact:true})).not.toBeChecked();
  await ui.getByRole('button',{name:'取消',exact:true}).click();
  assert.equal((await read())[0].find(s=>s.id===legacy).mask,-1,'cancel preserves legacy range');
  // An unsupported minute range remains empty; no nearest-period substitution.
  await page.evaluate(id=>widget.chart(0).showPropertiesDialog(id),legacy);await ui.getByText('可见范围',{exact:true}).click();
  await minuteRange.locator('input[name=from-input]').fill('2');await minuteRange.locator('input[name=from-input]').press('Tab');
  await minuteRange.locator('input[name=to-input]').fill('4');await minuteRange.locator('input[name=to-input]').press('Tab');
  await expect(ui.getByText('该范围没有可用的已选周期',{exact:true})).toBeVisible();
  for(const label of ['M1','M5','M15','M30'])await expect(ui.getByLabel(label,{exact:true})).not.toBeChecked();
  await expect(minuteRange.locator('input[name=from-input]')).toHaveValue('2');
  await expect(minuteRange.locator('input[name=to-input]')).toHaveValue('4');
  await ui.getByRole('button',{name:'取消',exact:true}).click();
  assert.equal((await read())[0].find(s=>s.id===legacy).mask,-1);
  // Exercise the native multi-object collector and undo applier together, with
  // mixed day/hour selections that a range edit must preserve independently.
  const multi=await page.evaluate(()=>{
    const win=widget._innerWindow();let req;
    win.webpackChunktradingview.push([['mw-visibility-test'],{},r=>{req=r}]);
    const chart=widget.chart(0),undo=chart._chartWidget.model(),model=undo.model();
    const objects=chart.getAllShapes().slice(0,2).map(s=>model.dataSourceForId(s.id).properties().childs().intervalsVisibilities.childs());
    objects[0].mwMask.setValue(5|64);objects[1].mwMask.setValue(2|16);
    const collected=Object.fromEntries(Object.keys(objects[0]).map(k=>[k,objects.map(o=>o[k])]));
    const definitions=req(887608).getSelectionIntervalsVisibilitiesPropertiesDefinition(collected,undo).definitions;
    const range=definitions.find(d=>d.id==='MWDrawingRangeminutes');
    window.multiRange=range;
    const mixed=range.properties.from.value();
    range.properties.from.setValue(5);
    return {mixed,masks:objects.map(o=>o.mwMask.value()),ids:chart.getAllShapes().slice(0,2).map(s=>s.id)};
  });
  assert.equal(multi.mixed,'mixed');assert.deepEqual(multi.masks,[70,18]);
  await page.evaluate(()=>widget.undo());
  assert.deepEqual((await read())[0].filter(s=>multi.ids.includes(s.id)).map(s=>s.mask),[69,18]);
  await page.evaluate(()=>widget.redo());
  assert.deepEqual((await read())[0].filter(s=>multi.ids.includes(s.id)).map(s=>s.mask),[70,18]);
  await page.setViewportSize({width:430,height:800});
  await page.evaluate(id=>widget.chart(0).showPropertiesDialog(id),legacy);
  await ui.getByText('可见范围',{exact:true}).click();
  await expect(minuteRange.locator('input[name=from-input]')).toBeVisible();
  await ui.getByRole('button',{name:'取消',exact:true}).click();
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,edited,undone,saved,restored,errors}));
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
