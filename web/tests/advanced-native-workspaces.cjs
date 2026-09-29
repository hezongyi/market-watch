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
  const adapter = context.nativeWorkspaces(
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
  console.log(
    "native workspace adapter: conflict, serialized saves and readonly passed",
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
