const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm"),
  ts = require("typescript");
function load(file, require) {
  const context = { exports: {}, require, URL, URLSearchParams };
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    context,
  );
  return context.exports;
}
const center = load("src/market-data/location.ts");
const { safeNext, pageName } = load("src/app/navigation.ts", () => center);
assert.equal(safeNext('/advanced-charts/?panel=notifications&event=s%3A123'),'/advanced-charts?panel=notifications&event=s%3A123');
for (const next of [
  "https://evil.invalid/x",
  "//evil.invalid/x",
  "/\\evil.invalid/x",
  "/login?next=/signals",
  "/api/signals",
  "/chart-data-center?session=x",
  "/mcp",
  "/signals\n",
  "/advanced-charts/../login",
  "/%2f%2fevil.invalid",
  "javascript:alert(1)",
  "/settings/unknown",
  "/replay?dataset_version=123",
  "/replay/run-1",
  "/legacy/monitoring",
  "/chart-workspaces/legacy-1",
])
  assert.equal(safeNext(next), "/advanced-charts", next);
for (const next of [
  "/advanced-charts/abc-123?panel=alerts#main",
  "/signals?signal=abc#notification",
  "/settings/account",
])
  assert.equal(safeNext(next), next);
assert.equal(
  safeNext("/market-data?tab=platform&source=oanda&evil=1"),
  "/market-data?tab=platform&source=oanda",
);
assert.equal(pageName("/signals"), "通知");
assert.equal(pageName("/unknown"), "页面不存在");
console.log("single-app continuation allowlist passed");
