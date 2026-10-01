const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const sent = [];
const context = vm.createContext({
  URL,
  URLSearchParams,
  Map,
  Promise,
  Date,
  Intl,
  Error,
  location: { search: "?parent=http://localhost" },
  parent: { postMessage: (message) => sent.push(message) },
  crypto: { randomUUID: () => "test" },
  addEventListener() {},
  setTimeout: () => 1,
  clearTimeout() {},
});
vm.runInContext(fs.readFileSync("../advanced-host/series.js", "utf8"), context);
vm.runInContext(fs.readFileSync("../advanced-host/bridge.js", "utf8"), context);
(async()=>{
 vm.runInContext(`
   let testPage={bars:[]};
   progressivePages={get:async args=>{globalThis.lastRead=args;return testPage}};
   globalThis.setPage=bars=>{testPage={bars}};
   globalThis.load=(symbol,count)=>new Promise((resolve,reject)=>feed.getBars(
     {ticker:symbol},'1D',{from:Date.now()/1000-30*86400,to:Date.now()/1000+86400,
       countBack:count,firstDataRequest:true},(bars,meta)=>resolve({bars,meta}),reject));
 `,context);
 const bars=Array.from({length:5},(_,i)=>({start:Date.now()-(10-i)*86400000,
   end:Date.now()-(9-i)*86400000,open:1,high:2,low:0.5,close:1,complete:true}));
 assert.equal((await context.load('COLD',5)).meta.noData,true);
 assert.equal(context.lastRead.limit,7,'D1 local read reserves two rows for exclusive date filtering');
 context.setPage(bars.slice(-2));
 assert.equal((await context.load('COLD',5)).meta.noData,true,'partial cold first screen must stop native auto paging');
 assert.equal((await context.load('REOPEN',5)).meta.noData,true,'first observation of incomplete persisted history is also cold');
 context.setPage(bars);
 await context.load('WARM',5);
 context.setPage(bars.slice(-2));
 assert.equal((await context.load('WARM',5)).meta.noData,false,'previously complete warm history must retain navigation');
 context.setPage(bars);
 assert.equal((await context.load('COLD',5)).meta.noData,false,'complete cold screen reopens native paging');
 context.setPage(bars.slice(-2));
 assert.equal((await context.load('COLD',5)).meta.noData,false,'cold marker clears after completion');
 // D1 buffer bars beyond p.to must not suppress historical acquisition.
 vm.runInContext(`
   let navigations=0;
   widget={chartsCount:()=>1,chart:()=>({symbol:()=>"BTCUSDT",resolution:()=>"1D",
     getTimeScale:()=>({width:()=>500,barSpacing:()=>5})})};
   historicalNavigationPage=async()=>{navigations++;return {bars:[{
     start:Date.parse('2026-01-06T00:00:00Z'),end:Date.parse('2026-01-07T00:00:00Z'),
     open:1,high:2,low:0.5,close:1}]}};
   globalThis.navigationCount=()=>navigations;
   globalThis.loadBoundary=()=>new Promise((resolve,reject)=>feed.getBars(
     {ticker:'BTCUSDT'},'1D',{from:Date.parse('2026-01-06T00:00:00Z')/1000,
       to:Date.parse('2026-01-07T12:00:00Z')/1000,countBack:1,firstDataRequest:false},
     (bars,meta)=>resolve({bars,meta}),reject));
 `,context);
 context.setPage([{start:Date.parse('2026-01-08T00:00:00Z'),
   end:Date.parse('2026-01-09T00:00:00Z'),open:1,high:2,low:0.5,close:1}]);
 const boundary=await context.loadBoundary();
 assert.equal(context.navigationCount(),1,'D1 bars beyond requested date must not suppress acquisition');
 assert.equal(boundary.bars.length,1);
 assert.equal(boundary.meta.noData,false);
 console.log('Cold partial first screen ends native paging; warm navigation and completed screens remain open');
})().catch(e=>{console.error(e);process.exitCode=1});
