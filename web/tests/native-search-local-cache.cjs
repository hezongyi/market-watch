const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
let now=100000;class Clock extends Date {static now(){return now;}}
const ctx=vm.createContext({URL,URLSearchParams,Map,Set,Promise,Date:Clock,Intl,Error,
 document:{createElement:()=>({}),head:{append(){}}},location:{search:'?parent=http://localhost'},
 parent:{postMessage(){}},crypto:{randomUUID:()=> 'test'},addEventListener(){},setTimeout,clearTimeout});
for(const file of ['series.js','composite-display-batches.js','chart-runtime.js'])vm.runInContext(fs.readFileSync('../advanced-host/'+file,'utf8'),ctx);
const run=code=>vm.runInContext(code,ctx);
(async()=>{
 const config=await run('new Promise(resolve=>feed.onReady(resolve))');
 assert(config.exchanges.some(s=>s.value==='AKSHARE' && s.name.includes('新浪') && s.name.includes('腾讯')), 'Symbol source selector must expose AKShare, Sina and Tencent');
 run(`globalThis.calls=[];request=async q=>{calls.push(q);return {items:[{display_symbol:'EURUSD',ticker:'MWP:EURUSD',label:'EURUSD',description:'平台',source:'fxcm'}],next_cursor:'next'};}`);
 await run(`searchNativeSymbols({userInput:'EURUSD',start:0})`);
 await run(`searchNativeSymbols({userInput:'EURUSD',exchange:'',symbolType:'',start:0})`);
 assert.equal(run('calls.length'),1,'reopening shares the maintained local result');
 await run(`searchNativeSymbols({userInput:'EURUSD',start:1})`);
 assert.equal(run('calls.length'),2,'continuation still fetches the next cursor');
 assert.equal(run('calls[1].args.cursor'),'next');
 await assert.rejects(run(`searchNativeSymbols({userInput:'EURUSD',signal:{aborted:true}})`),e=>e.name==='AbortError');
 now+=300001;await run(`searchNativeSymbols({userInput:'EURUSD'})`);assert.equal(run('calls.length'),3);
 run('clearNativeSearchCache()');await run(`searchNativeSymbols({userInput:'EURUSD'})`);assert.equal(run('calls.length'),4);
 console.log('Local search results expire, invalidate, retain pagination, and honor cancelled consumers');
})().catch(e=>{console.error(e);process.exitCode=1});
