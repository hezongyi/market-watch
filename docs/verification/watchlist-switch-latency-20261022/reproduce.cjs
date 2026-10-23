const {chromium}=require(require.resolve('playwright',{paths:[process.cwd()+'/web']}));
const fs=require('node:fs');
const base='https://192.168.7.232:18280',out=process.env.MW_PERF_OUT||'/tmp/mwa-switch-perf';fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true});
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1600,height:1000}});
 const report={at:new Date().toISOString(),trials:[],errors:[],blocked:[]};let active=null;
 await context.route('**/api/**',async route=>{
  const r=route.request(),p=new URL(r.url()).pathname;
  if(process.env.MW_PERF_CLEAN_SINGLE&&r.method()==='GET'&&p==='/api/advanced-charts/workspaces/7d72eead-6be5-41a4-b3d5-bfdfff98b2bb'){
   const response=await route.fetch();const body=await response.json();body.document={engine:'tv31',schemaVersion:1,symbol:'MWC:8c490df00408ed7102d9106e2ad6d3991d3e6488de0b0905d92a2ec052343cbb',series_kind:'composite',interval:'60'};return route.fulfill({response,json:body});
  }
  if(['GET','HEAD','OPTIONS'].includes(r.method())||p.startsWith('/api/charts/history-loads')||p.startsWith('/api/charts/indicator-demands/')||['/api/login','/api/market-data/resolve','/api/charts/data','/api/charts/reserve','/api/market-data/viewport-session','/api/market-data/history/cache','/api/market-data/history/demand','/api/market-data/quotes','/api/charts/stream/subscribe','/api/charts/stream/unsubscribe','/api/charts/stream/accept'].includes(p))return route.continue();
  report.blocked.push({method:r.method(),path:p});
  if(p==='/api/advanced-charts/preferences/migrate')return route.fulfill({json:{ok:true}});
  return route.fulfill({status:409,json:{detail:'Read-only performance diagnosis'}});
 });
 const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
 page.on('request',r=>{if(!active||!r.url().includes('/api/'))return;let b;try{b=r.postDataJSON();b=b?.query||b}catch{}const row={path:new URL(r.url()).pathname,method:r.method(),at_ms:Date.now()-active.start,query:b?{instrument:b.instrument,symbol:b.symbol,timeframe:b.timeframe,series_kind:b.series_kind,countBack:b.countBack,firstDataRequest:b.firstDataRequest,indicators:b.indicators?.length}:undefined};r._perf={row,start:Date.now()};active.requests.push(row)});
 page.on('response',async r=>{const item=r.request()._perf;if(!item)return;const row=item.row;row.headers_ms=Date.now()-item.start;row.status=r.status();if(['/api/charts/data','/api/market-data/resolve'].includes(row.path)||row.path.startsWith('/api/charts/history-loads')){const b=await r.json().catch(()=>({})),data=b.result||b;Object.assign(row,{ms:Date.now()-item.start,bars:data.bars?.length,cache_hit:data.cache_hit,timings_ms:data.timings_ms,keys:Object.keys(b),summary:{state:b.load?.state||b.state,phase:b.phase,pages:b.load?.pages||b.pages}})}else row.ms=row.headers_ms;});
 try{
  await page.goto(base+'/advanced-charts/7d72eead-6be5-41a4-b3d5-bfdfff98b2bb',{waitUntil:'domcontentloaded'});
  await page.locator('input[type=password]').fill(process.env.MW_ACCEPTANCE_PASSWORD);await page.locator('button.auth-submit').click();
  await page.locator('iframe').first().waitFor({timeout:30000});
  const before=await context.request.get(base+'/api/advanced-charts/workspaces/7d72eead-6be5-41a4-b3d5-bfdfff98b2bb');report.workspaceBefore=await before.json();
  let host;for(let i=0;i<100;i++){host=page.frames().find(f=>f.url().startsWith('https://192.168.7.232:18281/'));if(host)break;await page.waitForTimeout(100)}
  await host.waitForFunction(()=>typeof ready!=='undefined'&&ready&&!loading&&widget.activeChart().dataReady(),null,{timeout:90000});
  await page.getByText('已加载 · 行情按需更新',{exact:true}).waitFor({timeout:90000});
  const ui=host.childFrames()[0];await ui.locator('[data-symbol-full="MWP:EURUSD"]').waitFor();
  if(process.env.MW_PERF_SINGLE){await host.evaluate(()=>widget.setLayout('s'));await host.waitForFunction(()=>widget.chartsCount()===1&&widget.activeChart().dataReady(),null,{timeout:60000});await page.waitForTimeout(2000)}
  report.rows=await ui.locator('[data-symbol-full]').evaluateAll(es=>es.map(e=>e.dataset.symbolFull));
  await host.evaluate(()=>{
   window.__perfFeed=[];
   for(const method of ['resolveSymbol','getBars']){const orig=feed[method];feed[method]=function(...args){const e={method,at:Date.now(),symbol:method==='resolveSymbol'?args[0]:args[0]?.ticker,resolution:method==='getBars'?args[1]:undefined};window.__perfFeed.push(e);const pos=method==='resolveSymbol'?1:3,cb=args[pos];args[pos]=function(...values){e.ms=Date.now()-e.at;e.bars=Array.isArray(values[0])?values[0].length:undefined;return cb(...values)};return orig.apply(this,args)}}
  });
  const baseSymbols=['MWP:EURUSD','MWP:XAUUSD',report.rows.find(s=>s.startsWith('MWH:')),report.rows.find(s=>s.startsWith('MWC:')&&s!==report.rows.at(-1)),report.rows.at(-1),'MWP:EURUSD'];
  const symbols=process.env.MW_PERF_SHORT?[baseSymbols[0],baseSymbols[2],baseSymbols[3],baseSymbols[0]]:baseSymbols;
  for(const ticker of symbols){
   const trial={ticker,start:Date.now(),requests:[]};active=trial;report.trials.push(trial);
   const feedStart=Date.now();
   await ui.locator('[data-symbol-full="'+ticker+'"]').click();trial.click_ms=Date.now()-trial.start;
   try{await host.waitForFunction(t=>{try{const c=widget.activeChart();return c.symbol().toUpperCase()===t.toUpperCase()&&c.dataReady()&&!loading}catch{return false}},ticker,{timeout:45000});trial.ready_ms=Date.now()-trial.start;}catch(e){trial.error=e.message;trial.ready_ms=null;}
   trial.charts=await host.evaluate(()=>Array.from({length:widget.chartsCount()},(_,i)=>({symbol:widget.chart(i).symbol(),res:widget.chart(i).resolution(),ready:widget.chart(i).dataReady()})));
   if(process.env.MW_PERF_ALLWAIT){try{await host.waitForFunction(t=>Array.from({length:widget.chartsCount()},(_,i)=>widget.chart(i)).every(c=>c.symbol().toUpperCase()===t.toUpperCase()&&c.dataReady()),ticker,{timeout:45000});trial.all_ready_ms=Date.now()-trial.start;}catch(e){trial.all_ready_error=e.message}}
   trial.feed=await host.evaluate(t=>window.__perfFeed.filter(e=>e.at>=t),feedStart);
   trial.slow=trial.ready_ms===null||trial.ready_ms>3000||(trial.all_ready_ms||0)>3000;
   console.log(JSON.stringify({ticker,click_ms:trial.click_ms,ready_ms:trial.ready_ms,all_ready_ms:trial.all_ready_ms,slow:trial.slow,requests:trial.requests.length,charts:trial.charts,feed:trial.feed}));
   fs.writeFileSync(out+'/report.json',JSON.stringify(report,null,2));
   await page.screenshot({path:out+'/trial-'+report.trials.length+'.png'});active=null;
   await page.waitForTimeout(800);
  }
  report.workspaceAfter=await(await context.request.get(base+'/api/advanced-charts/workspaces/7d72eead-6be5-41a4-b3d5-bfdfff98b2bb')).json();
  report.workspaceUnchanged=JSON.stringify(report.workspaceBefore)===JSON.stringify(report.workspaceAfter);
 }catch(e){report.error=e.message;console.log('ERROR',e.message)}
 finally{fs.writeFileSync(out+'/report.json',JSON.stringify(report,null,2));await browser.close()}
 const slow=report.trials.filter(t=>t.slow).length;console.log(JSON.stringify({verdict:slow?'SLOW_REPRODUCED':'NO_SLOW',slow,total:report.trials.length,error:report.error,workspaceUnchanged:report.workspaceUnchanged}));if(slow||report.error)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1});
