// A native history restart retains plot coverage while retiring the drawing
// consumer. Its replacement must rebuild recent drawings as well as old ones.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const root=require('node:path').resolve(__dirname,'../..');
let generation=1,available=true,coverage,serial=0,scopeFirst=3000;
const nativeRows=new Map(),shapes=new Map(),batches=[],reads=[],errors=[];
const inputs={timeframe:'D',pattern_type:'NR4/NR7',show_signals:false,
  nr4_color:'#66bb6a',nr7_color:'#ffee58',range_color:'#787b86'};
const keys=['range_high','range_low','range_mid','range_start','range_end','pattern_high',
  'pattern_low','pattern_type','pattern_start','pattern_end','period_start'];
const chart={_chartWidget:{},symbol:()=>'TEST',resolution:()=>'60',dataReady:()=>true,
  getAllStudies:()=>[{id:'nr'}],getStudyById:()=>({isVisible:()=>true,
    getInputValues:()=>Object.entries(inputs).map(([id,value])=>({id,value}))}),
  onDataLoaded:()=>({subscribe(){},unsubscribe(){}}),
  createMultipointShape:async(points,options)=>{const id=++serial;shapes.set(id,{points,options});return id;},
  getShapeById:id=>({setPoints:points=>{shapes.get(id).points=points;},
    setProperties:properties=>{shapes.get(id).properties=properties;},bringToFront(){}}),
  removeEntity:id=>shapes.delete(id)};
const adapter={scope:()=>available?{generation,name:'NR',resolution:'60',first:scopeFirst,last:6000,
    count:(6000-scopeFirst)/1000+1,coverage}:null,
  attach:(_chart,_id,identity)=>({generation,identity}),
  detach:handle=>{if(handle.generation===generation){nativeRows.clear();coverage=null;}},
  applyBatch:async(_handle,batch)=>{batches.push(batch);if(batch.kind==='snapshot')nativeRows.clear();
    for(const row of batch.rows)nativeRows.set(row.time,row);coverage=batch.coverage;return true;}};
const context=vm.createContext({MWNativeIndicatorResults:adapter,queueMicrotask,Date,crypto,
  setInterval:()=>1,clearInterval(){}});
for(const file of ['nr-breakout-display.js','indicator-coordinator.js'])
  vm.runInContext(fs.readFileSync(root+'/advanced-host/'+file,'utf8'),context);
const drawings=context.chartNRBreakoutDisplay({report:error=>errors.push(String(error))});
const coordinator=context.chartIndicatorCoordinator({chartsCount:()=>1,chart:()=>chart},
  {NR:{render_profile:'nr_breakout_v1',params:{timeframe:'D',pattern_type:'NR4/NR7'},series:keys.map(key=>({key}))}},
  {drawings,identity:{binding:()=>({revision:'fixed',inputRevision:1,tailVersion:1,calculationStart:0}),chartTime:b=>b.start},
    report:error=>errors.push(String(error)),read:async(_ticker,_resolution,args)=>{
      reads.push(args);const bars=[0,1000,2000,3000,4000,5000,6000].filter(t=>t<args.before)
        .slice(-args.limit).map(start=>({start}));
      const value=(key,t)=>({range_high:12,range_low:8,range_mid:10,
        range_start:t>=5000?5000:1000,range_end:t,pattern_high:12,pattern_low:8,
        pattern_type:7,pattern_start:t>=5000?4000:0,pattern_end:t>=5000?5000:1000,period_start:t})[key];
      return {bars,input_revision:1,has_more:false,indicators:[{name:'NR',params:{timeframe:'D',pattern_type:'NR4/NR7'},
        series:keys.map(key=>({key,values:bars.map(b=>({time:b.start,value:value(key,b.start)}))}))}]};}});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const boxes=()=>[...shapes.values()].filter(s=>s.options.shape==='rectangle').map(s=>s.points[0].time).sort();
(async()=>{
  await coordinator.sync();await flush();assert.deepEqual(boxes(),[0,4]);
  // The new native generation owns retained rows. Detaching its old handle
  // must leave those rows intact, matching the real external-results adapter.
  generation++;available=false;await coordinator.sync();await flush();
  assert.equal(shapes.size,0);assert.equal(nativeRows.size,4);
  available=true;scopeFirst=1000;await coordinator.sync();await flush();
  assert.deepEqual(boxes(),[0,4],'native restart plus prepend must restore the latest NR box');
  assert.equal(nativeRows.size,6);
  assert.equal(batches.at(-1).kind,'snapshot','missing drawings need complete accepted history');
  assert.equal(reads.at(-1).before,6001);
  // Ordinary pagination keeps the local projection and still uses an increment.
  scopeFirst=0;await coordinator.sync();await flush();
  assert.equal(batches.at(-1).kind,'prepend');assert.deepEqual(boxes(),[0,4]);
  // A restart without an earlier boundary must not rebuild from a one-row tail.
  generation++;available=false;await coordinator.sync();available=true;
  await coordinator.sync();await flush();assert.deepEqual(boxes(),[0,4]);
  assert.equal(batches.at(-1).kind,'snapshot');assert.deepEqual(errors,[]);
  coordinator.dispose();await flush();assert.equal(shapes.size,0);
  console.log('PASS NR drawings survive retained native coverage across history restart, prepend and tail');
})().catch(error=>{console.error(error);process.exitCode=1;});
