const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const path = require('node:path');
const sent = [], handlers = {};
let uuid = 0;
const parent = {postMessage: message => sent.push(message)};
const context = vm.createContext({URL, URLSearchParams, Map, Set, Promise, Date, Intl, Error,
  location:{search:'?parent=http://localhost'}, parent,
  crypto:{randomUUID:()=> 'listener-' + ++uuid},
  atob:s=>Buffer.from(s,'base64').toString('utf8'),
  addEventListener:(name,callback)=>{handlers[name]=callback},
  setTimeout, clearTimeout, queueMicrotask});
for (const file of ['series.js','bridge.js'])
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../../advanced-host',file),'utf8'),context);
const evaluate = source => vm.runInContext(source, context);
const deliver = event => handlers.message({source:parent,origin:'http://localhost',
  data:{channel:'mw-chart-v1',type:'market-event',event}});
(async()=>{
  evaluate(`globalThis.received=[]; globalThis.quotes=[];
    globalThis.symbol=MWSeries.encode('a'.repeat(64),'composite');
    lastHistory.set(symbol+'|1',60000);
    feed.subscribeBars({ticker:symbol},'1',bar=>received.push(bar),'chart',()=>{});`);
  const registration = sent.find(row=>row.type==='market-subscribe').args;
  assert.equal(registration.kind,'bars');
  const event = {listener:registration.listener,generation:registration.generation,
    sequence:1,type:'bars',bars:[{start:60000,end:120000,open:1,high:1.5,low:.9,close:1.1}],indicators:[]};
  await deliver(event);
  assert.equal(context.received.length,1);
  await deliver({...event,sequence:2,bars:[{...event.bars[0],high:1.2,low:1,close:1.12}]});
  assert.equal(context.received.at(-1).high,1.2,'confirmation may shrink the previous high');
  await deliver(event);
  await deliver({...event,sequence:3,generation:registration.generation+1});
  assert.equal(context.received.length,2,'same-bar old sequence and other generation are rejected');
  await evaluate('tick()');
  assert.equal(sent.filter(row=>row.type==='data'||row.type==='market').length,0,
    'normal maintenance tick performs no market query');
  evaluate("feed.unsubscribeBars('chart')");
  await deliver({...event,sequence:4});
  assert.equal(context.received.length,2,'late event after unsubscribe has no native callback');
  const cancellation=sent.find(row=>row.type==='market-unsubscribe').args;
  assert.equal(cancellation.generation,registration.generation);
  evaluate(`initialHistoryGate={promise:new Promise(()=>{})};
    feed.subscribeQuotes([symbol],[],rows=>quotes.push(...rows),'watchlist');`);
  const quoteRegistration=sent.filter(row=>row.type==='market-subscribe').at(-1).args;
  await deliver({listener:quoteRegistration.listener,generation:quoteRegistration.generation,
    sequence:1,type:'quotes',quotes:[{s:'ok',n:context.symbol,v:{lp:1.12,quote_ready:true}}]});
  assert.equal(context.quotes.at(-1).v.lp,1.12);
  evaluate("feed.unsubscribeQuotes('watchlist')");
  const beforePreparation=sent.filter(row=>row.type==='market-subscribe').length;
  evaluate(`feed.subscribeBars({ticker:'EURUSD'},'1',bar=>received.push(bar),'preparing',()=>{});`);
  const preparing=sent.filter(row=>row.type==='market-subscribe');
  assert.equal(preparing.length,beforePreparation+1,
    'empty first history must retain a preparation subscription');
  assert.equal(preparing.at(-1).args.history_accepted,false,
    'preparation subscription must fence bars until HTTP history is accepted');
  await evaluate(`(async()=>{
    request=async query=>query.op==='dataset' ? {ready:false,reason:'preparing'} :
      {bars:[],indicators:[],has_more:false};
    await feed.getBars({ticker:'EURUSD'},'1',{to:1000,countBack:160,firstDataRequest:true},
      ()=>{},error=>{throw Error(error)});
    globalThis.emptyAccepted=marketHistoryState.get('EURUSD|1|');
  })()`);
  assert.equal(context.emptyAccepted?.empty,true,
    'accepted empty history must retain its preparation state');
  const preparationRegistration=sent.filter(row=>row.type==='market-subscribe').at(-1).args;
  const beforeRecovery=sent.filter(row=>row.type==='market-subscribe').length;
  await evaluate(`(async()=>{
    reloadHistory=async()=>{
      request=async query=>query.op==='dataset' ? {ready:true,start:60000,revision:2} :
        {bars:[{start:60000,end:120000,open:1,high:2,low:1,close:2}],indicators:[],has_more:false};
      await feed.getBars({ticker:'EURUSD'},'1',{to:1000,countBack:160,firstDataRequest:true},
        ()=>{},error=>{throw Error(error)});
      return true;
    };
  })()`);
  await deliver({listener:preparationRegistration.listener,generation:preparationRegistration.generation,
    sequence:1,type:'reset',reason:'initial_history_ready'});
  const restoredRegistration=sent.filter(row=>row.type==='market-subscribe').at(-1).args;
  assert.equal(restoredRegistration.history_accepted,true);
  assert.equal(restoredRegistration.query.dataset_start,60000);
  assert.equal(restoredRegistration.cursor,60000);
  assert.equal(sent.filter(row=>row.type==='market-subscribe').length,beforeRecovery+1,
    'history recovery must publish one accepted generation after the reload completes');
  await evaluate(`reloadHistory=async()=>{
    lastHistory.set('EURUSD|1',30000);
    acceptMarketHistory('EURUSD','1',{bars:[{start:30000,end:90000}],as_of:Date.now()});
    return true;
  };`);
  await deliver({listener:restoredRegistration.listener,generation:restoredRegistration.generation,
    sequence:1,type:'reset',reason:'tail_retracted'});
  const retractedRegistration=sent.filter(row=>row.type==='market-subscribe').at(-1).args;
  assert.equal(retractedRegistration.cursor,30000,
    'recovery must accept an authoritative shorter tail without restoring the old cursor');
  evaluate("feed.unsubscribeBars('preparing')");
  await evaluate(`(async()=>{
    globalThis.rejectedTicker=MWSeries.encode('b'.repeat(64),'composite');
    request=async()=>({bars:[{start:120000,end:180000,open:1,high:2,low:1,close:2}],
      indicators:[],has_more:false});
    await feed.getBars({ticker:rejectedTicker},'1',{to:1000,countBack:160,firstDataRequest:true},
      ()=>false,error=>{throw Error(error)});
    feed.subscribeBars({ticker:rejectedTicker},'1',()=>{},'rejected',()=>{});
  })()`);
  const rejectedRegistration=sent.filter(row=>row.type==='market-subscribe').at(-1).args;
  assert.equal(rejectedRegistration.history_accepted,false,
    'a rejected native history callback must not authorize realtime cache updates');
  evaluate("feed.unsubscribeBars('rejected')");
  await evaluate(`(async()=>{
    globalThis.filteredTicker=MWSeries.encode('c'.repeat(64),'composite');
    await feed.getBars({ticker:filteredTicker},'1',{to:60,countBack:160,firstDataRequest:true},
      ()=>{},error=>{throw Error(error)});
    feed.subscribeBars({ticker:filteredTicker},'1',()=>{},'filtered',()=>{});
  })()`);
  assert.equal(sent.filter(row=>row.type==='market-subscribe').at(-1).args.history_accepted,false,
    'bars excluded from the native history window must not mark an empty callback as loaded');
  evaluate("feed.unsubscribeBars('filtered')");
  console.log('Unified native callbacks: generation/order fences, authoritative extremes, quote delivery and no polling passed');
})().catch(error=>{console.error(error);process.exitCode=1});
