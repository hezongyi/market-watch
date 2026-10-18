const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('../advanced-host/bridge.js','utf8');
const helperStart=source.indexOf('function providerRecoveryRows(');
const recoveryStart=helperStart<0?source.indexOf('const displayRecoveries=new Map();'):helperStart;
const end=source.indexOf('function acceptMarketHistory',recoveryStart);
function harness(change=()=>{}){
 const rows=[[1,1,2,.5,1.5,4],[2,1.5,3,1,2,5]],events=[];
 const page={cache_revision:7,provider_snapshot_id:'renewed',bars:[
  {start:1000,open:'1',high:'2',low:'.5',close:'1.5',volume:'4'},
  {start:2000,open:'1.5',high:'3',low:'1',close:'2',volume:'5'}]};
 let symbol='MWP:DUKA:test',reloads=0,reads=0,registered=0;
 const data={size:()=>rows.length,each:fn=>{for(let i=0;i<rows.length;i++)if(fn(i,rows[i]))break;}};
 const chart={symbol:()=>symbol,resolution:()=> '1',dataReady:()=>true,
  _chartWidget:{model:()=>({model:()=>({mainSeries:()=>({data:()=>data})})})}};
 const key='MWP:DUKA:test|1',binding={providerSnapshot:'expired',tailVersion:7,lastChartTime:2000,
  lastStart:2000,firstStart:1000,calculationStart:500,correctionVersion:0};
 const ctx={alertUIWorkspace:'test-workspace',alertUISession:'test-session',crypto:require('node:crypto').webcrypto,ready:true,widget:{chartsCount:()=>1,chart:()=>chart},workspaceEpoch:1,
  indicatorKey:(s,r)=>s+'|'+r,indicatorBindings:new Map([[key,binding]]),
  decode:()=>({series_kind:'provider'}),indicatorCoordinator:{sync(){}},
  chartUsesSymbol:(c,s,r)=>c.symbol()===s&&c.resolution()===r,
  compositeDisplayBatches:{cancel(){}},subscriptions:new Map([['sub',{symbol,res:'1'}]]),
  cache:new Map(),marketGeneration:1,send:e=>events.push(e),setTimeout:fn=>{queueMicrotask(fn);return 1;},
  query:async(_,__,args)=>{reads++;assert.equal(args.indicators?.length||0,0);assert.equal(args.provider_snapshot_id,undefined);change({page,rows,ctx,setSymbol:s=>symbol=s});return page;},
  barsOf:p=>p.bars.map(b=>({time:b.start,open:+b.open,high:+b.high,low:+b.low,close:+b.close,volume:+b.volume})),
  reloadHistory:async()=>{reloads++;return true;},registerMarketBar:()=>registered++};
 vm.runInNewContext(source.slice(source.indexOf('function rememberIndicatorBinding('),source.indexOf('function startIndicatorCoordinator('))+
  source.slice(recoveryStart,end)+'\nglobalThis.recover=recoverDisplaySnapshot;',ctx);
 return {ctx,get binding(){return ctx.indicatorBindings.get(key);},events,rows,run:()=>ctx.recover(symbol,'1','expired'),counts:()=>({reloads,reads,registered})};
}
(async()=>{
 let h=harness();await h.run();assert.equal(h.counts().reloads,0,'unchanged accepted provider prices must renew without resetting the main chart');
 assert.equal(h.counts().reads,1);assert.equal(h.binding.providerSnapshot,'renewed');
 assert.equal(h.binding.calculationStart,500,'credential renewal preserves the established calculation origin');
 assert.equal(h.events.filter(e=>e.state).at(-1).state,'ready');
 for(const mutate of [({page})=>page.cache_revision++,({page})=>page.bars[0].close='1.6',
  ({page})=>page.bars[0].volume='8',({page})=>page.bars.pop(),({page})=>delete page.provider_snapshot_id,
  ({page})=>delete page.cache_revision,
  ({rows})=>rows[0][4]=1.6]){
  h=harness(mutate);await h.run();assert.equal(h.counts().reloads,1,'changed, incomplete or raced observations retain full recovery');
 }
 h=harness(({ctx})=>ctx.workspaceEpoch++);await h.run();assert.equal(h.counts().reloads,0);assert.equal(h.binding.providerSnapshot,'expired');
 h=harness(({setSymbol})=>setSymbol('MWP:DUKA:other'));await h.run();assert.equal(h.counts().reloads,0);assert.equal(h.binding.providerSnapshot,'expired');
 h=harness(({ctx})=>ctx.indicatorBindings.get('MWP:DUKA:test|1').providerSnapshot='newer-stream');await h.run();
 assert.equal(h.counts().reloads,0,'a newer accepted stream credential supersedes a delayed expiry recovery');
 console.log('PASS provider credential-only recovery preserves main prices; corrections and stale navigation remain fenced');
})().catch(e=>{console.error(e);process.exitCode=1;});
