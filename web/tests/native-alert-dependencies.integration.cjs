// Real pinned library and shipped adapters, synthetic quotes, no production API.
// Start alerts before any symbol-search/settings UI can warm shared dependencies.
const { chromium } = require(process.env.MW_PLAYWRIGHT || "@playwright/test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const library = process.env.MW_PROBE_LIBRARY;
if (!library)
  throw Error("MW_PROBE_LIBRARY must point to the private pinned library");
const origin = "https://native-dependencies.invalid";
const delayedChunks = new Set(
  (process.env.MW_DELAY_CHUNKS || "32171,36145").split(","),
);
const fixture = `
const feed = {
  onReady: cb => setTimeout(() => cb({supported_resolutions:['60']}), 0),
  resolveSymbol: (name, cb) => setTimeout(() => cb({name,ticker:name,description:name,type:'forex',session:'24x7',timezone:'Etc/UTC',minmov:1,pricescale:100000,has_intraday:true,supported_resolutions:['60']}), 0),
  getBars: (symbol, resolution, period, cb) => setTimeout(() => cb(Array.from({length:period.countBack}, (_,i) => ({time:(Math.floor(period.to/3600)-period.countBack+i)*3600000,open:1.12,high:1.13,low:1.11,close:1.12})), {noData:false}), 0),
  subscribeBars() {}, unsubscribeBars() {},
  getQuotes: (symbols, cb) => cb(symbols.map(n => ({n,s:'ok',v:{lp:1.12,ch:0,chp:0,short_name:n,exchange:'Fixture'}}))),
  subscribeQuotes() {}, unsubscribeQuotes() {}
};
const widget = new TradingView.widget({container:'chart',library_path:'/charting_library/',datafeed:feed,symbol:'EURUSD',interval:'60',locale:'zh',autosize:true,theme:'Dark',widgetbar:{watchlist:true,details:true,datawindow:true,watchlist_settings:{default_symbols:['EURUSD']}},disabled_features:['use_localstorage_for_settings','create_volume_indicator_by_default']});
globalThis.result = {failures:[], alerts:false, center:false};
widget.onChartReady(async () => {
  const doc = (await widget.widgetbar())._widgetbar._wrap.ownerDocument;
  let shell;
  try {
    shell = await nativeAlertShell(widget, {
      mount(node) { node.textContent = 'Alert business fixture'; result.alerts = true; },
      unmount() {}, report(error) { result.failures.push(String(error)); }
    });
    shell.open();
  } catch(error) { result.failures.push('原生告警接入失败：' + String(error)); }
  try {
    const ui = await chartNativeUi(widget, doc).load();
    result.center = !!ui.react && typeof ui.createRoot === 'function';
  } catch(error) { result.failures.push('原生界面适配暂不可用：' + String(error)); }
  shell?.destroy(); widget.remove(); globalThis.done = true;
});
`;
(async () => {
  const browser = await chromium.launch({
    ...(process.env.MW_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.MW_CHROMIUM_EXECUTABLE }
      : {}),
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.route(origin + "/**", async (route) => {
      const url = new URL(route.request().url());
      // A successful but slow shared chunk reproduces the real startup race.
      // Alert initialization must await it rather than use a partly ready module.
      if (delayedChunks.has(path.basename(url.pathname).split(".")[0]))
        await new Promise((resolve) => setTimeout(resolve, 500));
      if (url.pathname === "/")
        return route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><html><head><style>html,body,#chart{margin:0;height:100%}</style></head><body><div id="chart"></div><script src="/charting_library/charting_library.js"></script><script src="/native-alert-shell.js"></script><script src="/native-ui.js"></script><script src="/fixture.js"></script></body></html>',
        });
      if (url.pathname === "/fixture.js")
        return route.fulfill({
          contentType: "text/javascript; charset=utf-8",
          body: fixture,
        });
      if (["/native-alert-shell.js", "/native-ui.js"].includes(url.pathname))
        return route.fulfill({
          path: path.join(root, "advanced-host", url.pathname.slice(1)),
          contentType: "text/javascript",
        });
      const file = path.resolve(
        library,
        url.pathname.replace(/^\/charting_library\//, ""),
      );
      if (
        !file.startsWith(path.resolve(library) + path.sep) ||
        !fs.existsSync(file)
      )
        return route.fulfill({ status: 404, body: "Missing fixture asset" });
      return route.fulfill({
        path: file,
        ...(file.endsWith(".js") ? { contentType: "text/javascript" } : {}),
      });
    });
    await page.goto(origin);
    await page.waitForFunction(() => globalThis.done, undefined, {
      timeout: 30000,
    });
    const result = await page.evaluate(() => globalThis.result);
    console.log(JSON.stringify(result));
    assert.deepEqual(
      result.failures,
      [],
      "Exact native alert and data-center initialization failures",
    );
    assert.equal(
      result.alerts,
      true,
      "Native alert page mounted from a cold runtime",
    );
    assert.equal(
      result.center,
      true,
      "Data-center native UI stays usable after alert initialization",
    );
    assert.deepEqual(errors, [], "No vendor module initialization errors");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
