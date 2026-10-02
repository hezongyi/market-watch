const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
(async () => {
  const timers = new Map();
  let seq = 0, saves = 0, rejectWrite = false;
  const persisted = [];
  const context = vm.createContext({
    setInterval(callback, delay) { const id = ++seq; timers.set(id, {callback, delay}); return id; },
    clearInterval(id) { timers.delete(id); },
  });
  vm.runInContext(fs.readFileSync('../advanced-host/chart-autosave.js', 'utf8'), context);
  const control = context.chartAutoSave([], async value => {
    if (rejectWrite) throw Error('conflict');
    persisted.push(value);
  }, () => saves++, false);
  assert.equal(control.enabled, false);
  assert.equal(timers.size, 0);
  await control.select(true);
  assert.equal(timers.size, 1);
  const timer = [...timers.values()][0];
  assert.equal(timer.delay, 30000);
  timer.callback(); assert.equal(saves, 1);
  rejectWrite = true;
  await assert.rejects(control.select(false), /conflict/);
  assert.equal(control.enabled, true); assert.equal(timers.size, 1);
  rejectWrite = false;
  await control.select(false);
  assert.equal(timers.size, 0);
  assert.deepEqual(persisted, [true, false]);
  const restored = context.chartAutoSave([{kind:'setting',name:'mw.autoSave',content:{value:true}}], async()=>{},()=>{},false);
  assert.equal(restored.enabled,true); restored.dispose(); assert.equal(timers.size,0);
  const readonly = context.chartAutoSave([{kind:'setting',name:'mw.autoSave',content:{value:true}}], async()=>{throw Error('readonly');},()=>{},true);
  await readonly.select(true); assert.equal(readonly.enabled,false); assert.equal(timers.size,0);
  console.log('autosave toggle: default off, 30s interval, reload, failed writes and readonly passed');
})().catch(error=>{console.error(error);process.exitCode=1});
