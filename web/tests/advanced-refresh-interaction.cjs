const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const wheel=new Map();
const document={querySelectorAll:()=>[],addEventListener:(n,fn)=>wheel.set(n,fn),removeEventListener:n=>wheel.delete(n)};
const context=vm.createContext({document,setTimeout,clearTimeout,requestAnimationFrame:cb=>setTimeout(cb,0)});
vm.runInContext(fs.readFileSync('../advanced-host/viewports.js','utf8'),context);
(async()=>{
 let loaded,spacing=6,restores=0;
 const events=new Map();
 const chart={symbol:()=> 'XAUUSD',resolution:()=> '1D',getVisibleRange:()=>({from:1,to:2}),
  getTimeScale:()=>({barSpacing:()=>spacing,rightOffset:()=>2,width:()=>1200,
    setBarSpacing(){restores++},setRightOffset(){}}),
  dataReady:cb=>{cb?.();return true},
  onDataLoaded:()=>({subscribe:(_,cb)=>{loaded=cb},unsubscribe:()=>{loaded=null}}),
  resetData:()=>setTimeout(()=>loaded?.(),10)};
 const widget={chartsCount:()=>1,chart:()=>chart,subscribe:(name,fn)=>events.set(name,fn),
  unsubscribe:name=>events.delete(name),dateRangeSync:()=>({value:()=>false,setValue(){}})};
 let job=context.refreshChartHistory(widget,chart,()=>{},()=>true);
 events.get('mouse_down')();assert.equal(await job,false);assert.equal(restores,0);
 assert.equal(events.size,0);
 job=context.refreshChartHistory(widget,chart,()=>{},()=>true);
 spacing=8;wheel.get('wheel')();assert.equal(await job,false);assert.equal(restores,0);
 assert.equal(wheel.size,0);
 job=context.refreshChartHistory(widget,chart,()=>{},()=>true);
 events.get('layout_about_to_be_changed')('s');
 assert.equal(await job,false);assert.equal(restores,0);
 assert.equal(events.size,0);
 assert.equal(await context.refreshChartHistory(widget,chart,()=>{},()=>true),true);
 assert.equal(restores,1);assert.equal(events.size,0);
 job=context.refreshChartHistory(widget,chart,()=>{},()=>true);
 spacing=10;assert.equal(await job,true);assert.equal(restores,2);
 assert.equal(wheel.size,0);
 console.log('History refresh yields to new mouse/focus/zoom intent and removes listeners');
})().catch(e=>{console.error(e);process.exit(1)});
