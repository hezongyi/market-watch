// Snapshot isolation and the actual alert draft module, without an application fixture.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {transformSync}=require('esbuild');
const root=path.resolve(__dirname,'../..'),ctx=vm.createContext({});
for(const file of ['swing-sr-display.js','rolling-range-squeeze-display.js'])
 vm.runInContext(fs.readFileSync(path.join(root,'advanced-host',file),'utf8'),ctx);
const store=ctx.squeezeSnapshotStore(),params={k:3,lookback:20,low_pct:5,confirm_on_close:false};
const page=(revision,asof,origin=1)=>({history_revision:revision,indicators:[{
 name:'ROLLING_RANGE_SQUEEZE',params,presentation:{render_profile:'rolling_range_squeeze_v1',
 as_of_bar_time:asof,calculation_origin:origin,boxes:[],labels:[]}}]});
assert.equal(store.publish('EURUSD','60',page(2,100),2),true);
assert.equal(store.publish('EURUSD','60',page(1,200),3),false,'older input revision');
assert.equal(store.publish('EURUSD','60',page(2,200),1),false,'late old request');
assert.equal(store.publish('EURUSD','60',page(2,200,50),3),false,'page-local origin');
assert.equal(store.publish('EURUSD','60',page(3,90),1),true,'correction may retract latest bar');
for(const [symbol,res,p] of [['XAUUSD','60',params],['EURUSD','240',params],
 ['EURUSD','60',{...params,confirm_on_close:true}],['EURUSD','60',{...params,k:4}],
 ['EURUSD','60',{...params,low_pct:10}],['EURUSD','60',{...params,lookback:30}]])
 assert.equal(store.get(symbol,res,p),undefined,'independent calculation identity');
store.clear();assert.equal(store.get('EURUSD','60',params),undefined);
const moduleStub={exports:{}};
vm.runInNewContext(transformSync(fs.readFileSync(path.join(root,'web/src/advanced/chartAlerts.ts'),'utf8'),
 {loader:'ts',format:'cjs'}).code,{module:moduleStub,exports:moduleStub.exports});
const {freshDraft,normalizeCondition,indicatorUnit}=moduleStub.exports;
const indicator={name:'ROLLING_RANGE_SQUEEZE',version:'1',params,output:'signal'};
const draft=freshDraft({instrument:'EURUSD',series_kind:'provider',timeframe:'H1',indicator,association:null});
assert.equal(draft.name,'Rolling Range Squeeze');assert.equal(draft.message,'Rolling Range Squeeze triggered');
assert.equal(draft.condition.relation,'above');assert.equal(draft.condition.right.value,'0');
assert.equal(draft.condition.left.indicator.params.confirm_on_close,false);
assert.equal(indicatorUnit(indicator),'boolean');
assert.equal(indicatorUnit({...indicator,output:'sma'}),'price');
const incompatible=normalizeCondition({...draft.condition,right:{kind:'price'},offset:{kind:'atr'}});
assert.equal(incompatible.right.kind,'constant');assert.equal(incompatible.offset,undefined);
console.log('PASS squeeze snapshot isolation, revision/origin fences and source alert defaults');
