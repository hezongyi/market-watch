const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const sandbox = vm.createContext({setTimeout, WeakMap, Map, Promise});
vm.runInContext(fs.readFileSync('../advanced-host/native-alert-shell.js', 'utf8'), sandbox);
(async () => {
  let calls = 0;
  const transient = {e: async () => {if (++calls === 1) throw Object.assign(Error('chunk unavailable'), {name: 'ChunkLoadError'});}};
  await Promise.all([sandbox.nativeAlertChunks(transient, [1]), sandbox.nativeAlertChunks(transient, [1])]);
  assert.equal(calls, 2, 'concurrent consumers share the one bounded retry');
  calls = 0;
  const permanent = {e: async () => {calls++; throw Object.assign(Error('missing'), {name: 'ChunkLoadError'});}};
  await assert.rejects(sandbox.nativeAlertChunks(permanent, [2]), /missing/);
  assert.equal(calls, 2, 'missing assets remain a visible terminal failure after one retry');
  calls = 0;
  const unsupported = {e: async () => {calls++; throw Error('unsupported contract');}};
  await assert.rejects(sandbox.nativeAlertChunks(unsupported, [3]), /unsupported/);
  assert.equal(calls, 1, 'contract failures are never retried');
  console.log('PASS native chunk shared flight, one transient retry and terminal failure');
})().catch(error => {console.error(error); process.exitCode = 1;});
