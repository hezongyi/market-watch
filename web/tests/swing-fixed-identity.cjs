const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
const context=vm.createContext({Map,Set,BigInt});
for(const file of ['series.js','swing-sr-display.js'])
  vm.runInContext(fs.readFileSync(path.join(root,'advanced-host',file),'utf8'),context);
vm.runInContext(`
  globalThis.store=swingSnapshotStore();
  globalThis.params={high_strength:5,low_strength:5};
  globalThis.page={indicators:[{name:'SWING_SR_V1',params,presentation:{
    render_profile:'swing_sr_v1',history_revision:'fixed-hash',as_of_bar_time:100,statistics_origin:0}}]};
`,context);
for(const ticker of ['MWH:63bc01d4-3943-45cc-93a5-b04c3caaab16','MWC:'+'abc012'.repeat(10)+'abcd']){
  context.ticker=ticker;
  vm.runInContext("store.publish(ticker.toUpperCase(),'60',page,store.ticket())",context);
  assert.ok(vm.runInContext("store.get(ticker,'60',params)",context),'renderer must find native uppercase fixed ticker');
  assert.equal(vm.runInContext("store.get(ticker,'240',params)",context),undefined);
  assert.equal(vm.runInContext("store.get(ticker,'60',{...params,high_strength:6})",context),undefined);
}
context.ticker='MWP:EURUSD';
vm.runInContext("store.publish(ticker,'60',page,store.ticket())",context);
assert.ok(vm.runInContext("store.get(ticker,'60',params)",context));
assert.equal(vm.runInContext("store.get('EURUSD','60',params)",context),undefined);
console.log('PASS Swing fixed identity normalization and series/period/parameter isolation');
