// Real licensed consumers and API. Controlled HTTP barriers inject pending
// coverage and delayed responses; these cases are labelled separately.
const {product}=require('./pro-charts-support.cjs');
const assert=require('node:assert/strict'),fs=require('node:fs');
const composite='85eb595180ed9491e1d5e3064aca750933a9ffd787b840d1357645fbbeca3b8a',history='95d5f45a-54dd-4e1e-8367-3edd37d5618c';
(async()=>{const p=await product(),r={environment:'Ubuntu mw-pro-charts-20261011',cases:[]};
 const settle=()=>p.host.waitForFunction(()=>!loading&&!pending.size&&!requests.length&&!rangeGuard.busy()&&!edgeGuard.busy()&&!MWNativeNavigation.busy()&&widget.activeChart().dataReady(),null,{timeout:90000});
 try {
  await p.host.evaluate(()=>{widget.symbolSync().setValue(false);widget.intervalSync().setValue(false);widget.timeSync().setValue(false);widget.dateRangeSync().setValue(false);widget.setLayout('s');widget.activeChart().removeAllStudies();widget.activeChart().setSymbol('MWC:'+ '85eb595180ed9491e1d5e3064aca750933a9ffd787b840d1357645fbbeca3b8a');});await settle();
  await p.host.evaluate(()=>{globalThis.lifecycleLoads=[];const original=feed.getBars;feed.getBars=function(s,res,args,cb,err){const entry={ticker:s.ticker,res,countBack:args.countBack};lifecycleLoads.push(entry);return original(s,res,args,(bars,meta)=>{entry.rows=bars.length;entry.meta=meta;entry.accepted=cb(bars,meta)!==false;return entry.accepted;},error=>{entry.error=String(error);entry.code=error.code;return err(error);});};});
  const detail=await(await p.page.request.get('http://localhost:19997/api/market-data/composites/'+composite)).json();
  const seam=detail.revision.seam/1000,revision=detail.active_revision_id;
  const seamPages=[];const jobs=[];p.page.on('response',response=>{if(response.url().endsWith('/api/charts/data')){const q=response.request().postDataJSON();if(q.series_kind==='composite'&&q.timeframe==='H1')jobs.push(response.json().then(page=>{seamPages.push({revision:page.revision_id,input:page.input_revision,bars:page.bars?.map(b=>({start:b.start,end:b.end,seam_crossing:b.seam_crossing,seam_at_start:b.seam_at_start,segments:b.segments?.map(s=>s.segment)})),pending:page.pending});}).catch(()=>{}));}});
  await p.host.evaluate(()=>widget.activeChart().setResolution('60',{doNotActivateChart:true}));await settle();
  await p.host.evaluate(async ({seam,revision,composite})=>{await query('MWC:'+composite,'60',{before:(seam+12*3600)*1000,limit:36,composite_revision_id:revision},Date.now()+30000);const c=widget.activeChart();await c.setVisibleRange({from:seam-12*3600,to:seam+12*3600},{rejectByTimeout:90000});},{seam,revision,composite});await settle();await Promise.all(jobs);
  assert.ok(seamPages.some(page=>page.bars?.some(b=>b.start<seam*1000)&&page.bars?.some(b=>b.end>seam*1000)),'actual page straddles fixed seam');
  assert.ok(seamPages.every(page=>!page.revision||page.revision===revision));
  const before=await p.host.evaluate(()=>({range:widget.activeChart().getVisibleRange(),spacing:widget.activeChart().getTimeScale().barSpacing()}));
  await p.host.evaluate(()=>widget.activeChart().getTimeScale().setBarSpacing(8));await settle();assert.equal(await p.host.evaluate(()=>widget.activeChart().getTimeScale().barSpacing()),8);
  r.cases.push({name:'real composite seam pagination and zoom retain pinned revision',revision,seam,before,pages:seamPages});
  console.log('SEAM_PASS');
  // One genuine HTTP page is replaced with a pending coverage response. Empty
  // unknown coverage must reach native as noData:false, never a fixed origin.
  let injected=false;await p.page.route('**/api/charts/data',async route=>{const q=route.request().postDataJSON();if(!injected&&q.series_kind==='history'&&q.timeframe==='M15'){injected=true;const response=await route.fetch();const page=await response.json();return route.fulfill({response,json:{...page,bars:[],has_more:false,pending:['受控验收：覆盖尚未核实'],next_before:null}});}return route.continue();});
  const loadStart=await p.host.evaluate(()=>lifecycleLoads.length);await p.host.evaluate(()=>{widget.activeChart().setSymbol('MWH:95d5f45a-54dd-4e1e-8367-3edd37d5618c');widget.activeChart().setResolution('15');});
  await p.host.waitForFunction(start=>lifecycleLoads.slice(start).some(x=>x.ticker.startsWith('MWH:')&&x.res==='15'&&x.rows===0),loadStart,{timeout:60000});
  const unknown=await p.host.evaluate(start=>lifecycleLoads.slice(start).find(x=>x.ticker.startsWith('MWH:')&&x.res==='15'&&x.rows===0),loadStart);assert.equal(unknown.meta.noData,false);r.cases.push({name:'controlled pending/unknown HTTP response is not confirmed end of history',load:unknown});
  console.log('UNKNOWN_PASS');
  await p.page.unroute('**/api/charts/data');
  await p.host.evaluate(()=>{widget.activeChart().setSymbol('MWH:95d5f45a-54dd-4e1e-8367-3edd37d5618c');widget.activeChart().setResolution('30');});await settle();
  await p.host.evaluate(()=>new Promise((ok,bad)=>widget.saveChartToServer(ok,bad)));
  console.log('SAVED');
  // A real request stays in flight while native loads the saved workspace twice.
  // The obsolete callback must be rejected even if its HTTP body arrives later.
  let release,observed;const gate=new Promise(ok=>release=ok),seen=new Promise(ok=>observed=ok);let delayed=false;
  await p.page.route('**/api/charts/data',async route=>{const q=route.request().postDataJSON();if(!delayed&&q.series_kind==='history'&&q.timeframe==='M30'){delayed=true;observed(q);await gate;try{return await route.continue();}catch{return;}}return route.continue();});
  const start=await p.host.evaluate(()=>lifecycleLoads.length);await p.host.evaluate(()=>{widget.resetCache();widget.activeChart().resetData();});await Promise.race([seen,new Promise((_,reject)=>setTimeout(()=>reject(Error('No cold M30 request')),30000))]);
  console.log('COLD_REQUEST_DELAYED');
  const record=(await(await p.page.request.get('http://localhost:19997/api/advanced-charts/native-charts')).json()).find(x=>x.id==='pro-charts-fixture');assert.ok(record);
  const epoch=await p.host.evaluate(()=>workspaceEpoch);
  await p.host.evaluate(async record=>{await widget.loadChartFromServer(record);await widget.loadChartFromServer(record);},record);release();
  console.log('DOUBLE_LOADED');
  await p.host.waitForFunction(start=>lifecycleLoads.slice(start).some(x=>x.code==='HISTORY_CANCELLED'),start,{timeout:60000});await settle();
  const cancelled=await p.host.evaluate(({start,epoch})=>({epoch,now:workspaceEpoch,loads:lifecycleLoads.slice(start),charts:Array.from({length:widget.chartsCount()},(_,i)=>({symbol:widget.chart(i).symbol(),resolution:widget.chart(i).resolution(),ready:widget.chart(i).dataReady(),range:widget.chart(i).getVisibleRange()}))}),{start,epoch});
  assert.ok(cancelled.now>=epoch+2);assert.equal(cancelled.loads[0].code,'HISTORY_CANCELLED');assert.ok(!cancelled.loads[0].accepted);assert.ok(cancelled.charts.every(x=>x.ready&&x.range.to>x.range.from));r.cases.push({name:'actual saved-workspace rapid double load cancels obsolete native consumer',...cancelled});
  await p.page.unroute('**/api/charts/data');assert.deepEqual(p.errors,[]);r.passed=true;
 }catch(e){r.failure=e.stack;r.loads=await p.host.evaluate(()=>globalThis.lifecycleLoads).catch(()=>null);throw e;}finally{r.errors=p.errors;fs.writeFileSync('docs/verification/pro-charts-20261011/browser-lifecycle.json',JSON.stringify(r,null,2));await p.browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
