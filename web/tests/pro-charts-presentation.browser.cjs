// Real Ubuntu API/PG/native UI; rare quote states are injected at the snapshot
// seam and explicitly distinguished from the live synthetic-supply response.
const {product}=require('./pro-charts-support.cjs');
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{const p=await product(),r={environment:'Ubuntu mw-pro-charts-20261011',cases:[]};
 try {
  await p.host.evaluate(()=>{widget.setLayout('s');widget.symbolSync().setValue(false);widget.intervalSync().setValue(false);});
  await p.host.waitForFunction(()=>widget.chartsCount()===1&&widget.activeChart().dataReady());
  await p.host.evaluate(()=>widget.activeChart().setSymbol('MWC:85eb595180ed9491e1d5e3064aca750933a9ffd787b840d1357645fbbeca3b8a'));
  await p.host.waitForFunction(()=>widget.activeChart().dataReady());
  const baseHeight=await p.host.locator('#chart').evaluate(n=>n.getBoundingClientRect().height);
  const details=p.ui.locator('[data-test-id-widget-type="detail"]');
  const slot=details.locator('[data-name="mw-quote-details-time"]');
  for(const theme of ['Dark','Light']) {
    await p.host.evaluate(t=>widget.changeTheme(t),theme);
    const watch=p.ui.getByRole('button',{name:'观察清单和详情',exact:true});
    if(await watch.getAttribute('aria-pressed')!=='true')await watch.click();
    await p.expect(slot).toContainText('来源行情观察时间');
    const raw=await p.host.evaluate(()=>{const i=decode(widget.activeChart().symbol());return quoteSnapshotRows.get(MWSeries.encode(i.symbol,i.series_kind));});
    assert.ok(raw.v.data_start);assert.equal(raw.v.quote_time,null);
    for(const zone of ['Etc/UTC','Asia/Shanghai','America/New_York','exchange']) {
      const expected=await p.host.evaluate(zone=>{widget.activeChart().getTimezoneApi().setTimezone(zone);const i=decode(widget.activeChart().symbol());const q=quoteSnapshotRows.get(MWSeries.encode(i.symbol,i.series_kind));return quoteTimeText(q.v.data_start,presentationFor(widget.activeChart().symbol()));},zone);
      await p.expect(slot).toContainText(expected);
    }
    for(let i=0;i<4;i++) {
      const alert=p.ui.getByRole('button',{name:'警报',exact:true});await alert.click();
      const geometry=await alert.evaluate(n=>{const a=n.getBoundingClientRect(),b=n.querySelector('svg').getBoundingClientRect();return {button:[a.width,a.height],svg:[b.width,b.height],center:[b.x+b.width/2-a.x,b.y+b.height/2-a.y]};});
      assert.deepEqual(geometry.button,[44,44]);assert.deepEqual(geometry.svg,[44,44]);assert.deepEqual(geometry.center,[22,22]);
      await p.ui.getByRole('tab',{name:'日志',exact:true}).click();await p.ui.getByRole('tab',{name:'警报',exact:true}).click();
      await watch.click();await p.expect(slot).toBeVisible();
      assert.equal(await p.host.locator('#chart').evaluate(n=>n.getBoundingClientRect().height),baseHeight);
      assert.equal(await p.host.getByRole('complementary',{name:'商品状态和行情时间'}).count(),0);
    }
    r.cases.push({name:'native details/timezones and sidebar geometry/height',theme,quoteTime:raw.v.data_start,height:baseHeight});
  }
  // Pause quote callbacks in this browser alone, then replay rare states.
  await p.host.evaluate(()=>{globalThis.presentationQuoteSaved=[...quoteSnapshotRows.values()];for(const id of [...quoteSubscriptions.keys()])feed.unsubscribeQuotes(id);});
  for(const [name,values,phrase] of [
    ['no record',{quote_time:null,data_start:null},'最后更新时间：暂无记录'],
    ['closed failure',{market_session:'closed',fetch_status:'fetch_failed'},'休市 · 更新失败'],
    ['unknown',{market_session:'unknown'},'时段未核实'],
    ['precise quote',{quote_time:Date.UTC(2026,9,9,20,59,58)},'最后更新时间：'],
    ['fixed history',{time_type:'fixed_history'},'历史数据时间：'],
  ]) {
    await p.host.evaluate(values=>{const i=decode(widget.activeChart().symbol()),key=MWSeries.encode(i.symbol,i.series_kind),old=presentationQuoteSaved.find(q=>MWSeries.same(q.n,key));quoteSnapshotRows.set(key,{...old,v:{...old.v,...values}});quoteDetails.refresh();},values);
    await p.expect(slot).toContainText(phrase);r.cases.push({name:'controlled native snapshot '+name,text:await slot.innerText()});
  }
  await p.host.evaluate(()=>{for(const q of presentationQuoteSaved)quoteSnapshotRows.set(q.n,q);quoteDetails.refresh();});
  // Real calendar API and controls, plus native footer at two themes/widths.
  for(const theme of ['Dark','Light']) {
    await p.host.evaluate(t=>widget.changeTheme(t),theme);
    await p.host.evaluate(()=>dataCenter.open('/market-data?tab=calendar'));await p.expect(p.center).toBeVisible();
    await p.expect(p.center.locator('.dc-calendar-row summary').first()).toBeVisible();
    for(const width of [1600,768,375]) {
      await p.page.setViewportSize({width,height:1000});await p.page.waitForTimeout(250);
      const search=p.center.getByLabel('品种搜索');await search.fill('EURUSD');
      const summary=p.center.locator('.dc-calendar-row summary').filter({hasText:'EURUSD'}).first();await p.expect(summary).toBeVisible();
      const identities=await p.center.locator('summary .dc-calendar-identity').allTextContents();assert.ok(identities.length&&identities.every(x=>x.includes(' · ')));
      const layout=await p.center.evaluate(n=>({overflow:n.scrollWidth-n.clientWidth,search:n.querySelector('.dc-calendar-search').getBoundingClientRect().bottom,filters:n.querySelector('.dc-calendar-table-head').getBoundingClientRect().top}));
      assert.equal(layout.overflow,0);assert.ok(layout.search<=layout.filters);
      await summary.focus();await p.page.keyboard.press('Enter');assert.equal(await summary.evaluate(n=>n.parentElement.open),true);await p.page.keyboard.press('Space');
      await p.choose('来源筛选','OANDA');await p.expect(p.center.locator('.dc-calendar-row summary').first()).toContainText('OANDA');
      await p.choose('来源筛选','全部来源');
      const footer=p.center.locator('[class*="footer-"]').last();await p.expect(footer).toContainText('Esc');await p.expect(footer).toBeVisible();
      r.cases.push({name:'calendar identity/search/filter/native footer',theme,width,layout,identities});
    }
    await p.center.getByRole('button',{name:'关闭数据中心',exact:true}).click();
  }
  await p.page.setViewportSize({width:1600,height:1000});
  // The platform's inline warning is visible before opening its native action.
  await p.host.evaluate(()=>dataCenter.open('/market-data?tab=platform'));await p.expect(p.center).toBeVisible();
  const row=p.center.locator('[data-role="list-item"]').first();await p.expect(row).toBeVisible();
  await p.expect(p.center.getByText('打开将关闭品种和周期同步，保留其他图格。',{exact:true})).toBeVisible();
  await p.center.getByRole('button',{name:'关闭数据中心',exact:true}).click();
  assert.deepEqual(p.errors,[]);r.passed=true;
 }catch(e){r.failure=e.stack;r.failureState=await p.host.evaluate(()=>({loading,pending:pending.size,queued:requests.length,types:requests.map(q=>({type:q.type,op:q.query.op})),charts:Array.from({length:widget.chartsCount()},(_,i)=>({symbol:widget.chart(i).symbol(),ready:widget.chart(i).dataReady(),studies:widget.chart(i).getAllStudies()}))})).catch(()=>null);throw e;}finally{r.errors=p.errors;fs.writeFileSync('docs/verification/pro-charts-20261011/browser-presentation.json',JSON.stringify(r,null,2));await p.browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
