const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const root=require('node:path').resolve(__dirname,'../..');
const context={globalThis:{},Map,Set,JSON,Number,Promise,setTimeout,clearTimeout};
vm.createContext(context);
vm.runInContext(fs.readFileSync(require('node:path').join(root,'advanced-host/paio-display.js'),'utf8'),context);
const objects=context.paioObjects;
assert.equal(typeof objects,'function');
const chart={symbol:()=>"EURUSD",resolution:()=>"5",getPanes:()=>[{getHeight:()=>200,getMainSourcePriceScale:()=>({getVisiblePriceRange:()=>({from:1,to:2})})}]};
const snapshot={schema:'paio_presentation_v1',objects:[
  {id:'gap:1',kind:'box',left:1000,right:2000,top:1.2,bottom:1.1,color:'up',sequence:1,detected_at:2},
  {id:'pv:1',kind:'line',left:1000,right:9000,price:1.15,color:'one',style:'dot',width:2,sequence:2,detected_at:3},
  {id:'label:1',kind:'label',time:2000,price:null,bar_high:1.2,bar_low:1.1,location:'abovebar',text:'iiii',color:'io',size:'large',sequence:3,detected_at:4},
  {id:'na:1',kind:'label',time:3000,price:null,bar_high:1.2,bar_low:1.1,location:'price',text:'H1',color:'h',sequence:4,detected_at:5},
]};
const inputs={up:'rgba(8,153,129,.6)',one:'#434651',dot:'dotted',io:'#787b86',large:'large'};
const desired=objects(snapshot,inputs,chart);
assert.equal(desired.size,3,'na-coordinate object stays in the backend quota but is not drawn');
assert.equal(desired.get('gap:1').shape,'rectangle');
assert.equal(desired.get('gap:1').properties.backgroundColor,inputs.up);
assert.equal(desired.get('pv:1').properties.linestyle,1);
assert.equal(desired.get('label:1').text,'iiii');
assert.ok(desired.get('label:1').points[0].price>1.2);

let serial=0;const shapes=new Map(),errors=[];
const native={...chart,getStudyById:()=>({applyOverrides(){}}),getShapeById:id=>({setPoints(points){shapes.get(id).points=points;},setProperties(properties){shapes.get(id).properties=properties;}}),
  createShape:async(point,options)=>{const id=++serial;shapes.set(id,{point,options});return id;},
  createMultipointShape:async(points,options)=>{const id=++serial;shapes.set(id,{points,options});return id;},
  removeEntity:id=>shapes.delete(id)};
const renderer=context.chartPAIODisplay({report:error=>errors.push(error)});
const consumer={key:'chart|study',id:'study-1',chart:native,meta:{render_profile:'paio_v1'},inputs};
const presentation={...snapshot,objects:[snapshot.objects[0]]};
renderer.update(consumer,{identity:{main:'EURUSD',period:'5',revision:1},presentation});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
  await flush();assert.equal(shapes.size,1);
  renderer.update(consumer,{identity:{main:'EURUSD',period:'5',revision:1},presentation:{...presentation,objects:[]}});
  await flush();assert.equal(shapes.size,0,'removed backend objects are removed in the host');
  renderer.update(consumer,{identity:{main:'EURUSD',period:'5',revision:1},presentation});
  renderer.clear(consumer);await flush();assert.equal(shapes.size,0,'late native creation cannot revive a removed instance');
  assert.deepEqual(errors,[]);assert.equal(renderer.diagnostics().bindings,0);
  console.log('PASS PAIO plot object mapping, styles, missing-coordinate omission, corrections, cleanup and late-promise fencing');
})().catch(error=>{console.error(error);process.exitCode=1;});
