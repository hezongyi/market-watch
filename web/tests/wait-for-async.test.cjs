const assert = require("node:assert/strict");
const waitForAsync = require("./wait-for-async.cjs");
(async () => {
  let calls = 0;
  await waitForAsync({evaluate: async () => ++calls === 3}, null, null, {timeout: 1000});
  assert.equal(calls, 3, "Resolved false promises must keep polling");
  await assert.rejects(waitForAsync({evaluate: async () => false}, null, null, {timeout: 10}), /timeout/);
  await assert.rejects(waitForAsync({evaluate: async () => {throw Error("browser failed");}}, null), /browser failed/);
  console.log("Async polling waits for truth, times out, and propagates browser failures");
})().catch(error => {console.error(error);process.exit(1);});
