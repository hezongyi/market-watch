const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function load(file,extra={}){const context={exports:{},AbortController,AbortSignal,Map,JSON,...extra};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);return context.exports;}
(async()=>{
 const calls=[],requests=new Map();const {dataCenterRuntime}=load('src/runtime/dataCenter.ts');
 const rpc=dataCenterRuntime({api:async(path)=>{calls.push(path);return {ok:true}},mobile:false,session:()=> 'test',requests});
 for(const path of ['/market-data/catalog/directory-status?source=yahoo','/market-data/catalog/description','/market-data/catalog/discover'])assert.equal((await rpc({session:'test',path},1,{})).ok,true);
 await assert.rejects(rpc({session:'test',path:'/settings/account'},1,{}),/不允许/);
 assert.equal(calls.length,3);assert.ok([...requests.values()].every(map=>map.size===0));
 const budgets=[];const center=load('src/market-data/api.ts',{require:()=>({api:async()=>({})}),AbortSignal:{timeout:ms=>{budgets.push(ms);return {}},any:signals=>signals[0]}});
 await center.api('/market-data/history-catalog/refresh?market=a',{source:'fxcm'});
 await center.api('/market-data/history-catalog/refresh?market=a',{source:'yahoo'});
 await center.api('/market-data/catalog/directory-status');
 assert.deepEqual(budgets,[70000,120000,20000]);
 const paths=[],rows=[{ticker:'MWP:BINANCE:BTCUSDT'}];
 const {marketRuntime}=load('src/runtime/market.ts',{require:()=>({}),URLSearchParams});
 const marketRequests=new Map(),inflight={current:0},source={};
 const {market}=marketRuntime({api:async(path)=>{paths.push(path);return {items:rows,has_more:false}},marketRequests,inflight});
 assert.deepEqual(await market({op:'search',args:{query:'BTCUSDT',kind:'provider',source:'binance'}},source,{id:1}),rows);
 const url=new URL(paths[0],'http://localhost');
 assert.equal(url.pathname,'/market-data/series/page');
 assert.equal(url.searchParams.get('include_total'),'false');
 assert.equal(url.searchParams.get('page_size'),'100');
 assert.equal(url.searchParams.get('source'),'binance');
 assert.equal((await market({op:'searchPage',args:{kind:'provider'}},source,{id:2})).items,rows);
 assert.equal(inflight.current,0);assert.equal(marketRequests.size,0);
 console.log('Catalog RPC endpoints stay session-scoped and provider refresh budgets cover query strings');
})().catch(error=>{console.error(error);process.exitCode=1});
