const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const path=require('node:path');
const messages=[];
const context=vm.createContext({document:{createElement:()=>({}),head:{append(){}}},URL,URLSearchParams,
  Map,Set,Promise,Date,Intl,Error,location:{search:'?parent=http://localhost'},
  parent:{postMessage:m=>messages.push(m)},crypto:{randomUUID:()=>Math.random().toString()},
  addEventListener(){},setTimeout,clearTimeout,queueMicrotask});
for(const file of ['series.js','price-format.js','composite-display-batches.js','chart-runtime.js'])
  vm.runInContext(require("./fixtures/direct-runtime.cjs").read(path.resolve(__dirname,'../../advanced-host',file),'utf8'),context);
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
    Object.assign(watchlistMetadata.get(tickers[2].toLowerCase()),{price_description:'Bid · 来源原生UTC周期'});
    Object.assign(watchlistMetadata.get(tickers[3].toLowerCase()),{name:'Apple Inc.',delay_seconds:900});
    feed.subscribeQuotes(tickers,[],batch=>rows.push(...batch),'all-sources');
  `,context);
  assert.equal(context.rows.length,0,'native name callbacks remain asynchronous');
  await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal(context.rows.length,context.tickers.length,
    'all sources and kinds receive prewarmed human names before the network snapshot');
  assert.deepEqual(Array.from(context.rows,r=>r.v.short_name),['EURUSD','BTCUSDT','GBPUSD','AAPL','GBPUSD','EURUSD','EURUSD']);
  assert(context.rows.every(r=>r.v.lp===undefined&&r.v.ch===undefined),'metadata never invents prices');
  assert.deepEqual(Array.from(context.rows,r=>r.n),Array.from(context.tickers),'routing identities are unchanged');
  assert.equal(context.rows[0].v.description,'EURUSD · 平台行情',
    'initial provider description agrees with the actual quote description');
  assert.equal(context.rows[4].v.description,'GBPUSD · 自建行情',
    'legacy managed metadata must not be mislabeled as a composite');
  assert.equal(context.rows[2].v.description,'GBPUSD · 平台行情 · Bid · 来源原生UTC周期');
  assert.equal(context.rows[3].v.description,'Apple Inc. · Yahoo 市场报价 · 延迟 15 分钟',
    'supplier delay remains explicit before the first price');
  vm.runInContext(`
    globalThis.cached=[];globalThis.arriving=[];globalThis.reset=[];globalThis.cancelled=[];
    const cachedQuote={s:'ok',n:tickers[0],v:{short_name:'EURUSD',description:'EURUSD · 平台行情',
      lp:1.12345,read_at:100,market_session:'open',fetch_status:'ok',time_type:'source_m1',
      data_start:100,revision_id:'current'}};
    rememberQuoteRows([cachedQuote]);
    feed.subscribeQuotes([tickers[0]],[],batch=>cached.push(...batch),'cached');
    feed.subscribeQuotes([tickers[1]],[],batch=>arriving.push(...batch),'arriving');
    rememberQuoteRows([{...cachedQuote,n:tickers[1],v:{...cachedQuote.v,short_name:'BTCUSDT',lp:65000}}]);
    feed.subscribeQuotes([tickers[2]],[],batch=>reset.push(...batch),'reset');
    rememberQuoteRows([{...cachedQuote,n:tickers[2]}]);
    // A revision reset removes the previous binding before the async callback.
    quoteSnapshotRows.delete(tickers[2]);quoteResetTokens.set(tickers[2],{});
    feed.subscribeQuotes([tickers[0]],[],batch=>cancelled.push(...batch),'cancelled');
    feed.unsubscribeQuotes('cancelled');
  `,context);
  await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal(context.cached.length,1);
  assert.equal(context.cached[0].v.lp,1.12345,'resubscription keeps the existing real price');
  assert.equal(context.cached[0].v.market_session,'open','resubscription keeps the actual session');
  assert.equal(context.cached[0].v.revision_id,'current','resubscription keeps the current binding');
  assert.equal(context.arriving[0].v.lp,65000,'a stream arriving before the async callback wins over metadata');
  assert.equal(context.reset[0].v.lp,undefined,'a reset cannot replay the removed price');
  assert.equal(context.cancelled.length,0,'removed subscriptions receive no delayed presentation');
  vm.runInContext(`
    globalThis.nativeQuotes=[];
    feed.getQuotes([tickers[0]],batch=>nativeQuotes.push(...batch),error=>{throw Error(error)});
  `,context);
  assert.equal(context.nativeQuotes.length,0,'cached native quote callbacks remain asynchronous');
  await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal(context.nativeQuotes[0]?.v.lp,1.12345,
    'native details receives the current subscribed quote without waiting behind a slow supplier batch');
  vm.runInContext(`
    globalThis.nativeReset=[];globalThis.nativeLatest=[];
    feed.getQuotes([tickers[0]],batch=>nativeLatest.push(...batch),error=>{throw Error(error)});
    rememberQuoteRows([{s:'ok',n:tickers[0],v:{short_name:'EURUSD',description:'EURUSD · 平台行情',lp:1.12346,read_at:200}}]);
    feed.getQuotes([tickers[1]],batch=>nativeReset.push(...batch),error=>{throw Error(error)});
    quoteSnapshotRows.delete(tickers[1]);quoteResetTokens.set(tickers[1],{});
  `,context);
  await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal(context.nativeLatest[0]?.v.lp,1.12346,'native initial callback uses a newer stream observation');
  assert.equal(context.nativeReset.length,0,'native cached path cannot replay a price cleared by reset');
  console.log('All source/type metadata supplies human names without inventing quotes.');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{
  for(const entry of vm.runInContext('[...pending.values()]',context)){
    clearTimeout(entry.timer);clearTimeout(entry.cancellationTimer);
  }
});
