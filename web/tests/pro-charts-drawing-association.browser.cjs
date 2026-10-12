// Real product UI/API. Selection and dialog opening use the pinned engine's
// adapter boundaries; checkbox editing and alert submission use mouse input.
const {product}=require('./pro-charts-support.cjs');
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{const p=await product(),r={environment:'Ubuntu mw-pro-charts-20261011',cases:[]};
 const masks=ids=>p.host.evaluate(ids=>ids.map(id=>widget.chart(0)._chartWidget.model().model().dataSourceForId(id).properties().childs().intervalsVisibilities.childs().mwMask.value()),ids);
 try {
  await p.host.evaluate(()=>{widget.symbolSync().setValue(false);widget.intervalSync().setValue(false);widget.setLayout('s');widget.activeChart().removeAllStudies();widget.activeChart().drawOnAllCharts(false);widget.activeChart().setSymbol('MWC:85eb595180ed9491e1d5e3064aca750933a9ffd787b840d1357645fbbeca3b8a');});
  await p.host.waitForFunction(()=>widget.chartsCount()===1&&widget.chart(0).dataReady(),null,{timeout:60000});
  await p.host.evaluate(()=>widget.chart(0).setResolution('60',{doNotActivateChart:true}));
  await p.host.waitForFunction(()=>widget.chart(0).resolution()==='60'&&widget.chart(0).dataReady());
  const ids=await p.host.evaluate(async()=>{const c=widget.chart(0),time=c.getVisibleRange().to-7200;
   const ids=await Promise.all([1.11,1.12].map(price=>c.createShape({time,price},{shape:'horizontal_line'})));
   ids.forEach(id=>c.getShapeById(id).setProperties({intervalsVisibilities:{mwMask:511}}));c.selection().clear();c.selection().add(ids);return ids;});
  await p.host.evaluate(()=>widget.chart(0)._chartWidget.showSelectedSourcesProperties());
  await p.ui.getByText('可见范围',{exact:true}).click();
  for(const label of ['M1','M5','M15','M30','H1','H4','D1','W1','MN']) {
   const field=p.ui.getByLabel(label,{exact:true});await p.expect(field).toBeVisible();if(['M1','M15'].includes(label))await field.check();else await field.uncheck();
  }
  await p.ui.getByRole('button',{name:'确认',exact:true}).click();
  assert.deepEqual(await masks(ids),[5,5]);r.cases.push({name:'native multi-selection nine checkbox edits both drawing masks',ids,masks:await masks(ids)});
  await p.host.evaluate(ids=>{const c=widget.chart(0);c.getShapeById(ids[1]).setProperties({intervalsVisibilities:{mwMask:16}});c.selection().clear();c.selection().add(ids);c._chartWidget.showSelectedSourcesProperties();},ids);
  await p.ui.getByText('可见范围',{exact:true}).click();await p.ui.getByLabel('H4',{exact:true}).check();await p.ui.getByRole('button',{name:'确认',exact:true}).click();
  assert.deepEqual(await masks(ids),[37,48]);await p.host.evaluate(()=>widget.undo());assert.deepEqual(await masks(ids),[5,16]);await p.host.evaluate(()=>widget.redo());assert.deepEqual(await masks(ids),[37,48]);
  r.cases.push({name:'mixed selection preserves each other bit and native undo/redo macro',masks:await masks(ids)});
  await p.host.evaluate(ids=>{const c=widget.chart(0);c.getShapeById(ids[0]).setProperties({intervalsVisibilities:{mwMask:-1,minutes:true,minutesFrom:5,minutesTo:5,hours:false,days:false,weeks:false,months:false}});c.getShapeById(ids[1]).setProperties({intervalsVisibilities:{mwMask:16}});c.selection().clear();c.selection().add(ids);c._chartWidget.showSelectedSourcesProperties();},ids);
  await p.ui.getByText('可见范围',{exact:true}).click();await p.ui.getByLabel('M15',{exact:true}).check();await p.ui.getByRole('button',{name:'取消',exact:true}).click();assert.deepEqual(await masks(ids),[-1,16]);
  await p.host.evaluate(ids=>{const c=widget.chart(0);c.selection().clear();c.selection().add(ids);c._chartWidget.showSelectedSourcesProperties();},ids);await p.ui.getByText('可见范围',{exact:true}).click();await p.ui.getByLabel('M15',{exact:true}).check();await p.ui.getByRole('button',{name:'确认',exact:true}).click();assert.deepEqual(await masks(ids),[6,20]);
  await p.host.evaluate(()=>widget.undo());assert.deepEqual(await masks(ids),[-1,16]);
  r.cases.push({name:'multi-selection legacy migration occurs only on confirmed edit; cancel/undo preserve ranges'});
  await p.host.evaluate(()=>widget.chart(0).setResolution('1',{doNotActivateChart:true}));await p.host.waitForFunction(()=>widget.chart(0).resolution()==='1'&&widget.chart(0).dataReady());
  await p.host.evaluate(ids=>{const c=widget.chart(0);ids.forEach(id=>c.getShapeById(id).setProperties({visible:true,intervalsVisibilities:{mwMask:511}}));c.getShapeById(ids[0]).setProperties({visible:false});c.selection().clear();c.selection().add(ids);c._chartWidget.showSelectedSourcesProperties();},ids);
  await p.ui.getByText('可见范围',{exact:true}).click();await p.ui.getByLabel('H4',{exact:true}).uncheck();await p.ui.getByRole('button',{name:'确认',exact:true}).click();
  const hidden=()=>p.host.evaluate(ids=>ids.map(id=>widget.chart(0)._chartWidget.model().model().dataSourceForId(id).isSourceHidden()),ids);
  assert.deepEqual(await hidden(),[true,false]);
  const group=await p.host.evaluate(ids=>{const c=widget.chart(0);c.selection().clear();c.selection().add(ids);const group=c.shapesGroupController().createGroupFromSelection();c.shapesGroupController().setGroupVisibility(group,false);c.selection().clear();c.selection().add(ids);c._chartWidget.showSelectedSourcesProperties();return group;},ids);
  await p.ui.getByText('可见范围',{exact:true}).click();await p.ui.getByLabel('H1',{exact:true}).uncheck();await p.ui.getByRole('button',{name:'确认',exact:true}).click();assert.deepEqual(await hidden(),[true,true]);
  r.cases.push({name:'period edits preserve manual hidden and hidden group state',group,masks:await masks(ids)});
  await p.host.evaluate(({group,ids})=>{const c=widget.chart(0);c.shapesGroupController().setGroupVisibility(group,true);ids.forEach(id=>c.shapesGroupController().excludeShapeFromGroup(group,id));}, {group,ids});
  await p.host.evaluate(()=>widget.chart(0).setResolution('60',{doNotActivateChart:true}));await p.host.waitForFunction(()=>widget.chart(0).resolution()==='60'&&widget.chart(0).dataReady());
  await p.host.evaluate(ids=>ids.forEach(id=>widget.chart(0).getShapeById(id).setProperties({intervalsVisibilities:{mwMask:5}})),ids);
  await p.host.evaluate(id=>alertBridge.create({chart:widget.chart(0),object:{type:'shape',id}}),ids[0]);
  const create=p.ui.getByRole('dialog').getByRole('button',{name:'创建告警',exact:true});await p.expect(create).toBeEnabled({timeout:30000});
  const response=p.page.waitForResponse(x=>x.url().endsWith('/api/chart-alerts')&&x.request().method()==='POST');
  await create.click();const savedResponse=await response;assert.equal(savedResponse.status(),201,await savedResponse.text());const saved=await savedResponse.json();
  assert.equal(saved.config.association.native_object_id,ids[0]);assert.equal(saved.config.association.object_kind,'drawing');assert.equal(saved.config.condition.right.kind,'line');assert.equal(saved.config.condition.right.line.kind,'horizontal_line');
  r.cases.push({name:'adapter opens actual drawing alert form; real UI/API POST201',id:saved.id,association:saved.config.association});
  await p.host.evaluate(id=>widget.chart(0).showPropertiesDialog(id),ids[0]);await p.ui.getByText('可见范围',{exact:true}).click();await p.ui.getByLabel('H1',{exact:true}).check();await p.ui.getByRole('button',{name:'确认',exact:true}).click();
  await p.page.waitForTimeout(1500);
  const updated=await(await p.page.request.get('http://localhost:19997/api/chart-alerts/'+saved.id)).json();assert.equal(updated.version,saved.version);assert.deepEqual(updated.config,saved.config);assert.deepEqual(updated.market_identity,saved.market_identity);
  assert.deepEqual(await masks(ids),[21,5]);r.cases.push({name:'visibility-only edit preserves alert rule version, geometry, identity and association',version:updated.version,masks:await masks(ids)});
  assert.deepEqual(p.errors,[]);r.passed=true;
 }catch(e){r.failure=e.stack;r.ui=await p.ui.locator('body').innerText();throw e;}finally{r.errors=p.errors;fs.writeFileSync('docs/verification/pro-charts-20261011/browser-drawing-association.json',JSON.stringify(r,null,2));await p.browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
