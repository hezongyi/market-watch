const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const exportsObject={};
let now=1000;
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/advanced/providerSubscriptions.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
 {exports:exportsObject,Date:{now:()=>now},Map,Set,Promise,Error,JSON,setTimeout,clearTimeout});
(async()=>{
 const streams=[],states=[];
 const provider=exportsObject.providerSubscriptions(async()=>{},()=>{
   const events={};const stream={readyState:1,onmessage:null,onopen:null,onerror:null,close(){},addEventListener(type,callback){events[type]=callback;},events};
   streams.push(stream);return stream;
 },()=>{},error=>{throw error;},undefined,undefined,undefined,state=>states.push(state));
 assert.equal(states.length,0,'no subscription means no connected status');
 await provider.subscribe({client:'mobile',listener:'chart',sequence:0});
 assert.equal(states.at(-1).state,'connecting');
 streams[0].onopen({});
 assert.equal(states.at(-1).openedAt,1000);assert.equal(states.at(-1).heartbeatAt,null);
 now=2000;streams[0].events.heartbeat({data:'{}'});
 assert.equal(states.at(-1).heartbeatAt,2000);assert.equal(states.at(-1).messageAt,null);
 now=3000;streams[0].onmessage({data:JSON.stringify({listener:'chart',type:'bars',sequence:1})});
 assert.equal(states.at(-1).messageAt,3000);assert.equal(states.at(-1).heartbeatAt,2000);
 await provider.subscribe({client:'mobile',listener:'watch'});assert.equal(streams.length,1,'observation reuses the shared stream');
 now=4000;streams[0].onerror({});assert.equal(states.at(-1).state,'error');assert.equal(states.at(-1).openedAt,null);
 now=5000;streams[0].onopen({});assert.equal(states.at(-1).heartbeatAt,null,'reopen cannot claim old heartbeat');
 await provider.dispose();assert.equal(states.at(-1).state,'idle');
 const count=states.length;streams[0].events.heartbeat({});assert.equal(states.length,count,'late events from disposed stream are ignored');
 console.log('PASS mobile transport: actual open/message/heartbeat/error, shared connection, reopen and teardown');
})().catch(error=>{console.error(error);process.exitCode=1;});
