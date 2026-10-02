// Research only: synthetic M5, public widget methods, no API/DB/reset/private API.
const {chromium}=require('@playwright/test');
const fs=require('node:fs');
const OUT=process.env.NATIVE_ADDITIVE_OUTPUT||'/tmp/mw-native-additive-jump';
fs.mkdirSync(OUT,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 const report={kind:'native v31.1 additive historical jump boundaries; synthetic M5; no API/DB',cases:[]};
 try{
  for(const config of [{name:'cold-latest-then-jump',mode:'cold',startup:false},{name:'cached-latest-then-jump',mode:'cached',startup:false},{name:'cold-historical-startup',mode:'cold',startup:true},{name:'cached-historical-startup',mode:'cached',startup:true}]){
   const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:1400,height:900}});
   const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/api/**',route=>route.abort());
   await page.route('https://127.0.0.1:15454/__native-additive-jump',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body style="margin:0"><div id="chart" style="height:850px"></div><script src="/charting_library/charting_library.js"></script></body></html>'}));
   await page.goto('https://127.0.0.1:15454/__native-additive-jump');
   await page.evaluate(config=>{
    globalThis.trace=[];globalThis.events=[];globalThis.pending=0;globalThis.phase='initial';
    const step=300000,end=Date.parse('2026-10-01T00:00:00Z');
    globalThis.target={from:end/1000-10165*300,to:end/1000-10000*300};
    const feed={onReady:cb=>setTimeout(()=>cb({supported_resolutions:['5']}),0),resolveSymbol:(s,cb)=>setTimeout(()=>cb({name:s,ticker:s,description:s,type:'crypto',exchange:'TEST',listed_exchange:'TEST',session:'24x7',timezone:'Etc/UTC',minmov:1,pricescale:100,has_intraday:true,intraday_multipliers:['5'],supported_resolutions:['5'],format:'price',data_status:'streaming'}),0),getServerTime:cb=>cb(end/1000),
     getBars:(s,r,p,cb)=>{
      const t={at:performance.now(),phase,params:{...p},visible:globalThis.widget?.activeChart().getVisibleRange()};trace.push(t);pending++;
      const isJump=config.startup||phase!=='initial';
      const extra=config.mode==='cold'?600:(isJump?2000:3000);
      const n=Math.max(1,p.countBack)+extra;
      const last=Math.min(end-step,Math.floor((p.to*1000-1)/step)*step);
      const bars=Array.from({length:n},(_,i)=>{const time=last-(n-1-i)*step,v=100+Math.sin(time/step)*2;return{time,open:v,high:v+1,low:v-1,close:v+.4}});
      setTimeout(()=>{pending--;t.callback_at=performance.now();t.returned=n;t.extra=extra;t.first=bars[0].time/1000;t.last=bars.at(-1).time/1000;t.hasAtOrAfterTo=bars.some(b=>b.time/1000>=p.to);cb(bars,{noData:false});},50);
     },subscribeBars:()=>{},unsubscribeBars:()=>{}};
    globalThis.widget=new TradingView.widget({container:'chart',library_path:'/charting_library/',symbol:'TEST',interval:'5',datafeed:feed,locale:'zh',autosize:true,...(config.startup?{timeframe:target}:{}),enabled_features:['determine_first_data_request_size_using_visible_range'],disabled_features:['use_localstorage_for_settings','header_widget','left_toolbar','create_volume_indicator_by_default','trading_account_manager']});
    globalThis.ready=false;widget.onChartReady(()=>{ready=true;widget.activeChart().onVisibleRangeChanged().subscribe(null,r=>events.push({at:performance.now(),phase,range:r}));});
    globalThis.snap=()=>({at:performance.now(),range:widget.activeChart().getVisibleRange(),spacing:widget.activeChart().getTimeScale().barSpacing(),offset:widget.activeChart().getTimeScale().rightOffset(),dataReady:widget.activeChart().dataReady(),pending,requests:trace.length});
   },config);
   await page.waitForFunction(()=>ready&&widget.activeChart().dataReady()&&pending===0,null,{timeout:30000});
   await page.waitForTimeout(300);
   const initial=await page.evaluate(()=>snap());
   if(!config.startup){await page.evaluate(async()=>{phase='jump';await widget.activeChart().setVisibleRange(target);});await page.waitForFunction(()=>pending===0&&widget.activeChart().dataReady());await page.waitForTimeout(200);}
   const jump=await page.evaluate(()=>snap());
   for(const f of page.frames())await f.getByText('了解！',{exact:true}).click({timeout:150}).catch(()=>{});
   const movements=[];
   for(const movement of [{name:'older',from:200,to:800},{name:'newer-return',from:800,to:200},{name:'newer-beyond-target',from:800,to:200}]){
    const before=await page.evaluate(name=>{phase=name;return snap()},movement.name);
    await page.mouse.move(movement.from,250);await page.mouse.down();await page.mouse.move(movement.to,250,{steps:20});await page.mouse.up();
    await page.waitForTimeout(120);await page.waitForFunction(()=>pending===0&&widget.activeChart().dataReady());await page.waitForTimeout(80);
    for(const f of page.frames())await f.getByText('了解！',{exact:true}).click({timeout:150}).catch(()=>{});
    const after=await page.evaluate(()=>snap());movements.push({name:movement.name,before,after,newRequests:after.requests-before.requests});
   }
   const details=await page.evaluate(()=>({trace,events,target,version:TradingView.version()}));
   const item={config,initial,jump,movements,...details,errors};report.cases.push(item);fs.writeFileSync(OUT+'/results.json',JSON.stringify(report,null,2));
   console.log(JSON.stringify({name:config.name,initial,jump,movements:movements.map(m=>({name:m.name,newRequests:m.newRequests,range:m.after.range})),trace:details.trace,errors}));
   await page.screenshot({path:OUT+'/'+config.name+'.png'});await page.close();
  }
 }finally{fs.writeFileSync(OUT+'/results.json',JSON.stringify(report,null,2));await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
