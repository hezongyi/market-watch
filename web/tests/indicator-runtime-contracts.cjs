// Exercise actual backend progress shape, main-tail updates and dependency demand.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=require('node:path').resolve(__dirname,'../..');
function harness({binding={revision:'fixed-1',inputRevision:7,calculationStart:1000},read,studies=[{id:'a',period:5}],demand=()=>{}}){
 let clock=10000;const batches=[],states=[],reports=[],coverage=new Map(),revisions=new Map();
 const chart={_chartWidget:{},symbol:()=> 'MWC:fixed-composite',resolution:()=> '5',dataReady:()=>true,
  getAllStudies:()=>studies,getStudyById:id=>({isVisible:()=>!studies.find(s=>s.id===id).hidden,
   getInputValues:()=>[{id:'period',value:studies.find(s=>s.id===id).period}]}),
  onDataLoaded:()=>({subscribe(){},unsubscribe(){}})};
 const adapter={scope:(chart,id)=>({generation:1,name:'LWMA',resolution:'5',first:1000,last:2000,count:2,coverage:coverage.get(id)}),
  attach:(chart,id,identity)=>({generation:1,identity,id}),detach:handle=>coverage.delete(handle.id),invalidate:async(handle,range,revision)=>Number(revision)>=Number(revisions.get(handle.id) || 0),
  applyBatch:async(handle,batch)=>{revisions.set(handle.id,batch.inputRevision);batches.push({id:handle.id,...batch});coverage.set(handle.id,{...batch.coverage,generation:1});return true;}};
 class Clock extends Date{static now(){return clock;}}
 const context={MWNativeIndicatorResults:adapter,queueMicrotask,Date:Clock,setInterval:()=>1,clearInterval(){},
  indicatorBindings:new Map(),indicatorCoordinator:undefined,decode:()=>({series_kind:'composite'})};
 const bridge=fs.readFileSync(root+'/advanced-host/bridge.js','utf8');
 const bindingSource=bridge.slice(bridge.indexOf('function rememberIndicatorBinding('),bridge.indexOf('function startIndicatorCoordinator('));
 vm.runInNewContext(bindingSource+fs.readFileSync(root+'/advanced-host/indicator-coordinator.js','utf8'),context);
 context.indicatorBindings.set(chart.symbol()+'|5',binding);
 const coordinator=context.chartIndicatorCoordinator({chartsCount:()=>1,chart:()=>chart},
  {LWMA:{params:{period:5},series:[{key:'value'}]}},{
   identity:{binding:()=>context.indicatorBindings.get(chart.symbol()+'|5'),chartTime:bar=>bar.start},
   status:(consumer,state)=>states.push({id:consumer.id,state}),report:error=>reports.push(error),read,demand});
 return {coordinator,context,chart,batches,states,reports,advance:ms=>{clock+=ms;}};
}
const bars=[{start:1000,open:'1',high:'2',low:'1',close:'2'},
 {start:2000,open:'2',high:'3',low:'2',close:'3'}];
