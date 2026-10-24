const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const context=vm.createContext({});
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../../advanced-host/nr-breakout-display.js'),'utf8'),context);
const {nrBreakoutObjects:objects,chartNRBreakoutDisplay:renderer}=context;
assert.match(fs.readFileSync(require('node:path').join(__dirname,'../../advanced-host/build-assets.mjs'),'utf8'),/'nr-breakout-display\.js'/,'production bundle must include the renderer');
assert.match(fs.readFileSync(require('node:path').join(__dirname,'../../advanced-host/Dockerfile'),'utf8'),/COPY[^\n]*advanced-host\/nr-breakout-display\.js/,'Docker assets stage must copy the renderer');
const inputs={show_signals:true,signal_size:'Small',up_color:'#089981',down_color:'#f23645',
  nr4_color:'rgba(102,187,106,.3)',nr7_color:'rgba(255,238,88,.3)',range_color:'#787b86'};
const row=(time,start,end,signal=null)=>({time,drawing:{range_start:start,range_end:end,range_high:12,range_low:8,
  range_mid:10,period_start:time,pattern_start:start-1000,pattern_end:start,pattern_high:12,pattern_low:8,
  pattern_type:7,up_signal:signal,down_signal:null}});
const plain=value=>JSON.parse(JSON.stringify(value));
const rows=[row(2000,2000,2000),row(3000,2000,3000,8),row(4000,2000,3000),row(5000,2000,5000,8)];
const geometry=objects(rows,inputs);
assert.deepEqual(plain(geometry.get('line:2000:high').points),[{time:2,price:12},{time:5,price:12}]);
assert.equal(geometry.get('line:2000:mid').properties.linestyle,2);
assert.equal(geometry.get('signal:3000:up').text,'\n▲');
assert.equal(geometry.get('signal:3000:up').points[0].price,8);
assert.equal(objects([rows[0]],inputs).size,1,'Pine first-bar lines have zero length');
assert.equal([...objects(rows,{...inputs,show_signals:false}).keys()].filter(k=>k.startsWith('signal:')).length,0);
const many=Array.from({length:600},(_,i)=>row((i+2)*1000,(i+2)*1000,(i+3)*1000,8));
const limited=objects(many,inputs),count=prefix=>[...limited.keys()].filter(k=>k.startsWith(prefix)).length;
assert.equal(count('line:'),500);assert.equal(count('signal:'),500);assert.equal(count('box:'),499);

(async()=>{
  let serial=0,symbol='TEST';const shapes=new Map(),pending=[],errors=[],layers=[];
  const chart={symbol:()=>symbol,resolution:()=>'1D',
    createMultipointShape:(points,options)=>create(points,options),createShape:(point,options)=>create([point],options),
    getShapeById:id=>({setPoints:points=>{shapes.get(id).points=points;},
      setProperties:properties=>{shapes.get(id).properties=properties;},
      bringToFront:()=>{const i=layers.indexOf(id);if(i>=0)layers.splice(i,1);layers.push(id);}}),removeEntity:id=>{shapes.delete(id);const i=layers.indexOf(id);if(i>=0)layers.splice(i,1);}};
  function create(points,options){const id=++serial;shapes.set(id,{points,options});return new Promise(resolve=>pending.push(()=>resolve(id)));}
  const display=renderer({report:e=>errors.push(e),centerText:(_chart,id)=>{shapes.get(id).centered=true;}}),consumer={key:'pane1|id1',id:'id1',chart,inputs,
    meta:{render_profile:'nr_breakout_v1'}};
  const flush=async()=>{await Promise.resolve();pending.splice(0).forEach(done=>done());await new Promise(resolve=>setImmediate(resolve));};
  const update=(rows,kind='snapshot',identity={revision:1})=>display.update(consumer,{rows,kind,identity});
  update(rows);await flush();assert.equal(shapes.size,6);
  assert.deepEqual(layers.map(id=>shapes.get(id).options.shape),['rectangle','trend_line','trend_line','trend_line','text','text']);
  assert.ok([...shapes.values()].filter(s=>s.options.shape==='text').every(s=>s.centered));
  assert.ok([...shapes.values()].every(s=>s.options.ownerStudyId==='id1'&&s.options.disableSave&&s.options.disableUndo));
  update([row(6000,2000,6000)],'append');await flush();
  assert.ok([...shapes.values()].some(s=>s.options.shape==='trend_line'&&s.points[1].time===6));
  update([row(1000,1000,2000)],'prepend');await flush();assert.equal(shapes.size,10);
  assert.deepEqual(layers.slice(0,2).map(id=>shapes.get(id).options.shape),['rectangle','rectangle'],'prepended boxes remain below all range lines and signals');
  update(rows.slice(0,1));await flush();assert.equal(shapes.size,1,'short snapshot retracts lines and signals');
  update(rows);await Promise.resolve();update([]);await flush();assert.equal(shapes.size,0,'late promises cannot revive a removed correction');
  update(rows);await flush();consumer.inputs={...inputs,signal_size:'Huge',range_color:'#ff0000'};display.refresh(consumer);
  assert.ok([...shapes.values()].filter(s=>s.options.shape==='text').every(s=>s.properties.fontsize===24));
  assert.ok([...shapes.values()].filter(s=>s.options.shape==='trend_line').every(s=>s.properties.linecolor==='#ff0000'));
  consumer.inputs={...inputs,show_signals:false};display.refresh(consumer);assert.equal(shapes.size,4);
  const second={...consumer,key:'pane2|id2',id:'id2'};
  display.update(second,{rows,kind:'snapshot',identity:{revision:1}});await flush();assert.equal(shapes.size,8);
  display.clear(consumer);assert.equal(shapes.size,4,'removal is isolated per study');
  symbol='OTHER';display.refresh(second);assert.equal(shapes.size,0,'symbol change retires geometry');
  update(rows,'snapshot',{revision:2});await Promise.resolve();display.dispose();await flush();assert.equal(shapes.size,0);
  assert.deepEqual(errors,[]);assert.equal(display.diagnostics().bindings,0);
  console.log('PASS NR4/NR7 geometry, source caps, style changes, pagination, corrections, asynchronous removal and per-study isolation');
})().catch(error=>{console.error(error);process.exitCode=1;});
