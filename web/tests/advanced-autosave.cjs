const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const messages = [],
  callbacks = [];
const context = vm.createContext({
  URL,
  URLSearchParams,
  Map,
  Promise,
  Date,
  Intl,
  Error,
  location: { search: "?parent=http://localhost" },
  parent: { postMessage: (m) => messages.push(m) },
  crypto: { randomUUID: () => "test" },
  addEventListener() {},
  setTimeout,
  clearTimeout,
  callbacks,
});
vm.runInContext(fs.readFileSync("../advanced-host/series.js", "utf8"), context);
vm.runInContext(fs.readFileSync("../advanced-host/chart-runtime.js", "utf8"), context);
vm.runInContext(
  `ready=true;nativeMode=true;dirty=true;
widget={saveChartToServer:(ok,fail)=>callbacks.push({ok,fail})};snapshot();
dirty=true;snapshot();`,
  context,
);
assert.equal(callbacks.length, 1);
assert.equal(messages.filter((m) => m.type === "native-saving").length, 1);
callbacks[0].ok();
assert.equal(
  callbacks.length,
  2,
  "edits during an outstanding save must trigger another save",
);
assert.equal(
  messages.filter((m) => m.type === "native-saved").length,
  0,
  "do not acknowledge unsaved edits",
);
callbacks[1].ok();
assert.equal(messages.filter((m) => m.type === "native-saving").length, 2);
assert.equal(messages.filter((m) => m.type === "native-saved").length, 1);
vm.runInContext("dirty=true;snapshot()", context);
callbacks[2].fail(new Error("offline"));
assert.equal(
  vm.runInContext("dirty", context),
  true,
  "failed save remains dirty",
);
assert.equal(vm.runInContext("nativeSaving", context), false);
vm.runInContext("snapshot();workspaceEpoch++;dirty=false;", context);
callbacks[3].ok();
assert.equal(
  messages.filter((m) => m.type === "native-saved").length,
  1,
  "old workspace completion cannot acknowledge the newly loaded workspace",
);
vm.runInContext(
  'widget.saveChartToServer=()=>{throw Error("sync failure")};snapshot()',
  context,
);
assert.equal(vm.runInContext("nativeSaving", context), false);
assert.equal(vm.runInContext("dirty", context), true);
vm.runInContext("rangeGuard={busy:()=>true};dirty=false;snapshot()",context);
assert.equal(vm.runInContext("dirty",context),true,"loading guard defers save without clearing pending edits");
assert.equal(vm.runInContext("nativeSaving",context),false);
console.log("Autosave preserves in-flight edits and failed-save retry state");
