// Actual adapter lifecycle at the native-engine boundary; no database or licensed renderer.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=require('node:path').resolve(__dirname,'../..');
const sandbox={queueMicrotask,TradingView:{version:()=> '6b804c486857f27920cf761aa7eb6e29d9bb6362'}};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(root+'/advanced-host/native-indicator-results.js','utf8'),sandbox);
const adapter=sandbox.MWNativeIndicatorResults;
const main=[{index:0,value:[1000]},{index:1,value:[1060]}],rendered=new Map();
const item={turnaround:'t1',metainfo:{id:'MWPythonLWMA@market-watch-1',plots:[{}]}};
const messenger={onStudyLoading(){},onStudyCompleted(){},onDataUpdate(_id,_turn,rows,meta){
  if(meta.data.data.mwResultsReplace)rendered.clear();
  for(const row of rows)rendered.set(row.value[0],row.value[1]);
}};
const engine={_studiesCache:{s:{i:item}},_timeScales:{s:{fillIndexesInRows(rows){
  for(const row of rows)row.index=main.findIndex(x=>x.value[0]===row.value[0]);
}}},_chartApiMessagerProvider:{getChartApiMessager:()=>messenger},
  _getSeriesData:()=>main,_setEndOfData(){},_updateTimeScaleState(){}};
const study={_ongoingDataUpdate:Promise.resolve(),clearData(){},_onDataUnpacked(){},sourceId:()=> 'i',
  _chartApi:{chartApi:()=>({_studyEngine:engine}),sessionId:()=> 's'}};
const chart={symbol:()=> 'TEST',resolution:()=> '60',_chartWidget:{model:()=>({model:()=>({dataSourceForId:()=>study})})}};
const identity={main:'TEST',fixedRevision:'provider:TEST',paramsFingerprint:'{"period":5}',
  algorithmVersion:'LWMA:1',calculationStart:1000000,period:'60'};
const rows=[{time:1000000,values:[12],valid:[true]},{time:1060000,values:[13],valid:[true]}];
const batch=handle=>({identity:handle.identity,generation:handle.generation,sequence:1,inputRevision:'10',
  kind:'snapshot',rows,coverage:{first:1000000,last:1060000,count:2,identity:JSON.stringify(identity)}});
(async()=>{
  adapter.configure({LWMA:{}},{enable:true});
  assert.equal(adapter.start(engine,'TEST','60',null,'s','i','t1','main',{}),true);
  const acceptedHandle=adapter.attach(chart,'study',identity);
  assert.equal(await adapter.applyBatch(acceptedHandle,batch(acceptedHandle)),true);
  const before=adapter.scope(chart,'study'),valuesBefore=[...rendered];
  item.engine.stop();item.turnaround='t2';
  assert.equal(adapter.start(engine,'TEST','60',null,'s','i','t2','main',{}),true);
  await new Promise(setImmediate);
  const after=adapter.scope(chart,'study');
  const oldHandleAccepted=await adapter.applyBatch(acceptedHandle,{...batch(acceptedHandle),sequence:2});
  const retainedValuesEqual=JSON.stringify(valuesBefore)===JSON.stringify([...rendered]);
  assert.ok(after.generation>before.generation);
  assert.equal(retainedValuesEqual,true);
  assert.equal(oldHandleAccepted,false);
  const newHandle=adapter.attach(chart,'study',identity);
  assert.equal(await adapter.applyBatch(newHandle,batch(newHandle)),true);
  console.log('PASS: native restart retains values, advances generation and rejects the old handle');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
