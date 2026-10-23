// Exercise the production bridge queue under competing optional/visible reads.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const messages=[],handlers=[];
const ctx=vm.createContext({document:{createElement:()=>({}),head:{append:()=>{}}},URL,URLSearchParams,Map,Promise,Date,Intl,Error,
 location:{search:'?parent=http://localhost'},parent:{postMessage:m=>messages.push(m)},
 crypto:{randomUUID:()=> 'test'},addEventListener:(name,fn)=>{if(name==='message')handlers.push(fn)},setTimeout,clearTimeout});
for(const f of ['series.js','composite-display-batches.js','bridge.js'])vm.runInContext(fs.readFileSync('../advanced-host/'+f,'utf8'),ctx);
const sent=()=>messages.filter(m=>m.type==='data');
async function finish(name){const m=sent().find(m=>m.query.name===name);assert.ok(m,name+' not dispatched');
 await handlers[0]({source:ctx.parent,origin:'http://localhost',data:{channel:'mw-chart-v1',type:'result',id:m.id,result:{}}});}
(async()=>{
 vm.runInContext(`globalThis.work=[];
 for(const name of ['reserve1','reserve2','reserve3'])work.push(request({name,native_reserve:{screen_bars:100,batch_screens:1}}));
 for(const name of ['visible1','visible2'])work.push(request({name}));`,ctx);
 assert.deepEqual(sent().map(m=>m.query.name),['reserve1','reserve2','visible1','visible2']);
 assert.equal(vm.runInContext('pending.size',ctx),4,'same four total in-flight limit');
 vm.runInContext(`work.push(request({name:'reserve4',native_reserve:{screen_bars:100,batch_screens:1}}));work.push(request({name:'visible3'}));`,ctx);
 await finish('visible1');assert.equal(sent().at(-1).query.name,'visible3','visible read must outrank queued reserve');
 await finish('visible2');assert.equal(sent().length,5,'third reserve must wait while two reserves are in flight');
 await finish('reserve1');assert.equal(sent().at(-1).query.name,'reserve3');
 assert.equal(vm.runInContext('[...pending.values()].filter(e=>e.reserve).length',ctx),2);
 await finish('reserve2');assert.equal(sent().at(-1).query.name,'reserve4');
 for(const name of ['visible3','reserve3','reserve4'])await finish(name);
 await Promise.all(ctx.work);assert.equal(vm.runInContext('pending.size+requests.length',ctx),0);
 console.log('Two reserve lanes, four total lanes and visible-request priority passed');
})().catch(error=>{for(const entry of vm.runInContext('[...pending.values()]',ctx)){clearTimeout(entry.timer);clearTimeout(entry.cancellationTimer)}console.error(error);process.exitCode=1;});
