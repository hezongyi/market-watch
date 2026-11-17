const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  vm = require("node:vm"),
  path = require("node:path");
const { buildSync } = require("esbuild");
const source = buildSync({
  entryPoints: [path.resolve(__dirname, "../src/advanced/alertPriceEdit.ts")],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
}).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(source, {
  module: mod,
  exports: mod.exports,
  structuredClone,
  Error,
});
const { editAlertPrice } = mod.exports;
const base = () => ({
  id: "rule",
  version: 3,
  control_revision: 7,
  status: "paused",
  display_identity: { code: "EURUSD" },
  config: {
    name: "EURUSD 上穿 1.11951",
    message: "custom 1.11951 message",
    notify_ntfy: true,
    notify_web: false,
    max_triggers: 3,
    source: "fixture",
    timeframe: "H1",
    association: { workspace_id: "ws", object_kind: null },
    condition: {
      relation: "cross_up",
      left: { kind: "price" },
      right: { kind: "constant", value: "1.11951" },
    },
  },
});
test("gesture keeps exact decimals, controls, message and delivery while updating generated name", async () => {
  const row = base(),
    calls = [];
  const result = await editAlertPrice(
    row,
    "1.123456789012345678",
    async (path, body) => {
      calls.push({ path, body });
      return body
        ? { ...row, version: 4, config: body.config }
        : structuredClone(row);
    },
  );
  assert.equal(result.config.condition.right.value, "1.123456789012345678");
  assert.equal(result.config.name, "EURUSD 上穿 1.123456789012345678");
  assert.equal(result.status, "paused");
  assert.equal(result.config.message, row.config.message);
  assert.equal(result.config.notify_ntfy, true);
  assert.equal(result.config.notify_web, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.version, 3);
  assert.equal(row.config.condition.right.value, "1.11951");
});
test("custom name survives; stale version and lifecycle revisions reject before any write", async () => {
  const row = base();
  row.config.name = "固定自定义名称";
  let writes = 0;
  const result = await editAlertPrice(row, "1.12", async (p, b) => {
    if (b) {
      writes++;
      return { ...row, config: b.config };
    }
    return structuredClone(row);
  });
  assert.equal(result.config.name, row.config.name);
  for (const change of [{ version: 4 }, { control_revision: 8 }]) {
    await assert.rejects(
      editAlertPrice(row, "1.13", async () => ({ ...row, ...change })),
      /版本或状态/,
    );
  }
  assert.equal(writes, 1);
});
test("unsupported ATR, drawing, units and non-active statuses never write", async () => {
  for (const change of [
    (r) => (r.config.condition.offset = { kind: "atr" }),
    (r) => (r.config.association.object_kind = "drawing"),
    (r) => (r.config.condition.left.kind = "indicator"),
    (r) => (r.status = "completed"),
    (r) => (r.config.condition.relation = "enter"),
  ]) {
    const row = base();
    change(row);
    let writes = 0;
    await assert.rejects(
      editAlertPrice(row, "1.2", async (p, b) => {
        if (b) writes++;
        return row;
      }),
      /不能拖动/,
    );
    assert.equal(writes, 0);
  }
  for (const price of ["0", "-1", "NaN", "Infinity", "1e3", ""])
    await assert.rejects(
      editAlertPrice(base(), price, async () =>
        assert.fail("invalid values do not request"),
      ),
    );
});
test("lost response is read back; genuine conflicts expose authoritative row and never auto-retry writes", async () => {
  const row = base();
  let stored = structuredClone(row),
    writes = 0;
  const result = await editAlertPrice(row, "1.15", async (p, b) => {
    if (b) {
      writes++;
      stored = { ...stored, version: 4, config: b.config };
      throw Error("response lost");
    }
    return stored;
  });
  assert.equal(result.version, 4);
  assert.equal(writes, 1);
  stored = structuredClone(row);
  writes = 0;
  let failure;
  try {
    await editAlertPrice(row, "1.16", async (p, b) => {
      if (b) {
        writes++;
        stored = {
          ...stored,
          version: 4,
          config: { ...stored.config, name: "并发修改" },
        };
        throw Error("conflict");
      }
      return stored;
    });
  } catch (e) {
    failure = e;
  }
  assert.match(failure.message, /conflict/);
  assert.equal(failure.currentRow.config.name, "并发修改");
  assert.equal(writes, 1);
});

test("generated names follow grouped or fractional native display prices", async () => {
  for (const [previousText, text, value] of [
    ["1,234.00", "1,235.00", "1235.00"],
    ["129'16", "129'24", "129.75"],
  ]) {
    const row = base();
    row.config.name = `EURUSD 上穿 ${previousText}`;
    const saved = await editAlertPrice(
      row,
      value,
      async (p, body) => (body ? { ...row, config: body.config } : row),
      { previousText, text },
    );
    assert.equal(saved.config.name, `EURUSD 上穿 ${text}`);
    assert.equal(saved.config.condition.right.value, value);
  }
});

test("lost response and failed readback remain explicitly unknown", async()=>{
 const row=base();let reads=0,writes=0;
 await assert.rejects(editAlertPrice(row,"1.15",async(p,b)=>{
  if(b){writes++;throw Error('response lost');}
  if(reads++===0)return row;
  throw Error('offline');
 }),error=>error.outcomeUnknown===true && !error.currentRow);
 assert.equal(writes,1);
});

test("same price with different concurrent config is not mistaken for this save",async()=>{
 const row=base();let reads=0;
 await assert.rejects(editAlertPrice(row,"1.15",async(p,b)=>{
  if(b)throw Error('response lost');
  if(reads++===0)return row;
  return {...row,version:4,config:{...row.config,condition:{...row.config.condition,right:{kind:'constant',value:'1.15'}},message:'other client'}};
 }),e=>e.currentRow?.config.message==='other client');
});

test('a read of the old version cannot disprove a timed-out edit that commits later',async()=>{
 for(const status of [504,200,undefined]){
  const row=base();let stored=structuredClone(row),commit;
  await assert.rejects(editAlertPrice(row,'1.15',async(p,b)=>{
   if(b){commit=()=>{stored={...row,version:row.version+1,control_revision:row.control_revision+1,config:b.config};};throw Object.assign(Error('ambiguous response'),{status});}
   return structuredClone(stored);
  }),e=>e.outcomeUnknown===true && e.currentRow.version===row.version);
  commit();assert.equal(stored.config.condition.right.value,'1.15');
 }
});
