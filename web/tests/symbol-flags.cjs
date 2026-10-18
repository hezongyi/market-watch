const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm");
const c = vm.createContext({});
vm.runInContext(
  fs.readFileSync("../advanced-host/series.js", "utf8") +
    "\n" +
    fs.readFileSync("../advanced-host/symbol-flags.js", "utf8") +
    "\nglobalThis.flags=MWSymbolFlags;",
  c,
);
const { flags: F } = c;
const plain = (x) => JSON.parse(JSON.stringify(x));
(async () => {
  assert.throws(() => F.parse({ version: 2, flags: {} }));
  assert.throws(() => F.parse({ version: 1, flags: { EURUSD: "orange" } }));
  let row = null,
    fail = false;
  async function rpc(op, args) {
    if (op === "read") return structuredClone(row);
    if (fail) throw Object.assign(Error("offline"), { status: 503 });
    if ((row?.revision || 0) !== args.revision)
      throw Object.assign(Error("conflict"), { status: 409 });
    row = { ...args, id: "account-flags", revision: args.revision + 1 };
    return structuredClone(row);
  }
  const a = F.store(null, rpc),
    b = F.store(null, rpc);
  await a.set("EURUSD", "red");
  await b.set("MWP:EURUSD", "blue");
  assert.deepEqual(
    plain(row.content.value.flags),
    { EURUSD: "red", "MWP:EURUSD": "blue" },
    "concurrent first insert rebases only edited ticker",
  );
  await Promise.all([a.set("XAUUSD", "green"), b.set("BTCUSDT", "yellow")]);
  assert.equal(row.content.value.flags.EURUSD, "red");
  assert.equal(row.content.value.flags["MWP:EURUSD"], "blue");
  for (const color of Object.keys(F.colors)) await a.set("EURUSD", color);
  await a.set("EURUSD", null);
  assert.equal(row.content.value.flags.EURUSD, undefined);
  assert.equal(row.content.value.flags["MWP:EURUSD"], "blue");
  const restored = F.store(structuredClone(row), rpc);
  assert.deepEqual(plain(restored.get()), plain(row.content.value.flags));
  fail = true;
  const before = plain(restored.get());
  await assert.rejects(restored.set("XAUUSD", "pink"), /offline/);
  assert.deepEqual(
    plain(restored.get()),
    before,
    "failed writes do not masquerade as persistence",
  );
  fail = false;
  await restored.set("XAUUSD", "pink");
  assert.equal(row.content.value.flags.XAUUSD, "pink");
  assert.ok(!("lists" in row.content.value));
  assert.throws(() => F.identity("__proto__!"));
  console.log(
    "symbol flags version, identities, seven colors, restore, failure and concurrent rebase passed",
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
