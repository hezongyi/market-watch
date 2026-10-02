// Isolated native performance probe backed by actual acceptance API.
// No workspace writes or runtime cache resets; cold samples use separate historical windows.
// Run from web/. Output defaults to /tmp, not committed artifacts.
const {chromium}=require('@playwright/test');
const fs=require('node:fs');
const OUT=process.env.ADDITIVE_BUFFER_OUTPUT||require('node:path').resolve(__dirname,'../../docs/verification/native-history/additive-display');fs.mkdirSync(OUT,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1400,height:900}});
 const credentials=JSON.parse(fs.readFileSync(require('node:path').resolve(__dirname,'../../../market-watch/artifacts/local-credentials.json')));
 const login=await context.request.post('https://localhost:15453/api/login',{data:{password:credentials.password}});if(!login.ok())throw Error('login failed');const csrf=(await login.json()).csrf;
 const report={kind:'additive buffer research: actual native countBack plus extras; isolated native widget connected to real running API via test binding; no product workspace/bridge modifications',records:[]};let index=0;
 try{
 for(let repeat=0;repeat<3;repeat++){
  const configs=[{cached:false,extra:0,visible:0},{cached:false,extra:600,visible:0},{cached:false,extra:600,visible:700},{cached:true,extra:3000,visible:0},{cached:true,extra:3000,visible:2500}];
  for(const instrument of ['OANDA:AUD_CAD','BTCUSDT'])for(const config of (repeat%2?configs.slice().reverse():configs)){
   const {cached,extra,visible}=config;
   const before=cached?Date.parse('2025-05-21T14:00:00Z'):Date.parse('2021-06-04T14:00:00Z')-index++*28*86400000;
   const sample={cached,repeat,instrument,extra,visible,before,http:[],errors:[]};
   const page=await context.newPage();page.on('pageerror',e=>sample.errors.push(e.message));
   await page.exposeBinding('acquireBars',async(_,params)=>{
    const started=Date.now();const response=await context.request.post('https://localhost:15453/api/charts/data',{headers:{'X-CSRF-Token':csrf},data:{instrument,series_kind:'provider',timeframe:'M5',before:Math.min(before,params.to*1000),countBack:params.countBack+extra,limit:params.countBack+extra,indicators:[]}});
    const body=await response.body(),payload=JSON.parse(body);sample.http.push({status:response.status(),elapsed_ms:Date.now()-started,bytes:body.length,countBack:params.countBack,returned:payload.bars?.length,cache_hit:payload.cache_hit,timings_ms:payload.timings_ms});
    if(!response.ok())throw Error('API status '+response.status());return payload;
   });
   await page.route('https://127.0.0.1:15454/__native-buffer-api',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html><body style="margin:0"><div id="chart" style="height:850px"></div><script src="/charting_library/charting_library.js"></script></body></html>'}));
   try{
    await page.goto('https://127.0.0.1:15454/__native-buffer-api');
    await page.evaluate(({instrument,before,visible})=>{
     globalThis.log=[];globalThis.displayed=false;globalThis.started=performance.now();
     const feed={onReady:cb=>setTimeout(()=>cb({supported_resolutions:['5']}),0),resolveSymbol:(s,cb)=>setTimeout(()=>cb({name:s,ticker:s,description:s,type:'crypto',exchange:'TEST',listed_exchange:'TEST',session:'24x7',timezone:'Etc/UTC',minmov:1,pricescale:100000,has_intraday:true,intraday_multipliers:['5'],supported_resolutions:['5'],format:'price',data_status:'streaming'}),0),getBars:async(s,r,p,cb,err)=>{try{log.push({kind:'request',at:performance.now(),params:p});const result=await acquireBars(p);const rows=result.bars.map(b=>({time:b.chart_time,open:Number(b.open),high:Number(b.high),low:Number(b.low),close:Number(b.close)}));globalThis.callbackAt=performance.now();cb(rows,{noData:result.history_boundary===true});log.push({kind:'callback',at:performance.now(),count:rows.length});}catch(e){log.push({kind:'error',error:e.message});err(e.message)}},subscribeBars:()=>{},unsubscribeBars:()=>{},getServerTime:cb=>cb(before/1000)};
     widget=new TradingView.widget({...(visible?{timeframe:{from:before/1000-visible*300,to:before/1000}}:{}),container:'chart',library_path:'/charting_library/',symbol:instrument,interval:'5',datafeed:feed,locale:'zh',autosize:true,enabled_features:['determine_first_data_request_size_using_visible_range'],disabled_features:['use_localstorage_for_settings','header_widget','left_toolbar','create_volume_indicator_by_default','trading_account_manager']});
     widget.onChartReady(()=>{requestAnimationFrame(()=>requestAnimationFrame(()=>{globalThis.finished=performance.now();displayed=true}))});
    },{instrument,before,visible});
    await page.waitForFunction(()=>displayed&&widget.activeChart().dataReady(),null,{timeout:20000});
    Object.assign(sample,await page.evaluate(()=>({displayed_ms:finished-started,pre_request_ms:log.find(x=>x.kind==='request').at-started,callback_to_display_ms:finished-callbackAt,log,range:widget.activeChart().getVisibleRange(),spacing:widget.activeChart().getTimeScale().barSpacing()})));
   }catch(e){sample.error=e.message.split('\n')[0]}
   report.records.push(sample);fs.writeFileSync(OUT+'/results.json',JSON.stringify(report,null,2));console.log(JSON.stringify({cached,repeat,instrument,extra,visible,displayed_ms:sample.displayed_ms,http:sample.http,error:sample.error}));await page.close();
  }
 }
 }finally{fs.writeFileSync(OUT+'/results.json',JSON.stringify(report,null,2));await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
