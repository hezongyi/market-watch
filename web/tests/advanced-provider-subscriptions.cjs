const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const source=ts.transpileModule(fs.readFileSync('src/advanced/providerSubscriptions.ts','utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const moduleExports={};
const timers=new Map();let timerId=0;
vm.runInNewContext(source,{exports:moduleExports,Map,Promise,JSON,
 setTimeout:cb=>{const id=++timerId;timers.set(id,cb);return id},clearTimeout:id=>timers.delete(id)});
const factory=moduleExports.providerSubscriptions;
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const watchdog=setTimeout(()=>{console.error('Provider subscription test timed out');process.exit(1)},10000);
(async()=>{
  const calls=[],streams=[],received=[],errors=[];
  let release;
  const registration=new Promise(resolve=>release=resolve);
  const transport=factory(async(path,args)=>{
    calls.push({path,args});
    if(path.endsWith('/subscribe'))await registration;
  },client=>{
    const stream={client,closed:false,close(){this.closed=true},onmessage:null};
    streams.push(stream);return stream;
  },event=>received.push(event),error=>errors.push(error));
  const first=transport.subscribe({client:'c',listener:'one'});
  await flush();
  assert.equal(calls.length,1);
  const cancel=transport.unsubscribe({client:'c',listener:'one'});
  await flush();
  assert.equal(calls.length,1,'cancel waits for the in-flight registration');
  release();await Promise.all([first,cancel]);
  assert.deepEqual(calls.map(c=>c.path),['/charts/provider/subscribe','/charts/provider/unsubscribe']);
  assert.equal(streams.length,0,'late registration never starts an abandoned stream');
  await transport.subscribe({client:'c',listener:'two'});
  await transport.subscribe({client:'c',listener:'three',history_tail_revision:'http-tail'});
  assert.equal(streams.length,1,'same client shares one event stream');
  streams[0].onmessage({data:JSON.stringify({listener:'two',type:'bars'})});
  assert.equal(received.length,1);
  await transport.unsubscribe({client:'c',listener:'two'});
  assert.equal(streams[0].closed,false,'another listener remains active');
  streams[0].onmessage({data:JSON.stringify({listener:'three',type:'bars',cursor:12000,revision:3,as_of:1000,
    loaded_before:12000,history_revision:'loaded-prefix',history_tail_revision:'delivered-tail',
    initial_input_revision:4})});
  streams[0].onmessage({data:JSON.stringify({listener:'three',type:'status',sequence:2,
    initial_input_revision:5,dependency_observed_at:2000,dependency_revision:'accepted-prefix'})});
  streams[0].onopen({});await flush();await flush();
  const resumed=calls.filter(c=>c.path.endsWith('/subscribe')&&c.args.listener==='three').at(-1);
  assert.equal(resumed.args.cursor,12000,'reconnect restores the last delivered cursor');
  assert.equal(resumed.args.revision,3);
  assert.equal(resumed.args.loaded_before,12000,'reconnect retains the expanded loaded range');
  assert.equal(resumed.args.history_revision,'loaded-prefix');
  assert.equal(resumed.args.history_tail_revision,'delivered-tail',
    'reconnect retains the tail credential accepted from realtime delivery');
  assert.equal(resumed.args.initial_input_revision,5);
  assert.equal(resumed.args.dependency_observed_at,2000);
  assert.equal(resumed.args.dependency_revision,'accepted-prefix');
  streams[0].readyState=2;
  streams[0].onerror({});
  assert.equal(timers.size,1,'terminal EventSource errors schedule transport recovery');
  for(const [id,callback] of timers){timers.delete(id);callback()}
  assert.equal(streams.length,2,'terminal native stream is replaced while listeners remain');
  streams[1].onopen({});await flush();await flush();
  const replaced=calls.filter(c=>c.path.endsWith('/subscribe')&&c.args.listener==='three').at(-1);
  assert.equal(replaced.args.cursor,12000);
  assert.equal(replaced.args.history_tail_revision,'delivered-tail',
    'terminal transport replacement must preserve the same accepted tail credential');
  streams[0].onmessage({data:JSON.stringify({listener:'two',type:'bars'})});
  assert.equal(received.length,3,'delayed events for canceled listeners are ignored');
  streams[1].readyState=2;streams[1].onerror({});
  await transport.clear();assert.equal(streams[1].closed,true);
  assert.equal(timers.size,0,'canceling the final listener cancels reconnection');
  await transport.subscribe({client:'quotes',listener:'watchlist',generation:1,sequence:0});
  const quoteStream=streams.at(-1);
  quoteStream.onmessage({data:JSON.stringify({listener:'watchlist',generation:1,sequence:1,
    type:'quotes',quotes:[{s:'ok',snapshot:{revision_id:'accepted-revision'},v:{lp:1.1}}]})});
  quoteStream.onopen({});await flush();await flush();
  assert.equal(calls.filter(c=>c.path.endsWith('/subscribe')&&c.args.listener==='watchlist').at(-1)
    .args.binding,'accepted-revision','quote reconnect retains the previously delivered binding');
  await transport.clear();
  const ackCalls=[],ackStreams=[];
  const ackTransport=factory(async(path,args)=>ackCalls.push({path,args}),()=>{
    const stream={close(){},onmessage:null};ackStreams.push(stream);return stream;
  },()=>{},error=>{throw error},
  {subscribe:'/charts/stream/subscribe',unsubscribe:'/charts/stream/unsubscribe'});
  await ackTransport.subscribe({client:'native',listener:'price',generation:1,sequence:0});
  const fingerprint='a'.repeat(64);
  ackStreams[0].onmessage({data:JSON.stringify({listener:'price',generation:1,sequence:1,
    result_epoch:'epoch',type:'bars',bars:[{start:60000}],
    provider_acceptance:[{start:60000,fingerprint}]})});
  assert.equal(ackCalls.filter(c=>c.path.endsWith('/accept')).length,0,
    'receiving an SSE payload alone does not acknowledge native acceptance');
  await ackTransport.accept({client:'native',listener:'price',generation:1,sequence:1,
    result_epoch:'epoch',provider_acceptance:[{start:60000,fingerprint}]});
  assert.equal(ackCalls.filter(c=>c.path.endsWith('/accept')).length,1);
  ackStreams[0].onopen({});await flush();await flush();
  const resumedAck=ackCalls.filter(c=>c.path.endsWith('/subscribe')).at(-1).args;
  assert.equal(resumedAck.provider_acceptance[0].fingerprint,fingerprint,
    'reconnect carries the successful native acknowledgement');
  await ackTransport.accept({client:'native',listener:'price',generation:2,sequence:1,
    result_epoch:'epoch',provider_acceptance:[{start:60000,fingerprint}]});
  await ackTransport.accept({client:'native',listener:'price',generation:1,sequence:1,
    result_epoch:'other',provider_acceptance:[{start:60000,fingerprint}]});
  assert.equal(ackCalls.filter(c=>c.path.endsWith('/accept')).length,1,
    'stale generation and epoch cannot acknowledge a different native cache');
  await ackTransport.clear();
  assert.equal(errors.length,0);
  let finish;
  const pending=new Promise(resolve=>finish=resolve);
  const finalCalls=[],finalStreams=[];
  const closing=factory(async(path)=>{finalCalls.push(path);if(path.endsWith('/subscribe'))await pending},
    ()=>{finalStreams.push(1);return {close(){},onmessage:null}},()=>{},()=>{});
  const opened=closing.subscribe({client:'old',listener:'gone'});
  await flush();const disposed=closing.dispose();finish();await opened;await disposed;
  assert.deepEqual(finalCalls,['/charts/provider/subscribe','/charts/provider/unsubscribe']);
  assert.equal(finalStreams.length,0,'unmount drains pending registrations before releasing them');
  const facts=[],outageStreams=[];let requestFailure=true,releaseOld;
  const outages=factory(async()=>{if(requestFailure)throw Error('subscribe503')},()=>{
    const stream={readyState:0,onmessage:null,close(){}};outageStreams.push(stream);return stream;
  },()=>{},()=>{},undefined,(args,kind,error,attempt)=>facts.push({listener:args.listener,kind,error:!!error,attempt}));
  const args={client:'outage',listener:'active',generation:1,sequence:0};
  await outages.subscribe(args);
  assert.equal(facts.length,1,'actual registration failure produces a connection occurrence');
  requestFailure=false;await outages.subscribe(args);
  // The explicit new subscribe replaces a failed registration owner. Its first
  // successful data path has no invented recovery for the abandoned owner.
  const stream=outageStreams[0];
  stream.onerror({});stream.onerror({});
  assert.equal(facts.filter(f=>f.error).length,2,'continuous EventSource outage emits once');
  stream.onopen({});await flush();
  assert.equal(facts.at(-1).error,false,'EventSource open explicitly recovers the current outage');
  stream.onmessage({data:JSON.stringify({listener:'active',generation:1,sequence:1,type:'status',error:'provider503'})});
  stream.onmessage({data:JSON.stringify({listener:'active',generation:1,sequence:2,type:'status',error:'provider503'})});
  assert.equal(facts.filter(f=>f.kind==='market'&&f.error).length,1);
  stream.onmessage({data:JSON.stringify({listener:'active',generation:2,sequence:3,type:'bars',bars:[]})});
  assert.equal(facts.at(-1).error,true,'old or different generation cannot resolve the outage');
  stream.onmessage({data:JSON.stringify({listener:'active',generation:1,sequence:3,type:'bars',bars:[]})});
  const recovered=facts.at(-1);assert.equal(recovered.error,false);
  stream.onmessage({data:JSON.stringify({listener:'active',generation:1,sequence:4,type:'status',error:'provider503'})});
  assert.notEqual(facts.at(-1).attempt,recovered.attempt,'recurrence gets a distinct failure attempt');
  stream.onmessage({data:JSON.stringify({listener:'active',generation:1,sequence:5,type:'quotes',quotes:[{s:'ok',v:{lp:1,fetch_status:'fetch_failed'}}]})});
  assert.equal(facts.at(-1).error,true,'cached price with failed fetch cannot resolve an outage');
  const beforeWaiting=facts.length;
  let waitingSequence=5;
  for(const state of ['pending','stale']) {
    stream.onmessage({data:JSON.stringify({listener:'active',generation:1,sequence:waitingSequence+=.25,type:'quotes',quotes:[{s:'ok',v:{lp:1,fetch_status:state}}]})});
    assert.equal(facts.length,beforeWaiting,'shared waiting neither fails nor recovers a market observation');
  }
  stream.onmessage({data:JSON.stringify({listener:'active',generation:1,sequence:6,type:'quotes',quotes:[{s:'error',v:{}}]})});
  assert.equal(facts.at(-1).error,true,'error quote is a persistent failure');
  stream.onmessage({data:JSON.stringify({listener:'active',generation:1,sequence:7,type:'quotes',quotes:[{s:'ok',v:{lp:2,fetch_status:'ok'}}]})});
  assert.equal(facts.at(-1).error,false,'successful quote explicitly recovers');
  stream.onmessage({data:JSON.stringify({listener:'active',generation:1,sequence:8,type:'bars',status:{state:'error',error:'backfill503'},bars:[]})});
  assert.equal(facts.at(-1).error,true,'bar payload can carry a genuine failure despite successful SSE');
  stream.onmessage({data:JSON.stringify({listener:'active',generation:1,sequence:9,type:'bars',status:{state:'pending'},bars:[]})});
  assert.equal(facts.at(-1).error,true,'pending bar state cannot count as recovery');
  stream.onmessage({data:JSON.stringify({listener:'active',generation:1,sequence:10,type:'bars',status:{state:'ready'},bars:[]})});
  assert.equal(facts.at(-1).error,false);
  stream.onmessage({data:JSON.stringify({listener:'active',generation:1,sequence:11,type:'quotes',quotes:[{s:'ok',v:{lp:2,fetch_status:'provider_maintenance'}}]})});
  assert.equal(facts.at(-1).error,true,'composite maintenance is a real failure despite cached price');
  stream.onmessage({data:JSON.stringify({listener:'active',generation:1,sequence:12,type:'bars',status:{connection:'connected',owned:true,current_account:true,confirmed_tail_ready:true},bars:[]})});
  assert.equal(facts.at(-1).error,false,'healthy owned composite bars explicitly recover');
  stream.onmessage({data:JSON.stringify({listener:'active',generation:1,sequence:13,type:'bars',status:{connection:'recovering',connection_error:'unauthorized',owned:true,current_account:true,confirmed_tail_ready:false},bars:[]})});
  assert.equal(facts.at(-1).error,true,'composite bars retain their explicit connection failure');
  await outages.clear();const count=facts.length;stream.onerror({});stream.onopen({});
  assert.equal(facts.length,count,'cancelled subscriptions produce neither failure nor recovery');
  const late=factory(async(path)=>{if(path.endsWith('/subscribe'))await new Promise((resolve,reject)=>{releaseOld=()=>reject(Error('late503'))})},()=>({close(){},onmessage:null}),()=>{},()=>{},undefined,
    ()=>facts.push('stale'));
  const pendingOld=late.subscribe({client:'late',listener:'old',generation:1});await flush();
  const clearOld=late.clear();releaseOld();await pendingOld;await clearOld;
  assert.equal(facts.length,count,'late registration errors after release cannot produce facts');
  console.log('Provider subscription transport: ordered cancellation, shared stream, stale events and unmount passed');
})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>clearTimeout(watchdog));
