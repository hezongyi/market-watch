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
  console.log('Provider subscription transport: ordered cancellation, shared stream, stale events and unmount passed');
})().catch(error=>{console.error(error);process.exitCode=1});
