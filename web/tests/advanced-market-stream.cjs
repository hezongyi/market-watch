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
  console.log('Unified native callbacks: generation/order fences, authoritative extremes, quote delivery and no polling passed');
})().catch(error=>{console.error(error);process.exitCode=1});
