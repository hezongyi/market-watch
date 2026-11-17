const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const sent=[],handlers={};let uuid=0;
const ctx=vm.createContext({document:{createElement:()=>({}),head:{append(){}}},URL,URLSearchParams,Map,Set,Promise,Date,Intl,Error,
 location:{search:''},parent:{postMessage:value=>sent.push(value)},crypto:{randomUUID:()=> 'listener-'+ ++uuid},atob:s=>Buffer.from(s,'base64').toString('utf8'),
 addEventListener:(name,fn)=>handlers[name]=fn,setTimeout,clearTimeout,queueMicrotask});
for(const name of ['series.js','price-format.js','composite-display-batches.js','chart-runtime.js'])vm.runInContext(require('./fixtures/direct-runtime.cjs').read('../advanced-host/'+name,'utf8'),ctx);
const run=code=>vm.runInContext(code,ctx),message=data=>handlers.message({data});
(async()=>{
 run(`mobileMode=true;globalThis.values=[];globalThis.symbol='MWC:'+'a'.repeat(64);
 const pane={symbol:()=>symbol,resolution:()=> '1',getTimeScale:()=>({width:()=>200,barSpacing:()=>6})};
 widget={chartsCount:()=>1,chart:()=>pane};ready=true;
 marketHistoryState.set(symbol+'|1|',{accepted:true,first:60000,last:60000,observed_at:1000,binding:'revision-a',history_tail_revision:'old-tail'});
 lastHistory.set(symbol+'|1',60000);
 feed.subscribeBars({ticker:symbol},'1',bar=>values.push(bar),'active',()=>{});`);
 const initial=sent.filter(row=>row.type==='market-subscribe').at(-1).args;
 await message({type:'market-event',event:{listener:initial.listener,generation:initial.generation,sequence:1,as_of:2000,type:'bars',loaded_before:120000,history_tail_revision:'new-tail',bars:[{start:120000,end:180000,open:1,high:2,low:1,close:2}]}});
 await message({type:'mobile-market-resume'});
 const resumed=sent.filter(row=>row.type==='market-subscribe').at(-1).args;
 assert(resumed.generation>initial.generation,'foreground recovery must fence the old generation');
 assert.equal(resumed.cursor,120000,'resume starts at the last candle accepted by the chart');
 assert.equal(resumed.history_tail_revision,'new-tail');assert.equal(resumed.observed_at,2000);
 const count=ctx.values.length;
 await message({type:'market-event',event:{listener:initial.listener,generation:initial.generation,sequence:99,type:'bars',bars:[{start:180000,end:240000,open:9,high:9,low:9,close:9}]}});
 assert.equal(ctx.values.length,count,'retired stream cannot append during resync');
 await message({type:'market-event',event:{listener:resumed.listener,generation:resumed.generation,sequence:1,type:'bars',bars:[120000,180000,240000].map(start=>({start,end:start+60000,open:2,high:3,low:1,close:2.5,complete:start!==240000}))}});
 assert.deepEqual(Array.from(ctx.values.slice(-3),bar=>bar.time),[120000,180000,240000],'all missed bars and forming bar are accepted in order');
 const before=sent.length;run('mobileMode=false');await message({type:'mobile-market-resume'});assert.equal(sent.length,before,'desktop flow is unchanged');
 run("feed.unsubscribeBars('active')");
 console.log('PASS native mobile resume: accepted cursor/tail, generation fence, ordered catch-up and forming bar; desktop unchanged');
})().catch(error=>{console.error(error);process.exitCode=1});
