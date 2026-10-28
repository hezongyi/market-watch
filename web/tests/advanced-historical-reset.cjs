// Exercise the unified event handler and the actual historical reload dispatcher.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const {read} = require('./fixtures/direct-runtime.cjs');
const handlers = [], messages = [];
const ctx = vm.createContext({URLSearchParams, Map, Set, Promise, Date, Intl, Error,
  location:{search:''}, parent:{postMessage:value=>messages.push(value)},
  crypto:{randomUUID:()=> 'listener'}, setTimeout, clearTimeout, queueMicrotask,
  addEventListener:(name,fn)=>{if(name==='message')handlers.push(fn);}});
for(const file of ['series.js','composite-display-batches.js','chart-runtime.js'])
  vm.runInContext(read(path.join(__dirname,'../../advanced-host',file),'utf8'),ctx);
const evaluate=code=>vm.runInContext(code,ctx);
const deliver=event=>handlers[0]({data:{type:'market-event',event}});
(async()=>{
  evaluate(`globalThis.reloads=0;globalThis.delivered=[];globalThis.currentRes='5';
    ready=true;
    const chart={symbol:()=> 'MWP:BTCUSDT',resolution:()=>currentRes,getAllStudies:()=>[],
      getTimeScale:()=>({width:()=>960,barSpacing:()=>6})};
    widget={chartsCount:()=>1,chart:()=>chart};
    globalThis.MWNativeNavigation={historical:()=>true,coverage:()=>({last:200000}),
      chartWindow:()=>({id:'historical'}),busy:()=>false,interacting:()=>false,
      refreshChartWindow:async()=>{reloads++;
        acceptMarketHistory('MWP:BTCUSDT','5',{bars:[{start:100000,end:200000}],as_of:2000},'historical');
        return true;}};
    acceptMarketHistory('MWP:BTCUSDT','5',{bars:[{start:100000,end:200000}],as_of:1000},'historical');
    feed.subscribeBars({ticker:'MWP:BTCUSDT',mw_window:'historical'},'5',bar=>delivered.push(bar),'native',()=>{});`);
  const initial=messages.filter(row=>row.type==='market-subscribe').at(-1).args;
  assert.equal(initial.historical,true);
  await deliver({listener:initial.listener,generation:initial.generation,sequence:1,
    type:'status',status:'history_current'});
  assert.equal(ctx.reloads,0,'unchanged historical proof must not reload');
  await deliver({listener:initial.listener,generation:initial.generation,sequence:2,
    type:'bars',bars:[{start:9000000,end:9300000,open:1,high:2,low:1,close:2}]});
  assert.equal(ctx.delivered.length,0,'latest bars cannot cross a historical window gap');
  await deliver({listener:initial.listener,generation:initial.generation,sequence:3,
    type:'reset',reason:'history_changed'});
  assert.equal(ctx.reloads,1,'verified historical correction must dispatch a window reload');
  const rebound=messages.filter(row=>row.type==='market-subscribe').at(-1).args;
  assert.ok(rebound.generation>initial.generation);
  await deliver({listener:initial.listener,generation:initial.generation,sequence:99,
    type:'reset',reason:'history_changed'});
  assert.equal(ctx.reloads,1,'old generation cannot reload the new window');
  evaluate("currentRes='1'");
  await deliver({listener:rebound.listener,generation:rebound.generation,sequence:1,
    type:'reset',reason:'history_changed'});
  assert.equal(ctx.reloads,1,'hidden old-period cache cannot reload the current chart');
  evaluate("feed.unsubscribeBars('native')");
  console.log('PASS: unified historical proof, reset/reload, gap and generation fences');
})().catch(error=>{console.error(error);process.exitCode=1});
