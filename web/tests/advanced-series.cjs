const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const events = [];
const ctx = vm.createContext({URL, URLSearchParams, Map, Promise, Date, Intl, Error,
  location:{search:"?parent=http://localhost"},parent:{postMessage:m=>events.push(m)},
  crypto:{randomUUID:()=>"test"},addEventListener(){},setTimeout,clearTimeout,queueMicrotask,
  requestAnimationFrame:callback=>setImmediate(callback),
  atob:s=>Buffer.from(s,"base64").toString("utf8"),btoa:s=>Buffer.from(s).toString("base64")});
for (const file of ["series.js","bridge.js","indicators.js"])
  vm.runInContext(fs.readFileSync("../advanced-host/"+file,"utf8"),ctx);

(async()=> {
  for (const symbol of ["EURUSD","XAUUSD","BTCUSDT","OANDA:EUR_CHF"]) {
    ctx.symbol = symbol;
    assert.equal(vm.runInContext('MWSeries.decode(symbol).series_kind',ctx),"managed");
    assert.equal(vm.runInContext('MWSeries.decode(MWSeries.encode(symbol,"provider")).symbol',ctx),symbol);
    assert.equal(vm.runInContext('MWSeries.same(symbol,MWSeries.encode(symbol,"provider"))',ctx),false);
  }
  ctx.oldSynthetic = "MWPY_"+Buffer.from(JSON.stringify({symbol:"XAUUSD",spec:{name:"SMA"},key:"value"})).toString("base64");
  ctx.platformSynthetic = "MWPY_"+Buffer.from(JSON.stringify({symbol:"MWP:XAUUSD",spec:{name:"SMA"},key:"value"})).toString("base64");
  assert.equal(vm.runInContext('decode(oldSynthetic).series_kind',ctx),"managed");
  assert.equal(vm.runInContext('decode(platformSynthetic).series_kind',ctx),"provider");
  await vm.runInContext(`(async()=>{
    globalThis.calls=[];
    request=async(q,type)=> {
      calls.push({q,type});
      if(q.op==='search')return [{id:'OANDA:EUR_CHF',symbol:'EUR_CHF',label:'欧元/瑞郎',supported:true,source:'oanda',asset_type:'CURRENCY'}];
      if(q.op)throw Error('provider unexpectedly requested managed history');
      return {bars:[{start:1000,end:2000,chart_time:3000,open:1,high:2,low:1,close:2}],
        history_boundary:true,indicators:[]};
    };
    await feed.searchSymbols('EUR','', '', rows=>{globalThis.search=rows});
    await feed.getBars({ticker:'MWP:OANDA:EUR_CHF'},'1D',
      {to:10,countBack:10,firstDataRequest:true}, (bars,meta)=>{globalThis.page={bars,meta}}, error=>{throw Error(error)});
  })()`,ctx);
  assert.equal(ctx.search[0].ticker,"MWP:OANDA:EUR_CHF","search selects platform data");
  assert.equal(ctx.search.length,1,"managed data is temporarily hidden from search");
  assert.ok(ctx.search[0].description.includes("欧元/瑞郎"),"search displays the Chinese name");
  assert.equal(ctx.page.bars[0].time,3000,"native provider labels override managed date stamping");
  assert.equal(ctx.page.meta.noData,true,"only provider's explicit boundary ends pagination");
  const calls = vm.runInContext('calls',ctx);
  assert.equal(calls[1].q.series_kind,"provider");
  assert.equal(calls[1].q.instrument,"OANDA:EUR_CHF");
  assert.equal(calls[1].type,"data");
  assert.equal(calls[1].q.limit,10,"first request must preserve native countBack");
  assert.equal(calls[1].q.countBack,10);
  assert.equal(calls[1].q.before,10000);
  assert.equal(calls[1].q.firstDataRequest,true);
  await vm.runInContext(`(async()=>{
    request=async(q,type)=>{
      calls.push({q,type});
      return {bars:Array.from({length:q.countBack},(_,i)=>({start:(i+1)*1000,
        end:(i+2)*1000,chart_time:(i+1)*1000,open:1,high:2,low:1,close:2})),
        history_boundary:false,indicators:[]};
    };
    await feed.getBars({ticker:'MWP:BTCUSDT'},'5',{from:1,to:10000,countBack:4500,firstDataRequest:true},
      bars=>{globalThis.largeBars=bars},error=>{throw Error(error)});
  })()`,ctx);
  assert.equal(ctx.largeBars.length,4500,"backend result is delivered without frontend pagination");
  assert.equal(calls.length,3,"one native request produces exactly one backend read");
  assert.equal(calls[2].q.countBack,4500);
  assert.equal(calls[2].q.from,1000);
  await vm.runInContext(`(async()=>{
    globalThis.windowPages=[];
    request=async()=>({bars:[{start:1000,end:61000,chart_time:1000,
      open:1,high:2,low:1,close:2}],history_boundary:false,window_limit:true,
      has_more:windowPages.length===0,indicators:[]});
    for(let index=0;index<2;index++)
      await feed.getBars({ticker:'MWP:YAHOO:22222222222222222222222222222222'},'1',
        {from:0,to:100,countBack:1,firstDataRequest:false},
        (bars,meta)=>windowPages.push({bars,meta}),error=>{throw Error(error)});
  })()`,ctx);
  assert.equal(ctx.windowPages[0].meta.noData,false,
    "an upstream rolling limit must not hide more cached history");
  assert.equal(ctx.windowPages[1].meta.noData,true,
    "pagination ends once the cached history is exhausted");
  await vm.runInContext(`(async()=>{
    const ident='YAHOO:11111111111111111111111111111111', ticker='MWP:'+ident;
    symbolPresentations.set(ident,{symbol:'AAPL',name:'苹果公司',exchange:'NasdaqGS'});
    globalThis.quoteEvents=[];globalThis.quoteReads=0;
    initialHistoryGate={promise:new Promise(resolve=>{globalThis.releaseQuoteGate=resolve})};
    request=async()=>{quoteReads++;return [{s:'ok',n:ticker,v:{short_name:'AAPL',lp:333}}]};
    feed.subscribeQuotes([ticker],[],rows=>quoteEvents.push(rows),'startup-details');
    await new Promise(resolve=>setTimeout(resolve,0));
  })()`,ctx);
  assert.equal(ctx.quoteEvents[0][0].v.short_name,"AAPL","startup details uses the original code");
  assert.equal(ctx.quoteEvents[0][0].v.lp,undefined,"startup naming must not invent a market price");
  assert.equal(ctx.quoteReads,0,"startup naming must preserve candle priority");
  await vm.runInContext('releaseQuoteGate();new Promise(resolve=>setTimeout(resolve,0))',ctx);
  assert.equal(ctx.quoteReads,1,"subscription loads the real quote after the first candle page");
  assert.ok(ctx.quoteEvents.some(rows=>rows[0].v.lp===333));
  console.log("Series: legacy compatibility, synthetic identity, search defaults, isolated provider feed passed");
})().catch(error=>{console.error(error);process.exitCode=1});
