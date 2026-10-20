const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm");
const context = vm.createContext({ Map, Promise, JSON, Error });
vm.runInContext(
  fs.readFileSync("../advanced-host/preferences.js", "utf8"),
  context,
);
(async () => {
  const stored = new Map();
  let serial = 0;
  async function rpc(op, args) {
    if (op === "read") return [...stored.values()];
    if (op === "delete") {
      const row = [...stored.values()].find((r) => r.id === args.id);
      assert.equal(row.revision, args.revision);
      stored.delete(JSON.stringify([row.kind, row.name, row.tool]));
      return { ok: true };
    }
    const key = JSON.stringify([args.kind, args.name, args.tool]),
      previous = stored.get(key);
    if (args.revision !== (previous?.revision || 0)) throw Error("conflict");
    const row = {
      ...args,
      id: previous?.id || String(++serial),
      revision: args.revision + 1,
    };
    stored.set(key, row);
    return row;
  }
  const errors = [],
    first = context.nativePreferences([], rpc, false, (e) =>
      errors.push(String(e)),
    );
  await Promise.all([
    first.templates.saveStudyTemplate({ name: "SMA", content: "v1" }),
    first.templates.saveStudyTemplate({ name: "SMA", content: "v2" }),
  ]);
  assert.equal(
    await first.templates.getStudyTemplateContent({ name: "SMA" }),
    "v2",
  );
  await first.templates.saveDrawingTemplate("trend_line", "Default", "line");
  await first.templates.saveDrawingTemplate("ray", "Default", "ray");
  assert.equal(
    await first.templates.loadDrawingTemplate("trend_line", "Default"),
    "line",
  );
  await first.templates.saveChartTemplate("Light", {
    chartProperties: { paneProperties: { background: "#fff" } },
  });
  assert.equal(
    (await first.templates.getChartTemplateContent("Light")).content
      .chartProperties.paneProperties.background,
    "#fff",
  );
  const second = context.nativePreferences(
    [...stored.values()],
    rpc,
    false,
    (e) => errors.push(String(e)),
  );
  assert.equal(
    await second.templates.getStudyTemplateContent({ name: "SMA" }),
    "v2",
  );
  await first.templates.saveStudyTemplate({ name: "SMA", content: "v3" });
  await assert.rejects(
    second.templates.saveStudyTemplate({ name: "SMA", content: "stale" }),
    /未保存/,
  );
  const readonly = context.nativePreferences(
    [...stored.values()],
    rpc,
    true,
    (e) => errors.push(String(e)),
  );
  await assert.rejects(
    readonly.templates.removeStudyTemplate({ name: "SMA" }),
    /只读/,
  );
  const size = stored.size;
  readonly.settings.setValue("theme", "Dark");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(stored.size, size);
  await first.templates.removeDrawingTemplate("ray", "Default");
  assert.equal((await first.templates.getDrawingTemplates("ray")).length, 0);
  assert.equal(
    (await first.templates.getDrawingTemplates("trend_line")).length,
    1,
  );
  assert.equal(errors.length, 2, "native template failures are reported even when the library swallows rejection");
  assert.ok(errors.every(error => error.includes("设置未保存")));
  console.log(
    "native adapters: queued writes, namespaces, reload, conflict and readonly passed",
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
