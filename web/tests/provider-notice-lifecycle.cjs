const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const source = ts.transpileModule(fs.readFileSync('src/advanced/providerSubscriptions.ts','utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const flush = async () => { for (let i=0;i<4;i++) await new Promise(setImmediate); };
function setup(request = async () => {}) {
  const timers = new Map(), facts = [], streams = [], exports = {}; let next = 0;
  vm.runInNewContext(source, {exports,
    setTimeout:(callback, delay)=>{timers.set(++next,{callback,delay});return next},
    clearTimeout:id=>timers.delete(id)});
  const transport = exports.providerSubscriptions(request, () => {
    const stream={readyState:0,close(){this.closed=true},onmessage:null}; streams.push(stream);return stream;
  },()=>{},()=>{},undefined,(args,kind,error,attempt,lifecycle)=>
    facts.push({listener:args.listener,kind,failed:error!=null,attempt,lifecycle}));
  return {transport,timers,facts,streams, async tick(){
    const [id,{callback}] = timers.entries().next().value;timers.delete(id);callback();await flush();
  }};
}
(async()=>{
  const shared=setup();
  await shared.transport.subscribe({client:'c',listener:'one',generation:1});
  await shared.transport.subscribe({client:'c',listener:'two',generation:1});
  const stream=shared.streams[0];
  stream.onerror({});stream.onerror({});
  assert.equal(shared.facts.length,1,'one transport occurrence for two listeners');
  await shared.transport.unsubscribe({client:'c',listener:'one',generation:1});
  assert.equal(shared.facts.length,1,'removing one observer does not end the shared connection');
  stream.onopen({});await flush();
  assert.equal(shared.facts.length,2);assert.equal(shared.facts[1].failed,false);
  assert.equal(shared.facts[1].attempt,shared.facts[0].attempt);
  stream.onerror({});
  await shared.transport.clear();
  assert.equal(shared.facts.at(-1).lifecycle,'ended','last observer leaves without asserting recovery');
  assert.equal(shared.timers.size,0);

  let calls=0;
  const terminal=setup(async()=>{calls++;throw Object.assign(Error('bad subscription'),{status:422})});
  await terminal.transport.subscribe({client:'bad',listener:'bad',generation:1});
  assert.equal(terminal.timers.size,0,'422 never enters registration retry');
  assert.equal(terminal.streams.length,0);
  assert.deepEqual(terminal.facts.map(f=>[f.kind,f.failed]),[['subscription',true]]);
  await terminal.transport.clear();
  assert.equal(calls,2,'only explicit cancellation follows the rejected registration');
  assert.equal(terminal.facts.at(-1).lifecycle,'ended');

  let failing=true;
  const initial=setup(async path=>{if(path.endsWith('/subscribe')&&failing)throw Object.assign(Error('temporary'),{status:503})});
  await initial.transport.subscribe({client:'new',listener:'new',generation:1});
  assert.equal(initial.streams.length,0,'first registration has no stream to drive a retry');
  assert.equal([...initial.timers.values()][0].delay,1000);
  await initial.tick();
  assert.equal([...initial.timers.values()][0].delay,2000);
  assert.equal(initial.facts.length,1,'retries retain one registration occurrence');
  failing=false;await initial.tick();
  assert.equal(initial.streams.length,1);
  assert.equal(initial.facts.at(-1).failed,false);
  assert.equal(initial.facts.at(-1).kind,'subscription');
  assert.equal(initial.timers.size,0);
  const first=initial.streams[0];
  first.onmessage({data:JSON.stringify({listener:'new',generation:1,sequence:1,type:'status',error:'upstream'})});
  first.onmessage({data:JSON.stringify({listener:'new',generation:1,sequence:2,type:'status',error:'upstream',notice_owner:'server'})});
  assert.equal(initial.facts.at(-1).lifecycle,'ended','worker ownership ends the old browser observation');
  const before=initial.facts.length;
  first.onmessage({data:JSON.stringify({listener:'new',generation:1,sequence:3,type:'quotes',quotes:[{s:'error'}],notice_owner:'server'})});
  assert.equal(initial.facts.length,before,'server-owned failure is not reported again by its listener');
  await initial.transport.dispose();

  const canceled=setup(async path=>{if(path.endsWith('/subscribe'))throw Error('503')});
  await canceled.transport.subscribe({client:'gone',listener:'gone',generation:1});
  assert.equal(canceled.timers.size,1);
  await canceled.transport.dispose();
  assert.equal(canceled.timers.size,0,'dispose cancels initial registration retries');
  assert.equal(canceled.facts.at(-1).lifecycle,'ended');
  console.log('PASS shared transport, terminal registration, initial retry/backoff, cancel and server ownership');
})().catch(error=>{console.error(error);process.exitCode=1});