function page(specs,pendingPeriod=null,value=10){
 const progress=specs.map(spec=>({id:spec.name,run_id:'run-'+spec.params.period,
  status:spec.params.period===pendingPeriod?'pending':'complete',cursor:spec.params.period===pendingPeriod?1000:3000,input_revision:7}));
 return {bars,input_revision:7,has_more:false,indicator_progress:progress,
  indicators:specs.map((spec,i)=>({id:spec.name,...spec,calculation:progress[i],
   series:[{key:'value',values:spec.params.period===pendingPeriod?[]:bars.map(b=>({time:b.start,value}))}]}))};
}
(async()=>{
 const bridge=fs.readFileSync(root+'/advanced-host/bridge.js','utf8');
 const querySource=bridge.slice(bridge.indexOf('function query('),bridge.indexOf('// Share only in-flight planning reads;'));
 let requests=0;
 const queryContext={decode:()=>({symbol:'TEST',series_kind:'managed'}),frames:{'1':'M1'},
  managedSessions:new Map(),cache:new Map(),workspaceEpoch:1,Date:class extends Date {static now(){return 1000;}},
  hasHistoryViewer:()=>true,MWSeries:{encode:s=>s},request:async()=>({value:++requests}),
  alertCalculationOrigins:new Map(),alertCompositeRevisions:new Map()};
 vm.runInNewContext(querySource,queryContext);
 const args={before:3001,indicators:[{name:'EMA',params:{period:5}}]};
 assert.equal((await queryContext.query('TEST','1',args)).value,1);
 assert.equal((await queryContext.query('TEST','1',args)).value,2,
  'new accepted tail/correction demand must not reuse completed managed response');

 let pending=5,reads=0;
 const progress=harness({studies:[{id:'a',period:5},{id:'b',period:7}],read:async(t,r,args)=>{reads++;return page(args.indicators,pending);}});
 await progress.coordinator.sync();
 assert.deepEqual(progress.batches.map(b=>b.id),['b'],'ready parameter sibling must render while another run is pending');
 assert.ok(!progress.states.some(s=>s.id==='a'&&s.state==='ready'),'pending backend run cannot become ready');
 pending=null;progress.advance(2000);await progress.coordinator.sync();
 assert.equal(reads,2);assert.ok(progress.batches.some(b=>b.id==='a'&&b.rows.at(-1).values[0]===10));
 assert.deepEqual(progress.reports,[]);progress.coordinator.dispose();

 let value=10;reads=0;
 const tail=harness({read:async(t,r,args)=>{reads++;return page(args.indicators,null,value);}});
 const remember=page=>tail.context.rememberIndicatorBinding(tail.chart.symbol(),'5',page);
 remember({revision_id:'fixed-1',input_revision:7,origin:1000,history_revision:'first',bars});
 await tail.coordinator.sync();assert.equal(reads,1);
 value=20;remember({type:'bars',input_revision:7,history_revision:'second',history_tail_revision:'changed',
  bars:[{...bars[1],close:'20',high:'20'}]});
 await tail.coordinator.sync();assert.equal(reads,2,'same-time mutable tail must reread');
 assert.equal(tail.batches.at(-1).rows.at(-1).values[0],20);
 remember({type:'bars',input_revision:7,history_revision:'credentials-only',bars:[]});
 await tail.coordinator.sync();assert.equal(reads,2,'empty metadata update must not duplicate tail reads');
 remember({input_revision:7,origin:1000,bars:[{start:0,open:'1',high:'2',low:'1',close:'2'}]});
 await tail.coordinator.sync();assert.equal(reads,2,'older main page must not replace the mutable tail token');
 tail.coordinator.dispose();

 let managedReads=0;
 const managed=harness({binding:{revision:'published:1',calculationStart:1000},read:async(t,r,args)=>{
  managedReads++;const result=page(args.indicators);delete result.input_revision;result.history_revision='100';return result;}});
 managed.context.rememberIndicatorBinding(managed.chart.symbol(),'5',{bars});
 await managed.coordinator.sync();assert.equal(managedReads,1);
 managed.context.rememberIndicatorBinding(managed.chart.symbol(),'5',{}, {correction:true});
 await managed.coordinator.sync();assert.equal(managedReads,2,
  'managed invalidation must use the same numeric domain as accepted results');
 managed.coordinator.dispose();

 const fallback=harness({read:async(t,r,args)=>page(args.indicators)});
 const ticker=fallback.chart.symbol(),key=ticker+'|5';
 Object.assign(fallback.context.indicatorBindings.get(key),{firstStart:2000,dependencyRevision:'old'});
 Object.assign(fallback.context,{indicatorDependencyOrigins:new Map([[key,1000]]),
  query:async()=>({history_check:{revision:'new'}}),first:{symbol:ticker,res:'5'},identity:{series_kind:'composite'},result:{bars:[]}});
 const pollSource=bridge.slice(bridge.indexOf('        const dependencyOrigin=indicatorDependencyOrigins.get(first.symbol'),
  bridge.indexOf('        const bars = barsOf(result, first.res, first.symbol);',bridge.indexOf('        const dependencyOrigin=indicatorDependencyOrigins.get(first.symbol')));
 vm.runInNewContext('async function prefixPoll(){'+pollSource+'}',fallback.context);
 await fallback.context.prefixPoll();await fallback.context.prefixPoll();
 assert.equal(fallback.context.indicatorBindings.get(key).dependencyRevision,'new');
 assert.equal(fallback.context.indicatorBindings.get(key).correctionVersion,1,
  'polling must retain proof before replacing binding so one repair withdraws only once');
 fallback.coordinator.dispose();

 const demands=[],studies=[{id:'a',period:5},{id:'b',period:7}];
 const deps=harness({studies,demand:rows=>demands.push(JSON.parse(JSON.stringify(rows))),read:async(t,r,args)=>page(args.indicators)});
 await deps.coordinator.sync();
 assert.deepEqual(demands.at(-1),[{ticker:'MWC:fixed-composite',resolution:'5',origin:1000}],
  'one main dependency demand covers all visible studies');
 studies.forEach(s=>s.hidden=true);await deps.coordinator.sync();assert.deepEqual(demands.at(-1),[],'hiding all studies releases dependency demand');
 studies[0].hidden=false;await deps.coordinator.sync();assert.equal(demands.at(-1).length,1);
 deps.coordinator.dispose();assert.deepEqual(demands.at(-1),[],'workspace disposal releases dependency demand');
 console.log('PASS runtime contracts: per-run pending/completion, same-time tail updates and visible dependency lifetime');
})().catch(error=>{console.error(error);process.exitCode=1;});
