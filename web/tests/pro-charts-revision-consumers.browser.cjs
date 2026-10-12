// Actual isolated revision activation, licensed shared consumers and live stream.
const {product}=require('./pro-charts-support.cjs');
const assert=require('node:assert/strict'),fs=require('node:fs'),cp=require('node:child_process');
const composite='85eb595180ed9491e1d5e3064aca750933a9ffd787b840d1357645fbbeca3b8a',ticker='MWC:'+composite;
(async()=>{
 const p=await product(),r={environment:'Ubuntu mw-pro-charts-20261011',supplier:'synthetic I/O; actual API/PG revision and stream',cases:[]};
 const settle=()=>p.host.waitForFunction(()=>!loading&&!pending.size&&!requests.length&&!rangeGuard.busy()&&!edgeGuard.busy()&&!MWNativeNavigation.busy()&&Array.from({length:widget.chartsCount()},(_,i)=>widget.chart(i)).every(c=>c.dataReady()&&c.getVisibleRange()?.to>c.getVisibleRange()?.from),null,{timeout:90000});
 const snapshot=()=>p.host.evaluate(()=>Array.from({length:widget.chartsCount()},(_,i)=>{const c=widget.chart(i),bars=c._chartWidget.model().model().mainSeries().bars();return {symbol:c.symbol(),resolution:c.resolution(),range:c.getVisibleRange(),first:bars.firstIndex(),last:bars.lastIndex(),studies:c.getAllStudies()};}));
 try {
  const original=await(await p.page.request.get('http://localhost:19997/api/market-data/composites/'+composite)).json();r.originalRevision=original.active_revision_id;
  await p.host.evaluate(()=>{widget.symbolSync().setValue(false);widget.intervalSync().setValue(false);widget.timeSync().setValue(false);widget.dateRangeSync().setValue(false);widget.setLayout('4');});await p.host.waitForFunction(()=>widget.chartsCount()===4);
  await p.host.evaluate(async ticker=>{for(let i=0;i<4;i++){const c=widget.chart(i);c.removeAllStudies();await c.setSymbol(ticker,{doNotActivateChart:true});c.setResolution('60',{doNotActivateChart:true});}},ticker);await settle();
  const compare=await p.host.evaluate(ticker=>widget.chart(3).createStudy('Compare',true,false,{symbol:ticker},undefined,{priceScale:'new-left'}),ticker);
  await settle();
  for(const layout of ['2v','3r','4']) {
   await p.host.evaluate(layout=>widget.setLayout(layout),layout);await settle();
   const charts=await snapshot();assert.ok(charts.every(c=>c.symbol.toLowerCase()===ticker.toLowerCase()&&c.resolution==='60'&&c.last>=c.first));
   r.cases.push({name:'same composite/period consumers through real layout',layout,charts});
  }
  assert.ok((await snapshot())[3].studies.some(s=>s.id===compare),'shared comparison survives hidden layouts');
  await p.host.evaluate(()=>{widget.intervalSync().setValue(true);widget.chart(0).setResolution('15');});
  await p.host.waitForFunction(()=>Array.from({length:4},(_,i)=>widget.chart(i).resolution()).every(x=>x==='15'),null,{timeout:60000});await settle();
  await p.host.evaluate(()=>{widget.symbolSync().setValue(true);widget.chart(0).setSymbol('MWP:BTCUSDT');});
  await p.host.waitForFunction(()=>Array.from({length:4},(_,i)=>widget.chart(i).symbol()).every(x=>x==='MWP:BTCUSDT'),null,{timeout:60000});await settle();
  await p.host.evaluate(ticker=>widget.chart(0).setSymbol(ticker),ticker);await settle();
  await p.host.waitForFunction(ticker=>Array.from({length:4},(_,i)=>widget.chart(i).symbol()).every(x=>MWSeries.same(x,ticker)),ticker,{timeout:60000});
  await p.host.evaluate(()=>{widget.symbolSync().setValue(false);widget.intervalSync().setValue(false);});
  r.cases.push({name:'real symbol and interval synchronization on/off with shared consumers',charts:await snapshot()});
  await p.host.evaluate(()=>{globalThis.revisionLoads=[];const original=feed.getBars;feed.getBars=function(s,res,args,cb,err){const entry={ticker:s.ticker,res};revisionLoads.push(entry);return original(s,res,args,(bars,meta)=>{entry.rows=bars.length;entry.accepted=cb(bars,meta)!==false;return entry.accepted;},e=>{entry.error=String(e);entry.code=e.code;return err(e);});};});
  await p.host.evaluate(()=>dataCenter.open('/market-data/composites/85eb595180ed9491e1d5e3064aca750933a9ffd787b840d1357645fbbeca3b8a?section=seam'));await p.expect(p.center).toBeVisible();
  await p.choose('新历史基线',/NY17/);await p.choose('实时映射版本',/OANDA practice/);
  await p.center.locator('textarea').fill('Ubuntu actual active revision shared-consumer acceptance');
  const seam=p.center.getByLabel('拼接时刻（UTC）');await seam.fill(new Date(original.revision.seam-60000).toISOString().slice(0,16));
  await p.center.getByLabel('明确使用非日界分钟拼接规则',{exact:true}).check();
  const response=p.page.waitForResponse(x=>x.url().endsWith('/revisions')&&x.request().method()==='POST');
  await p.center.getByRole('button',{name:'提交修订准备',exact:true}).click();const prepared=await response;const payload=await prepared.json();r.preparation={status:prepared.status(),payload};assert.equal(prepared.status(),201);const revision=payload.id;assert.match(revision,/^[a-f0-9-]{36}$/);r.newRevision=revision;
  cp.execFileSync('sg',['docker','-c',`docker compose -p mw-pro-charts-20261011 -f docs/verification/pro-charts-20261011/compose.yaml exec -T api python /acceptance/fixture-runtime.py prepare ${revision}`],{timeout:120000});
  await p.center.getByRole('button',{name:'刷新',exact:true}).click();
  const article=p.center.locator('#composite-revision-'+revision);await p.expect(article.getByRole('button',{name:'启用此修订',exact:true})).toBeEnabled({timeout:30000});
  const activated=p.page.waitForResponse(x=>x.url().endsWith('/activate')&&x.request().method()==='POST');await article.getByRole('button',{name:'启用此修订',exact:true}).click();assert.equal((await activated).status(),200);
  await p.center.getByRole('button',{name:'关闭数据中心',exact:true}).click();
  await p.host.waitForFunction(({ticker,revision})=>[...marketHistoryState.entries()].some(([key,s])=>MWSeries.same(key.split('|')[0],ticker)&&key.split('|')[1]==='15'&&s.binding===revision),{ticker,revision},{timeout:90000});await settle();
  const state=await p.host.evaluate(ticker=>({states:[...marketHistoryState.entries()].filter(([key])=>MWSeries.same(key.split('|')[0],ticker)),consumers:[...subscriptions.values()].filter(s=>MWSeries.same(s.symbol,ticker)).map(s=>({res:s.res,paused:s.marketPaused,recovering:s.marketRecovering,reload:s.needsHistoryReload,last:s.last})),loads:revisionLoads}),ticker);
  assert.ok(state.loads.some(x=>x.accepted&&x.rows>0),'active revision triggers real accepted native history');
  // Native shares one feed subscription/cache across same-series pane models.
  // Count the real pane models separately; a subscription per pane is not required.
  r.activation=state;
  assert.ok(state.consumers.length>=1&&state.consumers.every(s=>!s.paused&&!s.recovering&&!s.reload&&s.last>0));
  const charts=await snapshot();assert.ok(charts.every(c=>c.symbol.toLowerCase()===ticker.toLowerCase()&&c.resolution==='15'&&c.last>=c.first));
  const current=await(await p.page.request.get('http://localhost:19997/api/market-data/composites/'+composite)).json();assert.equal(current.active_revision_id,revision);assert.notEqual(revision,r.originalRevision);
  r.cases.push({name:'committed actual activation resets shared main/compare consumers to new revision',state,charts});
  assert.deepEqual(p.errors,[]);r.passed=true;
 }catch(e){r.failure=e.stack;r.charts=await snapshot().catch(()=>null);r.ui=await p.center.innerText().catch(()=>null);r.state=await p.host.evaluate(()=>({states:[...marketHistoryState.entries()],loads:globalThis.revisionLoads})).catch(()=>null);throw e;}finally{r.errors=p.errors;fs.writeFileSync('docs/verification/pro-charts-20261011/browser-revision-consumers.json',JSON.stringify(r,null,2));await p.browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
