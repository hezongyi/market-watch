const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const repo = require('node:path').resolve(__dirname, '../..');
const bridge = fs.readFileSync(repo + '/advanced-host/bridge.js', 'utf8');
const wrapperStart = bridge.indexOf('  layouts.saveChart = async (data) => {');
const wrapperEnd = bridge.indexOf('  const viewportBindings', wrapperStart);
assert.ok(wrapperStart >= 0 && wrapperEnd > wrapperStart);
const dirtyStart = bridge.indexOf('function markWorkspaceDirty()');
const dirtyEnd = bridge.indexOf('const resolutions', dirtyStart);
const context = vm.createContext({
  barRangeMapping: {snapshot:()=>({version:1,enabled:true,style:'rectangle'})},
  layouts: {}, viewportRestoring: false, rangeGuard: null, edgeGuard: null,
  busySaveNoticeShown: false, initialNativeSave: false, workspace: {id:'example'},
  editRevision: 0, workspaceEpoch: 0, dirty: true, nativeReadonly: false,
  ready: true, loading: false, grid: {value:'dotted'}, offset:10, messages:[],
  setTimeout, requestAnimationFrame: fn => setTimeout(fn,0),
});
vm.runInContext(`
  const send = value => messages.push(value);
  const scale = {barSpacing:()=>10, rightOffset:()=>offset, width:()=>1000};
  const chart = {symbol:()=> 'MWP:EURUSD', resolution:()=> '1D',
    getVisibleRange:()=>({from:100,to:200}),getTimeScale:()=>scale};
  const sync = {value:()=>false, setValue:()=>{}};
  const widget = {chartsCount:()=>1,chart:()=>chart,dateRangeSync:()=>sync,
    timeSync:()=>sync,save:callback=> {globalThis.finishCapture = callback;}};
  const saveLayout = async data => {globalThis.saved = data; return 'example';};
`, context);
context.__widget=vm.runInContext('widget',context);
require('./fixtures/sync-coordinator.cjs')(context,context.__widget);
vm.runInContext(fs.readFileSync(repo + '/advanced-host/viewports.js', 'utf8'), context);
vm.runInContext(bridge.slice(dirtyStart, dirtyEnd), context);
vm.runInContext(bridge.slice(wrapperStart, wrapperEnd), context);
(async () => {
  const pending = context.layouts.saveChart({id:'example',name:'Example'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(typeof context.finishCapture,'function');
  // A user scroll after viewport capture, before the public widget.save callback.
  vm.runInContext('offset=20;markWorkspaceDirty();', context);
  assert.equal(context.dirty,true);
  context.finishCapture({charts:[]});
  await pending;
  const savedOffset = JSON.parse(context.saved.content)._mwViewports[0].offset;
  const wronglyClean = !context.dirty && context.messages.some(m=>m.type==='native-saved');
  console.log(JSON.stringify({saved_offset:savedOffset,current_offset:context.offset,
    dirty:context.dirty,messages:context.messages,bug_reproduced:savedOffset!==context.offset&&wronglyClean}));
  assert.equal(savedOffset,10);
  assert.deepEqual(JSON.parse(context.saved.content)._mwBarRangeMapping,{version:1,enabled:true,style:'rectangle'});
  assert.equal(context.offset,20);
  assert.equal(context.dirty,true,'viewport edit during capture must remain dirty');
  assert.equal(wronglyClean,false,'stale snapshot cannot acknowledge the newer viewport');
  context.messages.length=0;
  const unchanged=context.layouts.saveChart({id:'example',name:'Example'});
  await new Promise(resolve=>setImmediate(resolve));
  context.finishCapture({charts:[]});
  await unchanged;
  assert.equal(context.dirty,false);
  assert.ok(context.messages.some(m=>m.type==='native-saved'));
  context.messages.length=0;context.dirty=true;
  const oldWorkspace=context.layouts.saveChart({id:'example',name:'Example'});
  await new Promise(resolve=>setImmediate(resolve));
  context.workspaceEpoch++;
  context.finishCapture({charts:[]});
  await oldWorkspace;
  assert.equal(context.dirty,true,'old workspace save cannot clean current workspace');
  assert.ok(!context.messages.some(m=>m.type==='native-saved'));
  console.log('Native save preserves edits and workspace switches during async capture; unchanged snapshot acknowledges.');
})().catch(error=>{console.error(error);process.exitCode=1});
