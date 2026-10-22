const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const events=[];
const context=vm.createContext({document:{createElement:()=>({}),head:{append:()=>{}}},URL,URLSearchParams,Map,Promise,Date,Intl,Error,
 location:{search:'?parent=http://localhost'},parent:{postMessage:m=>events.push(m)},
 crypto:{randomUUID:()=> 'test'},addEventListener(){},setTimeout,clearTimeout});
vm.runInContext(fs.readFileSync("../advanced-host/series.js", "utf8"), context);
vm.runInContext(fs.readFileSync("../advanced-host/composite-display-batches.js", "utf8"), context);
vm.runInContext(fs.readFileSync('../advanced-host/bridge.js','utf8'),context);
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
 vm.runInContext('for(const p of pending.values()){clearTimeout(p.timer);clearTimeout(p.cancellationTimer)}pending.clear()',context);
 console.log('Four obsolete in-flight histories release slots within 180ms; current request starts');
})().catch(e=>{console.error(e);process.exit(1)});
