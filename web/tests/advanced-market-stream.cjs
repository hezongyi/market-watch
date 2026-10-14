const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const path = require('node:path');
const sent = [], handlers = {};
let uuid = 0;
const parent = {postMessage: message => sent.push(message)};
const context = vm.createContext({document:{createElement:()=>({}),head:{append:()=>{}}},URL, URLSearchParams, Map, Set, Promise, Date, Intl, Error,
  location:{search:'?parent=http://localhost'}, parent,
  crypto:{randomUUID:()=> 'listener-' + ++uuid},
  atob:s=>Buffer.from(s,'base64').toString('utf8'),
  addEventListener:(name,callback)=>{handlers[name]=callback},
  setTimeout, clearTimeout, queueMicrotask});
for (const file of ['series.js','price-format.js','composite-display-batches.js','bridge.js'])
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
  evaluate(`globalThis.providerTicker='MWP:EURUSD';
    lastHistory.set(providerTicker+'|1|',60000);
    marketHistoryState.set(providerTicker+'|1|',{accepted:true,first:60000,last:60000,observed_at:1000});
    feed.subscribeBars({ticker:providerTicker},'1',bar=>received.push(bar),'provider-accepted',()=>{});`);
  const platform=sent.filter(row=>row.type==='market-subscribe').at(-1).args;
  const receipt={start:60000,fingerprint:'a'.repeat(64)};
  await deliver({listener:platform.listener,generation:platform.generation,result_epoch:'epoch',
    sequence:1,type:'bars',bars:event.bars,provider_acceptance:[receipt]});
  const acceptedMessage=sent.filter(row=>row.type==='market-accept').at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(acceptedMessage.args.provider_acceptance)),[receipt]);
  assert.equal(acceptedMessage.args.generation,platform.generation);
  const beforeAck=sent.filter(row=>row.type==='market-accept').length;
  await deliver({listener:platform.listener,generation:platform.generation+1,result_epoch:'epoch',
    sequence:2,type:'bars',bars:event.bars,provider_acceptance:[receipt]});
  assert.equal(sent.filter(row=>row.type==='market-accept').length,beforeAck,'stale generation cannot acknowledge');
  evaluate(`subscriptions.get('provider-accepted').cb=()=>false;`);
  await deliver({listener:platform.listener,generation:platform.generation,result_epoch:'epoch',
    sequence:2,type:'bars',bars:event.bars,provider_acceptance:[receipt]});
  assert.equal(sent.filter(row=>row.type==='market-accept').length,beforeAck,'rejected callback cannot acknowledge');
  evaluate(`subscriptions.get('provider-accepted').cb=()=>{throw Error('native callback failed')};`);
  await assert.rejects(()=>deliver({listener:platform.listener,generation:platform.generation,result_epoch:'epoch',
    sequence:3,type:'bars',bars:event.bars,provider_acceptance:[receipt]}),/native callback failed/);
  assert.equal(sent.filter(row=>row.type==='market-accept').length,beforeAck,'throwing callback cannot acknowledge');
  evaluate("feed.unsubscribeBars('provider-accepted')");
  evaluate(`{
    const count=200000;
    let reads=0;
    const bars=Array.from({length:count},(_,index)=>({
      get start(){
        if(++reads>count*10)throw Error('History acceptance repeatedly scans the full page');
        return index*60000;
      },chart_time:index*60000+1000,open:1,high:2,low:0,close:1,
    }));
    const receipts=Array.from({length:2048},(_,index)=>({
      start:(count-2048+index)*60000,fingerprint:'b'.repeat(64),
    }));
    acceptMarketHistory('MWP:WIDE','1',{bars,as_of:1000,provider_acceptance:receipts},'',
      bars.map(bar=>({time:bar.chart_time})));
    const state=marketHistoryState.get('MWP:WIDE|1|');
    if(state.provider_acceptance.length!==2048)throw Error('Wide history lost accepted receipts');
    if(state.first!==0 || state.last!==(count-1)*60000)throw Error('Wide history was truncated');
    const binding=indicatorBindings.get('MWP:WIDE|1');
    if(binding.firstStart!==0 || binding.lastStart!==(count-1)*60000)
      throw Error('Wide history lost indicator input bounds');
    acceptMarketHistory('MWP:PARTIAL','1',{bars:bars.slice(-2),as_of:1000,
      provider_acceptance:receipts.slice(-2)},'',[{time:bars.at(-1).chart_time}]);
    const partial=marketHistoryState.get('MWP:PARTIAL|1|').provider_acceptance;
    if(partial.length!==1 || partial[0].start!==(count-1)*60000)
      throw Error('Receipt filtering must use accepted chart times and input starts');
  }`);
  context.indicatorTicker='MWPY_'+Buffer.from(JSON.stringify({symbol:context.symbol,
    spec:{name:'EMA',params:{period:2}},key:'value'})).toString('base64');
  evaluate(`lastHistory.set(indicatorTicker+'|1',60000);
    feed.subscribeBars({ticker:indicatorTicker},'1',bar=>received.push(bar),'indicator',()=>{});`);
  const indicatorRegistration=sent.filter(row=>row.type==='market-subscribe').at(-1).args;
  await deliver({listener:indicatorRegistration.listener,generation:indicatorRegistration.generation,
    sequence:1,type:'bars',bars:event.bars,
    indicators:[{series:[{key:'value',values:[{time:60000,value:1.2}]}]}]});
  assert.equal(context.received.at(-1).close,1.2,
    'indicator callback applies changed study values even when its OHLC is unchanged');
  evaluate("feed.unsubscribeBars('indicator')");
  const cancellation=sent.find(row=>row.type==='market-unsubscribe').args;
  assert.equal(cancellation.generation,registration.generation);
  evaluate(`initialHistoryGate={promise:new Promise(()=>{})};
    feed.subscribeQuotes([symbol],[],rows=>quotes.push(...rows),'watchlist');`);
  const quoteRegistration=sent.filter(row=>row.type==='market-subscribe').at(-1).args;
  await deliver({listener:quoteRegistration.listener,generation:quoteRegistration.generation,
    sequence:1,type:'quotes',quotes:[{s:'ok',n:context.symbol,v:{lp:1.12,quote_ready:true}}]});
  assert.equal(context.quotes.at(-1).v.lp,1.12);
  await deliver({listener:quoteRegistration.listener,generation:quoteRegistration.generation,
    sequence:2,type:'reset',reason:'binding_changed'});
  const quoteRebound=sent.filter(row=>row.type==='market-subscribe').at(-1).args;
  assert.ok(quoteRebound.generation>quoteRegistration.generation);
  await deliver({listener:quoteRegistration.listener,generation:quoteRegistration.generation,
    sequence:3,type:'quotes',quotes:[{s:'ok',n:context.symbol,v:{lp:9}}]});
  assert.equal(context.quotes.at(-1).v.lp,1.12,'quote reset rejects the previous revision generation');
  await deliver({listener:quoteRebound.listener,generation:quoteRebound.generation,
    sequence:1,type:'quotes',quotes:[{s:'ok',n:context.symbol,v:{lp:1.13}}]});
  assert.equal(context.quotes.at(-1).v.lp,1.13,'rebound quotes reach the current native callback');
  evaluate("feed.unsubscribeQuotes('watchlist')");
  evaluate(`symbolPresentations.set('YAHOO:AAPL', {source:'yahoo',asset_type:'EQUITY',display_precision:8});
    feed.subscribeQuotes(['MWP:YAHOO:AAPL'],[],rows=>quotes.push(...rows),'stock');`);
  const stockRegistration=sent.filter(row=>row.type==='market-subscribe').at(-1).args;
  await deliver({listener:stockRegistration.listener,generation:stockRegistration.generation,
    sequence:1,type:'quotes',quotes:[{s:'ok',n:'MWP:YAHOO:AAPL',v:{lp:252.29456789,ch:0.01456789}}]});
  assert.equal(context.quotes.at(-1).v.mw_display_pricescale,100,
    'streamed stock quotes must retain the same presentation scale as the initial snapshot');
  assert.equal(context.quotes.at(-1).v.lp,252.29456789,'stream presentation must preserve source price');
  await deliver({listener:stockRegistration.listener,generation:stockRegistration.generation,
    sequence:2,type:'quotes',quotes:[{s:'ok',n:'MWP:YAHOO:AAPL',v:{lp:0.001234}}]});
  assert.equal(context.quotes.at(-1).v.mw_display_pricescale,1e5,
    'streamed low-price updates must adapt precision without rounding source data');
  evaluate("feed.unsubscribeQuotes('stock')");
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
        {bars:[{start:60000,end:120000,open:1,high:2,low:1,close:2}],indicators:[],has_more:false,
          history_check:{next_revision:'accepted-prefix',next_tail_revision:'accepted-tail'}};
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
  assert.equal(restoredRegistration.history_revision,'accepted-prefix');
  assert.equal(restoredRegistration.history_tail_revision,'accepted-tail',
    'accepted HTTP tail credential must accompany the restored subscription');
  assert.equal(sent.filter(row=>row.type==='market-subscribe').length,beforeRecovery+1,
    'history recovery must publish one accepted generation after the reload completes');
  await deliver({listener:restoredRegistration.listener,generation:restoredRegistration.generation,
    sequence:1,type:'bars',bars:[{start:60000,end:120000,open:1,high:2,low:1,close:2}],
    history_revision:'delivered-prefix',history_tail_revision:'delivered-tail'});
  assert.equal(evaluate("marketHistoryState.get('EURUSD|1|').history_tail_revision"),'delivered-tail',
    'accepted realtime delivery must retain its latest tail credential for re-registration');
  await evaluate(`reloadHistory=async()=>{
    lastHistory.set('EURUSD|1',30000);
    acceptMarketHistory('EURUSD','1',{bars:[{start:30000,end:90000}],as_of:Date.now()});
    return true;
  };`);
  await deliver({listener:restoredRegistration.listener,generation:restoredRegistration.generation,
    sequence:2,type:'reset',reason:'tail_retracted'});
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
  evaluate(`ready=true; loading=false;
    widget={chartsCount:()=>1,chart:()=>({symbol:()=> 'EURUSD',resolution:()=> '5',getAllStudies:()=>[]})};
    lastHistory.set('EURUSD|1',60000);
    feed.subscribeBars({ticker:'EURUSD'},'1',()=>{throw Error('Invisible old-period callback')},'cached-period',()=>{});
    globalThis.invisibleRecovery=0;
    reloadHistory=async()=>{invisibleRecovery++;return true;};`);
  const cached=sent.filter(row=>row.type==='market-subscribe').at(-1).args;
  const beforeInvisible=sent.filter(row=>row.type==='market-subscribe').length;
  await deliver({listener:cached.listener,generation:cached.generation,sequence:1,
    type:'reset',reason:'initial_history_ready'});
  assert.equal(context.invisibleRecovery,0,'A cached old native period must not trigger recovery after the visible period changes');
  assert.equal(sent.filter(row=>row.type==='market-subscribe').length,beforeInvisible,
    'An invisible native cache must not re-register its retired demand');
  assert.ok(sent.some(row=>row.type==='market-unsubscribe' && row.args.listener===cached.listener));
  evaluate("feed.unsubscribeBars('cached-period')");
  console.log('Unified native callbacks: generation/order fences, authoritative extremes, quote delivery and no polling passed');
})().catch(error=>{console.error(error);process.exitCode=1});
