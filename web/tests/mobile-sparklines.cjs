const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const exportsObject={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/mobile/sparklines.ts','utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
}).outputText,{exports:exportsObject,Map,Set,Promise,AbortController,Number,Math,JSON});
const {sparklineLoader,sparklinePaths}=exportsObject;
(async()=>{
  const requests=[],received=[],failed=[];let active=0,maxActive=0;
  const loader=sparklineLoader((items,signal)=>new Promise(resolve=>{
    active++;maxActive=Math.max(maxActive,active);
    requests.push({items,signal,resolve:value=>{active--;resolve(value);}});
  }),items=>received.push(items),error=>failed.push(error));
  const old=loader.load(Array.from({length:65},(_,i)=>({ticker:'OLD'+i})));
  assert.equal(requests.length,2);assert(requests.every(request=>request.items.length<=20));
  const next=loader.load([{ticker:'NEW'},{ticker:'NEW'}]);
  assert.equal(requests.length,3);assert(requests.slice(0,2).every(request=>request.signal.aborted));
  requests[0].resolve({as_of:10,items:[{ticker:'OLD',window_end:100}]});
  requests[1].resolve({as_of:10,items:[{ticker:'OLD',window_end:100}]});
  requests[2].resolve({as_of:10,items:[{ticker:'NEW',window_end:100}]});
  await Promise.all([old,next]);assert.equal(received.length,1);assert.equal(received[0][0].ticker,'NEW');
  assert.equal(requests[2].items.length,1,'same-window items are deduplicated');
  assert.equal(failed.length,0);
  const visible=loader.load(Array.from({length:50},(_,i)=>({ticker:'VISIBLE'+i})));
  requests[3].resolve({as_of:10,items:[]});requests[4].resolve({as_of:10,items:[]});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests.length,6);assert.equal(requests[5].items.length,10);
  requests[5].resolve({as_of:100,items:[{ticker:'EXPIRED',window_end:100}]});await visible;
  assert(received.at(-1).length===0,'window that ended before server as_of is discarded');
  const paths=sparklinePaths({window_start:0,window_end:100,points:[
    {time:0,price:'1',gap_before:false},{time:10,price:'2',gap_before:false},
    {time:30,price:'3',gap_before:true}]});
  assert.equal(paths.length,2);assert.equal(paths[0].end[0],20);assert.equal(paths[1].end[0],60);
  assert(paths[1].end[0]<200,'future window remains blank instead of stretching points');
  console.log('PASS mobile sparklines: bounded batches/concurrency, deduplication, abort/late replies, window expiry and gaps');
})().catch(error=>{console.error(error);process.exitCode=1;});
