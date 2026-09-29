const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm");
const context = vm.createContext({ Map, Promise, Error });
vm.runInContext(
  fs.readFileSync("../advanced-host/workspaces.js", "utf8"),
  context,
);
(async () => {
  let row = { id: "a", revision: 1, name: "A", content: "{}" },
    saved = 0,
    loaded = 0;
  async function rpc(op, args) {
    if (op === "list") return [{ ...row }];
    if (op === "load") return { ...row };
    if (args.revision !== row.revision) throw Error("conflict");
    if (op === "save") {
      row = { ...row, ...args, revision: row.revision + 1 };
      return { ...row };
    }
    return { ok: true };
  }
  let adapter = context.nativeWorkspaces(
    row,
    rpc,
    false,
    () => loaded++,
    () => saved++,
  );
  row.revision = 2;
  await adapter.getAllCharts();
  await assert.rejects(
    adapter.saveChart({ id: "a", content: "{}" }),
    /conflict/,
  );
  assert.equal(saved, 0);
  await assert.rejects(adapter.getChartContent("a"), /未保存/);
  // A fresh page/session can explicitly reload server state.
  adapter = context.nativeWorkspaces(
    row,
    rpc,
    false,
    () => loaded++,
    () => saved++,
  );
  await adapter.getChartContent("a");
  await adapter.saveChart({ id: "a", name: "B", content: "{}" });
  assert.equal(saved, 1);
  assert.equal(loaded, 1);
  assert.equal(row.revision, 3);
  await Promise.all([
    adapter.saveChart({ id: "a", content: "{}" }),
    adapter.saveChart({ id: "a", content: "{}" }),
  ]);
  assert.equal(row.revision, 5);
  const mobile = context.nativeWorkspaces(
    row,
    rpc,
    true,
    () => {},
    () => {},
  );
  await assert.rejects(mobile.removeChart("a"), /只读/);
  await assert.rejects(mobile.saveChart({ id: "a" }), /只读/);
  const order = [];
  let finish;
  const delayed = context.nativeWorkspaces(
    { id: "a", revision: 1 },
    async (op, args) => {
      if (op === "save") {
        await new Promise((resolve) => {
          finish = resolve;
        });
        order.push("saved");
        return { id: "a", revision: 2, content: "{}" };
      }
      order.push("loaded");
      return { id: args.id, revision: 1, content: "{}" };
    },
    false,
    () => order.push("onLoaded"),
    () => order.push("onSaved"),
  );
  const saving = delayed.saveChart({ id: "a", content: "{}" });
  await Promise.resolve();
  const loading = delayed.getChartContent("b");
  await Promise.resolve();
  assert.deepEqual(order, [], "load must wait for the earlier save");
  finish();
  await Promise.all([saving, loading]);
  assert.deepEqual(order, ["saved", "onSaved", "loaded", "onLoaded"]);
  let refuse = true;
  const protectedAdapter = context.nativeWorkspaces(
    { id: "a", revision: 1 },
    async (op, args) => {
      if (op === "save" && refuse) throw Error("conflict");
      return { id: args.id || "copy", revision: 1, content: "{}" };
    },
    false,
    () => {},
    () => {},
  );
  await assert.rejects(
    protectedAdapter.saveChart({ id: "a", content: "draft" }),
    /conflict/,
  );
  await assert.rejects(protectedAdapter.getChartContent("b"), /未保存/);
  refuse = false;
  await protectedAdapter.saveChart({ name: "copy", content: "draft" });
  await protectedAdapter.getChartContent("b");
  console.log(
    "native workspace adapter: conflict, serialized saves and readonly passed",
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
