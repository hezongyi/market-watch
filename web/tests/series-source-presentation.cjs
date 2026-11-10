// Exercise the actual native resolver and pending watchlist presentation for every kind.
const assert=require('node:assert/strict'),vm=require('node:vm');
const ctx=vm.createContext({document:{createElement:()=>({}),head:{append:()=>{}}},URL,URLSearchParams,Map,Promise,Date,Intl,Error,
 location:{search:'?parent=http://localhost'},parent:{postMessage:()=>{}},
 crypto:{randomUUID:()=>Math.random().toString()},addEventListener:()=>{},setTimeout,clearTimeout});
for(const file of ['series.js','price-format.js','composite-display-batches.js','chart-runtime.js'])
 vm.runInContext(require('./fixtures/direct-runtime.cjs').read('../advanced-host/'+file,'utf8'),ctx);
(async()=>{
 for(const [ticker,kind,source,description] of [
  ['MWP:TENCENT:SZSE:000001','provider','akshare','000001 · 平安银行 · 平台 · 腾讯（AKShare） · 原始价格'],
  ['EURUSD','managed','dukascopy','EURUSD · 我的欧元 · 自建 · Dukascopy · 买价'],
  ['MWH:12345678-1234-1234-1234-123456789abc','history','dukascopy','EURUSD · 欧元 / 美元 · 自建 · Dukascopy · 买价'],
  ['MWC:'+'a'.repeat(64),'composite','composite','EURUSD · 欧元 / 美元 · 组合 · 历史：Dukascopy → 实时：OANDA Live · 买价'],
 ]) {
  ctx.testTicker=ticker;ctx.testMeta={symbol:'EURUSD',display_symbol:'EURUSD',name:'旧名称',source,series_kind:kind,
   precision:5,basis:'bid',calendar:'ny17',presentation_description:description};
  await vm.runInContext(`initialSymbol={ticker:testTicker,metadata:testMeta};
   feed.resolveSymbol(testTicker,info=>{globalThis.resolved=info},error=>{throw error})`,ctx);
  assert.equal(ctx.resolved.ticker,ticker);assert.equal(ctx.resolved.pricescale,100000);
  assert.ok(ctx.resolved.description.startsWith(description));
  assert.equal(vm.runInContext('seriesPresentationRows([testTicker])[0].v.description',ctx),description,
   'pending watchlist quotes retain the same source and kind as the chart');
  assert.equal(vm.runInContext('presentationFor(testTicker).source',ctx),source);
 }
 ctx.testTicker='MWP:YAHOO:'+'b'.repeat(32);ctx.testMeta={source:'yahoo',symbol:'AAPL',presentation_description:'AAPL · 苹果 · 平台 · Yahoo Finance · 来源价格',delay_seconds:900};
 vm.runInContext('watchlistMetadata.set(testTicker,testMeta)',ctx);
 assert.equal(vm.runInContext('seriesPresentationRows([testTicker])[0].v.description',ctx),ctx.testMeta.presentation_description+' · 延迟 15 分钟');
 console.log('Platform, managed, fixed and composite native descriptions preserve source, type and identity');
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{await new Promise(resolve=>setTimeout(resolve,10));for(const entry of vm.runInContext('[...pending.values()]',ctx)){clearTimeout(entry.timer);clearTimeout(entry.cancellationTimer)}});
