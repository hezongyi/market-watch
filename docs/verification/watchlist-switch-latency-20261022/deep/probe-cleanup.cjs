// Historical bug witness: this deliberately asserts the old blocked delivery.
// It should fail on the repaired module. Use web/tests/advanced-history-loading.cjs
// and advanced-history-admission.cjs for the repair's pass/fail regressions.
const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const ts=require(require.resolve('typescript',{paths:[process.cwd()+'/web']}));
const source=fs.readFileSync('web/src/advanced/nativeHistoryLoads.ts','utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
let releaseCleanup,signalResult;
const cleanup=new Promise(resolve=>releaseCleanup=resolve);
const resultRequested=new Promise(resolve=>signalResult=resolve);
const calls=[];
class ApiError extends Error{}
const api=async path=>{
 calls.push(path);
 if(path==='/charts/history-loads')return {load:{id:'diagnostic-handle',state:'ready',pages:1}};
 if(path.endsWith('/result')){signalResult();return {result:{bars:[{time:1}],cache_hit:true}};}
 if(path.endsWith('/cancel')){await cleanup;return {state:'cancelled'};}
 throw Error('Unexpected diagnostic API call');
};
const moduleExports={};
vm.runInNewContext(compiled,{exports:moduleExports,require:name=>{assert.equal(name,'../api');return {api,ApiError};},
 crypto:globalThis.crypto,AbortSignal,DOMException,setTimeout,clearTimeout,Date},{filename:'nativeHistoryLoads.ts'});
(async()=>{
 let settled=false;
 const load=moduleExports.loadNativeHistory({countBack:77},new AbortController().signal,{task_seconds:10},()=>{});
 load.then(()=>settled=true);
 await resultRequested;
 await new Promise(resolve=>setTimeout(resolve,25));
 assert.equal(settled,false,'Real function should still be awaiting cleanup with price data already available');
 assert.equal(calls.at(-1),'/charts/history-loads/diagnostic-handle/cancel');
 releaseCleanup();
 const result=await load;
 assert.equal(result.bars.length,1);
 console.log(JSON.stringify({real_module:true,result_available_but_delivery_waits_for_cleanup:true,bars:result.bars.length,calls}));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
