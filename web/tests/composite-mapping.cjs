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
for (const [symbol, asset, base, currency, product] of [
  ["EURUSD", "forex", "EUR", "USD", "spot_fx"],
  ["USD_CAD", "forex", "USD", "CAD", "spot_fx"],
  ["XAU/USD", "metal", "XAU", "USD", "spot_metal"],
]) {
  const draft = initialMatch(dataset(symbol, asset));
  assert.equal(draft.underlying, base);
  assert.equal(draft.quote_currency, currency);
  assert.equal(draft.historical_product, product);
  assert.equal(draft.reviewed, false);
  assert.equal(draft.relationship, "");
  assert.equal(draft.live_evidence, "");
}
assert.equal(pair("USD__CAD", "forex"), null);
assert.equal(pair("NAS100_USD", "index"), null);
assert.equal(pair("ABCDEF", "cfd"), null);
assert.equal(initialMatch(dataset("NAS100_USD", "index")).quote_currency, "");
const match = {
  ...initialMatch(dataset("USDCAD", "forex")),
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
assert.equal(Object.keys(matchFields({ ...match, basis: "bid" })).length, 9);
for (const [changes, field] of [
  [{ relationship: "" }, "relationship"],
  [{ live_product: "cfd" }, "relationship"],
  [
    { historical_evidence: "https://user:secret@example.test" },
    "historical_evidence",
  ],
  [{ live_evidence: "file:///tmp/evidence" }, "live_evidence"],
  [{ reviewed: false }, "reviewed"],
  [{ rationale: "short" }, "rationale"],
  [{ quote_currency: "" }, "quote_currency"],
])
  assert.ok(validMatch({ ...match, ...changes })[field]);
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
  "PASS mapping inference, explicit product review, evidence validity and canonical reconciliation",
);
