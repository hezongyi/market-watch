const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),path=require('node:path');
const {buildSync}=require('esbuild');
const mod={exports:{}};
vm.runInNewContext(buildSync({entryPoints:[path.resolve(__dirname,'../src/advanced/chartPriceAlertRuntime.ts')],bundle:true,write:false,format:'cjs',platform:'node'}).outputFiles[0].text,{module:mod,exports:mod.exports,structuredClone,URLSearchParams,AbortSignal,Error});
const {chartPriceAlertRequest:request}=mod.exports;
const id='11111111-1111-4111-8111-111111111111',instrument='a'.repeat(64);
const context=()=>({request_id:id,instrument,series_kind:'composite',source:'composite',timeframe:'D1',price:'107.500',phone_available:true,display_identity:{code:'AUDJPY'},association:{workspace_id:'unsaved',chart_id:'local',generation:'1'},composite_revision_id:'revision'});
test('quick create freezes reviewed cross/intrabar/one delivery intent without layout association',async()=>{
 const calls=[];
 await request({op:'price_create',context:context()},async(p,b)=>{calls.push([p,b]);return b;},()=>true);
 const c=calls[0][1].config;
 assert.equal(c.mode,'intrabar');assert.equal(c.condition.relation,'cross');assert.equal(c.max_triggers,1);
 assert.equal(c.notify_ntfy,true);assert.equal(c.association,null);assert.equal(c.timeframe,'D1');assert.equal(c.composite_revision_id,'revision');
 assert.equal(calls.length,1);assert.equal(calls[0][0],'/chart-alerts');
 const disabled=context();disabled.phone_available=false;
 await request({op:'price_create',context:disabled},async(p,b)=>{assert.equal(b.config.notify_ntfy,false);},()=>true);
});
test('native, forged prices and object-based mobile writes never reach authenticated API',async()=>{
 let calls=0;const call=async()=>{calls++;};
 for(const patch of [{series_kind:'provider'},{instrument:'same-name'},{price:'0'},{price:'Infinity'},{line:{}},{indicator:{}}])
  await assert.rejects(request({op:'price_create',context:{...context(),...patch}},call,()=>true));
 await assert.rejects(request({op:'geometry'},call,()=>true));
 await assert.rejects(request({op:'price_capabilities',...context()},call,()=>false));
 assert.equal(calls,0);
});
test('listing deduplicates full series identities and excludes drawings and indicators',async()=>{
 const fixed={id,config:{series_kind:'composite',condition:{left:{kind:'price'},right:{kind:'constant'},relation:'cross'},association:null}};
 let calls=0;
 const rows=await request({op:'price_list',instruments:[instrument,instrument]},async()=>{calls++;return [fixed,{...fixed,config:{...fixed.config,association:{object_kind:'drawing'}}}];},()=>true);
 assert.equal(calls,1);assert.equal(rows.length,1);
});

test('previous-day exit ranges are listed and retain normal pause/archive lifecycle; drag editing is rejected',async()=>{
 const range={id,version:1,control_revision:1,status:'active',config:{series_kind:'composite',instrument,timeframe:'M5',condition:{relation:'exit',left:{kind:'price'},lower:'100',upper:'110'},association:null}};
 const rows=await request({op:'price_list',instruments:[instrument]},async()=>[range],()=>true);
 assert.equal(rows.length,1);
 await assert.rejects(request({op:'price_edit',alert_id:id,price:105},async()=>range,()=>true),/区间告警请在告警编辑器中修改/);
 const calls=[];
 const saved=await request({op:'price_action',alert_id:id,action:'pause',request_id:id,version:1,control_revision:1},async(path,body)=>{
  calls.push([path,body]);if(!body)return range;return {...range,status:'paused',control_revision:2};
 },()=>true);
 assert.equal(saved.status,'paused');assert.equal(calls.at(-1)[0],`/chart-alerts/${id}/lifecycle`);
});
test('delayed responses are fenced by the actual chart owner',async()=>{
 let current=true;
 await assert.rejects(request({op:'price_capabilities',...context()},async()=>{current=false;return {};},()=>current),/图表已切换/);
});

test('lifecycle response loss reads back committed state, while old or offline reads stay unknown',async()=>{
 const row={id,version:1,control_revision:1,status:'active',config:{series_kind:'composite',condition:{left:{kind:'price'},right:{kind:'constant'},relation:'cross'},association:null}};
 for(const mode of ['committed','old','offline']){
  let stored=structuredClone(row),writes=0,posted=false;
  const task=request({op:'price_action',alert_id:id,version:1,control_revision:1,action:'pause',request_id:id},async(p,b)=>{
   if(b){writes++;posted=true;if(mode==='committed')stored={...stored,status:'paused',control_revision:2};throw Error('lost response');}
   if(mode==='offline' && posted)throw Error('offline');return stored;
  },()=>true);
  if(mode==='committed')assert.equal((await task).status,'paused');else await assert.rejects(task,e=>e.outcomeUnknown===true);
  assert.equal(writes,1);
 }
});
