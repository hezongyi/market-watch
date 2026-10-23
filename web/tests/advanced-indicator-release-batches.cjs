// The real coordinator callback must retain all cancellation fences under churn.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const handlers=[],messages=[];let release;
const ctx=vm.createContext({URL,URLSearchParams,Map,Promise,Date,Intl,Error,
  document:{createElement:()=>({}),head:{append:()=>{}}},location:{search:'?parent=http://localhost'},
  parent:{postMessage:m=>messages.push(m)},crypto:{randomUUID:()=> 'release-batches'},
  chartIndicatorCoordinator:(_widget,_catalog,hooks)=>{release=hooks.release;return {};},
  addEventListener:(name,fn)=>{if(name==='message')handlers.push(fn);},setTimeout,clearTimeout});
for(const file of ['series.js','composite-display-batches.js','bridge.js'])
  vm.runInContext(fs.readFileSync('../advanced-host/'+file,'utf8'),ctx);
const run=code=>vm.runInContext(code,ctx);
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));};
(async()=>{
  try {
    run(`startIndicatorCoordinator([]);globalThis.failures=[];for(let i=0;i<4;i++)void request({name:'slow'+i});`);
    for(let generation=1;generation<=2;generation++)for(let i=0;i<70;i++)release([{id:'pane-'+i,generation}]);
    run(`globalThis.price=request({name:'current',firstDataRequest:true},'data').catch(e=>failures.push(String(e)));`);
    await flush();
    assert.equal(run('failures.length'),0,'release churn cannot exhaust admission for the current price read');
    assert.equal(run("requests.filter(e=>e.type==='indicator-demand-release').length"),2,
      'seventy consumer fences use two queued batches within the existing 64-row protocol');
    const completed=new Set();
    for(let i=0;i<10;i++) {
      const message=messages.find(m=>m.id&&!completed.has(m.id));if(!message)break;
      completed.add(message.id);
      await handlers[0]({source:ctx.parent,origin:'http://localhost',data:{channel:'mw-chart-v1',type:'result',id:message.id,result:{}}});
      await flush();
    }
    await ctx.price;
    const batches=messages.filter(m=>m.type==='indicator-demand-release');
    assert.equal(batches.length,2);
    assert.ok(batches.every(m=>m.query.consumers.length<=64),'batching preserves parent and HTTP validation limits');
    const consumers=batches.flatMap(m=>m.query.consumers);
    assert.equal(consumers.length,70,'every distinct consumer retains its cancellation fence');
    assert.ok(consumers.every(c=>c.generation===2),'highest queued generation fences every older demand');
    assert.equal(run('requests.length+pending.size'),0);
    console.log('Indicator releases: coordinator churn batches at most 64 fences and preserves all consumer generations');
  } finally {run('for(const e of pending.values()){clearTimeout(e.timer);clearTimeout(e.cancellationTimer);}');}
})().catch(e=>{console.error(e);process.exitCode=1;});
