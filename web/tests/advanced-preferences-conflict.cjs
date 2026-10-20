const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const sandbox = vm.createContext({ Map, Promise, JSON, Error });
vm.runInContext(
  fs.readFileSync("../advanced-host/preferences.js", "utf8"),
  sandbox,
);
const clone = (value) => JSON.parse(JSON.stringify(value));
const conflict = () => Object.assign(Error("版本冲突"), { status: 409 });

(async () => {
  let row = {
    id: "one",
    kind: "setting",
    name: "widgetbar.layout-settings",
    tool: "",
    revision: 1,
    content: { value: JSON.stringify({ watchlist: true, width: 300 }) },
  };
  let writes = 0,
    reads = 0,
    racing = false;
  async function rpc(op, args) {
    if (op === "read") {
      reads++;
      return row ? [clone(row)] : [];
    }
    writes++;
    if (racing || args.revision !== (row?.revision || 0)) throw conflict();
    if (op === "delete") {
      row = null;
      return;
    }
    row = { ...args, id: "one", revision: args.revision + 1 };
    return clone(row);
  }
  const adapter = () =>
    sandbox.nativePreferences(row ? [clone(row)] : [], rpc, false, () => {});
  const a = adapter(),
    b = adapter();
  await a.savePreference(
    "setting",
    row.name,
    JSON.stringify({ watchlist: true, width: 400 }),
  );
  await b.savePreference(
    "setting",
    row.name,
    JSON.stringify({ watchlist: false, width: 300 }),
  );
  assert.deepEqual(
    JSON.parse(row.content.value),
    { watchlist: false, width: 400 },
    "merge disjoint fields across real adapters",
  );
  await b.savePreference("setting", row.name,
    JSON.stringify({ watchlist: true, width: 300 }));
  assert.deepEqual(JSON.parse(row.content.value), { watchlist: true, width: 400 },
    "subsequent callbacks retain remote fields absent from this window's memory");
  const c = adapter(),
    d = adapter();
  await c.savePreference(
    "setting",
    row.name,
    JSON.stringify({ watchlist: false, width: 500 }),
  );
  const beforeConflict = writes;
  await assert.rejects(
    d.savePreference(
      "setting",
      row.name,
      JSON.stringify({ watchlist: false, width: 600 }),
    ),
    /未保存/,
  );
  await assert.rejects(
    d.savePreference(
      "setting",
      row.name,
      JSON.stringify({ watchlist: false, width: 600 }),
    ),
    /未保存/,
  );
  assert.equal(
    writes,
    beforeConflict,
    "repeated conflicting callbacks never overwrite remote settings",
  );
  assert.equal(JSON.parse(row.content.value).width, 500);
  await d.savePreference("setting", row.name, row.content.value);
  assert.equal(writes, beforeConflict, "same intended value is already saved");
  const e = adapter();
  row.revision++;
  await e.savePreference(
    "setting",
    row.name,
    JSON.stringify({ watchlist: true, width: 500 }),
  );
  assert.equal(
    JSON.parse(row.content.value).watchlist,
    true,
    "content unchanged on another revision is safe",
  );
  const f = adapter();
  const beforeRace = writes;
  racing = true;
  await assert.rejects(
    f.savePreference(
      "setting",
      row.name,
      JSON.stringify({ watchlist: true, width: 700 }),
    ),
    /未保存/,
  );
  assert.ok(writes - beforeRace <= 2, "bounded retry under persistent races");
  racing = false;
  const g = adapter();
  row = null;
  await assert.rejects(
    g.savePreference("setting", "widgetbar.layout-settings", "{}"),
    /未保存/,
  );
  assert.equal(row, null, "deleted remote setting is never resurrected");

  row = {
    id: "template",
    kind: "study",
    name: "SMA",
    tool: "",
    revision: 1,
    content: { value: "v1" },
  };
  const first = adapter(),
    stale = adapter();
  await first.templates.saveStudyTemplate({ name: "SMA", content: "v2" });
  await assert.rejects(
    stale.templates.saveStudyTemplate({ name: "SMA", content: "stale" }),
    /未保存/,
  );
  assert.equal(
    row.content.value,
    "v2",
    "opaque template conflicts cannot be merged",
  );
  assert.equal(
    await stale.templates.getStudyTemplateContent({ name: "SMA" }),
    "v2",
    "reads see other windows",
  );
  await stale.templates.saveStudyTemplate({ name: "SMA", content: "v3" });
  assert.equal(
    row.content.value,
    "v3",
    "new explicit edit after reading latest is allowed",
  );
  assert.ok(reads > 0);
  console.log(
    "PASS multi-window preference merge, idempotence, conflict retention, bounded retries, deletion and opaque templates",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
