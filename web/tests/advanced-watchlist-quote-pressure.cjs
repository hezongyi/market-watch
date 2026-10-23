// Real native quote subscriptions and price datafeed share the production bridge.
// A slow read plus repeated subscription replacement must not reject current prices.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const handlers = [], messages = [];
const ctx = vm.createContext({URL, URLSearchParams, Map, Promise, Date, Intl, Error,
  document:{createElement:()=>({}),head:{append:()=>{}}},
  location:{search:'?parent=http://localhost'}, parent:{postMessage:m=>messages.push(m)},
  crypto:{randomUUID:()=> 'quote-pressure'},
  addEventListener:(name,fn)=>{if(name==='message')handlers.push(fn);},
  setTimeout,clearTimeout,queueMicrotask,requestAnimationFrame:fn=>setImmediate(fn)});
for(const file of ['series.js','price-format.js','composite-display-batches.js','bridge.js'])
  vm.runInContext(fs.readFileSync('../advanced-host/'+file,'utf8'),ctx);
const run = code => vm.runInContext(code,ctx);
const flush = async () => { for(let n=0;n<8;n++) await new Promise(r=>setImmediate(r)); };
(async()=>{
  try {
    run(`
      globalThis.prices=[];globalThis.failures=[];globalThis.quoteCallbacks=[];
      for(let i=0;i<4;i++) void request({name:'slow'+i}).catch(()=>{});
      for(let i=0;i<65;i++) feed.subscribeQuotes(['MWP:EURUSD'],[],
        ()=>quoteCallbacks.push(i),'native-details');
      globalThis.price=feed.getBars({ticker:'MWP:EURUSD'},'60',
        {from:1,to:100,countBack:1,firstDataRequest:true},
        bars=>prices.push(bars.length),error=>failures.push(String(error)));
    `);
    await flush();
    assert.equal(run('failures.length'),0,
      'replaced quote subscriptions must not fill the queue and fail the current first-screen getBars');
    assert.ok(run('requests.length')<=2,
      'only the current quote subscription and current price read may remain queued');
    const completed=new Set();
    for(let turn=0;turn<8;turn++) {
      const sent=messages.find(m=>['data','market'].includes(m.type)&&!completed.has(m.id));
      if(!sent)break;
      completed.add(sent.id);
      const result=sent.query?.op==='quotes' ? [{n:'MWP:EURUSD',s:'ok',v:{lp:1}}] :
        {bars:[{start:1000,end:2000,chart_time:1000,open:1,high:2,low:0,close:1,complete:true}],history_boundary:false};
      await handlers[0]({source:ctx.parent,origin:'http://localhost',data:{
        channel:'mw-chart-v1',type:'result',id:sent.id,result}});
      await flush();
    }
    await ctx.price;
    assert.equal(run('prices.length'),1,'current price callback completes exactly once');
    assert.equal(run('failures.length'),0);
    assert.equal(run('quoteCallbacks.some(i=>i!==64)'),false,
      'replaced subscriptions never receive a late quote callback');
    run(`
      globalThis.sharedCallbacks=[];
      for(let i=0;i<4;i++) void request({name:'slow-shared'+i}).catch(()=>{});
      for(let i=0;i<65;i++) feed.getQuotes(['MWP:EURUSD'],
        rows=>sharedCallbacks.push(rows),()=>{},undefined,true);
      globalThis.sharedPrice=feed.getBars({ticker:'MWP:EURUSD'},'60',
        {from:1,to:100,countBack:1,firstDataRequest:true},
        bars=>prices.push(bars.length),error=>failures.push(String(error)));
    `);
    await flush();
    assert.equal(run('failures.length'),0,
      'concurrent live quote consumers for one snapshot must not exhaust admission and fail prices');
    assert.ok(run('requests.length')<=2,'identical concurrent quote reads share one queued operation');
    const quoteRequestsBefore=messages.filter(m=>m.query?.op==='quotes').length;
    for(let turn=0;turn<8;turn++) {
      const sent=messages.find(m=>['data','market'].includes(m.type)&&!completed.has(m.id));
      if(!sent)break;
      completed.add(sent.id);
      await handlers[0]({source:ctx.parent,origin:'http://localhost',data:{channel:'mw-chart-v1',type:'result',id:sent.id,
        result:sent.query?.op==='quotes' ? [{n:'MWP:EURUSD',s:'ok',v:{lp:2}}] :
          {bars:[{start:1000,end:2000,chart_time:1000,open:1,high:2,low:0,close:1,complete:true}],history_boundary:false}}});
      await flush();
    }
    await ctx.sharedPrice;
    assert.equal(messages.filter(m=>m.query?.op==='quotes').length-quoteRequestsBefore,1,
      'sixty-five live quote callers perform one snapshot read');
    assert.equal(run('sharedCallbacks.length'),65,'each live quote consumer receives its own completion');
    assert.equal(run('prices.length'),2);
    assert.equal(run('failures.length'),0);
    console.log('Watchlist quote pressure: stale subscriptions and duplicate live snapshots cannot strand current prices');
  } finally {
    run('for(const e of pending.values()){clearTimeout(e.timer);clearTimeout(e.cancellationTimer);}');
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
