const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const path=require('node:path');
const messages=[];
const context=vm.createContext({document:{createElement:()=>({}),head:{append(){}}},URL,URLSearchParams,
  Map,Set,Promise,Date,Intl,Error,location:{search:'?parent=http://localhost'},
  parent:{postMessage:m=>messages.push(m)},crypto:{randomUUID:()=>Math.random().toString()},
  addEventListener(){},setTimeout,clearTimeout,queueMicrotask});
for(const file of ['series.js','price-format.js','composite-display-batches.js','bridge.js'])
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../../advanced-host',file),'utf8'),context);
(async()=>{
  vm.runInContext(`
    globalThis.rows=[];
    globalThis.tickers=['MWP:EURUSD','MWP:BTCUSDT','MWP:DUKA:'+'b'.repeat(32),
      'MWP:YAHOO:'+'c'.repeat(32),'MD:'+'d'.repeat(24)+':GBPUSD',
      'MWH:24df99fe-2fb9-4d43-ac33-2c272bab9226','MWC:'+'a'.repeat(64)];
    const names=['EURUSD','BTCUSDT','GBPUSD','AAPL','GBPUSD','EURUSD','EURUSD'];
    const sources=['oanda','binance','dukascopy','yahoo','oanda','oanda','composite'];
    tickers.forEach((ticker,i)=>watchlistMetadata.set(ticker.toLowerCase(),
      {display_symbol:names[i],symbol:names[i],name:names[i],source:sources[i]}));
    feed.subscribeQuotes(tickers,[],batch=>rows.push(...batch),'all-sources');
  `,context);
  assert.equal(context.rows.length,0,'native name callbacks remain asynchronous');
  await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal(context.rows.length,context.tickers.length,
    'all sources and kinds receive prewarmed human names before the network snapshot');
  assert.deepEqual(Array.from(context.rows,r=>r.v.short_name),['EURUSD','BTCUSDT','GBPUSD','AAPL','GBPUSD','EURUSD','EURUSD']);
  assert(context.rows.every(r=>r.v.lp===undefined&&r.v.ch===undefined),'metadata never invents prices');
  assert.deepEqual(Array.from(context.rows,r=>r.n),Array.from(context.tickers),'routing identities are unchanged');
  console.log('All source/type metadata supplies human names without inventing quotes.');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{
  for(const entry of vm.runInContext('[...pending.values()]',context)){
    clearTimeout(entry.timer);clearTimeout(entry.cancellationTimer);
  }
});
