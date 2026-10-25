// Exercise the real resolveSymbol and its deferred native chart API call.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const timers=[];
const context=vm.createContext({URL,URLSearchParams,Map,Set,Promise,Date,Intl,Error,
 document:{createElement:()=>({}),head:{append(){}}},
 location:{search:'?parent=http://localhost'},parent:{postMessage(){}},
 crypto:{randomUUID:()=> 'test'},addEventListener(){},setTimeout:fn=>timers.push(fn),clearTimeout(){}});
for(const file of ['series.js','composite-display-batches.js','bridge.js'])vm.runInContext(fs.readFileSync('../advanced-host/'+file,'utf8'),context);
const run=code=>vm.runInContext(code,context);
(async()=>{
 run(`refreshNotificationTimezone=()=>{};watchlistLayout=null;
 globalThis.ticker='MWP:FXCM:abcdef01';globalThis.res='240';globalThis.changed=[];
 globalThis.chart={symbol:()=>ticker,resolution:()=>res,setResolution:r=>{changed.push(r);res=r;}};
 widget={chartsCount:()=>1,chart:()=>chart};
 globalThis.meta={symbol:'EUR/USD',source:'fxcm',precision:5,frames:['M1','D1'],basis:'bid'};
 request=async()=>meta;globalThis.resolved=null;`);
 await run(`feed.resolveSymbol(ticker,value=>resolved=value,e=>{throw Error(e)});`);
 assert.deepEqual(Array.from(run('resolved.supported_resolutions')),['1','1D']);
 while(timers.length)timers.shift()();
 assert.deepEqual(Array.from(run('changed')),['1']);
 run(`res='240';changed=[];meta.frames=['H1'];`);
 await run(`feed.resolveSymbol(ticker,()=>{},e=>{throw Error(e)});`);
 run(`ticker='MWP:OANDA:EUR_USD';`);
 while(timers.length)timers.shift()();
 assert.equal(run('changed.length'),0);
 console.log('Unsupported interval uses an available native frame; stale symbol switches are preserved');
})().catch(e=>{console.error(e);process.exitCode=1});
