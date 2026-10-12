// Exercise the production quote event branch and polling loop, including fences.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('advanced-host/bridge.js','utf8');
const row={s:'ok',n:'A',v:{lp:4000,description_base:'A',market_session:'closed',session_reason:'周末',
  data_start:1791579540000,data_end:1791579600000,quote_time:null,time_type:'source_m1',read_at:200,revision_id:'bound'}};
let delivered=[];
const entry={listener:'fixture',ticker:'A',generation:1,sequence:0};
const sub={symbols:['A'],listeners:[entry],cb:rows=>delivered.push(rows)};
const context={Intl,Date,Number,compactQuote:null,widget:null,quoteSnapshotRows:new Map([['A',row]]),quoteResetTokens:new Map(),
  quoteSubscriptions:new Map([['watchlist',sub]]),symbolPresentations:new Map(),decode:t=>({symbol:t}),
  send:()=>{},clientId:"fixture",marketGeneration:1,marketQuery:()=>({}),marketPollingFallback:true,workspaceEpoch:1,
  pendingHistory:new Map(),subscriptions:new Map(),polling:false,chartQuotePresentation:r=>r,
  seriesPresentationRows:()=>[],offerHistoryRetry:()=>{},flushProviderCorrections:async()=>{}};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('function quoteTimeText'),source.indexOf('function bindTimezoneEvents')),context);
vm.runInContext(source.slice(source.indexOf('function presentationFor'),source.indexOf('const alertSourceMetadata')),context);
const start=source.indexOf('    if(quote) {',source.indexOf("if(m.type==='market-event')"));
vm.runInContext('function eventHandler(quote,event){'+source.slice(start,source.indexOf('    const sub=',start))+'}',context);
function event(values){context.eventHandler(sub,{listener:'fixture',generation:entry.generation,sequence:entry.sequence+1,...values});}
event({type:'status',status:'error',error:'retry'});
assert.equal(delivered.length,1,'stream failure must update visible details');
assert.match(delivered.at(-1)[0].v.description,/更新失败，保留上次数据/);
assert.equal(delivered.at(-1)[0].v.lp,row.v.lp);assert.equal(delivered.at(-1)[0].v.data_start,row.v.data_start);
assert.equal(delivered.at(-1)[0].v.revision_id,'bound');
event({type:'quotes',quotes:[{...row,v:{...row.v,fetch_status:'ok',read_at:201}}]});
assert.doesNotMatch(delivered.at(-1)[0].v.description,/更新失败/);
const before=delivered.length;
event({type:'status',status:'error',generation:0});assert.equal(delivered.length,before,'old generation rejected');
context.quoteSnapshotRows.delete('A');event({type:'status',status:'error'});
assert.match(delivered.at(-1)[0].v.description,/更新失败，暂无成功行情/);
assert.equal(delivered.at(-1)[0].v.lp,undefined);assert.equal(delivered.at(-1)[0].v.data_start,undefined);
// A worker without the API process's cache can return a failed quote row.
const errorRow={s:'error',n:'A',v:{fetch_status:'fetch_failed',read_at:201,data_start:null,quote_time:null}};
context.quoteSnapshotRows.set('A',row);
event({type:'quotes',quotes:[errorRow]});
assert.equal(delivered.at(-1)[0].v.lp,4000);
assert.equal(delivered.at(-1)[0].v.data_start,row.v.data_start);
assert.equal(delivered.at(-1)[0].v.revision_id,'bound');
assert.match(delivered.at(-1)[0].v.description,/更新失败，保留上次数据/);
event({type:'quotes',quotes:[row]});
assert.doesNotMatch(delivered.at(-1)[0].v.description,/更新失败/);
context.rememberQuoteRows([{...errorRow,v:{...errorRow.v,revision_id:'different'}}]);
assert.equal(context.quoteSnapshotRows.get('A').v.lp,undefined,'different revision cannot borrow a price');
context.quoteSnapshotRows.set('A',{...row,v:{...row.v,time_type:'fixed_history'}});
event({type:'status',status:'error'});
assert.match(delivered.at(-1)[0].v.description,/历史数据时间/);
assert.match(delivered.at(-1)[0].v.description,/更新失败，保留上次数据/);
event({type:'quotes',quotes:[{...row,v:{...row.v,time_type:'fixed_history'}}]});
assert.doesNotMatch(delivered.at(-1)[0].v.description,/更新失败/);
vm.runInContext(source.slice(source.indexOf('async function tick()'),source.indexOf('async function tick()')+source.slice(source.indexOf('async function tick()')).indexOf('\nfunction ')),context);
(async()=>{
 context.quoteSnapshotRows.set('A',row);context.request=()=>Promise.reject(Error('poll failed'));
 await context.tick();assert.match(delivered.at(-1)[0].v.description,/更新失败，保留上次数据/);
 let shared;
 context.quoteSubscriptions.set('shared',{symbols:['A'],listeners:[],cb:rows=>{shared=rows;}});
 context.quoteSnapshotRows.set('A',row);
 await context.tick();assert.match(shared[0].v.description,/更新失败，保留上次数据/);
 context.quoteSubscriptions.delete('shared');
 context.request=async()=>[{...row,v:{...row.v,fetch_status:'ok'}}];
 await context.tick();assert.doesNotMatch(delivered.at(-1)[0].v.description,/更新失败/);
 let reject;context.request=()=>new Promise((resolve,fail)=>reject=fail);
 const staleFailure=context.tick();
 const newer={...row,v:{...row.v,lp:4001,read_at:202}};
 context.rememberQuoteRows([newer]);const previousCount=delivered.length;
 reject(Error('late failure'));await staleFailure;
 assert.equal(context.quoteSnapshotRows.get('A').v.lp,4001);
 assert.equal(context.quoteSnapshotRows.get('A').v.fetch_status,undefined);
 assert.equal(delivered.length,previousCount,'late failure cannot overwrite a newer stream snapshot');
 let finish;context.request=()=>new Promise(resolve=>finish=resolve);const pending=context.tick();
 context.quoteSubscriptions.set('watchlist',{symbols:['A'],listeners:[],cb:()=>{throw Error('cancelled poll touched replacement');}});
 finish([row]);await pending;
 context.quoteSubscriptions.set('watchlist',sub);
 for(const rejected of [false,true]) {
   context.quoteSnapshotRows.delete('A');const previousCount=delivered.length;
   let reject;context.request=()=>new Promise((resolve,fail)=>{finish=resolve;reject=fail;});
   const beforeReset=context.tick();event({type:'reset'});
   if(rejected)reject(Error('before reset'));else finish([row]);
   await beforeReset;
   assert.equal(context.quoteSnapshotRows.has('A'),false,'empty-cache reset rejects old polling result');
   assert.equal(delivered.length,previousCount,'old polling result cannot callback after reset');
 }
 console.log('Quote failures: stream/poll retention, recovery, first failure and cancelled generation passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
