// Built mobile entry and actual licensed widget, with explicit API test doubles.
// This is browser evidence, never backend/Find X8/ntfy acceptance.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium,expect}=require('@playwright/test');
const dist=path.resolve('dist'),id='a'.repeat(64),ticker='MWC:'+id;
const out=process.env.MOBILE_CHART_OUTPUT || '/tmp/mw-event-chart-browser';fs.mkdirSync(out,{recursive:true});
const requests=[],errors=[],checks=[],consoleErrors=[],layouts=[];let catalogMode='ready',releaseCatalog,holdHistory=false,failHistory=false,priceOffset=0;const heldHistory=[];
const provider='MWP:YAHOO:AAPL';
const alertRule={id:'fixture-rule',name:'EURUSD H1',status:'paused',health:'ready',version:1,control_revision:1,run:1,count:0,max_triggers:1,created_at:Date.now(),updated_at:Date.now(),display_identity:{code:'EURUSD',source:'composite'},condition_summary:'价格 上穿 101',runtime:{},config:{name:'EURUSD H1',instrument:id,series_kind:'composite',source:'composite',timeframe:'H1',mode:'close',condition:{relation:'cross_up',left:{kind:'price'},right:{kind:'constant',value:'101'}},max_triggers:1,expires_at:null,message:'',notify_web:true,notify_ntfy:false,late_delivery:'log_only',association:null,calculation_version:'chart-python-v1'}};
const anchor=Math.floor(Date.now()/3600000)*3600000-5*3600000;
const event={id:'fixture-event',alert_id:alertRule.id,occurred_at:anchor+3600000,detected_at:anchor+3600000,direction:'up',price:'101',threshold:'101',evidence:{config:alertRule.config,rule_version:1,ordinal:1,left:'101',observation:{bar:{start:anchor,end:anchor+3600000}}},message:'fixture',notification_id:'fixture-notice',notification_status:'server_accepted',delivery_status:'accepted',ack_at:null,display_label:'EURUSD · 测试组合'};
const reportId='6c276e57-6191-42cf-8c2f-79e3b29f439a';
const briefing={id:reportId,mode:'scheduled',status:'ready',created_at:Date.now(),cutoff_at:Date.now(),finished_at:Date.now(),snapshot:{groups:[{id:'fx',title:'外汇'}]},body:{coverage:{ok:1,total:1},sections:[{id:'daily_change',kind:'daily_change',title:'最近交易日涨跌',items:[{ticker,symbol:'EURUSD',source:'同源测试',category:'外汇',basis:'bid',status:'ok',change_pct:'0.2',close:'101',trading_date:'2026-11-16',previous_trading_date:'2026-11-13'}]}]}};
const priceRules=[alertRule];
let logged=true,shellRevision=0,brokenInstall=false,delayLogin=false,pendingLogin;
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
   if(url.pathname==='/api/chart-alerts/events/page')return json({items:[event],next_cursor:null});
   if(url.pathname==='/api/chart-alerts/events/fixture-event')return json(event);
   if(url.pathname==='/api/briefings/plan')return json({enabled:false,group_ids:['fx'],revision:1,next_run_at:null,groups:[{id:'fx',title:'外汇'}],phone_available:false});
   if(url.pathname==='/api/briefings/reports')return json({items:[briefing],next_cursor:null});
   if(url.pathname==='/api/briefings/reports/'+reportId)return json(briefing);
   if(url.pathname==='/api/session')return logged?json({csrf:'test-csrf',subject:'admin'}):json({detail:'未登录'},401);
   if(url.pathname==='/api/login'){logged=true;if(delayLogin){pendingLogin=()=>json({csrf:'test-csrf',subject:'admin'});return;}return json({csrf:'test-csrf',subject:'admin'});}
   if(url.pathname==='/api/logout'){logged=false;return json({ok:true});}
   if(url.pathname==='/api/advanced-charts/preferences')return json([]);
   if(url.pathname==='/api/market-data/composites/'+id)return json({id,source:'composite',frames:['M1','M5','H1','D1'],status:'ready'});
   if(url.pathname==='/api/market-data/series/page')return json({items:[{ticker,symbol:'EURUSD · 日内观察组合',source:'composite',instrument_name:'受控组合',description:'受控浏览器测试组合',series_kind:'composite'},{ticker:provider,symbol:'AAPL',description:'苹果',instrument_name:'苹果',source:'yahoo',series_kind:'provider',frames:['M1','M5','H1','D1']}]});
   if(url.pathname==='/api/advanced-charts/catalog'){if(catalogMode==='hold')await new Promise(resolve=>releaseCatalog=resolve);if(catalogMode==='fail')return json({detail:'图表目录读取失败'},500);return json({SMA:{label:"SMA 简单均线",pane:"main",aliases:["SMA","均线"],params:{period:20},series:[{key:"value",type:"line"}]}});}
   if(url.pathname==='/api/charts/history-capabilities')return json({protocol:1,version:'test',mode:'continuous',max_bars:20000,workspace_bars:100000,default_bars:1000,task_seconds:30});
   if(url.pathname==='/api/market-data/resolve')return json({symbol:query.series_kind==='provider'?'AAPL':'EURUSD · 日内观察组合',source:query.series_kind==='provider'?'yahoo':'composite',price_description:'收盘价',source_display:'FXCM',historical_source:'fxcm',name:query.series_kind==='provider'?'苹果':'受控组合',precision:2,calendar:'utc0',asset_type:'CRYPTO',frames:['M1','M5','H1','D1'],created:true,stream:false});
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
   if(url.pathname==='/api/notification-center/changes')return json({events:[],cursor:'test'});
   if(url.pathname==='/api/charts/history-loads/fixture-load/cancel')return json({ok:true});
   if(['/api/charts/data','/api/charts/history-loads','/api/charts/reserve'].includes(url.pathname)){
     const candleQuery=query.query || query;if(process.env.MOBILE_CHART_DEBUG)console.log('HISTORY',url.pathname,JSON.stringify(candleQuery));if(holdHistory && (url.pathname==='/api/charts/history-loads' || process.env.MOBILE_CHART_CACHE_COMPOSITE && url.pathname==='/api/charts/data' && !candleQuery.indicators?.length))await new Promise(resolve=>heldHistory.push(resolve));
     if(failHistory && process.env.MOBILE_CHART_CACHE_COMPOSITE && url.pathname==='/api/charts/data' && !candleQuery.indicators?.length)return json({detail:'历史暂不可用，请重试'},503);
     if(failHistory && url.pathname==='/api/charts/history-loads')return json({load:{id:'fixture-load',state:'failed',error:{code:'HISTORY_UNAVAILABLE',message:'平台历史暂不可用，请重试',status:503}}});
     const step={M1:60000,M5:300000,H1:3600000,D1:86400000}[candleQuery.timeframe] || 3600000;
     const end=Math.floor(Math.min(candleQuery.before || Date.now(),Date.now())/step)*step;
     const bars=Array.from({length:Math.min(candleQuery.limit || 100,500)},(_,i)=>{
       const label=end-(Math.min(candleQuery.limit || 100,500)-i)*step;const start=label-(candleQuery.timeframe==='D1'?2*3600000:0);
       const close=100+priceOffset+Math.sin(i/13)*1.2+Math.sin(i/4)*.25+i*.006,open=close+Math.sin(i*2)*.15;return {start,end:start+step,...(candleQuery.timeframe==='D1'?{chart_time:label}:{}),open:open.toFixed(2),high:(Math.max(open,close)+.12).toFixed(2),low:(Math.min(open,close)-.12).toFixed(2),close:close.toFixed(2),complete:true,revision:1};
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
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch(),context=await browser.newContext({viewport:{width:375,height:812},isMobile:true,hasTouch:true,serviceWorkers:'block'}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')console.log('CONSOLE',m.text())});
 const base=`http://127.0.0.1:${server.address().port}`,dialog=()=>page.getByRole('dialog').last();
 const locate=async()=>{await page.getByRole('button',{name:'查看触发位置',exact:true}).click();await expect(page.getByRole('button',{name:'返回触发记录',exact:true})).toBeVisible();await expect.poll(()=>page.evaluate(()=>{try{return MW_TEST_WIDGET.activeChart().getAllShapes().length}catch{return 0}}),{timeout:30000}).toBe(2);};
 try{
 await page.goto(base+'/m/alerts?signal=fixture-event');await expect(dialog()).toHaveAccessibleName('触发详情');await locate();
 const actual=await page.evaluate(()=>({range:MW_TEST_WIDGET.activeChart().getVisibleRange(),symbol:MW_TEST_WIDGET.activeChart().symbolExt().ticker,resolution:MW_TEST_WIDGET.activeChart().resolution(),shapes:MW_TEST_WIDGET.activeChart().getAllShapes().map(x=>({name:x.name,points:MW_TEST_WIDGET.activeChart().getShapeById(x.id).getPoints()}))}));
 assert.equal(actual.symbol,ticker);assert.equal(actual.resolution,'60');assert(actual.range.from<=anchor/1000&&actual.range.to>=anchor/1000);assert(actual.shapes.some(x=>x.points[0].time===anchor/1000));
 const saved=await page.evaluate(()=>new Promise(r=>MW_TEST_WIDGET.save(r)));assert(!JSON.stringify(saved).includes('判定柱'),'event marker never persists');
 await page.screenshot({path:path.join(out,'event-located-375.png')});
 await page.getByRole('button',{name:'查看最新',exact:true}).click();await expect.poll(()=>page.evaluate(()=>MW_TEST_WIDGET.activeChart().getTimeScale().rightOffset())).toBe(5);await expect.poll(()=>page.evaluate(()=>MW_TEST_WIDGET.activeChart().getAllShapes().length)).toBe(0);
 await page.getByRole('button',{name:'返回触发记录',exact:true}).click();await expect(dialog()).toHaveAccessibleName('触发详情');await expect(page.getByRole('button',{name:'查看触发位置',exact:true})).toBeVisible();
 await locate();await page.getByRole('link',{name:'数据',exact:true}).click();await page.waitForTimeout(650);await expect(page.locator('[data-mobile-overlay="true"]')).toHaveCount(0);
 checks.push('actual licensed widget: event→exact identity/hour/actual bar, transient marker excluded from save, latest resets range, return detail, main-nav abandon');
 await page.goto(base+'/m/more');await page.getByRole('button',{name:/告警记录/}).click();await page.getByRole('tab',{name:'触发',exact:true}).click();await dialog().locator('.alert-event-row').first().click();await locate();await page.evaluate(()=>dispatchEvent(new Event('mw-mobile-back',{cancelable:true})));await expect(dialog()).toHaveAccessibleName('触发详情');
 await locate();await page.getByRole('link',{name:'数据',exact:true}).click();await page.waitForTimeout(650);await expect(page.locator('[data-mobile-overlay="true"]')).toHaveCount(0);
 checks.push('global records nested return retains detail; abandon never reopens hidden parent');
 await page.goto(base+'/m/alerts');await page.locator('.alert-rule-open').first().click();await page.getByRole('button',{name:'此规则触发记录',exact:true}).click();await dialog().locator('.alert-event-row').first().click();await locate();await page.getByRole('button',{name:'返回触发记录',exact:true}).click();await expect(dialog()).toHaveAccessibleName('触发详情');await dialog().getByRole('button',{name:'关闭',exact:true}).click();await expect(dialog()).toHaveAccessibleName('规则触发记录');
 checks.push('rule record return preserves the exact event and parent');
 await dialog().getByRole('button',{name:'关闭',exact:true}).click();await page.waitForTimeout(550);await page.goto(base+'/m/alerts?signal=fixture-event');await expect(dialog()).toHaveAccessibleName('触发详情');
 alertRule.config.timeframe='D1';event.evidence.observation.bar={start:Math.floor(Date.now()/86400000)*86400000-2*3600000-86400000,end:Math.floor(Date.now()/86400000)*86400000-2*3600000};
 await page.reload();await expect(dialog()).toHaveAccessibleName('触发详情');await locate();
 const daily=await page.evaluate(()=>({resolution:MW_TEST_WIDGET.activeChart().resolution(),points:MW_TEST_WIDGET.activeChart().getAllShapes().map(x=>MW_TEST_WIDGET.activeChart().getShapeById(x.id).getPoints())}));
 assert.equal(daily.resolution,'1D');assert(daily.points.some(points=>points[0].time===(event.evidence.observation.bar.start+2*3600000)/1000));
 for(const theme of ['light','dark'])for(const width of [375,412])for(const font of [14,21]){await page.evaluate(({theme,font})=>{document.querySelector('.mobile-app').setAttribute('data-theme',theme);document.documentElement.style.fontSize=font+'px';},{theme,font});await page.setViewportSize({width,height:812});await page.waitForTimeout(400);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(out,`event-${theme}-${width}-${font}.png`)});}
 checks.push('NY17 D1 actual start differs from chart label: exact mapped candle + 375/412 light/dark/150% layout');
 await page.goto(base+'/m/more?briefing='+reportId);await expect(dialog().getByRole('button',{name:/EURUSD/})).toBeVisible();
 const scroll=dialog().locator('.mobile-drawer-scroll').first();await scroll.evaluate(el=>{el.scrollTop=110;});const beforeScroll=await scroll.evaluate(el=>el.scrollTop);
 await dialog().getByRole('button',{name:/EURUSD/}).click();await expect(page.getByRole('button',{name:'返回简报',exact:true})).toBeVisible();await page.getByRole('button',{name:'返回简报',exact:true}).click();await expect(dialog()).toHaveAccessibleName('市场简报');await expect(dialog().getByRole('button',{name:/EURUSD/})).toBeVisible();assert.equal(await scroll.evaluate(el=>el.scrollTop),beforeScroll);
 checks.push('briefing exact same ticker D1 chart→return retains report and scroll');
 assert(!requests.some(r=>r.method==='POST'&&/\/ack|\/handled|\/lifecycle|\/retry/.test(r.path)),'view never handles/acknowledges/edits rule');assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'proof.json'),JSON.stringify({checks,actual,errors},null,2));console.log(JSON.stringify({passed:true,checks,errors}));
 }catch(e){await page.screenshot({path:path.join(out,'failure.png')});console.log('DIAGNOSTICS',JSON.stringify({body:await page.locator('body').innerText(),errors,requests:requests.slice(-20),chart:await page.evaluate(()=>{try{return {symbol:MW_TEST_WIDGET.activeChart().symbol(),ready:MW_TEST_WIDGET.activeChart().dataReady(),shapes:MW_TEST_WIDGET.activeChart().getAllShapes()}}catch(e){return String(e)}})}));throw e;}finally{await context.close();await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
