const {product}=require('./pro-charts-support.cjs');
const assert=require('node:assert/strict'),fs=require('node:fs');
async function blankMenu(p,index=0) {
  await p.host.evaluate(i=>widget.setActiveChart(i),index);
  await p.page.mouse.move(5,5);
  const point=await p.host.evaluate(i=>{const pane=widget.chart(i)._chartWidget.paneWidgets().find(p=>p.containsMainSeries()),rect=pane.canvasElement().getBoundingClientRect();
    for(let y=60;y<rect.height-20;y+=15)for(let x=100;x<rect.width-20;x+=15)if(pane._dataSourceAtPoint(x,y)===null)return {x:rect.x+x,y:rect.y+y};
    throw Error('No blank native pane coordinate');},index);
  const frame=await (await p.ui.frameElement()).boundingBox();await p.page.mouse.click(frame.x+point.x,frame.y+point.y,{button:'right'});
  const item=p.ui.getByText(/^在 .+ 创建价格告警…$/).first();await p.expect(item).toBeVisible();return item;
}
(async()=>{const p=await product(),r={environment:'Ubuntu mw-pro-charts-20261011',delivery:'disabled',cases:[]};
 try {
  await p.host.evaluate(()=>{widget.setLayout('2h');widget.symbolSync().setValue(false);widget.intervalSync().setValue(false);});
  await p.host.waitForFunction(()=>widget.chartsCount()===2);
  await p.host.evaluate(()=>{widget.chart(0).removeAllStudies();widget.chart(1).removeAllStudies();widget.chart(0).setSymbol('MWC:85eb595180ed9491e1d5e3064aca750933a9ffd787b840d1357645fbbeca3b8a');widget.chart(1).setSymbol('MWP:XAUUSD');if(widget.chart(0).resolution()!=='60')widget.chart(0).setResolution('60');});
  await p.host.waitForFunction(()=>widget.chart(0).dataReady()&&widget.chart(1).dataReady(),null,{timeout:60000});
  let menu=await blankMenu(p),label=await menu.innerText(),price=label.match(/^在 (.+) 创建价格告警/)[1];
  await menu.click();const value=p.ui.getByLabel('比较值',{exact:true});await p.expect(value).toHaveValue(price.replace(/,/g,''));
  await p.expect(p.ui.getByText('创建警报 · EURUSD · 组合行情 · bid · H1',{exact:true})).toBeVisible();
  await p.host.evaluate(()=>widget.setActiveChart(1));
  const create=p.ui.getByRole('dialog').getByRole('button',{name:'创建告警',exact:true});
  await p.expect(create).toBeEnabled({timeout:30000});
  const pending=p.page.waitForResponse(x=>x.url().endsWith('/api/chart-alerts')&&x.request().method()==='POST');pending.catch(()=>{});
  await create.click();const response=await pending;
  assert.equal(response.status(),201,await response.text());const saved=await response.json();r.alert=saved;
  assert.equal(saved.config.instrument,'85eb595180ed9491e1d5e3064aca750933a9ffd787b840d1357645fbbeca3b8a');
  assert.equal(saved.config.condition.right.value,price);assert.equal(saved.config.timeframe,'H1');assert.equal(saved.config.association.chart_index,0);
  assert.match(saved.name,/EURUSD/);assert.ok(!saved.name.includes(saved.config.instrument));
  assert.match(saved.display_label,/EURUSD · 组合行情 · bid · H1/);
  r.cases.push({name:'real blank-pane formatted menu/dialog POST201 persists initiating pane after active switch',label,id:saved.id});
  // Menu/dialog roundtrips for source-specific price formats; cancel creates no alert.
  for(const symbol of ['MWP:EURUSD','MWP:USDJPY','MWP:XAUUSD','MWP:BTCUSDT']) {
    await p.host.evaluate(s=>{widget.chart(1).setSymbol(s);},symbol);await p.host.waitForFunction(()=>widget.chart(1).dataReady(),null,{timeout:60000});
    menu=await blankMenu(p,1);label=await menu.innerText();price=label.match(/^在 (.+) 创建价格告警/)[1];await menu.click();
    await p.expect(value).toHaveValue(price.replace(/,/g,''));await p.ui.getByRole('button',{name:'取消（保留草稿）',exact:true}).click();
    r.cases.push({name:'real formatter/menu/dialog',symbol,label,value:price.replace(/,/g,'')});
    console.log('PRICE_PASS',symbol);
  }
  await p.ui.getByRole('button',{name:'商品代码搜索',exact:true}).click();const search=p.ui.locator('[data-name="symbol-search-items-dialog"]');await search.getByRole('searchbox').fill('AAPL');await search.locator('[data-symbol-name^="MWP:YAHOO:"]').first().click();
  await p.host.waitForFunction(()=>widget.activeChart().symbol().startsWith('MWP:YAHOO:')&&widget.activeChart().dataReady(),null,{timeout:60000});
  menu=await blankMenu(p,1);label=await menu.innerText();price=label.match(/^在 (.+) 创建价格告警/)[1];await menu.click();await p.expect(value).toHaveValue(price.replace(/,/g,''));
  await p.expect(p.ui.getByText(/创建警报 · AAPL · 平台行情/)).toBeVisible();await p.ui.getByRole('button',{name:'取消（保留草稿）',exact:true}).click();r.cases.push({name:'real Yahoo formatter/menu/dialog has readable AAPL identity',label});
  menu=await blankMenu(p,0);await menu.click();const typed='1.123456789012345678';await value.fill(typed);await p.expect(create).toBeEnabled({timeout:30000});
  const precisionPost=p.page.waitForResponse(x=>x.url().endsWith('/api/chart-alerts')&&x.request().method()==='POST');precisionPost.catch(()=>{});await create.click();const precisionResponse=await precisionPost;assert.equal(precisionResponse.status(),201,await precisionResponse.text());const precision=await precisionResponse.json();
  assert.equal(precision.config.condition.right.value,typed);r.precisionAlert=precision;r.cases.push({name:'real UI/API POST201 preserves manually entered 18-place decimal',id:precision.id,threshold:typed});
  await p.host.evaluate(()=>new Promise((ok,bad)=>widget.saveChartToServer(ok,bad)));
  await p.page.reload();await p.page.locator('iframe[title="专业图表工作区"]').waitFor();
  const host=p.page.frames().find(f=>f.url().startsWith('http://localhost:19998/?'));await host.waitForFunction(()=>typeof ready!=='undefined'&&ready&&!loading&&widget.activeChart().dataReady(),null,{timeout:60000});
  const read=await p.page.request.get('http://localhost:19997/api/chart-alerts/'+saved.id);assert.equal(read.status(),200);
  const restored=await read.json();assert.deepEqual(restored.config,saved.config);r.cases.push({name:'actual API read after browser reload preserves threshold/identity/association',id:saved.id});
  const restoredPrecision=await(await p.page.request.get('http://localhost:19997/api/chart-alerts/'+precision.id)).json();assert.equal(restoredPrecision.config.condition.right.value,typed);assert.equal(restoredPrecision.name,precision.name);r.cases.push({name:'persisted manual precision and original name survive reload',id:precision.id});
  assert.deepEqual(p.errors,[]);r.passed=true;
 }catch(e){r.failure=e.stack;r.ui=await p.ui.locator('body').innerText();throw e;}finally{r.errors=p.errors;fs.writeFileSync('docs/verification/pro-charts-20261011/browser-alerts.json',JSON.stringify(r,null,2));await p.browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
