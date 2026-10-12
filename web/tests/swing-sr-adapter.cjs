/* Mapping and snapshot ordering tests; real native rendering is a separate gate. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname,'../..');
const catalog = JSON.parse(execFileSync(path.join(root,'.venv/bin/python'),['-c',
  'import json; from alerts.chart_indicators import public_catalog; print(json.dumps(public_catalog()))'],
  {cwd:root,env:{...process.env,PYTHONPATH:path.join(root,'backend')}}));
const context = vm.createContext({Map,Set,Date,console,btoa:value=>Buffer.from(value).toString('base64')});
for(const file of ['indicators.js','swing-sr-display.js'])
  vm.runInContext(fs.readFileSync(path.join(root,'advanced-host',file),'utf8'),context);
const PineJS={Std:{ticker:()=> 'MWP:EURUSD',period:()=> '240',time:ctx=>ctx.index ? 60 : 60,
  volume:()=>1,close:ctx=>ctx.index < 3 ? 1.1242 : 1.11711}};
context.catalog=catalog;context.PineJS=PineJS;
const studies=vm.runInContext('pythonStudies(PineJS,catalog)',context);
const swing=studies.find(item=>item.metainfo.id==='MWPythonSWING_SR_V1@market-watch-1');
assert.equal(swing.metainfo.shortDescription,'Swing');
assert.equal(swing.metainfo.plots.length,4);
assert.deepEqual(Array.from(Object.values(swing.metainfo.defaults.styles),s=>s.plottype),[6,6,6,6]);
assert.deepEqual(Array.from(Object.values(swing.metainfo.defaults.styles),s=>s.color),['#f23645','#f23645','#00bcd4','#00bcd4']);
assert.ok(Object.values(swing.metainfo.defaults.styles).every(s=>s.joinPoints===false));
const cfg=swing.metainfo.inputs;
assert.equal(cfg.find(i=>i.id==='show_average_spacing').type,'bool');
assert.equal(cfg.find(i=>i.id==='statistics_position').type,'text');
assert.equal(cfg.find(i=>i.id==='statistics_position').display,0);
const tickerSpecs=[];
const ctx={index:0,symbol:{info:{ticker:'MWP:EURUSD'}},select_sym(index){this.index=index;},
  new_sym(ticker){tickerSpecs.push(JSON.parse(Buffer.from(ticker.slice(5),'base64').toString()));},
  new_var(value){return {adopt:()=>value};}};
const study=new swing.constructor();
study.init(ctx,index=>[3,7,'high','low',true,'bottom_left'][index]);
assert.deepEqual(Array.from(study.main(ctx),v=>v.offset),[0,-3,0,-7]);
assert.deepEqual(Array.from(study.main(ctx),v=>v.value),[1.1242,1.1242,1.11711,1.11711]);
assert.ok(tickerSpecs.every(s=>JSON.stringify(s.spec)==='{"name":"SWING_SR_V1","params":{"high_strength":3,"low_strength":7}}'));
study.init(ctx,index=>[1,2,'high','low',false,'below_name'][index]);
assert.deepEqual(Array.from(study.main(ctx),v=>v.offset),[0,-1,0,-2]);
for(const old of studies.filter(s=>s!==swing)) {
  assert.ok(Object.values(old.metainfo.defaults.styles).every(s=>s.plottype!==6));
  assert.equal(old.metainfo.inputs.length,Object.keys(catalog[old.name.slice('守望 Python '.length)].params).length);
}
const store=vm.runInContext('swingSnapshotStore()',context);
const p={render_profile:'swing_sr_v1',as_of_bar_time:100,statistics_origin:0,current:{high:null,low:null},statistics:{}};
const page=(params,presentation)=>({indicators:[{name:'SWING_SR_V1',params,presentation}],history_revision:'one',bars:[]});
const params={high_strength:3,low_strength:7};
const old=store.ticket(),fresh=store.ticket();
store.publish('MWP:EURUSD','240',page(params,p),fresh);
store.publish('MWP:EURUSD','240',page(params,{...p,as_of_bar_time:200}),old);
assert.equal(store.get('MWP:EURUSD','240',params).presentation.as_of_bar_time,100,'late response must not overwrite newer request');
store.publish('MWP:EURUSD','240',page(params,{...p,as_of_bar_time:99}),store.ticket());
assert.equal(store.get('MWP:EURUSD','240',params).presentation.as_of_bar_time,100,'historical page cannot replace current cutoff');
store.publish('MWP:EURUSD','240',page(params,{...p,statistics_origin:50}),store.ticket());
assert.equal(store.get('MWP:EURUSD','240',params).presentation.statistics_origin,0,'page warmup cannot become statistics origin');
assert.equal(store.get('EURUSD','240',params),undefined,'managed and provider identity must differ');
assert.equal(store.get('MWP:EURUSD','60',params),undefined,'period identity must differ');
assert.equal(store.get('MWP:EURUSD','240',{...params,high_strength:4}),undefined,'strength identity must differ');
store.clear();assert.equal(store.get('MWP:EURUSD','240',params),undefined);
store.publish('MWP:EURUSD','240',page(params,p),store.ticket());
store.publish('MWP:EURUSD','240',{...page(params,{...p,as_of_bar_time:50,statistics_origin:25}),history_revision:'corrected'},store.ticket());
assert.equal(store.get('MWP:EURUSD','240',params).presentation.as_of_bar_time,50,'new revision invalidates the old range');
const bridgeContext=vm.createContext({document:{createElement:()=>({}),head:{append:()=>{}}},
  URL,URLSearchParams,Map,Set,Promise,Date,Intl,Error,location:{search:'?parent=http://localhost'},
  parent:{postMessage(){}},crypto:{randomUUID:()=> 'fixture'},addEventListener(){},setTimeout,clearTimeout,
  btoa:value=>Buffer.from(value).toString('base64'),atob:value=>Buffer.from(value,'base64').toString()});
for(const file of ['series.js','swing-sr-display.js','bridge.js'])
  vm.runInContext(fs.readFileSync(path.join(root,'advanced-host',file),'utf8'),bridgeContext);
bridgeContext.testRequests=[];
bridgeContext.page=page(params,p);
bridgeContext.tickers=['high','high_left','low','low_left'].map(key=>'MWPY_'+Buffer.from(JSON.stringify(
  {symbol:'MWP:EURUSD',spec:{name:'SWING_SR_V1',params},key})).toString('base64'));
vm.runInContext('request=(q)=>{testRequests.push(q);return Promise.resolve(page)}',bridgeContext);
(async()=>{
 await vm.runInContext("Promise.all(tickers.map(t=>query(t,'240',{limit:175})))",bridgeContext);
 assert.equal(bridgeContext.testRequests.length,1,'four plots share one in-flight calculation request');
 assert.equal(bridgeContext.testRequests[0].indicators.length,1);
 console.log('Swing four-plot datafeed request coalescing passed');
})().catch(error=>{console.error(error);process.exitCode=1});
console.log('Swing adapter: 4 circles, independent offsets, display-only inputs, old 8 studies and snapshot fences passed');
