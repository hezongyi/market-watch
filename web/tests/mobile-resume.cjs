// Actual mobile connection with controlled clocks and WebView visibility.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const compile=file=>ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
let now=1000,id=0;const timers=new Map(),calls=[],streams=[],events=new Map(),received=[];
const clock={now:()=>now},timer=(fn,delay)=>{timers.set(++id,{fn,at:now+delay});return id;};
const provider={};vm.runInNewContext(compile('src/advanced/providerSubscriptions.ts'),{exports:provider,Map,Set,Promise,Error,JSON,Date:clock,setTimeout:timer,clearTimeout:id=>timers.delete(id)});
const document={hidden:false,addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:()=>{}};
const windowEvents=new Map();
const navigator={onLine:true};
const mobile={};vm.runInNewContext(compile('src/mobile/market.ts'),{exports:mobile,require:name=>name==='../api'?{api:async(path,args)=>{calls.push({path,args:structuredClone(args)});}}:name==='./logs'?{logEvent:()=>{}}:provider,
 document,navigator,Date:clock,Map,Set,Promise,Error,JSON,AbortSignal,crypto:{randomUUID:()=> 'mobile'},encodeURIComponent,
 setTimeout:timer,clearTimeout:id=>timers.delete(id),addEventListener:(name,fn)=>windowEvents.set(name,fn),removeEventListener:name=>windowEvents.delete(name),
 EventSource:class{constructor(){this.readyState=0;this.events={};streams.push(this);}close(){this.closed=true;}addEventListener(name,fn){this.events[name]=fn;}}});
(async()=>{
 const connection=mobile.mobileMarket(error=>{throw Error(error)}),states=[];
 connection.observe(state=>states.push(state));
 await connection.subscribe({listener:'chart',generation:1,sequence:0,kind:'bars',query:{series_kind:'managed',instrument:'EURUSD'}},event=>received.push(event));
 streams[0].readyState=1;streams[0].onopen({});await flush();
 streams[0].onmessage({data:JSON.stringify({listener:'chart',generation:1,type:'bars',sequence:7,cursor:60000,bars:[{start:60000}],history_tail_revision:'accepted-tail'})});
 now+=20000;for(const [id,task]of [...timers])if(task.at<=now){timers.delete(id);task.fn();}await flush();
 assert.equal(streams.length,2,'an apparently open connection without heartbeats must be replaced');
 assert(streams[0].closed);streams[1].readyState=1;streams[1].onopen({});await flush();
 let resumed=calls.filter(row=>row.path.endsWith('/subscribe')).at(-1).args;
 assert.equal(resumed.cursor,60000);assert.equal(resumed.sequence,7);assert.equal(resumed.history_tail_revision,'accepted-tail');
 streams[0].onmessage({data:JSON.stringify({listener:'chart',generation:1,type:'bars',sequence:8,cursor:120000})});assert.equal(received.length,1,'old transport cannot deliver late bars');
 for(let i=0;i<4;i++){now+=5000;streams[1].events.heartbeat({});for(const [id,task]of [...timers])if(task.at<=now){timers.delete(id);task.fn();}await flush();}
 assert.equal(streams.length,2,'quiet markets must not be treated as disconnected');
 document.hidden=true;events.get('visibilitychange')();await flush();
 assert(streams[1].closed);assert.equal(timers.size,0,'background has no connection watchdog');
 now+=3600000;document.hidden=false;events.get('visibilitychange')();await flush();
 assert.equal(streams.length,3);streams[2].readyState=1;streams[2].onopen({});await flush();
 resumed=calls.filter(row=>row.path.endsWith('/subscribe')).at(-1).args;
 assert.equal(resumed.cursor,60000);assert.equal(resumed.sequence,7,'one hour away cannot silently skip missed bars');
 navigator.onLine=false;windowEvents.get('offline')();await flush();assert(streams[2].closed);
 navigator.onLine=true;windowEvents.get('online')();await flush();assert.equal(streams.length,4,'network recovery reconnects immediately');
 streams[3].readyState=1;streams[3].onopen({});await flush();
 await connection.subscribe({listener:'chart',generation:2,sequence:0,kind:'bars',query:{series_kind:'managed',instrument:'EURUSD'}},event=>received.push(event));
 await connection.unsubscribe({listener:'chart',generation:1});await flush();
 streams[3].onmessage({data:JSON.stringify({listener:'chart',generation:2,type:'bars',sequence:1,cursor:120000})});
 assert.equal(received.at(-1).generation,2,'late cleanup from an old generation cannot remove its replacement');
 await connection.dispose();assert.equal(timers.size,0);assert.equal(windowEvents.size,0);
 console.log('PASS mobile recovery: silent connection, cursor, old-stream fence, quiet-market heartbeat, hour-long background and disposal');
})().catch(error=>{console.error(error);process.exitCode=1});
