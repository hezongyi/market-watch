const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const sent = [];
const context = vm.createContext({
  URL,
  URLSearchParams,
  Map,
  Promise,
  Date,
  Intl,
  Error,
  location: { search: "?parent=http://localhost" },
  parent: { postMessage: (message) => sent.push(message) },
  crypto: { randomUUID: () => "test" },
  addEventListener() {},
  setTimeout: () => 1,
  clearTimeout() {},
});
vm.runInContext(fs.readFileSync("../advanced-host/series.js", "utf8"), context);
vm.runInContext(fs.readFileSync("../advanced-host/chart-runtime.js", "utf8"), context);
(async () => {
  const result = vm.runInContext(
    `(async () => {
    let active = true;
    hasHistoryViewer = () => active;
    for (let i = 0; i < 4; i++) request({ op: 'blocker' }, 'workspace');
    const old = historyQuery({instrument:'EURUSD', timeframe:'MN', before:123, limit:90})
      .then(() => 'resolved', e => e.code);
    active = false;
    pending.clear();
    drain();
    return old;
  })()`,
    context,
  );
  assert.equal(
    sent.filter((m) => m.query?.op === "history").length,
    0,
    "a queued history request must be rechecked before it can schedule backfill",
  );
  assert.equal(await result, "HISTORY_CANCELLED");
  await vm.runInContext(
    `(async () => {
    hasHistoryViewer = () => true;
    const args = {instrument:'EURUSD', timeframe:'MN', before:456, limit:3};
    const current = historyQuery(args);
    const [id, entry] = [...pending.entries()][0];
    pending.delete(id);
    entry.resolve({status:'ready'});
    await current;
    for (let i = 0; i < 4; i++) request({op:'blocker'}, 'workspace');
    const oldWorkspace = historyQuery({...args, before:789})
      .then(() => 'resolved', e => e.code);
    workspaceEpoch++;
    const newWorkspace = historyQuery({...args, before:789});
    pending.clear();
    drain();
    const [newId, newEntry] = [...pending.entries()][0];
    pending.delete(newId);
    newEntry.resolve({status:'ready'});
    await newWorkspace;
    if (await oldWorkspace !== 'HISTORY_CANCELLED') throw Error('workspace request survived');
  })()`,
    context,
  );
  assert.equal(
    sent.filter((m) => m.query?.op === "history").length,
    2,
    "current viewers still receive data; old workspaces do not",
  );
  console.log(
    "Queued stale history and old workspace requests cancel; current viewers proceed",
  );
  sent.length = 0;
  vm.runInContext(`
    for(let i=0;i<4;i++) request({op:'blocker'},'market');
    request({op:'historyCache'},'market');
    request({op:'viewport'},'market');
    pending.delete([...pending.keys()][0]);
    drain();
  `,context);
  assert.equal(sent.at(-1).query.op,'viewport','viewport interaction precedes queued history');
  assert.equal(vm.runInContext('pending.size',context),4,'interaction must retain concurrency limit');
  vm.runInContext(`
    requests.length=0;
    request({op:'historyCache',background:true},'market');
    request({op:'historyDemand'},'market');
    request({op:'historyCache',background:false},'market');
    pending.delete([...pending.keys()][0]);
    drain();
  `,context);
  assert.equal(sent.at(-1).query.background,false,'foreground cache read precedes prewarming');
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
