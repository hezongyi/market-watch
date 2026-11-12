// Reproduce the vendor's getQuotes -> subscribeQuotes handshake with no HTTP reply.
const assert=require('node:assert/strict'),vm=require('node:vm'),path=require('node:path');
const sent=[],handlers={};let uuid=0;
const ctx=vm.createContext({document:{createElement:()=>({}),head:{append(){}}},URL,URLSearchParams,
 Map,Set,Promise,Date,Intl,Error,location:{search:'?parent=http://localhost'},parent:{postMessage:m=>sent.push(m)},
 crypto:{randomUUID:()=>String(++uuid)},addEventListener:(n,f)=>handlers[n]=f,setTimeout,clearTimeout,queueMicrotask});
for(const file of ['series.js','price-format.js','composite-display-batches.js','chart-runtime.js'])
 vm.runInContext(require('./fixtures/direct-runtime.cjs').read(path.resolve(__dirname,'../../advanced-host',file),'utf8'),ctx);
const run=s=>vm.runInContext(s,ctx),pause=()=>new Promise(r=>setTimeout(r,20));
(async()=>{
 run(`globalThis.rows=[];globalThis.initial=[];
 globalThis.local='MWC:'+'a'.repeat(64);globalThis.slow='MWP:OANDA:USD_CAD';
 for(const ticker of [local,slow])watchlistMetadata.set(ticker,{symbol:ticker===local?'EURUSD':'USDCAD',source:ticker===local?'composite':'oanda'});
 feed.getQuotes([slow,local],batch=>{initial.push(batch);feed.subscribeQuotes([slow,local],[],batch=>rows.push(...batch),'watchlist')},()=>{});`);
 await pause();
 assert.equal(run('initial.length'),1,'initial presentation must release the vendor subscription handshake without waiting for upstream HTTP');
 assert.equal(sent.filter(m=>m.type==='market-subscribe').length,2,'both quote streams start while the mixed snapshot is unresolved');
 assert(run('initial[0].every(r=>r.v.lp===undefined&&r.v.ch===undefined&&r.v.quote_time==null)'), 'no fake prices or timestamps');
 const quote=sent.find(m=>m.query?.op==='quotes');
 assert.equal(quote.query.args.snapshot_only,true,'subscription snapshot must use local results, not a duplicate supplier refresh');
 const sub=sent.find(m=>m.type==='market-subscribe'&&m.args.query.series_kind==='composite').args;
 await handlers.message({data:{type:'market-event',event:{listener:sub.listener,generation:sub.generation,sequence:1,
 type:'quotes',quotes:[{s:'ok',v:{lp:1.2,read_at:100,fetch_status:'ok'}}]}}});
 assert.equal(run('rows.at(-1).v.lp'),1.2,'local composite renders while a platform request remains unresolved');
 await handlers.message({data:{type:'market-event',event:{listener:sub.listener,generation:sub.generation,sequence:2,
 type:'quotes',quotes:[{s:'ok',v:{lp:1.3,ch:.1,chp:8.333,prev_close_price:1.2,read_at:200,fetch_status:'ok'}}]}}});
 await handlers.message({data:{type:'market-event',event:{listener:sub.listener,generation:sub.generation,sequence:3,
 type:'quotes',quotes:[{s:'ok',v:{lp:1.4,read_at:300,fetch_status:'ok'}}]}}});
 assert.equal(run('rows.at(-1).v.ch'),null,'a price without a reference must clear the vendor merge cache, not retain an old change');
 assert.equal(run('rows.at(-1).v.chp'),null);
 assert.equal(run('rows.at(-1).v.prev_close_price'),null);
 run(`globalThis.requestOnly='MWP:AKSHARE:'+'b'.repeat(32);
 watchlistMetadata.set(requestOnly,{symbol:'TEST',source:'akshare'});
 feed.subscribeQuotes([requestOnly],[],()=>{},'request-only');`);
 // Release only local snapshots; the request-only supplier must still refresh
 // without acquiring a streaming subscription or delaying the composite callback.
 for(const message of sent.filter(m=>m.query?.op==='quotes'&&m.query.args.snapshot_only)) {
  await handlers.message({data:{type:'result',id:message.id,result:[]}});
 }
 await pause();
 assert(sent.some(m=>m.query?.op==='quotes'&&m.query.args.snapshot_only===false),
   'request-only suppliers retain their actual refresh');
 assert(!sent.some(m=>m.type==='market-subscribe'&&m.args.query.instrument.startsWith('AKSHARE:')),
   'request-only suppliers do not acquire an unsupported stream');
 run('feed.unsubscribeQuotes("watchlist");feed.unsubscribeQuotes("request-only");globalThis.late=[];feed.getQuotes([local],batch=>late.push(batch),()=>{});workspaceEpoch++;');
 await pause();
 assert.equal(run('late.length'),0,'workspace switch fences delayed initial callbacks');
 console.log('Watchlist startup: streams start before HTTP, slow platforms do not block composite rows');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>run('for(const e of pending.values()){clearTimeout(e.timer);clearTimeout(e.cancellationTimer)}'));
