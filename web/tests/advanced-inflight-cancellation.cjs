const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const events=[];
const warnings=[];
const context=vm.createContext({document:{createElement:()=>({}),head:{append:()=>{}}},URL,URLSearchParams,Map,Promise,Date,Intl,Error,
 location:{search:'?parent=http://localhost'},parent:{postMessage:m=>events.push(m)},
 crypto:{randomUUID:()=> 'test'},addEventListener(){},setTimeout,clearTimeout,clearInterval,cleanupListeners(){},
 console:{warn:(...args)=>warnings.push(args)}});
vm.runInContext(require("./fixtures/direct-runtime.cjs").read("../advanced-host/series.js", "utf8"), context);
vm.runInContext(require("./fixtures/direct-runtime.cjs").read("../advanced-host/composite-display-batches.js", "utf8"), context);
vm.runInContext(require("./fixtures/direct-runtime.cjs").read('../advanced-host/chart-runtime.js','utf8'),context);
(async()=>{
 vm.runInContext(`
  let current=true; var results=[];
  for(let i=0;i<4;i++) request({op:'history',args:{page:i}},'market',()=>current).catch(e=>results.push(e.code));
  current=false;
  request({op:'history',args:{page:'current'}},'market',()=>true).catch(()=>{});
 `,context);
 await new Promise(r=>setTimeout(r,180));
 assert.equal(vm.runInContext('pending.size',context),1);
 assert.equal(events.filter(e=>e.type==='cancel-request').length,4);
 assert.equal(events.at(-1).type==='cancel-request' || events.at(-1).query?.args.page==='current',true);
 assert.equal(events.filter(e=>e.query?.args.page==='current').length,1);
 assert.equal(vm.runInContext('results.filter(e=>e==="HISTORY_CANCELLED").length',context),4);
 const current=events.find(e=>e.query?.args.page==='current').id;
 vm.runInContext(`noticeUI={destroy(){throw Error('already detached')}};alertUI={destroy(){throw Error('already detached')}};indicatorCoordinator={dispose(){throw Error('vendor API already detached')}};dataCenter={dispose(){throw Error('vendor API already detached')}};`,context);
 assert.doesNotThrow(()=>vm.runInContext('adapter.dispose()',context),'native widget teardown errors must not abort session disposal');
 assert.equal(warnings.length,4,'teardown failures remain visible while later cleanup continues');
 assert.ok(warnings.every(([message,error])=>message==='Chart cleanup failed' && error instanceof Error));
 assert.ok(events.some(e=>e.type==='cancel-request' && e.id===current),'disposing the replaced workspace must abort its current HTTP request');
 assert.equal(vm.runInContext('pending.size',context),0);
 console.log('Four obsolete in-flight histories release slots within 180ms; current request starts');
})().catch(e=>{console.error(e);process.exit(1)});
