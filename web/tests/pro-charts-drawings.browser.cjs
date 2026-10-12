const {product}=require('./pro-charts-support.cjs');
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{const p=await product(),r={environment:'Ubuntu mw-pro-charts-20261011',cases:[]};
 const read=()=>p.host.evaluate(()=>Array.from({length:widget.chartsCount()},(_,i)=>widget.chart(i).getAllShapes().map(s=>{const n=widget.chart(i)._chartWidget.model().model().dataSourceForId(s.id);return {id:s.id,mask:n.properties().childs().intervalsVisibilities.childs().mwMask?.value(),hidden:n.isSourceHidden()};})));
 try {
  console.log('PRODUCT_READY');
  await p.host.evaluate(()=>{widget.activeChart().removeAllStudies();widget.symbolSync().setValue(false);widget.intervalSync().setValue(false);widget.setLayout('3h');});await p.host.waitForFunction(()=>widget.chartsCount()===3);
  for(let i=0;i<3;i++){
    await p.host.evaluate(i=>{widget.chart(i).removeAllStudies();widget.chart(i).setSymbol('MWC:85eb595180ed9491e1d5e3064aca750933a9ffd787b840d1357645fbbeca3b8a');},i);
    await p.host.waitForFunction(i=>widget.chart(i).symbol().startsWith('MWC:')&&widget.chart(i).dataReady(),i,{timeout:60000});
    console.log('SYMBOL_READY',i);
    await p.host.evaluate(i=>{const c=widget.chart(i),r=['1','5','15'][i];if(c.resolution()!==r)c.setResolution(r);},i);
    await p.host.waitForFunction(i=>widget.chart(i).resolution()===['1','5','15'][i]&&widget.chart(i).dataReady(),i,{timeout:60000});
    console.log('PANE_READY',i);
  }
  await p.host.evaluate(()=>{widget.setActiveChart(0);widget.chart(0).drawOnAllCharts(true);});
  await p.host.waitForFunction(()=>[0,1,2].every(i=>widget.chart(i).dataReady()),null,{timeout:60000});
  console.log('LAYOUT_READY');
  const id=await p.host.evaluate(()=>widget.chart(0).createShape({time:widget.chart(0).getVisibleRange().to-600,price:1.12},{shape:'horizontal_line'}));
  console.log('CREATED',id,await read());
  await p.host.waitForFunction(id=>[0,1,2].every(i=>widget.chart(i).getAllShapes().some(s=>s.id===id)),id,{timeout:30000});
  for(const theme of ['Dark','Light']) {
    console.log('THEME',theme);await p.host.evaluate(t=>{widget.changeTheme(t);},theme);await p.host.evaluate(id=>{widget.chart(0).showPropertiesDialog(id);},id);await p.ui.getByText('可见范围',{exact:true}).click();
    for(const label of ['M1','M5','M15','M30','H1','H4','D1','W1','MN']) {const field=p.ui.getByLabel(label,{exact:true});if(['M1','M15'].includes(label))await field.check();else await field.uncheck();}
    await p.ui.getByRole('button',{name:'确认',exact:true}).click();
    await p.host.waitForFunction(id=>widget.chart(1)._chartWidget.model().model().dataSourceForId(id).isSourceHidden(),id);
    const edited=await read();assert.deepEqual(edited.map(s=>s.find(x=>x.id===id)?.hidden),[false,true,false]);assert.ok(edited.every(s=>s.find(x=>x.id===id)?.mask===5));r.cases.push({name:'real native nine checkbox synchronized pane visibility',theme,edited});
    console.log('THEME_DONE',theme);
  }
  // Change each bit independently, then restore the original M1/M15 mask.
  for(const [resolution,bit] of [['60',16],['240',32],['1D',64],['1W',128],['1M',256]]) {
    await p.host.evaluate(({id,bit})=>widget.chart(0).getShapeById(id).setProperties({intervalsVisibilities:{mwMask:bit}}),{id,bit});
    await p.host.evaluate(res=>new Promise(ok=>widget.chart(0).setResolution(res,ok)),resolution);
    assert.equal((await read())[0].find(x=>x.id===id).hidden,false);
    const peer=resolution==='60'?'240':'60';await p.host.evaluate(res=>new Promise(ok=>widget.chart(0).setResolution(res,ok)),peer);assert.equal((await read())[0].find(x=>x.id===id).hidden,true);
    r.cases.push({name:'independent H1/H4/day/week/month bit',resolution,bit});
  }
  await p.host.evaluate(id=>widget.chart(0).getShapeById(id).setProperties({intervalsVisibilities:{mwMask:5}}),id);await p.host.evaluate(()=>new Promise(ok=>widget.chart(0).setResolution('1',ok)));
  await p.host.evaluate(id=>{widget.chart(0).selection().clear();widget.chart(0).selection().add([id]);widget.setActiveChart(0);},id);
  const before=(await read())[0].length;await p.page.keyboard.press('Control+c');await p.page.keyboard.press('Control+v');await p.host.waitForFunction(n=>widget.chart(0).getAllShapes().length>n,before);
  assert.ok((await read())[0].some(x=>x.id!==id&&x.mask===5));r.cases.push({name:'native clipboard copies mask'});
  await p.host.waitForFunction(()=>!loading&&!pending.size&&!requests.length&&!rangeGuard.busy()&&!edgeGuard.busy()&&!MWNativeNavigation.busy()&&[0,1,2].every(i=>widget.chart(i).dataReady()),null,{timeout:60000});
  for(let attempt=0;attempt<5;attempt++){
    const result=await p.host.evaluate(()=>new Promise(ok=>widget.saveChartToServer(()=>ok('saved'),e=>ok(String(e?.message||e)))));
    if(result==='saved')break;
    console.log('SAVE_RETRY',result);assert.match(result,/图表正在切换/);if(attempt===4)throw Error(result);
    const close=p.ui.getByRole('button',{name:'确认',exact:true});if(await close.count())await close.click();await p.page.waitForTimeout(1000);
  }
  await p.page.reload();await p.page.locator('iframe[title="专业图表工作区"]').waitFor();const restored=p.page.frames().find(f=>f.url().startsWith('http://localhost:19998/?'));
  await restored.waitForFunction(()=>typeof ready!=='undefined'&&ready&&!loading&&widget.chartsCount()===3&&[0,1,2].every(i=>widget.chart(i).dataReady()),null,{timeout:60000});
  const saved=await restored.evaluate(()=>widget.chart(0).getAllShapes().map(s=>({id:s.id,mask:widget.chart(0)._chartWidget.model().model().dataSourceForId(s.id).properties().childs().intervalsVisibilities.childs().mwMask.value()})));
  assert.ok(saved.some(s=>s.id===id&&s.mask===5));r.cases.push({name:'real server workspace save/reload',saved});
  await restored.evaluate(()=>{widget.chart(0).setSymbol('MWP:XAUUSD');});await restored.waitForFunction(()=>widget.chart(0).dataReady());assert.ok(!(await restored.evaluate(()=>widget.chart(0).getAllShapes())).some(s=>s.id===id));
  await restored.evaluate(()=>{widget.chart(0).setSymbol('MWC:85eb595180ed9491e1d5e3064aca750933a9ffd787b840d1357645fbbeca3b8a');});await restored.waitForFunction(()=>widget.chart(0).dataReady());assert.ok((await restored.evaluate(()=>widget.chart(0).getAllShapes())).some(s=>s.id===id));r.cases.push({name:'native cross-symbol drawing isolation and return'});
  assert.deepEqual(p.errors,[]);r.passed=true;
 }catch(e){r.failure=e.stack;throw e;}finally{r.errors=p.errors;fs.writeFileSync('docs/verification/pro-charts-20261011/browser-drawings.json',JSON.stringify(r,null,2));await p.browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
