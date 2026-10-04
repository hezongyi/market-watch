const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm");
const run = () => new Promise((resolve) => setImmediate(resolve));
(async () => {
  const ctx = vm.createContext({
    Map,
    Set,
    Promise,
    Error,
    Number,
    Math,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (cb) => setImmediate(cb),
    CustomEvent: class {},
    globalThis: { dispatchEvent() {} },
    location: { search: "" },
    URLSearchParams,
  });
  vm.runInContext(
    fs.readFileSync("../advanced-host/native-navigation.js", "utf8"),
    ctx,
  );
  const navigation = ctx.globalThis.MWNativeNavigation;
  navigation.setCapabilities({
    protocol: 1,
    mode: "continuous",
    max_bars: 100,
    workspace_bars: 150,
  });
  const pending = [];
  let delivered = 0,
    failed = 0;
  const thread = () => ({
    _symbolInfo: { ticker: "MWP:EURUSD" },
    _cache: { bars: [] },
    _datafeed: { getBars: (s, r, p, cb, err) => pending.push({ s, cb, err }) },
    _dealignTime: (t) => t,
    _purgeCache() {
      this._cache = { bars: [] };
    },
    _resolution: "5",
  });
  const one = thread(),
    two = thread();
  two._symbolInfo.ticker = "MWP:GBPUSD";
  navigation.bindThread(one, "5");
  navigation.bindThread(two, "5");
  one._datafeed.getBars(
    one._symbolInfo,
    "5",
    { countBack: 100 },
    () => delivered++,
    () => failed++,
  );
  two._datafeed.getBars(
    two._symbolInfo,
    "5",
    { countBack: 100 },
    () => delivered++,
    () => failed++,
  );
  await run();
  assert.equal(failed, 1, "concurrent sources reserve workspace capacity");
  assert.equal(pending.length, 1);
  one.mw_read.cancel();
  assert.equal(failed, 2);
  assert.equal(pending[0].s.mw_current(), false);
  pending[0].cb([{ time: 1 }], {});
  assert.equal(delivered, 0, "obsolete callbacks cannot populate native cache");
  assert.equal(
    navigation.diagnostics().pending,
    0,
    "failure releases reservation",
  );
  one._datafeed.getBars(
    one._symbolInfo,
    "5",
    { countBack: 10 },
    () => delivered++,
    () => failed++,
  );
  one._purgeCache();
  assert.equal(failed, 3, "purging a source finishes its native callback");
  pending[1].cb([{ time: 2 }], {});
  assert.equal(delivered, 0);
  navigation.unbindThread(one);
  navigation.unbindThread(two);
  assert.equal(navigation.diagnostics().threads, 0);
  console.log(
    "Continuous navigation: concurrent admission, cancellation, stale callbacks, source purge and release passed",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
