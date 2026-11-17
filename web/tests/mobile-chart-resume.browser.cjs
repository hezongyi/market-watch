// Built mobile entry and actual licensed widget, with explicit API test doubles.
// This is browser evidence, never backend/Find X8/ntfy acceptance.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium,expect}=require('@playwright/test');
const dist=path.resolve('dist'),id='a'.repeat(64),ticker='MWC:'+id;
const out=process.env.MOBILE_CHART_OUTPUT || '/tmp/mw-chart-round1';fs.mkdirSync(out,{recursive:true});
const streams=new Set(),subscriptions=new Map();
const requests=[],errors=[],checks=[],consoleErrors=[],layouts=[];let catalogMode='ready',releaseCatalog,holdHistory=false,failHistory=false;const heldHistory=[];
const provider=process.env.MOBILE_CHART_IDENTITY_ONLY ? 'MWP:DUKA:'+'A1'.repeat(16) : 'MWP:YAHOO:AAPL';
const alertRule={id:'fixture-rule',name:'EURUSD H1',status:'paused',health:'ready',version:1,control_revision:1,run:1,count:0,max_triggers:1,created_at:Date.now(),updated_at:Date.now(),display_identity:{code:'EURUSD',source:'composite'},condition_summary:'价格 上穿 101',runtime:{},config:{name:'EURUSD H1',instrument:id,series_kind:'composite',source:'composite',timeframe:'H1',mode:'close',condition:{relation:'cross_up',left:{kind:'price'},right:{kind:'constant',value:'101'}},max_triggers:1,expires_at:null,message:'',notify_web:true,notify_ntfy:false,late_delivery:'log_only',association:null,calculation_version:'chart-python-v1'}};
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
   if(url.pathname==='/api/market-data/center/dataset-summaries')return json({items:[],total:0});
   if(url.pathname==='/api/market-data/composites/'+id)return json({id,source:'composite',frames:['M1','M5','H1','D1'],status:'ready'});
   if(url.pathname==='/api/market-data/series/page')return json({items:[{ticker,symbol:'EURUSD · 日内观察组合',source:'composite',instrument_name:'受控组合',description:'受控浏览器测试组合',series_kind:'composite'},{ticker:provider,symbol:'AAPL',description:'苹果',instrument_name:'苹果',source:'yahoo',series_kind:'provider',frames:['M1','M5','H1','D1']}]});
   if(url.pathname==='/api/advanced-charts/catalog'){if(catalogMode==='hold')await new Promise(resolve=>releaseCatalog=resolve);if(catalogMode==='fail')return json({detail:'图表目录读取失败'},500);return json({SMA:{label:"SMA 简单均线",pane:"main",aliases:["SMA","均线"],params:{period:20},series:[{key:"value",type:"line"}]}});}
   if(url.pathname==='/api/charts/history-capabilities')return json({protocol:1,version:'test',mode:'continuous',max_bars:20000,workspace_bars:100000,default_bars:1000,task_seconds:30});
   if(url.pathname==='/api/market-data/resolve')return json({symbol:query.series_kind==='provider'?'AAPL':'EURUSD · 日内观察组合',source:query.series_kind==='provider'?'yahoo':'composite',price_description:'收盘价',name:query.series_kind==='provider'?'苹果':'受控组合',precision:2,calendar:'utc0',asset_type:'CRYPTO',frames:['M1','M5','H1','D1'],created:true,stream:true});
   if(url.pathname==='/api/chart-alerts/page')return json({items:[alertRule],next_cursor:null});
   if(url.pathname==='/api/chart-alerts/fixture-rule')return json(alertRule);
   if(url.pathname==='/api/chart-alerts/events/page')return json({items:[],next_cursor:null});
   if(url.pathname==='/api/health')return json({version:'fixture'});
   if(url.pathname==='/api/notification-center/snapshot')return json({events:[],cursor:'test'});
   if(url.pathname==='/api/notification-center/events')return json({events:[],before:null});
   if(url.pathname==='/api/charts/history-loads/fixture-load/cancel')return json({ok:true});
   if(['/api/charts/data','/api/charts/history-loads','/api/charts/reserve'].includes(url.pathname)){
     const candleQuery=query.query || query;if(url.pathname==='/api/charts/history-loads'&&holdHistory)await new Promise(resolve=>heldHistory.push(resolve));
     if(failHistory && url.pathname==='/api/charts/history-loads')return json({load:{id:'fixture-load',state:'failed',error:{code:'HISTORY_UNAVAILABLE',message:'平台历史暂不可用，请重试',status:503}}});
     const step={M1:60000,M5:300000,H1:3600000,D1:86400000}[candleQuery.timeframe] || 3600000;
     const end=Math.floor(Math.min(candleQuery.before || Date.now(),Date.now())/step)*step-2*step;
     const bars=Array.from({length:Math.min(candleQuery.limit || 100,500)},(_,i)=>{
       const start=end-(Math.min(candleQuery.limit || 100,500)-i)*step;
       const close=100+Math.sin(i/13)*1.2+Math.sin(i/4)*.25+i*.006,open=close+Math.sin(i*2)*.15;return {start,end:start+step,open:open.toFixed(2),high:(Math.max(open,close)+.12).toFixed(2),low:(Math.min(open,close)-.12).toFixed(2),close:close.toFixed(2),complete:true,revision:1};
     });
     const result={bars,has_more:false,pending:[],revision_id:'b'.repeat(64),input_revision:1,as_of:Date.now()};return json(url.pathname==='/api/charts/history-loads'?{load:{id:'fixture-load',state:'ready',pages:1},result}:result);
   }
   if(url.pathname==='/api/market-data/quotes')return json((query.symbols || []).map(n=>({n,s:'ok',v:{lp:101,ch:1,chp:1}})));
   if(url.pathname.startsWith('/api/charts/indicator-demands/'))return json({ok:true});
   if(url.pathname==='/api/charts/stream/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('event: heartbeat\ndata: {}\n\n');streams.add(res);res.on('close',()=>streams.delete(res));return;}
   if(url.pathname.startsWith('/api/charts/stream/')){if(url.pathname.endsWith('/subscribe'))subscriptions.set(query.listener,query);if(url.pathname.endsWith('/unsubscribe'))subscriptions.delete(query.listener);return json({ok:true});}
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
 page.on('pageerror',error=>errors.push(error.message));
 try{
  await page.goto('http://127.0.0.1:'+server.address().port+'/m/');
  await page.getByLabel('密码',{exact:true}).fill('test');await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.getByRole('button',{name:'添加自选',exact:true}).click();await page.locator('.symbol-search-body').filter({hasText:'EURUSD'}).first().click();await page.getByRole('button',{name:'打开图表',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>{try{return Boolean(window.MW_TEST_WIDGET?.activeChart().dataReady())}catch{return false}}),{timeout:30000}).toBe(true);
  const instance=await page.evaluateHandle(()=>window.MW_TEST_WIDGET);
  const values=()=>page.evaluate(()=>{const bars=window.MW_TEST_WIDGET.activeChart()._chartWidget.model().model().mainSeries().bars();return {size:bars.size(),last:bars.valueAt(bars.lastIndex()),range:window.MW_TEST_WIDGET.activeChart().getVisibleRange()};});
  const initial=await values();
  const study=await page.evaluate(()=>window.MW_TEST_WIDGET.activeChart().createStudy('Relative Strength Index',false,false,{length:9}));
  // Moving between networks must retain the actual widget and its candles.
  await context.setOffline(true);
  await expect(page.locator('.mobile-chart-canvas iframe')).toHaveCount(1);
  assert(await page.evaluate(widget=>window.MW_TEST_WIDGET===widget,instance),'offline must preserve the same native chart');
  await page.waitForTimeout(200);assert.equal((await values()).size,initial.size);
  await context.setOffline(false);await expect.poll(()=>streams.size,{timeout:10000}).toBe(1);
  await expect.poll(()=>[...subscriptions.values()].some(row=>row.kind==='bars'&&row.query.series_kind==='composite')).toBe(true);
  const before=[...subscriptions.values()].find(row=>row.kind==='bars'&&row.query.series_kind==='composite');assert(before);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
  await expect.poll(()=>streams.size).toBe(0);
  await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
  await expect.poll(()=>[...subscriptions.values()].some(row=>row.kind==='bars'&&row.generation>before.generation)).toBe(true);
  const resumed=[...subscriptions.values()].find(row=>row.kind==='bars'&&row.query.series_kind==='composite');
  assert.equal(resumed.cursor,initial.last[0]*1000,'accepted native candle anchors recovery');
  const start=initial.last[0]*1000,step=3600000;
  const publish=(sequence,bars)=>{for(const stream of streams)stream.write('data: '+JSON.stringify({listener:resumed.listener,generation:resumed.generation,sequence,type:'bars',as_of:Date.now(),bars})+'\n\n');};
  const bars=[0,1,2,3].map((n)=>({start:start+n*step,end:start+(n+1)*step,open:'101',high:'105',low:'100',close:String(102+n),complete:n!==3}));
  publish(1,bars);
  await expect.poll(async()=>(await values()).last[4]).toBe(105);
  assert.equal((await values()).size,initial.size+3,'all missed bars must appear without a gap');
  publish(2,[{...bars[3],close:'105.5'}]);await expect.poll(async()=>(await values()).last[4]).toBe(105.5);
  assert(await page.evaluate(widget=>window.MW_TEST_WIDGET===widget,instance));
  assert.equal(await page.evaluate(id=>window.MW_TEST_WIDGET.activeChart().getStudyById(id).getInputValues().find(value=>value.id==='length').value,study),9,'study and parameters survive recovery');
  assert.deepEqual(errors,[]);await page.screenshot({path:out+'/resume.png'});
  console.log('PASS licensed mobile chart: offline retains widget/data; foreground accepted-cursor recovery, missed candles and live forming bar');
 }finally{await context.close();await browser.close();for(const stream of streams)stream.end();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1});
