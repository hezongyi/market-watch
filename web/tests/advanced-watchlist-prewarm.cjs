const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const source=fs.readFileSync('src/advanced/ChartApplicationPage.tsx','utf8');
const start=source.indexOf('          const stored = (preferences as any[])');
const end=source.indexOf('          historyCapabilities.current = capabilities;',start);
assert(start>=0&&end>start);
const code=ts.transpile('(async()=>{'+source.slice(start,end)+';return Object.fromEntries(entries)})()',
  {target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS});
const tickers=Array.from({length:32},(_,i)=>'MWP:TEST'+i);
const preferences=[{kind:'setting',name:'mw.watchlists.v1',content:{value:{active:'a',lists:[{id:'a',symbols:tickers}]}}}];
const mobileSetters = {setMobilePreferenceRows(){},setMobileWatchlists(){},setMobileActiveWatchlist(){},setMobileFlags(){}};
(async()=>{
  let deadline,cleared=0,calls=0,signals=[];const late=[];
  const window={setTimeout:(fn,ms)=>{assert.equal(ms,4000);deadline=fn;return 1},clearTimeout:()=>cleared++};
  const result=vm.runInNewContext(code,{...mobileSetters,preferences,AbortController,window,
    api:(_,args,signal)=>{calls++;signals.push(signal);return new Promise(resolve=>late.push(()=>resolve({symbol:args.instrument})))}});
  assert.equal(calls,4,'bounded concurrency before optional metadata returns');
  deadline();
  const metadata=await result;
  assert.equal(Object.keys(metadata).length,0);
  assert.equal(calls,4,'shared deadline stops later batches');
  assert(signals.every(signal=>signal.aborted));assert.equal(cleared,1);
  late.forEach(resolve=>resolve());await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,4,'noncooperative late responses cannot resume prewarm');
  assert.equal(Object.keys(metadata).length,0,'late names cannot mutate the already delivered init map');
  calls=0;
  const fast=await vm.runInNewContext(code,{...mobileSetters,preferences,AbortController,window,
    api:async(_,args)=>{calls++;return {symbol:args.instrument}}});
  assert.equal(calls,32);assert.equal(Object.keys(fast).length,32);
  assert.equal(fast['MWP:TEST31'].symbol,'TEST31');
  console.log('PASS one startup metadata deadline, cancellation, bounded concurrency and warm names');
})().catch(error=>{console.error(error);process.exitCode=1});
