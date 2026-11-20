// Built mobile entry and actual licensed widget, with explicit API test doubles.
// This is browser evidence, never backend/Find X8/ntfy acceptance.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium,expect}=require('@playwright/test');
const dist=path.resolve('dist'),id='a'.repeat(64),ticker='MWC:'+id;
const out=process.env.MOBILE_CHART_OUTPUT || '/tmp/mw-chart-round1';fs.mkdirSync(out,{recursive:true});
const requests=[],errors=[],checks=[],consoleErrors=[],layouts=[];let catalogMode='hold',releaseCatalog,holdHistory=false,failHistory=false,priceOffset=0;const heldHistory=[];
const provider='MWP:YAHOO:AAPL';
const now=Date.now();
const alertRule={id:'fixture-rule',name:'EURUSD H1',status:'paused',health:'ready',version:1,control_revision:1,run:1,count:0,max_triggers:1,created_at:Date.now(),updated_at:Date.now(),display_identity:{code:'EURUSD',source:'composite'},condition_summary:'价格 上穿 101',runtime:{},config:{name:'EURUSD H1',instrument:id,series_kind:'composite',source:'composite',timeframe:'H1',mode:'close',condition:{relation:'cross_up',left:{kind:'price'},right:{kind:'constant',value:'101'}},max_triggers:1,expires_at:null,message:'',notify_web:true,notify_ntfy:false,late_delivery:'log_only',association:null,calculation_version:'chart-python-v1'}};
const priceRules=[alertRule];
let logged=false,shellRevision=0,brokenInstall=false,delayLogin=false,pendingLogin;
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/desktop-isolation') {
  const manifest=JSON.parse(fs.readFileSync(path.join(dist,'chart-assets.json')));
  res.writeHead(200,{'Content-Type':'text/html'});
  return res.end(`<!doctype html><html><head><meta charset="utf-8"><style>html,body,#chart{margin:0;width:100%;height:100%}</style></head><body><div id="chart"></div>
   <script src="/${manifest.libraryDirectory}/charting_library.js"></script><script src="/${manifest.script}"></script><script>
   globalThis.desktopReady=false;globalThis.desktopErrors=[];globalThis.desktopMessages=[];globalThis.desktopWrites=[];
   globalThis.desktopSettings=[{kind:'setting',name:'mw.theme',tool:'',content:{value:'Light'}}];
   globalThis.desktopWorkspace={id:'desktop-fixture',name:'桌面配置隔离验收',revision:1,document:{engine:'tv31',schemaVersion:1,symbol:'${provider}',interval:'60'}};
   const copy=value=>JSON.parse(JSON.stringify(value));
   const call=async(path,query)=>{const response=await fetch('/api'+path,{method:query?'POST':'GET',headers:{'Content-Type':'application/json'},body:query?JSON.stringify(query):undefined});return response.json();};
   const adapter=MWChartAdapter.mount(document.querySelector('#chart'),{
    observe(message,source){desktopMessages.push(message.type);if(message.type==='loaded')source.update({type:'init',readonly:false,workspace:copy(desktopWorkspace),document:copy(desktopWorkspace.document),catalog:{SMA:{label:'SMA 简单均线',pane:'main',params:{period:20},series:[{key:'value',type:'line'}]}},preferences:copy(desktopSettings),history_capabilities:{protocol:1,version:'fixture',mode:'continuous',task_seconds:30,default_bars:1000,max_bars:20000,workspace_bars:100000}}).catch(error=>desktopErrors.push(error.message));if(message.type==='ready')desktopReady=true;if(message.type==='error')desktopErrors.push(message.error);},
    market:async(kind,q)=>{if(kind==='data')return call('/charts/data',q);if(kind.startsWith('indicator-demand'))return {ok:true};const endpoints={resolve:'/market-data/resolve',quotes:'/market-data/quotes',search:'/market-data/series/page',searchPage:'/market-data/series/page',dataset:'/market-data/dataset',historyCache:'/market-data/history/cache'};if(q.op==='serverTime')return Math.floor(Date.now()/1000);return call(endpoints[q.op]||'/market-data/resolve',q.args||q);},
    workspace:async(kind,q)=>{if(q.op==='list')return [];if(q.op==='save'){const state=JSON.parse(q.args.content);desktopWorkspace={...desktopWorkspace,revision:desktopWorkspace.revision+1,document:{engine:'tv31',schemaVersion:1,state,symbol:q.args.symbol,interval:q.args.resolution}};desktopWrites.push('workspace');return copy(desktopWorkspace);}throw Error('Unexpected workspace operation '+q.op);},
    session:async(kind,q)=>{if(q.op==='read')return copy(desktopSettings);if(q.op==='draftCheck')return true;if(q.op==='save'){const row={...q.args,id:'b'.repeat(64),revision:1,content:{value:q.args.value}};desktopSettings=desktopSettings.filter(p=>p.name!==q.args.name);desktopSettings.push(row);desktopWrites.push('preferences');return row;}return {ok:true};},
    alerts:async()=>[],notifications:async()=>({events:[],cursor:'fixture'}),dataCenter:async()=>({items:[]}),cancel(){}
   });adapter.start();
   </script></body></html>`);
 }
 if(url.pathname.startsWith('/api/')) {
   let text='';for await(const chunk of req)text+=chunk;
   const query=text?JSON.parse(text):{};requests.push({path:url.pathname,method:req.method});
   const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
   if(url.pathname==='/api/session')return logged?json({csrf:'test-csrf',subject:'admin'}):json({detail:'未登录'},401);
   if(url.pathname==='/api/login'){logged=true;if(delayLogin){pendingLogin=()=>json({csrf:'test-csrf',subject:'admin'});return;}return json({csrf:'test-csrf',subject:'admin'});}
   if(url.pathname==='/api/logout'){logged=false;return json({ok:true});}
   if(url.pathname==='/api/advanced-charts/preferences')return json([]);
   if(url.pathname==='/api/market-data/composites/'+id)return json({id,source:'composite',frames:['M1','M5','H1','D1'],status:'ready'});
   if(url.pathname==='/api/market-data/series/page')return json({items:[{ticker,symbol:'EURUSD · 日内观察组合',source:'composite',instrument_name:'受控组合',description:'受控浏览器测试组合',series_kind:'composite'},{ticker:provider,symbol:'AAPL',description:'苹果',instrument_name:'苹果',source:'yahoo',series_kind:'provider',frames:['M1','M5','H1','D1']}]});
   if(url.pathname==='/api/advanced-charts/catalog'){if(catalogMode==='hold')await new Promise(resolve=>releaseCatalog=resolve);if(catalogMode==='fail')return json({detail:'图表目录读取失败'},500);return json({SMA:{label:"SMA 简单均线",pane:"main",aliases:["SMA","均线"],params:{period:20},series:[{key:"value",type:"line"}]}});}
   if(url.pathname==='/api/charts/history-capabilities')return json({protocol:1,version:'test',mode:'continuous',max_bars:20000,workspace_bars:100000,default_bars:1000,task_seconds:30});
   if(url.pathname==='/api/market-data/resolve')return json({symbol:query.series_kind==='provider'?'AAPL':'EURUSD · 日内观察组合',source:query.series_kind==='provider'?'yahoo':'composite',price_description:'收盘价',source_display:'FXCM',historical_source:'fxcm',name:query.series_kind==='provider'?'苹果':'受控组合',precision:2,calendar:'utc0',asset_type:'CRYPTO',frames:['M1','M5','H1','D1'],created:true,stream:false});
   if(url.pathname==='/api/chart-alerts/presets/previous-day')return json({kind:'previous_day',lower:'98.50',upper:'103.25',reference_date:'2026-11-19',reference_start:now-172800000,reference_end:now-86400000,day_end:Math.floor(now/86400000)*86400000+86400000,expires_at:Math.floor(now/86400000)*86400000+86400001,calendar:'utc0',outside:true,composite_revision_id:'b'.repeat(64),phone_available:true});
   if(url.pathname==='/api/chart-alerts/page')return json({items:[alertRule],next_cursor:null});
   if(url.pathname==='/api/chart-alerts/fixture-rule')return json(alertRule);
   if(url.pathname==='/api/chart-alerts/capabilities')return json({composite_revision_id:'b'.repeat(64),phone:{available:true,reason:null},sources:[{source:'composite',series_kind:'composite',available:true,atr_frames:['M1','M5','H1','D1'],price_modes:{intrabar:{available:true},close:{available:true}}}]});
   if(url.pathname==='/api/chart-alerts'){
     if(req.method==='POST'){const row={...structuredClone(alertRule),id:query.request_id,name:query.config.name,config:query.config,status:'active',version:1,control_revision:1};priceRules.push(row);return json(row);}
     return json(priceRules.filter(r=>r.status!=='archived'));
   }
   const priceMatch=url.pathname.match(/^\/api\/chart-alerts\/([a-f0-9-]{36})(?:\/(edit|lifecycle))?$/);
   if(priceMatch){const row=priceRules.find(r=>r.id===priceMatch[1]);if(!row)return json({detail:'not found'},404);if(req.method==='POST'){if(query.version!==row.version || (query.control_revision!==undefined && query.control_revision!==row.control_revision))return json({detail:'conflict'},409);if(priceMatch[2]==='edit'){row.config=query.config;row.name=query.config.name;row.version++;}else row.status={pause:'paused',resume:'active',archive:'archived'}[query.action];row.control_revision++;}return json(row);}
   if(url.pathname==='/api/chart-alerts/events/page')return json({items:[],next_cursor:null});
   if(url.pathname==='/api/health')return json({version:'fixture',ntfy_configured:true,delivery_enabled:true});
   if(url.pathname==='/api/notification-center/snapshot')return json({events:[],cursor:'test'});
   if(url.pathname==='/api/notification-center/events')return json({events:[],before:null});
   if(url.pathname==='/api/charts/history-loads/fixture-load/cancel')return json({ok:true});
   if(['/api/charts/data','/api/charts/history-loads','/api/charts/reserve'].includes(url.pathname)){
     const candleQuery=query.query || query;if(process.env.MOBILE_CHART_DEBUG)console.log('HISTORY',url.pathname,JSON.stringify(candleQuery));if(holdHistory && (url.pathname==='/api/charts/history-loads' || process.env.MOBILE_CHART_CACHE_COMPOSITE && url.pathname==='/api/charts/data' && !candleQuery.indicators?.length))await new Promise(resolve=>heldHistory.push(resolve));
     if(failHistory && process.env.MOBILE_CHART_CACHE_COMPOSITE && url.pathname==='/api/charts/data' && !candleQuery.indicators?.length)return json({detail:'历史暂不可用，请重试'},503);
     if(failHistory && url.pathname==='/api/charts/history-loads')return json({load:{id:'fixture-load',state:'failed',error:{code:'HISTORY_UNAVAILABLE',message:'平台历史暂不可用，请重试',status:503}}});
     const step={M1:60000,M5:300000,H1:3600000,D1:86400000}[candleQuery.timeframe] || 3600000;
     const end=Math.floor(Math.min(candleQuery.before || Date.now(),Date.now())/step)*step;
     const bars=Array.from({length:Math.min(candleQuery.limit || 100,500)},(_,i)=>{
       const start=end-(Math.min(candleQuery.limit || 100,500)-i)*step;
       const close=100+priceOffset+Math.sin(i/13)*1.2+Math.sin(i/4)*.25+i*.006,open=close+Math.sin(i*2)*.15;return {start,end:start+step,open:open.toFixed(2),high:(Math.max(open,close)+.12).toFixed(2),low:(Math.min(open,close)-.12).toFixed(2),close:close.toFixed(2),complete:true,revision:1};
     });
     const result={bars,has_more:false,pending:[],revision_id:'b'.repeat(64),input_revision:1,as_of:Date.now()};return json(url.pathname==='/api/charts/history-loads'?{load:{id:'fixture-load',state:'ready',pages:1},result}:result);
   }
   if(url.pathname==='/api/market-data/quotes')return json((query.symbols || []).map(n=>({n,s:'ok',v:{lp:101,ch:1,chp:1}})));
   if(url.pathname.startsWith('/api/charts/indicator-demands/'))return json({ok:true});
   if(url.pathname==='/api/charts/stream/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('event: heartbeat\ndata: {}\n\n');return;}
   if(url.pathname.startsWith('/api/charts/stream/'))return json({ok:true});
   return json({detail:'Unexpected test API '+url.pathname},404);
 }
 if(url.pathname==='/readyz'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({time:Date.now()}));}
 let file=path.join(dist,decodeURIComponent(url.pathname));
 if(url.pathname==='/m'){res.writeHead(308,{Location:'/m/'});return res.end();}
 if(fs.existsSync(file)&&fs.statSync(file).isDirectory())file=path.join(file,'index.html');
 if(!fs.existsSync(file)&&url.pathname.startsWith('/m/'))file=path.join(dist,'m/index.html');
 if(!file.startsWith(dist+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}
 const mime={'.js':'application/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.svg':'image/svg+xml'};
 res.writeHead(200,{'Content-Type':mime[path.extname(file)] || 'application/octet-stream','Cache-Control':'no-store'});
 let body=fs.readFileSync(file);
 if(url.pathname==='/m/sw.js'&&shellRevision){body=Buffer.from(body.toString().replace(/const CACHE='([^']+)'/,(_,name)=>`const CACHE='${name}-test-${shellRevision}'`).replace('const FILES=[',brokenInstall?"const FILES=['/missing-mobile-shell-resource.js',":'const FILES=['));}
 if(/^chart\.[a-f0-9]+\.js$/.test(path.basename(file)))body=Buffer.from(`const Original=TradingView.widget;TradingView.widget=function(...args){const widget=new Original(...args);globalThis.MW_TEST_WIDGET=widget;globalThis.MW_TEST_OPTIONS=args[0];return widget;};\n`+body);
 if(/^chart\.[a-f0-9]+\.js$/.test(path.basename(file)))body=Buffer.from(body.toString()+`
const originalMount=MWChartAdapter.mount;MWChartAdapter.mount=(root,app)=>originalMount(root,{...app,workspace:async(...args)=>{if(window.MW_TEST_SAVE_HOLD)await new Promise(resolve=>window.MW_TEST_RELEASE_SAVE=resolve);const result=await app.workspace(...args);window.MW_TEST_SAVE_COUNT=(window.MW_TEST_SAVE_COUNT||0)+1;return result;}});`);
 res.end(body);
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch(),context=await browser.newContext({viewport:{width:412,height:915},isMobile:true,hasTouch:true,serviceWorkers:'block'}),page=await context.newPage();
 // Replay the APK navigation policy: a blob iframe is cancelled before its
 // document can request any bundles. Normal same-origin HTTPS frames pass.
 await context.addInitScript(()=>{
   const html=Object.getOwnPropertyDescriptor(Element.prototype,'innerHTML');
   Object.defineProperty(Element.prototype,'innerHTML',{...html,set(value){
     html.set.call(this,String(value).replace(/(<iframe\b[^>]*\bsrc=")blob:[^"]*(")/g,'$1about:blank$2'));
   }});
 });
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text().slice(0,300))});
 const base='http://127.0.0.1:'+server.address().port;
 const back=()=>page.evaluate(()=>dispatchEvent(new Event('mw-mobile-back',{cancelable:true})));
 const settle=()=>page.waitForTimeout(380);
 const shot=async name=>{await settle();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal overflow: '+name);await page.screenshot({path:path.join(out,name+'.png')});};
 const native=()=>page.frameLocator('.mobile-chart-canvas iframe');
 const widgetReady=async()=>{await expect(page.locator('.chart-workspace')).toHaveAttribute('aria-busy','false',{timeout:30000});await expect(native().getByRole('button',{name:'指标 & 策略',exact:true})).toBeEnabled();await expect.poll(()=>page.evaluate(()=>{try{return Boolean(window.MW_TEST_WIDGET?.activeChart().dataReady())}catch{return false}}),{timeout:30000}).toBe(true);};
 const symbolIs=async value=>expect.poll(()=>page.evaluate(()=>window.MW_TEST_WIDGET.activeChart().symbol())).toBe(value);
 const theme=async value=>{await page.getByRole('link',{name:'更多',exact:true}).click();if(await page.locator('.mobile-app').getAttribute('data-theme')!==value)await page.getByRole('button',{name:/显示主题/}).click();await page.getByRole('link',{name:'图表',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.MW_TEST_WIDGET.getTheme().toLowerCase())).toBe(value);};
 const silentLocalSave=async()=>{
  const baseline=await page.evaluate(()=>window.MW_TEST_WIDGET.activeChart().getAllStudies().length);
  await page.evaluate(()=>window.MW_TEST_SAVE_HOLD=true);
  const study=await page.evaluate(()=>window.MW_TEST_WIDGET.activeChart().createStudy('Relative Strength Index',false,false,{length:11}));
  await expect.poll(()=>page.evaluate(()=>typeof window.MW_TEST_RELEASE_SAVE==='function')).toBe(true);
  assert.equal(await page.getByText('本次图表更改尚未记住',{exact:true}).count(),0,'pending autosave must not be presented as a storage failure');await shot('autosave-pending');
  const before=await page.evaluate(()=>window.MW_TEST_SAVE_COUNT||0);
  await page.evaluate(()=>{window.MW_TEST_SAVE_HOLD=false;window.MW_TEST_RELEASE_SAVE();delete window.MW_TEST_RELEASE_SAVE;});
  await expect.poll(()=>page.evaluate(()=>window.MW_TEST_SAVE_COUNT||0)).toBeGreaterThan(before);
  await page.getByRole('link',{name:'更多',exact:true}).click();await page.getByRole('link',{name:'图表',exact:true}).click();await page.reload();await widgetReady();
  await expect.poll(()=>page.evaluate(id=>window.MW_TEST_WIDGET.activeChart().getStudyById(id).getInputValues().find(v=>v.id==='length').value,study)).toBe(11);
  // Throw at the real local-storage write boundary; genuine failures must still
  // reach the existing notification, and an explicit flush can retry the write.
  await page.evaluate(()=>{const put=IDBObjectStore.prototype.put;window.MW_TEST_STORAGE_PUT=put;IDBObjectStore.prototype.put=function(value,key){if(this.name==='records'&&Array.isArray(key)&&key[3]==='chart')throw Error('本机存储写入失败');return put.call(this,value,key);};});
  await page.evaluate(id=>window.MW_TEST_WIDGET.activeChart().removeEntity(id),study);
  await expect(page.locator('.chart-operation-error')).toContainText('设置尚未保存到本机');await expect(page.locator('.mobile-toast')).toHaveCount(0);await shot('autosave-real-write-failure');
  await page.evaluate(()=>IDBObjectStore.prototype.put=window.MW_TEST_STORAGE_PUT);
  await page.getByRole('button',{name:'重试保存',exact:true}).click();await expect(page.locator('.chart-operation-error')).toHaveCount(0);await page.getByRole('link',{name:'更多',exact:true}).click();await page.getByRole('link',{name:'图表',exact:true}).click();await page.reload();await widgetReady();
  assert.equal(await page.evaluate(()=>window.MW_TEST_WIDGET.activeChart().getAllStudies().length),baseline,'retry flush persists latest settings after local storage recovers');await shot('autosave-reloaded');
  // A subsequent successful autosave must remove the old error by itself.
  await page.evaluate(()=>{const put=IDBObjectStore.prototype.put;window.MW_TEST_STORAGE_PUT=put;IDBObjectStore.prototype.put=function(value,key){if(this.name==='records'&&Array.isArray(key)&&key[3]==='chart')throw Error('本机存储写入失败');return put.call(this,value,key);};});
  const recoveredStudy=await page.evaluate(()=>MW_TEST_WIDGET.activeChart().createStudy('Relative Strength Index',false,false,{length:13}));
  await expect(page.locator('.chart-operation-error')).toBeVisible();
  await page.evaluate(()=>IDBObjectStore.prototype.put=window.MW_TEST_STORAGE_PUT);
  await page.evaluate(id=>MW_TEST_WIDGET.activeChart().removeEntity(id),recoveredStudy);
  await expect(page.locator('.chart-operation-error')).toHaveCount(0,{timeout:15000});
  checks.push('successful autosave automatically clears a previous real storage failure');
  checks.push('normal pending autosave is silent; study settings restored on reload; actual local write failure is reported; flush retries and persists after storage recovery');
 };
 const failedHistoryStartup=async()=>{
  await page.evaluate(ticker=>window.MW_TEST_WIDGET.activeChart().setSymbol(ticker),provider);await widgetReady();await symbolIs(provider);
  await page.getByRole('link',{name:'更多',exact:true}).click();
  const saved=await page.evaluate(()=>new Promise((resolve,reject)=>{const req=indexedDB.open('mw-mobile',2);req.onerror=()=>reject(req.error);req.onsuccess=()=>{const db=req.result,read=db.transaction('records').objectStore('records').get([location.origin,'admin',1,'chart']);read.onsuccess=()=>{db.close();resolve(read.result?.value?.state?._mwViewports);};};}));
  assert(saved?.[0]?.symbol===provider && saved[0].range?.to>saved[0].range?.from,'saved provider viewport is required to reproduce startup history failure');
  await page.evaluate(()=>new Promise(resolve=>{const r=indexedDB.open('mw-mobile',2);r.onsuccess=()=>{const db=r.result,tx=db.transaction('records','readwrite');tx.objectStore('records').delete([location.origin,'admin',1,'chart-history']);tx.oncomplete=()=>{db.close();resolve();};};}));
  failHistory=true;
  await page.getByRole('link',{name:'图表',exact:true}).click();await page.reload();
  await expect(page.locator('.chart-workspace')).toHaveAttribute('aria-busy','false',{timeout:8000});
  await expect(page.getByRole('status',{name:'准备图表'})).toHaveCount(0);
  await expect(page.getByText('行情读取失败',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'重试行情',exact:true})).toBeEnabled();
  await shot('failed-history-startup');
  // A genuine pending read still reports progress; the retry resets only data,
  // preserving the same widget, saved studies and local document.
  const instance=await page.evaluateHandle(()=>window.MW_TEST_WIDGET);failHistory=false;holdHistory=true;
  await page.getByRole('button',{name:'重试行情',exact:true}).click();await expect(page.getByRole('button',{name:'正在重试行情',exact:true})).toBeDisabled();
  holdHistory=false;heldHistory.splice(0).forEach(resolve=>resolve());await widgetReady();
  await expect(page.locator('.chart-history-failure')).toHaveCount(0);assert(await page.evaluate(w=>w===window.MW_TEST_WIDGET,instance));await instance.dispose();
  await symbolIs(provider);await shot('failed-history-recovered');
  await native().getByRole('radio',{name:'1 分钟',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.MW_TEST_WIDGET.activeChart().resolution())).toBe('1');await widgetReady();
  checks.push('saved provider viewport + failed first history: no infinite cover; readable failure; pending retry disabled; real data retry clears failure on same widget; period switch works');
  console.log('SAVED VIEWPORT + FAILED HISTORY: usable chart, explicit retry restores real bars');
 };
 const continuity=async()=>{
  const chosen=process.env.MOBILE_CHART_CACHE_COMPOSITE ? ticker.toUpperCase() : provider;
  await page.evaluate(t=>window.MW_TEST_WIDGET.activeChart().setSymbol(t),chosen);await widgetReady();await symbolIs(chosen);
  if(process.env.MOBILE_CHART_CACHE_STUDY)await page.evaluate(()=>MW_TEST_WIDGET.activeChart().createStudy('Relative Strength Index',false,false,{length:9}));
  const readHistory=()=>page.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('mw-mobile',2);r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,q=db.transaction('records').objectStore('records').get([location.origin,'admin',1,'chart-history']);q.onsuccess=()=>{db.close();resolve(q.result?.value||[]);};};}));
  const values=()=>page.evaluate(()=>{const chart=window.MW_TEST_WIDGET.activeChart(),bars=chart._chartWidget.model().model().mainSeries().bars();return {size:bars.size(),last:bars.valueAt(bars.lastIndex()),range:chart.getVisibleRange()};});
  for(const resolution of ['60','5']){
   await page.evaluate(r=>window.MW_TEST_WIDGET.activeChart().setResolution(r),resolution);await widgetReady();
   await page.getByRole('link',{name:'更多',exact:true}).click();await page.getByRole('link',{name:'图表',exact:true}).click();
   await expect.poll(async()=> (await readHistory()).some(row=>row.query.instrument===(process.env.MOBILE_CHART_CACHE_COMPOSITE ? id : 'YAHOO:AAPL')&&row.query.timeframe===(resolution==='5'?'M5':'H1'))).toBe(true);
  }
  if(process.env.MOBILE_CHART_DEBUG)console.log('CACHE BEFORE',JSON.stringify((await readHistory()).map(e=>({query:e.query,count:e.page.bars.length,first:e.page.bars[0].start,last:e.page.bars.at(-1).start,as_of:e.page.as_of}))));
  failHistory=Boolean(process.env.MOBILE_CHART_CACHE_FAILURE);holdHistory=!failHistory;await page.reload();await widgetReady();
  await expect(page.locator('.chart-preview')).toHaveCount(0);
  if(!failHistory)await expect(page.getByText('正在同步行情',{exact:true})).toBeVisible();
  assert((await values()).size>10,'real cached candles render while authoritative history is held');
  const oldClose=(await values()).last[4];
  const instance=await page.evaluateHandle(()=>window.MW_TEST_WIDGET);
  const crosshair=native().locator('.mw-mobile-crosshair-entry:visible');await crosshair.click();await expect(crosshair).toHaveAttribute('aria-pressed','true');await crosshair.click();
  assert.equal(await crosshair.innerText(),'','crosshair is icon-only');
  await shot('real-cached-chart-pending');
  let pastRange;
  if(process.env.MOBILE_CHART_CACHE_PAST){
   pastRange=await page.evaluate(async()=>{const chart=MW_TEST_WIDGET.activeChart(),range=chart.getVisibleRange();await chart.setVisibleRange({from:range.from+1800,to:range.to-1800});return chart.getVisibleRange();});
  }
  if(process.env.MOBILE_CHART_CACHE_SWITCH){
   await page.evaluate(()=>{void MW_TEST_WIDGET.activeChart().setResolution('1');});
   await expect.poll(()=>page.evaluate(()=>MW_TEST_WIDGET.activeChart().resolution())).toBe('1');
  }
  if(failHistory){
   await expect(page.locator('.chart-history-failure')).toBeVisible();await shot('cached-chart-sync-failed');
   await page.waitForTimeout(250);await expect(page.locator('.chart-history-failure')).toBeVisible();
   failHistory=false;priceOffset=10;
   await page.getByRole('button',{name:'重试行情',exact:true}).click();
  }
  priceOffset=10;holdHistory=false;heldHistory.splice(0).forEach(resolve=>resolve());
  if(process.env.MOBILE_CHART_CACHE_SWITCH){
   await widgetReady();await page.evaluate(()=>MW_TEST_WIDGET.activeChart().setResolution('5'));
   await expect.poll(()=>page.evaluate(()=>MW_TEST_WIDGET.activeChart().resolution())).toBe('5');
  }
  await expect(page.getByText('正在同步行情',{exact:true})).toHaveCount(0,{timeout:20000});await widgetReady();
  await expect.poll(async()=> (await values()).last[4]).toBeGreaterThan(oldClose+8);
  if(pastRange){const range=(await values()).range;assert(Math.abs(range.from-pastRange.from)<600 && Math.abs(range.to-pastRange.to)<600,'cache revalidation preserves historical viewport');}
  assert(await page.evaluate(w=>w===window.MW_TEST_WIDGET,instance),'fresh history keeps same widget');await instance.dispose();
  await shot('real-cached-chart-synchronized');
  priceOffset=0;
  checks.push('bounded real candle cache renders interactive widget on reload while history is delayed; no screenshot; synchronization replaces stale candles on same widget; icon-only crosshair remains usable');
 };
 const desktopIsolation=async()=>{
  const desktopContext=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  const desktop=await desktopContext.newPage();desktop.on('pageerror',e=>{errors.push(e.message);console.error('DESKTOP ERROR',e.message)});
  await desktop.goto(base+'/desktop-isolation');await desktop.waitForFunction(()=>desktopReady && window.MW_TEST_WIDGET?.activeChart().dataReady(),null,{timeout:30000}).catch(async error=>{console.error('DESKTOP STATE',await desktop.evaluate(()=>({errors:desktopErrors,messages:desktopMessages,html:document.body.innerHTML.slice(0,600),ready:desktopReady,widget:!!window.MW_TEST_WIDGET,options:window.MW_TEST_OPTIONS?.symbol,text:document.body.innerText})));await desktop.screenshot({path:path.join(out,'desktop-failure.png')});throw error;});
  const desktopNative=desktop.frameLocator('#chart iframe');
  await expect(desktopNative.getByRole('button',{name:'数据中心',exact:true})).toBeVisible();
  const options=await desktop.evaluate(()=>({enabled:MW_TEST_OPTIONS.enabled_features,disabled:MW_TEST_OPTIONS.disabled_features,theme:MW_TEST_WIDGET.getTheme()}));
  assert(options.enabled.includes('support_multicharts'));assert(!options.disabled.includes('header_settings'));assert.equal(options.theme.toLowerCase(),'light');
  assert.equal(await desktopNative.locator('.mw-mobile-crosshair-entry').count(),0);
  await desktopNative.getByRole('button',{name:'指标',exact:true}).click();
  await expect(desktopNative.locator('.mw-native-indicator-content')).toBeVisible();
  await desktopNative.getByRole('button',{name:'关闭指标窗口',exact:true}).click();
  const study=await desktop.evaluate(()=>window.MW_TEST_WIDGET.activeChart().createStudy('Relative Strength Index',false,false,{length:17}));
  await desktop.evaluate(()=>window.MW_TEST_WIDGET.activeChart().setResolution('5'));
  await desktop.waitForFunction(()=>MW_TEST_WIDGET.activeChart().resolution()==='5' && MW_TEST_WIDGET.activeChart().dataReady());
  await expect.poll(()=>desktop.evaluate(()=>new Promise(resolve=>MW_TEST_WIDGET.save(resolve)).then(s=>s.charts[0].panes.flatMap(p=>p.sources).some(p=>/Study/.test(p.type))))).toBe(true);
  // Save through the real vendor adapter; fixture storage cannot touch user workspaces.
  await expect.poll(()=>desktop.evaluate(()=>new Promise(resolve=>MW_TEST_WIDGET.saveChartToServer(()=>resolve('ok'),error=>resolve(String(error))))),{timeout:20000,intervals:[300]}).toBe('ok');
  await desktop.waitForTimeout(500);
  const before=await desktop.evaluate(()=>JSON.stringify({settings:desktopSettings,workspace:desktopWorkspace}));
  const desktopWidget=await desktop.evaluateHandle(()=>MW_TEST_WIDGET);
  await page.evaluate(()=>window.MW_TEST_WIDGET.activeChart().setResolution('1'));
  await theme('dark');await continuity();
  assert.equal(await desktop.evaluate(()=>JSON.stringify({settings:desktopSettings,workspace:desktopWorkspace})),before,'mobile changes do not change desktop preferences/layout');
  assert(await desktop.evaluate(w=>w===MW_TEST_WIDGET,desktopWidget));await desktopWidget.dispose();
  assert.equal(await desktop.evaluate(()=>MW_TEST_WIDGET.activeChart().resolution()),'5');
  assert.equal(await desktop.evaluate(id=>MW_TEST_WIDGET.activeChart().getStudyById(id).getInputValues().find(row=>row.id==='length').value,study),17);
  await desktop.screenshot({path:path.join(out,'desktop-isolation.png')});
  await desktop.evaluate(()=>({errors:desktopErrors})).then(value=>assert.deepEqual(value.errors,[]));
  await desktopContext.close();assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'proof.json'),JSON.stringify({checks:['real desktop native adapter keeps multicharts, enhanced indicators, native save','mobile changes preserve desktop widget, H1/M5 settings and RSI 17'],options,errors},null,2));
  console.log('PASS desktop/mobile isolation: real licensed widgets, enhanced desktop picker, native save; mobile operations preserve desktop settings/layout and widget');
 };
 const benchmark=async()=>{
  const rows=[];
  const painted=()=>page.waitForFunction(()=>{const all=window.MWMobileChartDiagnostics?.();return all?.at(-1)?.outcome==='ready' && !document.querySelector('.chart-preview');},null,{timeout:30000});
  // Measure only immediate fixture responses. Held-network/error tests are separate.
  for(let i=0;i<5;i++) {
   await page.reload();await widgetReady();await painted();
   const startup=await page.evaluate(()=>window.MWMobileChartDiagnostics()[0]);
   rows.push({kind:'reload',...startup});
   const instance=await page.evaluateHandle(()=>window.MW_TEST_WIDGET);
   await page.getByRole('link',{name:'更多',exact:true}).click();
   const before=Date.now();await page.getByRole('link',{name:'图表',exact:true}).click();
   assert(await page.evaluate(w=>w===window.MW_TEST_WIDGET,instance));await instance.dispose();
   assert.equal(await page.locator('.chart-loading:visible').count(),0);
   rows.push({kind:'navigation',elapsedMs:Date.now()-before});
   for(const resolution of ['60','5']) {
    const before=Date.now();await page.evaluate(r=>window.MW_TEST_WIDGET.activeChart().setResolution(r),resolution);await widgetReady();await painted();
    rows.push({kind:'period',resolution,elapsedMs:Date.now()-before,trace:await page.evaluate(()=>window.MWMobileChartDiagnostics().at(-1))});
   }
  }
  fs.writeFileSync(path.join(out,'timings.json'),JSON.stringify({environment:'local HTTP fixture + real licensed widget; no live upstream latency claim',rows},null,2));
  console.log('PASS repeat-five loading/navigation/period observations');
 };
 const polish=async()=>{
  const captures=[];
  for(const mode of ['dark','light']) {
   await theme(mode);
   for(const width of [375,412])for(const font of [14,21]) {
    await page.setViewportSize({width,height:width===375?812:915});
    await page.evaluate(v=>document.documentElement.style.fontSize=v+'px',font);
    await shot(`polish-${mode}-${width}-${font}`);
    const geometry=await native().locator('.mw-mobile-crosshair-entry:visible').evaluate(el=>{
     const box=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
     return {button:box(el),ancestors:[el.parentElement,el.parentElement.parentElement,el.closest('.mw-mobile-header-row'),el.ownerDocument.querySelector('[data-name="header-toolbar"]')].filter(Boolean).map(box)};
    });
    assert(geometry.button.width>=44 && geometry.button.height>=38 && geometry.button.y>=0,'native-height crosshair touch target is fully inside the toolbar');
    captures.push({mode,width,font,...geometry});
   }
  }
  fs.writeFileSync(path.join(out,'geometry.json'),JSON.stringify(captures,null,2));
  await page.setViewportSize({width:412,height:915});await page.evaluate(()=>document.documentElement.style.fontSize='14px');await theme('dark');
  const instance=await page.evaluateHandle(()=>window.MW_TEST_WIDGET);
  await page.getByRole('link',{name:'更多',exact:true}).click();await page.getByRole('link',{name:'图表',exact:true}).click();
  assert(await page.evaluate(w=>w===window.MW_TEST_WIDGET,instance),'navigation keeps the same native widget');await instance.dispose();
  await continuity();await failedHistoryStartup();await silentLocalSave();
  const diagnostics=await page.evaluate(()=>window.MWMobileChartDiagnostics?.());
  assert(diagnostics?.some(row=>row.outcome==='ready' && row.steps['画面可用']>=0),'native first painted frame has bounded support timing');
  const forbidden=requests.filter(r=>r.method==='POST'&&/advanced-charts\/(preferences|workspaces|native-charts)|\/alerts|\/tasks/.test(r.path));
  assert.deepEqual(forbidden,[]);assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'proof.json'),JSON.stringify({checks,captures,diagnostics,forbidden,errors},null,2));
  console.log('PASS mobile chart polish: real widget, local saves, error recovery, continuity, layouts and settings isolation');
 };
 try{
  await page.goto(base+'/m/');await page.getByLabel('密码',{exact:true}).fill('fixture-only');await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('navigation',{name:'主导航'})).toBeVisible();
  await page.getByRole('link',{name:'图表',exact:true}).click();await expect(page.getByText('选择要查看的品种',{exact:true})).toBeVisible();await shot('empty-dark-412');
  // Seed only the saved choice: chart regression does not depend on DataPage layout.
  await page.evaluate(ticker=>new Promise((resolve,reject)=>{const r=indexedDB.open('mw-mobile',2);r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction('records','readwrite');tx.objectStore('records').put({value:ticker,readAt:Date.now()},[location.origin,'admin',1,'chart-selection']);tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};}),ticker);await page.reload();
  await expect(page.getByRole('status',{name:'准备图表'})).toBeVisible();await shot('loading-dark-412');
  catalogMode='ok';releaseCatalog();await widgetReady();await expect(page.locator('.mobile-chart-canvas iframe')).toHaveAttribute('src',/\/charting_library_[a-f0-9]+\/sameorigin\.html$/);await shot('chart-dark-412');
  const nativeTouch=await page.locator('.mobile-chart-canvas iframe').evaluate(async node=>{
    const win=node.contentWindow;let load;
    win.webpackChunktradingview.push([[Date.now()],{},require=>{load=require;}]);
    await Promise.all([load.e(72141),load.e(85652)]);
    const Hammer=load(682937).HammerJS,manager=new Hammer.Manager(win.document.body);
    manager.destroy();return {version:Hammer.VERSION};
  });assert.match(nativeTouch.version,/^2\./);checks.push('native floating-toolbar touch chunks load over HTTP; real Hammer Manager starts and destroys');
  assert.equal(await page.locator('.mobile-chart-tools,.chart-symbol-trigger').count(),0,'entire outer toolbar removed');
  assert.equal(await native().locator('#header-toolbar-symbol-search').count(),0,'header reserves space for periods, no duplicate symbol title');
  await native().getByRole('button',{name:'图表周期',exact:true}).click();
  const rows=native().locator('[data-role="menuitem"][data-value]');await expect(rows).toHaveCount(4);await shot('period-favorites-dark-412');
  await rows.filter({hasText:'1 分钟'}).getByRole('button',{name:'添加到收藏',exact:true}).click();
  await expect(native().getByRole('radio',{name:'1 分钟',exact:true})).toBeVisible();
  await back();await expect(rows).toHaveCount(0);await expect(page).toHaveURL(/\/chart$/);
  await native().getByRole('radio',{name:'1 分钟',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.MW_TEST_WIDGET.activeChart().resolution())).toBe('1');
  await native().getByRole('radio',{name:'5 分钟',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.MW_TEST_WIDGET.activeChart().resolution())).toBe('5');await widgetReady();await shot('favorite-shortcuts-dark-412');
  checks.push('native header replaces outer toolbar; period menu only supported intervals; native star adds direct shortcut; Android back closes period popup; one-tap M1/M5');
  if(process.env.MOBILE_CHART_PREVIOUS_DAY_ONLY){
   await page.evaluate(()=>MW_TEST_WIDGET.activeChart().setResolution('60'));await widgetReady();
   const plus=async()=>{const b=await page.evaluate(()=>MW_TEST_WIDGET.activeChart()._chartWidget.paneWidgets().find(p=>p.containsMainSeries()).canvasElement().getBoundingClientRect().toJSON());await page.mouse.move(b.left+40,b.y+b.height*.46);await page.mouse.move(b.right-9,b.y+b.height*.46);await page.waitForTimeout(250);await page.mouse.click(b.right-9,b.y+b.height*.46);};
   await plus();await shot('previous-day-menu');
   await native().getByText('前日高低突破…',{exact:true}).click();
   await expect(page.getByRole('heading',{name:'设置告警',exact:true})).toBeVisible();
   await expect(page.locator('#alert-lower')).toHaveValue('98.50');
   await expect(page.locator('#alert-upper')).toHaveValue('103.25');
   await expect(page.getByText('最近 M5 收盘已在区间外，回到区间后再次离开才触发。',{exact:true})).toBeVisible();
   assert.equal(requests.filter(r=>r.method==='POST'&&r.path==='/api/chart-alerts').length,0);
   for(const mode of ['dark','light'])for(const width of [375,412])for(const font of [14,21]){
    await page.locator('.mobile-app').evaluate((el,mode)=>el.setAttribute('data-theme',mode),mode);await page.setViewportSize({width,height:width===375?812:915});await page.evaluate(font=>document.documentElement.style.fontSize=font+'px',font);
    await shot('previous-day-'+mode+'-'+width+'-font'+font);await expect(page.getByRole('button',{name:'创建告警',exact:true})).toBeInViewport();
    assert(await page.locator('.mobile-sheet-body, [data-mobile-overlay="true"]').evaluateAll(els=>els.every(el=>el.scrollWidth<=el.clientWidth+1)),'no horizontal overflow');
   }
   const priceRangeBefore=await page.evaluate(()=>MW_TEST_WIDGET.activeChart().getPanes()[0].getMainSourcePriceScale().getVisiblePriceRange());
   await page.getByRole('button',{name:'创建告警',exact:true}).click();
   await expect(page.getByRole('heading',{name:'设置告警',exact:true})).toHaveCount(0);
   const created=priceRules.at(-1).config;
   assert.equal(priceRules.length,2);assert.equal(created.condition.relation,'exit');assert.equal(created.condition.lower,'98.50');assert.equal(created.condition.upper,'103.25');
   assert.equal(created.timeframe,'M5');assert.equal(created.mode,'close');assert.equal(created.max_triggers,1);
   assert.equal(created.expires_at,Math.floor(now/86400000)*86400000+86400001);assert.equal(created.close_expiry_grace_ms,120000);
   assert.equal(created.notify_ntfy,true);assert.equal(created.association,null);
   assert.equal(await page.evaluate(()=>MW_TEST_WIDGET.activeChart().resolution()),'60','template does not switch the chart itself');
   assert.equal(requests.filter(r=>r.method==='POST'&&r.path==='/api/chart-alerts').length,1);
   const rangeLabel=native().locator('[data-name="mw-alert-range-label"]');
   await expect(rangeLabel).toHaveCount(1);
   assert.deepEqual(await page.evaluate(()=>MW_TEST_WIDGET.activeChart().getPanes()[0].getMainSourcePriceScale().getVisiblePriceRange()),priceRangeBefore,'range lines do not expand the visible price range');
   await page.evaluate(()=>{const scale=MW_TEST_WIDGET.activeChart().getPanes()[0].getMainSourcePriceScale();scale.setAutoScale(false);scale.setVisiblePriceRange({from:97,to:104});});
   await expect(rangeLabel).toBeVisible();await expect(rangeLabel).toContainText('前日高低 · M5');
   for(const mode of ['dark','light'])for(const width of [375,412]){
    await page.locator('.mobile-app').evaluate((el,mode)=>el.setAttribute('data-theme',mode),mode);
    await page.evaluate(mode=>MW_TEST_WIDGET.changeTheme(mode==='dark'?'Dark':'Light'),mode);
    await page.setViewportSize({width,height:width===375?812:915});await shot('range-'+mode+'-'+width);
   }
   await rangeLabel.click();await native().locator('[data-name="mw-alert-range-actions"]').getByRole('button',{name:'编辑',exact:true}).click();await expect(page.getByRole('heading',{name:'编辑告警',exact:true})).toBeVisible();
   await expect(page.locator('#alert-lower')).toHaveValue('98.50');await expect(page.locator('#alert-upper')).toHaveValue('103.25');
   await page.getByRole('button',{name:'关闭',exact:true}).click();
   await expect(page.getByRole('heading',{name:'编辑告警',exact:true})).toHaveCount(0);
   assert.equal(await page.evaluate(()=>MW_TEST_WIDGET.activeChart().resolution()),'60','range display and editing leave the chart interval unchanged');
   const forbidden=requests.filter(r=>r.method==='POST'&&/advanced-charts\/(preferences|workspaces|native-charts)|\/tasks/.test(r.path));assert.deepEqual(forbidden,[]);assert.deepEqual(errors,[]);
   checks.push('native plus opens shared mobile form; one exit/M5/close/once rule; paired range lines reopen that rule; exact expiry survives form; outside warning; 375/412 dark/light 100/150%; no chart/layout writes');
   fs.writeFileSync(path.join(out,'proof.json'),JSON.stringify({checks,errors,created,forbidden},null,2));console.log(JSON.stringify({checks,errors}));return;
  }
  if(process.env.MOBILE_CHART_PRICE_ALERT_ONLY){
   await page.evaluate(()=>MW_TEST_WIDGET.activeChart().setResolution('60'));await widgetReady();
   const labels=native().locator('[data-name="mw-alert-price-label"]');await expect(labels).toHaveCount(1);
   const plus=async()=>{const b=await page.evaluate(()=>MW_TEST_WIDGET.activeChart()._chartWidget.paneWidgets().find(p=>p.containsMainSeries()).canvasElement().getBoundingClientRect().toJSON());await page.mouse.move(b.left+40,b.y+b.height*.46);await page.mouse.move(b.right-9,b.y+b.height*.46);await page.waitForTimeout(250);await page.mouse.click(b.right-9,b.y+b.height*.46);};
   await plus();await native().getByText(/^价格穿越 .* 时提醒$/,{exact:true}).click();await expect(labels).toHaveCount(2);await shot('price-created-412-dark');
   assert.equal(priceRules.length,2);assert.equal(priceRules[1].config.mode,'intrabar');assert.equal(priceRules[1].config.association,null);assert.equal(priceRules[1].config.notify_ntfy,true);
   const active=native().locator('[data-name="mw-alert-price-label"][data-alert-id="'+priceRules[1].id+'"]');
   const cdp=await context.newCDPSession(page),touch=async(type,x,y)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y}]});
   let b=await active.boundingBox(),x=b.x+20,y=b.y+b.height/2;
   await touch('touchStart',x,y);for(let i=1;i<=8;i++)await touch('touchMove',x,y+24*i/8);await touch('touchEnd',x,y+24);
   await expect.poll(()=>priceRules[1].version).toBe(2);assert.equal(requests.filter(r=>r.path.endsWith('/edit')).length,1);
   b=await active.boundingBox();await touch('touchStart',b.x+20,b.y+b.height/2);await touch('touchEnd',b.x+20,b.y+b.height/2);
   await native().getByRole('button',{name:'编辑',exact:true}).click();await expect(page.getByRole('heading',{name:'编辑告警',exact:true})).toBeVisible();
   for(const mode of ['dark','light'])for(const width of [375,412])for(const font of [14,21]){
    await page.locator('.mobile-app').evaluate((el,mode)=>el.setAttribute('data-theme',mode),mode);await page.setViewportSize({width,height:width===375?812:915});await page.evaluate(font=>document.documentElement.style.fontSize=font+'px',font);
    await shot('price-editor-'+mode+'-'+width+'-font'+font);await expect(page.getByRole('button',{name:'保存告警',exact:true})).toBeInViewport();const saveBox=await page.getByRole('button',{name:'保存告警',exact:true}).boundingBox();assert(saveBox.y>=0 && saveBox.y+saveBox.height<=page.viewportSize().height,'complete save target remains visible at large text sizes');
   }
   await page.getByRole('button',{name:'保存告警',exact:true}).click();await expect(page.getByRole('heading',{name:'编辑告警',exact:true})).toHaveCount(0);assert.equal(priceRules[1].version,3);
   const forbidden=requests.filter(r=>r.method==='POST'&&/advanced-charts\/(preferences|workspaces|native-charts)|\/tasks/.test(r.path));assert.deepEqual(forbidden,[]);assert.deepEqual(errors,[]);
   checks.push('actual built MobileApp + licensed chart: native plus quick creates; CDP touch drag writes once; tap opens editor; shared mobile sheet saves same rule; 375/412 light/dark 100/150% screenshots; no desktop layout/preference writes');
   fs.writeFileSync(path.join(out,'proof.json'),JSON.stringify({checks,errors,forbidden},null,2));console.log(JSON.stringify({checks,errors}));return;
  }
  if(process.env.MOBILE_CHART_ALERT_ONLY){
   await page.getByRole('link',{name:'告警',exact:true}).click();
   await page.locator('.alert-rule-open').first().click();
   await page.getByRole('button',{name:'查看品种图表',exact:true}).click();
   await expect(page).toHaveURL(/\/chart$/);await widgetReady();await symbolIs(ticker.toUpperCase());
   await expect.poll(()=>page.evaluate(()=>window.MW_TEST_WIDGET.activeChart().resolution())).toBe('60');
   await shot('alert-opens-native-h1');
   checks.push('alert detail opens actual native widget at rule symbol and H1, replacing existing M5');
   await continuity();await failedHistoryStartup();
   const forbidden=requests.filter(r=>r.method==='POST'&&/advanced-charts\/(preferences|workspaces|native-charts)|\/alerts|\/tasks/.test(r.path));
   assert.deepEqual(forbidden,[]);assert.deepEqual(errors,[]);
   fs.writeFileSync(path.join(out,'proof.json'),JSON.stringify({evidence:'HTTP fixtures + actual licensed native widget; browser only',checks,errors,forbidden},null,2));console.log(JSON.stringify({checks,errors}));return;
  }
  if(process.env.MOBILE_CHART_ISOLATION_ONLY){await desktopIsolation();return;}
  if(process.env.MOBILE_CHART_BENCHMARK_ONLY){await benchmark();return;}
  if(process.env.MOBILE_CHART_POLISH_ONLY){await polish();return;}
  if(process.env.MOBILE_CHART_STARTUP_ONLY){await failedHistoryStartup();return;}
  if(process.env.MOBILE_CHART_ERROR_ONLY){
   await failedHistoryStartup();
   failHistory=true;await page.reload();
   await expect(page.getByRole('button',{name:'重试行情',exact:true})).toBeVisible();
   await expect(page.getByRole('button',{name:'关闭行情提示',exact:true})).toBeVisible({timeout:1500});
   for(const mode of ['dark','light']){
    await theme(mode);
    for(const width of [375,412])for(const font of [14,21]){
     await page.setViewportSize({width,height:width===375?812:915});await page.evaluate(v=>document.documentElement.style.fontSize=v+'px',font);
     await expect(page.getByRole('button',{name:'关闭行情提示',exact:true})).toBeInViewport();
     await expect(page.getByRole('button',{name:'重试行情',exact:true})).toBeInViewport();
     await shot(`error-${mode}-${width}-${font}`);
    }
   }
   await page.getByRole('button',{name:'关闭行情提示',exact:true}).click();
   await expect(page.locator('.chart-history-failure')).toHaveCount(0);
   await page.waitForTimeout(500);await expect(page.locator('.chart-history-failure')).toHaveCount(0);
   console.log('PASS actionable chart history failures can be dismissed without blocking chart');return;
  }
  if(process.env.MOBILE_CHART_SAVE_ONLY){await silentLocalSave();return;}
  if(process.env.MOBILE_CHART_CONTINUITY_ONLY){await continuity();assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'proof.json'),JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({checks,errors}));return;}
  await expect(native().getByRole('button',{name:'设置',exact:true})).toHaveCount(0);
  const crosshairEntry=native().locator('.mw-mobile-crosshair-entry:visible');
  await expect(native().getByRole('button',{name:'绘图与十字线',exact:true})).toHaveCount(0);
  await expect(crosshairEntry).toHaveAttribute('aria-pressed','false');
  const tracking=()=>page.evaluate(()=>window.MW_TEST_WIDGET.activeChart()._chartWidget.paneWidgets().some(p=>p.trackingModeEnabled()));
  await crosshairEntry.click();await expect(crosshairEntry).toHaveAttribute('aria-pressed','true');assert.equal(await tracking(),true);await shot('crosshair-active-dark-412');
  const plotBox=await native().locator('[data-name="pane-canvas"]').first().boundingBox();
  const cdp=await context.newCDPSession(page),touch=async(type,x,y)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y}]});
  const beforeCrosshair=await page.evaluate(()=>{const p=window.MW_TEST_WIDGET.activeChart()._chartWidget.model().model().crosshairSource().currentPoint();return {x:p.x,y:p.y}});
  await touch('touchStart',plotBox.x+plotBox.width*.5,plotBox.y+plotBox.height*.5);await touch('touchMove',plotBox.x+plotBox.width*.7,plotBox.y+plotBox.height*.4);await touch('touchEnd');
  const afterCrosshair=await page.evaluate(()=>{const p=window.MW_TEST_WIDGET.activeChart()._chartWidget.model().model().crosshairSource().currentPoint();return {x:p.x,y:p.y}});assert.notDeepEqual(afterCrosshair,beforeCrosshair);await expect(crosshairEntry).toHaveAttribute('aria-pressed','true');await shot('crosshair-dragged-dark-412');
  await crosshairEntry.click();await expect(crosshairEntry).toHaveAttribute('aria-pressed','false');assert.equal(await tracking(),false);
  await touch('touchStart',plotBox.x+plotBox.width*.6,plotBox.y+plotBox.height*.55);await page.waitForTimeout(850);await touch('touchEnd');
  await expect.poll(tracking).toBe(true);await expect(crosshairEntry).toHaveAttribute('aria-pressed','true');
  await page.touchscreen.tap(plotBox.x+plotBox.width*.7,plotBox.y+plotBox.height*.6);await expect.poll(tracking).toBe(false);await expect(crosshairEntry).toHaveAttribute('aria-pressed','false');
  // Original native edge remains the entry to drawing tools.
  const drawingEntry=native().locator('[data-name="toolbar-drawing-toggle-button"]');
  await drawingEntry.click();await expect(native().getByRole('button',{name:'十字线',exact:true}).first()).toBeVisible();await native().getByRole('button',{name:'趋势线',exact:true}).click();
  const horizontalRow=native().locator('[data-role="menuitem"][data-name="LineToolHorzLine"]');
  await horizontalRow.getByRole('button',{name:'添加到收藏',exact:true}).click();await back();
  // Closing through the original native edge also updates the Header button.
  await native().getByRole('button',{name:'隐藏绘图工具栏',exact:true}).click();await expect(crosshairEntry).toHaveAttribute('aria-pressed','false');
  const favoriteLine=native().locator('[data-name="FavoriteToolbarLineToolHorzLine"]');await expect(favoriteLine).toBeVisible();await favoriteLine.click();
  const plot=await native().locator('[data-name="pane-canvas"]').first().boundingBox();await page.touchscreen.tap(plot.x+plot.width*.55,plot.y+plot.height*.4);
  await expect.poll(()=>page.evaluate(()=>window.MW_TEST_WIDGET.activeChart().getAllShapes().length)).toBe(1);
  const savedLine=await page.evaluate(()=>{const chart=window.MW_TEST_WIDGET.activeChart(),id=chart.getAllShapes()[0].id,shape=chart.getShapeById(id),points=shape.getPoints();shape.setPoints(points.map(p=>({...p,price:p.price+.2})));return {id,points:shape.getPoints()};});
  await page.evaluate(id=>window.MW_TEST_WIDGET.activeChart().selection().add(id),savedLine.id);await shot('drawing-selected-dark-412');
  await page.evaluate(id=>window.MW_TEST_WIDGET.activeChart().showPropertiesDialog(id),savedLine.id);await expect(native().getByRole('dialog')).toBeVisible();await shot('drawing-properties-dark-412');await native().getByRole('button',{name:'取消',exact:true}).click();
  await page.getByRole('link',{name:'更多',exact:true}).click();await page.getByRole('link',{name:'图表',exact:true}).click();await page.reload();await widgetReady();
  await expect(crosshairEntry).toHaveAttribute('aria-pressed','false');await expect(favoriteLine).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>window.MW_TEST_WIDGET.activeChart().getAllShapes().length)).toBe(1);
  const restoredPoints=await page.evaluate(id=>window.MW_TEST_WIDGET.activeChart().getShapeById(id).getPoints(),savedLine.id);assert.deepEqual(restoredPoints.map(p=>p.price),savedLine.points.map(p=>p.price)); // Native horizontal lines have no meaningful time anchor.
  await page.evaluate(id=>window.MW_TEST_WIDGET.activeChart().selection().add(id),savedLine.id);await native().locator('[data-name="drawing-toolbar"] [data-name="remove"]').click();
  await expect.poll(()=>page.evaluate(()=>window.MW_TEST_WIDGET.activeChart().getAllShapes().length)).toBe(0);
  await page.evaluate(()=>window.MW_TEST_WIDGET.selectLineTool('trend_line'));await crosshairEntry.click();await expect.poll(()=>page.evaluate(()=>window.MW_TEST_WIDGET.selectedLineTool())).toBe('cursor');await crosshairEntry.click();
  await shot('drawing-favorites-dark-412');
  checks.push('native touch creates horizontal line from starred floating shortcut; geometry edits + drawing properties; local reload retains geometry and favorite; native toolbar deletes; original native edge retains drawings; reload starts with crosshair off');
  await native().getByRole('button',{name:'指标 & 策略',exact:true}).click();await expect(native().getByRole('dialog').first()).toBeVisible();await shot('indicators-dark-412');const indicatorsDialog=native().locator('[data-name="indicators-dialog"]');assert.equal(await indicatorsDialog.locator('.mw-native-indicator-content,.mw-native-study-details').count(),0);await indicatorsDialog.locator('input').first().fill('Python SMA');await expect(indicatorsDialog.getByText('守望 Python SMA',{exact:true})).toBeVisible();await shot('python-indicators-dark-412');await back();await expect(native().getByRole('dialog')).toHaveCount(0);
  const frameBox=await page.locator('.mobile-chart-canvas iframe').boundingBox();await page.mouse.click(frameBox.x+frameBox.width-30,frameBox.y+frameBox.height-14);await expect(native().getByText(/创建.*告警/)).toHaveCount(0);await shot('scale-menu-dark-412');await native().getByText('更多设置…',{exact:true}).click();await expect(native().getByRole('dialog')).toBeVisible();await shot('settings-dark-412');await page.getByRole('link',{name:'更多',exact:true}).click();await expect(page.getByRole('alertdialog',{name:'放弃未应用的参数？'})).toBeVisible();await page.getByRole('button',{name:'继续编辑',exact:true}).click();await native().getByRole('button',{name:'取消',exact:true}).click();
  checks.push('crosshair Header toggles actual native tracking and active highlight; touch drag moves crosshair; no top gear; native scale menu has no unsupported alert and opens full settings; indicators and parameter discard preserved');
  const study=await page.evaluate(()=>window.MW_TEST_WIDGET.activeChart().createStudy('Relative Strength Index',false,false,{length:9}));await expect.poll(()=>page.evaluate(()=>window.MW_TEST_WIDGET.activeChart().getPanes().length)).toBe(2);
  await page.evaluate(id=>window.MW_TEST_WIDGET.activeChart().showPropertiesDialog(id),study);const parameters=native().locator('[data-name="indicator-properties-dialog"]'),input=parameters.locator('input').first();await expect(parameters).toBeVisible();await input.fill('14');
  await page.getByRole('link',{name:'更多',exact:true}).click();await expect(page.getByRole('alertdialog',{name:'放弃未应用的参数？'})).toBeVisible();await shot('discard-dark-412');await page.waitForTimeout(5400);await page.getByRole('button',{name:'继续编辑',exact:true}).click();await expect(input).toHaveValue('14');assert.equal(await page.locator('.mobile-toast').count(),0,'human decision cannot time out');
  await page.getByRole('link',{name:'更多',exact:true}).click();await expect(page.getByRole('alertdialog')).toBeVisible();await back();await expect(page.getByRole('alertdialog')).toHaveCount(0);await expect(input).toHaveValue('14');
  await page.getByRole('link',{name:'更多',exact:true}).click();await page.getByRole('button',{name:'放弃修改',exact:true}).click();await expect(page).toHaveURL(/\/more$/);await page.getByRole('link',{name:'图表',exact:true}).click();await expect.poll(()=>page.evaluate(id=>window.MW_TEST_WIDGET.activeChart().getStudyById(id).getInputValues().find(v=>v.id==='length').value,study)).toBe(9);
  checks.push('shared discard confirmation; >5 seconds user decision; continue/back preserves input; discard restores applied study');
  await native().getByRole('button',{name:'变更品种',exact:true}).click();await expect(native().getByRole('dialog')).toBeVisible();await native().getByRole('dialog').locator('input').first().fill('AAPL');await expect(native().getByRole('dialog').getByText('AAPL',{exact:true})).toBeVisible();await shot('native-symbol-search');await back();await expect(native().getByRole('dialog')).toHaveCount(0);
  holdHistory=true;await page.evaluate(t=>{void window.MW_TEST_WIDGET.activeChart().setSymbol(t)},provider);await symbolIs(provider);await expect(page.locator('.chart-history-progress')).toBeVisible();await shot('history-pending');holdHistory=false;heldHistory.splice(0).forEach(resolve=>resolve());await widgetReady();
  await page.getByRole('link',{name:'更多',exact:true}).click();await page.getByRole('link',{name:'图表',exact:true}).click();await page.reload();await widgetReady();await symbolIs(provider);await expect(native().getByRole('radio',{name:'1 分钟',exact:true})).toBeVisible();await shot('favorites-restored');
  // Native unfavorite removes just that shortcut; existing saved settings win over defaults.
  await native().getByRole('button',{name:'图表周期',exact:true}).click();await native().locator('[data-role="menuitem"][data-value="60"]').getByRole('button',{name:'从收藏中移除',exact:true}).click();await back();await expect(native().getByRole('radio',{name:'1 小时',exact:true})).toHaveCount(0);
  await page.getByRole('link',{name:'更多',exact:true}).click();await page.getByRole('link',{name:'图表',exact:true}).click();await page.reload();await widgetReady();await expect(native().getByRole('radio',{name:'1 小时',exact:true})).toHaveCount(0);
  checks.push('native symbol search accessible from chart legend; source changes retained by parent; real pending history indicator; favorites add/remove survive reload in mobile local IDB');
  for(const mode of ['dark','light']){
   await theme(mode);
   for(const width of [375,412])for(const font of [14,21]){
    await page.setViewportSize({width,height:width===375?812:915});await page.evaluate(v=>document.documentElement.style.fontSize=v+'px',font);await shot(`chart-${mode}-${width}-font${font}`);
    const box=await page.locator('.mobile-chart-canvas').boundingBox();assert.equal(Math.round(box.y),0,'native Header starts at top, no outer title');
    const headerOrder=await native().locator('.mw-mobile-crosshair-entry:visible').evaluate(el=>{const row=el.closest('.mw-mobile-header-row');return ['#header-toolbar-intervals','.mw-mobile-crosshair-entry','#header-toolbar-indicators','#header-toolbar-chart-styles'].map(selector=>row.querySelector(selector).getBoundingClientRect().x);});assert(headerOrder.every((x,i)=>i===0||x>headerOrder[i-1]),'period/crosshair/indicator/type visual order');
    await expect(native().getByRole('radio',{name:'5 分钟',exact:true})).toBeInViewport();await expect(native().getByRole('button',{name:'指标 & 策略',exact:true})).toBeInViewport();await expect(native().locator('.mw-mobile-crosshair-entry:visible')).toBeInViewport();layouts.push({mode,width,font,canvas:box});
   }
  }
  await page.setViewportSize({width:915,height:412});await shot('landscape-light-font21');
  await page.setViewportSize({width:412,height:915});await page.evaluate(()=>document.documentElement.style.fontSize='14px');
  await continuity();await failedHistoryStartup();await silentLocalSave();
  const failing=await browser.newContext({viewport:{width:375,height:812},isMobile:true,hasTouch:true,serviceWorkers:'block'}),p2=await failing.newPage();p2.on('pageerror',e=>errors.push(e.message));catalogMode='fail';await p2.goto(base+'/m/');await expect(p2.getByRole('navigation',{name:'主导航'})).toBeVisible();await p2.evaluate(ticker=>new Promise((resolve,reject)=>{const r=indexedDB.open('mw-mobile',2);r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction('records','readwrite');tx.objectStore('records').put({value:ticker,readAt:Date.now()},[location.origin,'admin',1,'chart-selection']);tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};}),ticker);await p2.goto(base+'/m/chart');await expect(p2.getByText('图表暂时无法加载',{exact:true})).toBeVisible();await p2.screenshot({path:path.join(out,'failure-dark-375.png')});catalogMode='ok';await p2.getByRole('button',{name:'重新加载图表',exact:true}).click();await expect(p2.locator('.chart-workspace')).toHaveAttribute('aria-busy','false',{timeout:30000});await failing.close();
  const forbidden=requests.filter(r=>r.method==='POST'&&/advanced-charts\/(preferences|workspaces|native-charts)|\/alerts|\/tasks/.test(r.path));assert.deepEqual(forbidden,[]);assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'proof.json'),JSON.stringify({evidence:'API fixture with actual licensed widget; browser only',checks,layouts,errors,forbidden},null,2));console.log(JSON.stringify({out,checks,errors,layouts},null,2));
 }catch(e){await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});console.error('STATE',await page.locator('body').innerText(),consoleErrors);console.error('NATIVE DIALOGS',await Promise.all(page.frames().map(f=>f.locator('[role=dialog]').evaluateAll(els=>els.map(el=>({name:el.dataset.name,html:el.outerHTML.slice(0,350)}))).catch(()=>[]))));throw e;}finally{await context.close();await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1});
