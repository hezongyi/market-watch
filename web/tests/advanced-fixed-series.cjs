const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const events=[];
const ctx=vm.createContext({URL,URLSearchParams,Map,Set,Promise,Date,Intl,Error,
 location:{search:'?parent=http://localhost'},parent:{postMessage:m=>events.push(m)},
 crypto:{randomUUID:()=> 'test'},atob:s=>Buffer.from(s,'base64').toString('utf8'),
 addEventListener(){},setTimeout,clearTimeout,queueMicrotask});
for(const file of ['series.js','bridge.js'])vm.runInContext(fs.readFileSync('../advanced-host/'+file,'utf8'),ctx);
(async()=>{
 await vm.runInContext(`(async()=>{
  globalThis.calls=[];
  const version='abcdefab-1234-1234-1234-123456789abc';
  globalThis.fixedTicker=MWSeries.encode(version,'history');
  globalThis.compositeTicker=MWSeries.encode('a'.repeat(64),'composite');
  for(const ticker of [fixedTicker,compositeTicker]) {
    if(!MWSeries.same(ticker,ticker.toUpperCase()))throw Error('Native uppercase identity changed');
    request=async(q,type)=>{
      calls.push({q,type});
      if(q.op)throw Error('fixed chart incorrectly entered legacy managed maintenance');
      return {bars:[{start:100000,end:160000,open:1,high:2,low:1,close:2}],
        indicators:[],has_more:false,revision_id:'fixed-revision',input_revision:3};
    };
    await feed.getBars({ticker:ticker.toUpperCase()},'1',{to:1000,countBack:160,firstDataRequest:true},
      (bars,meta)=>{globalThis.page={bars,meta}},e=>{throw Error(e)});
  }
 })()`,ctx);
 assert.equal(ctx.page.bars.length,1);assert.equal(ctx.page.meta.noData,true);
 const calls=vm.runInContext('calls',ctx);
 assert.equal(calls.length,2);assert.equal(calls[0].q.series_kind,'history');
 assert.equal(calls[0].q.instrument,'abcdefab-1234-1234-1234-123456789abc');
 assert.equal(calls[0].q.client,undefined);
 assert.equal(calls[1].q.series_kind,'composite');assert.equal(calls[1].q.client,'test');
 assert.equal(events.filter(e=>e.type==='maintenance-required').length,0);
 await vm.runInContext(`(async()=>{
   let rejected=false;
   request=async()=>{throw Error('unsupported saved watchlist entry')};
   await feed.resolveSymbol('MWP:EURUSD',()=>{throw Error('Unexpected success')},()=>{rejected=true});
   if(!rejected)throw Error('Native requesting surface must receive resolve failure');
   symbolPresentations.set('a'.repeat(64),{symbol:'EURUSD',name:'欧元/美元',source:'composite'});
   initialHistoryGate={promise:new Promise(()=>{})};
   globalThis.quoteRows=[];
   feed.subscribeQuotes([compositeTicker.toUpperCase()],[],rows=>quoteRows.push(...rows),'composite-title');
   await new Promise(resolve=>setTimeout(resolve,0));
 })()`,ctx);
 assert.equal(events.filter(e=>e.type==='error').length,0,
   'A failing watchlist resolve must not open an unrelated workspace modal');
 assert.equal(ctx.quoteRows[0].v.short_name,'EURUSD');
 assert.equal(ctx.quoteRows[0].v.lp,undefined,'Naming a composite must not fabricate a quote');
 assert.equal(ctx.quoteRows[0].n,ctx.compositeTicker.toUpperCase());
 console.log('Fixed native feed: uppercase identity, pure history, composite demand, no legacy maintenance passed');
})().catch(e=>{console.error(e);process.exitCode=1});
