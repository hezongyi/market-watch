// Native drawings clamp unloaded dates. Exercise the shipped renderer against
// that behavior, then prepend/evict prices without changing the Python snapshot.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.resolve(__dirname,'../../advanced-host/rolling-range-squeeze-display.js'),'utf8');
const timers=[],shapes=new Map(),errors=[];
let range={from:300,to:600},nextId=0,visible=true;
const params={k:10,lookback:252,low_pct:5,confirm_on_close:true};
const input={...params,first_border_color:'green',first_fill_color:'green',next_border_color:'orange',
 next_fill_color:'orange',sma_color:'blue',label_text_color:'white',label_bg_color:'green'};
const stamp=points=>points.map(p=>({...p,time:Math.max(range.from,Math.min(range.to,p.time))}));
const study={getInputValues:()=>Object.entries(input).map(([id,value])=>({id,value})),
 isVisible:()=>visible,applyOverrides(){}};
const chart={dataReady:()=>true,symbol:()=> 'MWP:EURUSD',resolution:()=> '1D',
 getAllStudies:()=>[{id:'rrs',name:'Rolling Range Squeeze'}],getStudyById:()=>study,
 getShapeById:id=>({setPoints:points=>shapes.get(id).points=stamp(points),setProperties(){},bringToFront(){}}),
 createMultipointShape:async(points,options)=>{const id=++nextId;shapes.set(id,{points:stamp(points),options});return id;},
 removeEntity:id=>shapes.delete(id),
 _chartWidget:{model:()=>({model:()=>({mainSeries:()=>({bars:()=>({firstIndex:()=>0,lastIndex:()=>1})})})})},
 _convertIndexToPublicTime:index=>index===0?range.from:range.to};
const widget={chartsCount:()=>1,chart:()=>chart,subscribe(){},unsubscribe(){}};
const box=(id,left,right)=>({id,kind:'first',left_chart_time:left*1000,right_chart_time:right*1000,top:2,bottom:1});
const presentation={boxes:[box('old',100,200),box('crossing',200,400),box('recent',400,500)],
 labels:[{time:200000,chart_time:200000,price:2,text:'old'},
         {time:400000,chart_time:400000,price:2,text:'recent'}]};
const store={get:()=>({presentation,bars:[]}),clear(){}};
const ctx=vm.createContext({setInterval:callback=>{timers.push(callback);return 1;},clearInterval(){}});
vm.runInContext(source,ctx);
const display=ctx.chartSqueezeDisplay(widget,store,{identity:x=>x,report:error=>errors.push(error)});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const snapshot=()=>[...shapes.values()];
(async()=>{
 display.refresh();await settle();
 assert.equal(snapshot().filter(s=>s.options.shape==='balloon').length,1,'unloaded old labels must not pile up at the native boundary');
 assert.equal(snapshot().filter(s=>s.options.shape==='rectangle').length,2,'old boxes are deferred, crossing box is clipped');
 assert.ok(snapshot().some(s=>s.points[0].time===300&&s.points[1]?.time===400));
 const unchangedId=[...shapes].find(([,s])=>s.options.shape==='balloon')[0];
 range={from:100,to:600};timers[0]();await settle();
 assert.equal(snapshot().length,5,'prepending main candles restores all old drawings without a new calculation');
 assert.ok(snapshot().some(s=>s.options.shape==='balloon'&&s.points[0].time===200));
 assert.ok(snapshot().some(s=>s.options.shape==='rectangle'&&s.points[0].time===200&&s.points[1].time===400));
 assert.ok(shapes.has(unchangedId),'unchanged recent objects retain native IDs');
 range={from:450,to:600};display.refresh();await settle();
 assert.equal(snapshot().length,1,'evicting history removes unloaded labels instead of clamping them');
 assert.deepEqual(JSON.parse(JSON.stringify(snapshot()[0].points)),[{time:450,price:2},{time:500,price:1}]);
 visible=false;display.refresh();await settle();assert.equal(shapes.size,0);
 visible=true;display.refresh();await settle();assert.equal(shapes.size,1);
 display.dispose();assert.equal(shapes.size,0);assert.deepEqual(errors,[]);
 console.log('PASS native-clamped history, crossing boxes, prepend/reprojection, eviction, visibility and disposal');
})().catch(error=>{console.error(error);process.exitCode=1;});
