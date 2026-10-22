// Contract checks for the UI's conservative inference and save reconciliation.
const { buildSync } = require("esbuild"),
  vm = require("node:vm"),
  assert = require("node:assert/strict");
const compiled = buildSync({
  entryPoints: [
    require("node:path").resolve(__dirname, "../src/market-data/mapping.ts"),
  ],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
}).outputFiles[0].text;
const context = { module: { exports: {} }, URL };
vm.runInNewContext(compiled, context);
const { pair, initialMatch, matchFields, matchKey, validMatch } =
  context.module.exports;
const dataset = (symbol, asset_class) => ({
  identity: { provider_symbol: symbol },
  asset_class,
});
for (const [symbol, asset, base, currency] of [
  ["EURUSD", "forex", "EUR", "USD"],
  ["USD_CAD", "forex", "USD", "CAD"],
  ["XAU/USD", "metal", "XAU", "USD"],
]) {
  const draft = initialMatch(dataset(symbol, asset));
  assert.equal(draft.underlying, base);
  assert.equal(draft.quote_currency, currency);
  assert.equal(draft.historical_product, ""); // product rules come from the server
  assert.equal(draft.schema_version, 2);
  assert.equal(draft.reviewed, false);
  assert.equal(draft.relationship, "");
  assert.equal(draft.live_evidence, null);
}
assert.equal(pair("USD__CAD", "forex"), null);
assert.equal(pair("NAS100_USD", "index"), null);
assert.equal(pair("ABCDEF", "cfd"), null);
assert.equal(initialMatch(dataset("NAS100_USD", "index")).quote_currency, "");
const match = {
  ...initialMatch(dataset("USDCAD", "forex")),
  historical_product: "spot_fx",
  live_product: "spot_fx",
  relationship: "same_product",
  historical_evidence: "https://history.example",
  live_evidence: "https://live.example/products",
  rationale: "Explicit USD/CAD and Bid product review",
  reviewed: true,
};
assert.equal(Object.keys(validMatch(match)).length, 0);
assert.equal(
  matchKey(match),
  matchKey({ ...match, historical_evidence: "https://history.example/" }),
);
assert.equal(
  matchKey(match),
  matchKey({ ...match, target_catalog: { symbol: "USD_CAD" }, basis: "bid" }),
);
assert.equal(Object.keys(matchFields({ ...match, basis: "bid" })).length, 10);
for (const [changes, field] of [
  [{ relationship: "" }, "relationship"],
  [{ live_product: "unverified" }, "live_product"],
  [
    { historical_evidence: "https://user:secret@example.test" },
    "historical_evidence",
  ],
  [{ live_evidence: "file:///tmp/evidence" }, "live_evidence"],
  [{ rationale: "x".repeat(1001) }, "rationale"],
  [{ quote_currency: "" }, "quote_currency"],
])
  assert.ok(validMatch({ ...match, ...changes })[field]);
assert.equal(Object.keys(validMatch({ ...match, reviewed: false,
  rationale: "", historical_evidence: null, live_evidence: null })).length, 0);
assert.equal(
  Object.keys(
    validMatch({
      ...match,
      live_product: "cfd",
      relationship: "same_underlying_different_product",
    }),
  ).length,
  0,
);
console.log(
  "PASS v2 draft hints, optional notes/evidence, field validation and canonical reconciliation",
);
