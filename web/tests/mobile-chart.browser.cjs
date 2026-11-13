// Built mobile entry and actual licensed widget, with explicit API test doubles.
// This is browser evidence, never backend/Find X8/ntfy acceptance.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium,expect}=require('@playwright/test');
const dist=path.resolve('dist'),id='a'.repeat(64),ticker='MWC:'+id;
const out=process.env.MOBILE_CHART_OUTPUT || '/tmp/mw-chart-round1';fs.mkdirSync(out,{recursive:true});
const requests=[],errors=[],checks=[],consoleErrors=[],layouts=[];let catalogMode='hold',releaseCatalog,holdHistory=false,failHistory=false;const heldHistory=[];
const provider=process.env.MOBILE_CHART_IDENTITY_ONLY ? 'MWP:DUKA:'+'A1'.repeat(16) : 'MWP:YAHOO:AAPL';
let logged=false,shellRevision=0,brokenInstall=false,delayLogin=false,pendingLogin;
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
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
   if(url.pathname==='/api/market-data/resolve')return json({symbol:query.series_kind==='provider'?'AAPL':'EURUSD · 日内观察组合',source:query.series_kind==='provider'?'yahoo':'composite',price_description:'收盘价',name:query.series_kind==='provider'?'苹果':'受控组合',precision:2,calendar:'utc0',asset_type:'CRYPTO',frames:['M1','M5','H1','D1'],created:true,stream:false});
   if(url.pathname==='/api/health')return json({version:'fixture'});
   if(url.pathname==='/api/notification-center/snapshot')return json({events:[],cursor:'test'});
   if(url.pathname==='/api/notification-center/events')return json({events:[],before:null});
   if(url.pathname==='/api/charts/history-loads/fixture-load/cancel')return json({ok:true});
   if(['/api/charts/data','/api/charts/history-loads','/api/charts/reserve'].includes(url.pathname)){
     const candleQuery=query.query || query;if(url.pathname==='/api/charts/history-loads'&&holdHistory)await new Promise(resolve=>heldHistory.push(resolve));
     if(failHistory && url.pathname==='/api/charts/history-loads')return json({load:{id:'fixture-load',state:'failed',error:{code:'HISTORY_UNAVAILABLE',message:'平台历史暂不可用，请重试',status:503}}});
     const step={M1:60000,M5:300000,H1:3600000,D1:86400000}[candleQuery.timeframe] || 3600000;
     const end=Math.floor(Math.min(candleQuery.before || Date.now(),Date.now())/step)*step;
     const bars=Array.from({length:Math.min(candleQuery.limit || 100,500)},(_,i)=>{
       const start=end-(Math.min(candleQuery.limit || 100,500)-i)*step;
       const close=100+Math.sin(i/13)*1.2+Math.sin(i/4)*.25+i*.006,open=close+Math.sin(i*2)*.15;return {start,end:start+step,open:open.toFixed(2),high:(Math.max(open,close)+.12).toFixed(2),low:(Math.min(open,close)-.12).toFixed(2),close:close.toFixed(2),complete:true,revision:1};
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
 if(/^chart\.[a-f0-9]+\.js$/.test(path.basename(file)))body=Buffer.from(`const Original=TradingView.widget;TradingView.widget=function(...args){const widget=new Original(...args);globalThis.MW_TEST_WIDGET=widget;return widget;};\n`+body);
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
  await expect(page.locator('.mobile-toast')).toContainText('本次图表设置未记住');await shot('autosave-real-write-failure');
  await page.evaluate(()=>IDBObjectStore.prototype.put=window.MW_TEST_STORAGE_PUT);
  await page.getByRole('button',{name:'关闭通知',exact:true}).click();await page.getByRole('link',{name:'更多',exact:true}).click();await page.getByRole('link',{name:'图表',exact:true}).click();await page.reload();await widgetReady();
  assert.equal(await page.evaluate(()=>window.MW_TEST_WIDGET.activeChart().getAllStudies().length),baseline,'retry flush persists latest settings after local storage recovers');await shot('autosave-reloaded');
  checks.push('normal pending autosave is silent; study settings restored on reload; actual local write failure is reported; flush retries and persists after storage recovery');
 };
 const failedHistoryStartup=async()=>{
  await page.evaluate(ticker=>window.MW_TEST_WIDGET.activeChart().setSymbol(ticker),provider);await widgetReady();await symbolIs(provider);
  await page.getByRole('link',{name:'更多',exact:true}).click();
  const saved=await page.evaluate(()=>new Promise((resolve,reject)=>{const req=indexedDB.open('mw-mobile',2);req.onerror=()=>reject(req.error);req.onsuccess=()=>{const db=req.result,read=db.transaction('records').objectStore('records').get([location.origin,'admin',1,'chart']);read.onsuccess=()=>{db.close();resolve(read.result?.value?.state?._mwViewports);};};}));
  assert(saved?.[0]?.symbol===provider && saved[0].range?.to>saved[0].range?.from,'saved provider viewport is required to reproduce startup history failure');
  failHistory=true;
  await page.getByRole('link',{name:'图表',exact:true}).click();await page.reload();
  await expect(page.locator('.chart-workspace')).toHaveAttribute('aria-busy','false',{timeout:8000});
  await expect(page.getByRole('status',{name:'准备图表'})).toHaveCount(0);
  await expect(page.getByText('行情暂时无法读取',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'重试行情',exact:true})).toBeEnabled();
  await shot('failed-history-startup');
  // A genuine pending read still reports progress; the retry resets only data,
  // preserving the same widget, saved studies and local document.
  const instance=await page.evaluateHandle(()=>window.MW_TEST_WIDGET);failHistory=false;holdHistory=true;
  await page.getByRole('button',{name:'重试行情',exact:true}).click();await expect(page.getByRole('button',{name:'正在重试…',exact:true})).toBeDisabled();
  holdHistory=false;heldHistory.splice(0).forEach(resolve=>resolve());await widgetReady();
  await expect(page.locator('.chart-history-failure')).toHaveCount(0);assert(await page.evaluate(w=>w===window.MW_TEST_WIDGET,instance));await instance.dispose();
  await symbolIs(provider);await shot('failed-history-recovered');
  await native().getByRole('radio',{name:'1 分钟',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.MW_TEST_WIDGET.activeChart().resolution())).toBe('1');await widgetReady();
  checks.push('saved provider viewport + failed first history: no infinite cover; readable failure; pending retry disabled; real data retry clears failure on same widget; period switch works');
  console.log('SAVED VIEWPORT + FAILED HISTORY: usable chart, explicit retry restores real bars');
 };
 const continuity=async()=>{
  await page.evaluate(t=>window.MW_TEST_WIDGET.activeChart().setSymbol(t),provider);await widgetReady();await symbolIs(provider);
  const readPreviews=()=>page.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('mw-mobile',2);r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,q=db.transaction('records').objectStore('records').get([location.origin,'admin',1,'chart-previews']);q.onsuccess=()=>{db.close();resolve((q.result?.value||[]).map(({image,...row})=>({...row,bytes:image.length})));};};}));
  const save=async()=>{await page.getByRole('link',{name:'更多',exact:true}).click();await page.getByRole('link',{name:'图表',exact:true}).click();};
  for(const resolution of ['60','5']){
   await page.evaluate(r=>window.MW_TEST_WIDGET.activeChart().setResolution(r),resolution);await widgetReady();await save();
   await expect.poll(async()=>(await readPreviews()).some(row=>row.symbol===provider&&row.resolution===resolution)).toBe(true);
  }
  holdHistory=true;await page.reload();
  await expect(page.locator('.chart-preview')).toBeVisible({timeout:10000});
  await expect(page.locator('.chart-preview')).toContainText('上次数据');
  assert.equal(await page.locator('.chart-loading [data-slot="spinner"]').count(),0);await shot('previous-view-reload');
  holdHistory=false;heldHistory.splice(0).forEach(resolve=>resolve());await widgetReady();await expect(page.locator('.chart-preview')).toHaveCount(0);
  holdHistory=true;await page.evaluate(()=>{void window.MW_TEST_WIDGET.activeChart().setResolution('60');});
  await expect(page.locator('.chart-preview')).toBeVisible();await shot('previous-period-pending');
  assert.equal(await native().locator('.mw-mobile-crosshair-entry:visible').innerText(),'','crosshair is icon-only');
  holdHistory=false;heldHistory.splice(0).forEach(resolve=>resolve());await widgetReady();await expect(page.locator('.chart-preview')).toHaveCount(0);
  checks.push('bounded actual native screenshots persist locally; matching saved view appears during delayed reload; matching H1 preview replaces M5 while H1 is delayed; live-ready removes preview; crosshair has accessible name with no visible text');
 };
 const identityPreview=async()=>{
  await page.evaluate(t=>window.MW_TEST_WIDGET.activeChart().setSymbol(t),provider);await widgetReady();
  await page.getByRole('link',{name:'更多',exact:true}).click();
  await page.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('mw-mobile',2);r.onerror=()=>reject(r.error);r.onsuccess=()=>{
   const db=r.result,tx=db.transaction('records','readwrite'),store=tx.objectStore('records'),key=[location.origin,'admin',1,'chart-previews'],q=store.get(key);
   q.onsuccess=()=>{const row=q.result;if(!row?.value?.length){tx.abort();return;}row.value=row.value.map(v=>({...v,symbol:v.symbol.replace(/[a-f0-9]{32}$/i,id=>id.toLowerCase())}));store.put(row,key);};
   tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>{db.close();reject(Error('expected saved native preview'));};
  };}));
  await page.getByRole('link',{name:'图表',exact:true}).click();holdHistory=true;await page.reload();
  await expect(page.locator('.chart-preview')).toBeVisible({timeout:10000});await shot('dataset-id-preview');
  holdHistory=false;heldHistory.splice(0).forEach(resolve=>resolve());await widgetReady();await expect(page.locator('.chart-preview')).toHaveCount(0);
  // A new target without an album entry still exposes the real native header
  // while history is pending, instead of covering it with preparation text.
  await page.getByRole('link',{name:'更多',exact:true}).click();
  await page.evaluate(()=>new Promise(resolve=>{const r=indexedDB.open('mw-mobile',2);r.onsuccess=()=>{const db=r.result,tx=db.transaction('records','readwrite');tx.objectStore('records').put({value:[],readAt:Date.now()},[location.origin,'admin',1,'chart-previews']);tx.oncomplete=()=>{db.close();resolve();};};}));
  await page.getByRole('link',{name:'图表',exact:true}).click();holdHistory=true;await page.reload();
  await expect(native().getByRole('button',{name:'图表周期',exact:true})).toBeVisible({timeout:10000});
  await expect(page.getByRole('status',{name:'准备图表'})).toHaveCount(0);await shot('cold-history-native-header');
  holdHistory=false;heldHistory.splice(0).forEach(resolve=>resolve());await widgetReady();
  checks.push('uppercase native dataset identity reuses lowercase stored preview; real header stays visible during cold pending history with no preview');
 };
 try{
  await page.goto(base+'/m/');await page.getByLabel('密码',{exact:true}).fill('fixture-only');await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('navigation',{name:'主导航'})).toBeVisible();
  await page.getByRole('link',{name:'图表',exact:true}).click();await expect(page.getByText('选择要查看的品种',{exact:true})).toBeVisible();await shot('empty-dark-412');
  await page.getByRole('button',{name:'选择品种',exact:true}).click();await page.getByRole('button',{name:/EURUSD · 日内观察组合/}).click();await page.getByRole('button',{name:'打开图表',exact:true}).click();
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
  if(process.env.MOBILE_CHART_STARTUP_ONLY){await failedHistoryStartup();return;}
  if(process.env.MOBILE_CHART_SAVE_ONLY){await silentLocalSave();return;}
  if(process.env.MOBILE_CHART_CONTINUITY_ONLY){await continuity();assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'proof.json'),JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({checks,errors}));return;}
  if(process.env.MOBILE_CHART_IDENTITY_ONLY){await identityPreview();assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'proof.json'),JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({checks,errors}));return;}
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
  const failing=await browser.newContext({viewport:{width:375,height:812},isMobile:true,hasTouch:true,serviceWorkers:'block'}),p2=await failing.newPage();p2.on('pageerror',e=>errors.push(e.message));catalogMode='fail';await p2.goto(base+'/m/');await expect(p2.getByRole('navigation',{name:'主导航'})).toBeVisible();await p2.getByRole('link',{name:'数据',exact:true}).click();await p2.getByRole('button',{name:/EURUSD · 日内观察组合/}).click();await p2.getByRole('button',{name:'打开图表',exact:true}).click();await expect(p2.getByText('图表暂时无法加载',{exact:true})).toBeVisible();await p2.screenshot({path:path.join(out,'failure-dark-375.png')});catalogMode='ok';await p2.getByRole('button',{name:'重新加载图表',exact:true}).click();await expect(p2.locator('.chart-workspace')).toHaveAttribute('aria-busy','false',{timeout:30000});await failing.close();
  const forbidden=requests.filter(r=>r.method==='POST'&&/advanced-charts\/(preferences|workspaces|native-charts)|\/alerts|\/tasks/.test(r.path));assert.deepEqual(forbidden,[]);assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'proof.json'),JSON.stringify({evidence:'API fixture with actual licensed widget; browser only',checks,layouts,errors,forbidden},null,2));console.log(JSON.stringify({out,checks,errors,layouts},null,2));
 }catch(e){await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});console.error('STATE',await page.locator('body').innerText(),consoleErrors);console.error('NATIVE DIALOGS',await Promise.all(page.frames().map(f=>f.locator('[role=dialog]').evaluateAll(els=>els.map(el=>({name:el.dataset.name,html:el.outerHTML.slice(0,350)}))).catch(()=>[]))));throw e;}finally{await context.close();await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1});
