// Isolated full product sync acceptance. The licensed bundle is only observed.
const {chromium}=require('@playwright/test');
const fs=require('node:fs'),assert=require('node:assert/strict');
const APP='https://localhost:15743',CHART='https://localhost:15744';
const OUT=process.env.VIEWPORT_SYNC_OUTPUT||'/tmp/mw-viewport-acceptance/sync.json';
const report={at:new Date().toISOString(),scope:'actual provider OHLC, isolated PostgreSQL, native sync and pointer events',cases:[]};
const save=()=>fs.writeFileSync(OUT,JSON.stringify(report,null,2));
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,headless:true,args:['--no-sandbox']});
 try{for(const count of (process.env.COUNTS||'2,4,8').split(',').map(Number)){
  const item={count,errors:[],http:[],phases:[]};report.cases.push(item);save();
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1600,height:1000}});
  const response=await context.request.post(APP+'/api/login',{data:JSON.parse(fs.readFileSync('/tmp/mw-viewport-acceptance/login.json'))});
  assert.ok(response.ok());const csrf=(await response.json()).csrf;
  const api=async(endpoint,data)=>{const r=await context.request.post(APP+'/api/'+endpoint,{headers:{'X-CSRF-Token':csrf},data});assert.ok(r.ok(),endpoint+' '+r.status());return r.json();};
  const workspace=await api('advanced-charts/workspaces',{name:'Viewport sync acceptance '+count});
  await api(`advanced-charts/workspaces/${workspace.id}/save`,{name:workspace.name,revision:workspace.revision,document:{engine:'tv31',schemaVersion:1,symbol:'MWP:EURUSD',series_kind:'provider',interval:'5'}});
  const page=await context.newPage(),jobs=[];let phase='initial',frame,native;
  page.on('pageerror',e=>item.errors.push({phase,message:e.message}));
  page.on('response',r=>{if(!/\/api\/charts\/(data|reserve)$/.test(r.url()))return;const atPhase=phase;
   jobs.push((async()=>{const b=await r.json();item.http.push({phase:atPhase,status:r.status(),query:r.request().postDataJSON(),count:b.bars?.length,mandatory:b.mandatory_count,reserve_status:b.reserve_status,attempts:b.candles_http_attempts});})());});
  await page.route('**/bundles/library.*.js',async route=>{
   const response=await route.fetch();let s=await response.text(),anchor='s&&this._drawSources(e,t)}if(null!==this._state)';
   assert.equal(s.split(anchor).length,2,'native drawing probe must have one anchor');
   const hook=`s&&(this._drawSources(e,t),(()=>{const m=this.state().model();if(!this.containsMainSeries())return;(globalThis.__syncModels??=new Map).set(m.id(),{m,canvas:e.canvas});if(!globalThis.__syncRecord)return;const ts=m.timeScale(),r=ts.visibleBarsStrictRange(),bars=m.mainSeries().bars(),w=Math.ceil(e.canvas.width/6),h=e.canvas.height;let pixels=0;const p=e.getImageData(0,30,w,h-60).data;for(let i=0;i<p.length;i+=16){const R=p[i],G=p[i+1],B=p[i+2];if((R>130&&R>G*1.45&&R>B*1.3)||(G>85&&G>R*1.5&&G>B*1.15))pixels++;}(globalThis.__syncFrames??=[]).push({id:m.id(),resolution:m.interval(),first:r?.firstBar(),firstAvailable:bars.firstIndex(),pixels});})())}if(null!==this._state)`;
   await route.fulfill({response,body:s.replace(anchor,hook)});
  });
  async function settle(){await frame.waitForFunction(()=>typeof ready!=='undefined'&&ready&&!loading&&!rangeGuard.busy()&&!edgeGuard.busy()&&Array.from({length:widget.chartsCount()},(_,i)=>widget.chart(i).dataReady()).every(Boolean),null,{timeout:45000});await page.waitForTimeout(500);}
  const snapshot=()=>frame.evaluate(()=>({active:widget.activeChartIndex(),sync:{crosshair:widget.crosshairSync().value(),time:widget.timeSync().value(),date:widget.dateRangeSync().value()},reserve:MWNativeReserve.diagnostics(),charts:Array.from({length:widget.chartsCount()},(_,i)=>{const c=widget.chart(i),ts=c.getTimeScale();return{symbol:c.symbol(),resolution:c.resolution(),range:c.getVisibleRange(),spacing:ts.barSpacing(),offset:ts.rightOffset(),width:ts.width(),studies:c.getAllStudies(),shapes:c.getAllShapes(),ready:c.dataReady()};})}));
  async function models(){return native.evaluate(()=>[...globalThis.__syncModels.values()].filter(v=>v.canvas.isConnected).map(({m,canvas})=>{const b=canvas.getBoundingClientRect();return{id:m.id(),box:{x:b.x,y:b.y,width:b.width,height:b.height}};}).sort((a,b)=>a.box.y-b.box.y||a.box.x-b.box.x));}
  async function box(index){const mm=await models(),ib=await native.frameElement().then(e=>e.boundingBox());assert.equal(mm.length,count);const b=mm[index].box;return{x:b.x+ib.x,y:b.y+ib.y,width:b.width,height:b.height};}
  async function hover(index){const b=await box(index);await page.mouse.move(b.x+b.width*.5,b.y+b.height*.45);await page.waitForTimeout(300);return b;}
  async function drag(index,reverse=false){const b=await box(index);await page.mouse.move(b.x+b.width*(reverse?.8:.15),b.y+b.height*.45);await page.mouse.down();for(let step=1;step<=12;step++){const q=step/12,curve=q*q*(3-2*q);await page.mouse.move(b.x+b.width*((reverse?.8:.15)+(reverse?-1:1)*.55*curve),b.y+b.height*.45);await page.waitForTimeout(20);}await page.mouse.up();await settle();return native.evaluate(({index,reverse})=>{const mm=[...globalThis.__syncModels.values()].filter(v=>v.canvas.isConnected).sort((a,b)=>{const A=a.canvas.getBoundingClientRect(),B=b.canvas.getBoundingClientRect();return A.y-B.y||A.x-B.x;});const ts=mm[index].m.timeScale();return ts.points().valueAt(Math.round(ts.coordinateToIndex(ts.width()*(reverse?.25:.7))));},{index,reverse});}
  async function crosshairs(){return native.evaluate(()=>[...globalThis.__syncModels.values()].filter(v=>v.canvas.isConnected).map(({m,canvas})=>{const c=m.crosshairSource(),ts=m.timeScale(),i=c.appliedIndex(),b=canvas.getBoundingClientRect();return{id:m.id(),resolution:m.interval(),time:ts.points().valueAt(i),index:i,price:c.price,x:c.x,y:c.y,pane:!!c.pane,visible:c.visible,label:{...c._timeAxisView._rendererData},centerTime:ts.points().valueAt(Math.round(ts.coordinateToIndex(ts.width()/2))),box:{x:b.x,y:b.y}};}).sort((a,b)=>a.box.y-b.box.y||a.box.x-b.box.x));}
  function aligned(charts,source,allEdges){for(const c of charts){const seconds=Number(c.resolution)*60;for(const edge of allEdges?['from','to']:['from'])assert.ok(Math.abs(c.range[edge]-charts[source].range[edge])<=seconds+300,`range ${edge} diverged ${JSON.stringify(charts.map(c=>c.range))}`);}}
  async function start(name,toggles){phase=name;await frame.evaluate(t=>{widget.crosshairSync().setValue(t.crosshair);widget.timeSync().setValue(t.time);widget.dateRangeSync().setValue(t.date);},toggles);await settle();const row={name,initial:await snapshot()};item.phases.push(row);await native.evaluate(()=>{globalThis.__syncFrames=[];globalThis.__syncRecord=true;});return row;}
  async function end(row){await settle();row.final=await snapshot();row.frames=await native.evaluate(()=>{globalThis.__syncRecord=false;return globalThis.__syncFrames;});row.missing=row.frames.filter(f=>f.first<f.firstAvailable);row.blank=row.frames.filter(f=>f.pixels===0);assert.equal(row.missing.length,0,row.name+' missing historical bars');assert.equal(row.blank.length,0,row.name+' blank left candles');assert.ok(row.final.charts.every(c=>c.ready));for(let i=0;i<count;i++){for(const k of ['symbol','resolution','studies','shapes'])assert.deepEqual(row.final.charts[i][k],row.initial.charts[i][k],row.name+' changed '+k);}assert.deepEqual(item.errors,[]);save();}
  try{
   await page.goto(APP+'/advanced-charts');await page.waitForFunction(()=>[...document.querySelectorAll('iframe')].some(f=>f.src.startsWith('https://localhost:15744/')));
   for(let n=0;n<300&&!frame;n++){frame=page.frames().find(f=>f.url().startsWith(CHART+'/'));if(!frame)await page.waitForTimeout(100);}assert.ok(frame);await settle();
   await frame.evaluate(count=>{widget.crosshairSync().setValue(false);widget.timeSync().setValue(false);widget.dateRangeSync().setValue(false);widget.setLayout(count===2?'2h':String(count));},count);await settle();
   await frame.evaluate(async()=>{for(let i=0;i<widget.chartsCount();i++)await widget.chart(i).createStudy('Moving Average',false,false,{length:200});});await settle();
   native=frame.childFrames().find(f=>f.url().includes('charting_library'))||frame.childFrames()[0];assert.ok(native);
   await frame.waitForFunction(()=>MWNativeReserve.diagnostics().models.every(m=>m.geometry?.reserve>=m.geometry.screen*2-1),null,{timeout:30000});
   // Crosshair only: all peers must show the same actual candle time without panning.
   let row=await start('crosshair-only',{crosshair:true,time:false,date:false});
   await hover(0);row.crosshairs=await crosshairs();assert.ok(row.crosshairs.every(c=>c.pane&&c.visible&&c.label.visible&&c.label.text&&Number.isFinite(c.time)&&c.time===row.crosshairs[0].time),'linked crosshair must appear at the same actual bar time');
   row.events=await frame.evaluate(()=>{globalThis.__syncEvents=[];for(let i=0;i<widget.chartsCount();i++)widget.chart(i).crossHairMoved().subscribe(null,p=>globalThis.__syncEvents.push({i,time:p.time,price:p.price,userTime:p.userTime,series:p.entityValues?._seriesId}));return true;});
   const hb=await box(0);await page.mouse.move(hb.x+hb.width*.65,hb.y+hb.height*.5);await page.waitForTimeout(250);row.events=await frame.evaluate(()=>globalThis.__syncEvents);assert.ok(row.events.length&&row.events.every(e=>Number.isFinite(e.time)),'public crosshair time events');await page.screenshot({path:OUT.replace('.json',`-${count}-crosshair.png`)});
   await end(row);for(let i=0;i<count;i++)assert.deepEqual(row.final.charts[i].range,row.initial.charts[i].range,'crosshair-only must not pan');
   // Native time sync centers peers on the mouse-release time; it does not
   // require equal viewport spans or synchronized crosshairs.
   row=await start('time-only',{crosshair:false,time:true,date:false});await drag(0);row.releaseTime=await drag(0);row.crosshairs=await crosshairs();await end(row);
   assert.ok(row.final.charts.slice(1).some((c,i)=>c.offset!==row.initial.charts[i+1].offset),'time sync peers did not follow');assert.ok(row.crosshairs.slice(1).every(c=>Math.abs(c.centerTime-row.releaseTime)<=300),'released time must be centered in peer panes');
   // Date range sync: actual mouse drags on first and then last pane.
   row=await start('range-only',{crosshair:false,time:false,date:true});for(let i=0;i<6;i++)await drag(0,i===3);aligned((await snapshot()).charts,0,true);await drag(count-1);await end(row);aligned(row.final.charts,count-1,true);assert.equal(row.final.active,count-1,'pointer must switch focus');
   row=await start('all-sync',{crosshair:true,time:true,date:true});for(let i=0;i<6;i++)await drag(i%2?count-1:0,i===3);await hover(count-1);row.crosshairs=await crosshairs();assert.ok(row.crosshairs.every(c=>c.pane&&c.visible&&c.label.visible&&c.label.text&&Number.isFinite(c.time)&&c.time===row.crosshairs.at(-1).time));await end(row);aligned(row.final.charts,count-1,true);
   // Mixed M5/M15: select a common historical window within prewarmed coverage.
   phase='mixed-setup';await frame.evaluate(async()=>{widget.timeSync().setValue(false);widget.dateRangeSync().setValue(false);for(let i=1;i<widget.chartsCount();i+=2)await widget.chart(i).setResolution('15',{doNotActivateChart:true});});await settle();
   const charts=(await snapshot()).charts,to=Math.min(...charts.map(c=>c.range.to))-3600,target={from:to-6*3600,to};
   // Native dataReady can precede symbol metadata reattachment after a period change.
   // Use the same bounded retry as the product's viewport restoration.
   item.setupRetries=await frame.evaluate(async target=>{let retries=0;for(let i=0;i<widget.chartsCount();i++)for(let n=0;;n++){try{await widget.chart(i).setVisibleRange(target,{rejectByTimeout:30000});break;}catch(e){if(e.message!=='Value is null'||n>=20)throw e;retries++;await new Promise(ok=>setTimeout(ok,100));}}return retries;},target);await settle();
   await frame.waitForFunction(()=>MWNativeReserve.diagnostics().models.every(m=>m.geometry?.reserve>=m.geometry.screen*2-1),null,{timeout:30000});
   row=await start('mixed-all-sync',{crosshair:true,time:true,date:true});for(let i=0;i<4;i++)await drag(i%2?count-1:0,i===2);await hover(0);row.crosshairs=await crosshairs();assert.ok(row.crosshairs.every(c=>c.pane&&c.visible&&c.label.visible&&c.label.text&&Number.isFinite(c.time)&&Math.abs(c.time-row.crosshairs[0].time)<=900),'cross-period cursor must map to the containing bar');await end(row);aligned(row.final.charts,0,true);
   // Keep native synchronization enabled during a period change and reload.
   phase='linked-period-change';await frame.evaluate(()=>widget.chart(0).setResolution('15',{doNotActivateChart:true}));await settle();item.periodChange=await snapshot();assert.ok(item.periodChange.sync.date&&item.periodChange.sync.time&&item.periodChange.sync.crosshair);assert.equal(item.periodChange.charts[0].resolution,'15');
   phase='save';await frame.waitForFunction(()=>!nativeSaving&&!rangeGuard.busy()&&!edgeGuard.busy());await frame.evaluate(()=>new Promise((ok,fail)=>widget.saveChartToServer(ok,fail)));item.saved=await snapshot();
   phase='refresh';await page.reload();frame=undefined;for(let n=0;n<300&&!frame;n++){frame=page.frames().find(f=>f.url().startsWith(CHART+'/'));if(!frame)await page.waitForTimeout(100);}assert.ok(frame);await settle();native=frame.childFrames().find(f=>f.url().includes('charting_library'))||frame.childFrames()[0];item.restored=await snapshot();assert.deepEqual(item.restored.sync,item.saved.sync);assert.equal(item.restored.charts.length,count);for(let i=0;i<count;i++){for(const k of ['symbol','resolution','studies','shapes'])assert.deepEqual(item.restored.charts[i][k],item.saved.charts[i][k]);for(const edge of ['from','to'])assert.ok(Math.abs(item.restored.charts[i].range[edge]-item.saved.charts[i].range[edge])<=900,'refresh lost linked historical range');}
   await hover(0);item.restoredCrosshairs=await crosshairs();assert.ok(item.restoredCrosshairs.every(c=>c.visible&&c.label.visible&&c.label.text&&Number.isFinite(c.time)));assert.deepEqual(item.errors,[]);
   await Promise.all(jobs);assert.ok(item.http.some(r=>r.query.native_reserve));assert.ok(item.http.filter(r=>r.query.native_reserve).every(r=>r.status===200&&r.mandatory===0&&r.attempts.length===0));
   await page.screenshot({path:OUT.replace('.json',`-${count}.png`)});item.passed=true;
  }catch(e){item.error=String(e);item.observed=await snapshot().catch(()=>null);await page.screenshot({path:OUT.replace('.json',`-${count}-failure.png`)}).catch(()=>{});}
  finally{await Promise.allSettled(jobs);save();await context.close();}
 }}finally{save();await browser.close();}
 assert.ok(report.cases.every(c=>c.passed),'native sync acceptance failed');
})().catch(e=>{report.error=String(e);save();console.error(e.message);process.exitCode=1;});
