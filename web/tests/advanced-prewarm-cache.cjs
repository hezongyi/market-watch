const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const context=vm.createContext({Map,Promise,Date,JSON});
vm.runInContext(fs.readFileSync('../advanced-host/progressive-history.js','utf8'),context);
(async()=>{
 const calls=[];
 const cache=context.progressiveHistory(async(args,warm)=>{
   calls.push({args,warm});
   return {bars:Array.from({length:10},(_,i)=>({start:i+1,close:100+i}))};
 },()=>false,()=>{},e=>{throw e},2);
 await cache.warm({instrument:'XAUUSD',timeframe:'H1',before:12,limit:10});
 const page=await cache.get({instrument:'XAUUSD',timeframe:'H1',before:10,limit:3});
 assert.equal(calls.length,1);assert.deepEqual([...page.bars.map(b=>b.start)],[7,8,9]);
 assert.equal(calls[0].warm,true);
 // Newer tail is not present: never claim the old page covers it.
 await cache.get({instrument:'XAUUSD',timeframe:'H1',before:15,limit:3});
 assert.equal(calls.length,2);
 // A different period must never reuse H1 bars.
 await cache.get({instrument:'XAUUSD',timeframe:'M5',before:10,limit:3});
 assert.equal(calls.length,3);
 await cache.warm({instrument:'EURUSD',timeframe:'H1',before:12,limit:10});
 await cache.warm({instrument:'BTCUSDT',timeframe:'H1',before:12,limit:10});
 await cache.warm({instrument:'XAUUSD',timeframe:'H1',before:12,limit:10});
 assert.equal(calls.length,6,'oldest entries must be evicted at capacity');
 console.log('Prewarmed period pages satisfy smaller requests without network; boundaries and capacity enforced');
})().catch(e=>{console.error(e);process.exit(1)});
