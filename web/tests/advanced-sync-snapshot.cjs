const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const context=vm.createContext({setTimeout,requestAnimationFrame:callback=>setTimeout(callback,0)});
vm.runInContext(fs.readFileSync('../advanced-host/viewports.js','utf8'),context);
(async()=>{
 let date=true,time=true,fail=false;
 const chart={symbol:()=> 'MWP:EURUSD',resolution:()=> '5',getVisibleRange:()=>({from:1,to:2}),
  getTimeScale:()=>({barSpacing:()=>6,rightOffset:()=>10,width:()=>600})};
 const native={charts:[{panes:[{sources:[{id:'keep-drawing'}]}]}],opaque:['untouched']};
 const widget={chartsCount:()=>2,chart:()=>chart,dateRangeSync:()=>({value:()=>date,setValue:value=>{date=value}}),
  timeSync:()=>({value:()=>time,setValue:value=>{time=value}}),save:cb=>{
   assert.equal(date,false,'native startup layout must be captured without early range synchronization');
   assert.equal(time,false);if(fail)throw Error('native save failed');cb(native);
  }};
 const saved=await context.captureChartLayout(widget);
 assert.equal(saved.charts,native.charts,'vendor layout must come directly from the public save API');
 assert.equal(saved.opaque,native.opaque,'opaque supplier content is not rewritten');
 assert.equal(saved._mwSync.date,true);assert.equal(saved._mwSync.time,true);
 assert.equal(saved._mwViewports.length,2);
 assert.equal(date,true);assert.equal(time,true);
 fail=true;await assert.rejects(context.captureChartLayout(widget),/native save failed/);
 assert.equal(date,true,'failed save restores user synchronization');assert.equal(time,true);
 fail=false;
 widget.save=cb=>setTimeout(()=>cb(native),5);
 const simultaneous=await Promise.all([context.captureChartLayout(widget),context.captureChartLayout(widget)]);
 assert.ok(simultaneous.every(state=>state._mwSync.date===true),
  'overlapping viewport/native saves must not persist a temporary disabled sync state');
 assert.equal(date,true);assert.equal(time,true);
 // Legacy native layouts have no _mwSync metadata. Their toggles must be
 // deferred at the first history request, then restored after viewport setup.
 widget.chartsCount=()=>4;
 const desired=context.deferLegacyChartSynchronization(widget);
 assert.equal(desired.date,true);assert.equal(desired.time,true);
 assert.equal(date,false);assert.equal(time,false);
 context.restoreChartSynchronization(widget,desired);
 assert.equal(date,true);assert.equal(time,true);
 date=false;
 const independent=context.deferLegacyChartSynchronization(widget);
 assert.equal(independent.date,false);assert.equal(independent.time,true);
 assert.equal(time,true,'independent date ranges do not disable time synchronization');
 console.log('Public snapshots defer synchronized startup while retaining user choices and vendor content');
})().catch(error=>{console.error(error);process.exit(1)});
