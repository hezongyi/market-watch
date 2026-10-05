// Real Docker assets, a real browser cache, and synthetic OHLC for loading smoke.
const { chromium } = require("@playwright/test");
const http = require("node:http"),
  https = require("node:https");
const fs = require("node:fs"),
  path = require("node:path");
const assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const CANDIDATE = process.env.NATIVE_SYNC_CHART || "https://localhost:15844";
const DISABLED = process.env.NATIVE_DISABLED_CHART || "http://localhost:15944";
const OUT =
  process.env.NATIVE_CACHE_OUTPUT || "/tmp/mw-chart-sync-acceptance/cache.json";
function read(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;
    client
      .get(url, { rejectUnauthorized: false }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      })
      .on("error", reject);
  });
}
(async () => {
  const report = {
    scope:
      "isolated Docker compiled assets; real browser HTTP cache; synthetic 24x7 loading smoke",
    requests: [],
    errors: [],
  };
  let stage = "disabled";
  const entry = await read(CANDIDATE + "/");
  const version = entry.body
    .toString()
    .match(/(charting_library_[a-f0-9]+)\/charting_library.js/)[1];
  const disabledEntry = await read(DISABLED + "/");
  const disabledHost = disabledEntry.body
    .toString()
    .match(/src="\/(host\.[a-f0-9]+\.js)"/)[1];
  assert.ok(
    (await read(DISABLED + "/" + disabledHost)).body
      .toString()
      .includes("MW_NATIVE_RESERVE_ENABLED=false"),
  );
  const bundlePath = "/bundles/library.e2f8b3a016c9e1a0b7a5.js";
  const original = await read(DISABLED + "/charting_library" + bundlePath);
  const candidate = await read(CANDIDATE + "/" + version + bundlePath);
  const digest = (response) =>
    crypto.createHash("sha256").update(response.body).digest("hex");
  assert.equal(
    digest(original),
    "114428b8dde6eb137fd7ef3bc20ef35882189186c4bd092bb743b64d11682be1",
  );
  assert.equal(version, "charting_library_" + digest(candidate).slice(0, 16));
  assert.match(candidate.headers["cache-control"], /immutable/);
  assert.equal(
    (await read(CANDIDATE + "/charting_library" + bundlePath)).headers[
      "cache-control"
    ],
    "no-store",
  );
  report.assets = {
    version,
    originalSHA: digest(original),
    candidateSHA: digest(candidate),
    cacheControl: candidate.headers["cache-control"],
  };
  const server = http.createServer(async (request, response) => {
    try {
      if (request.url === "/navigation.js") {
        response.setHeader("content-type", "application/javascript");
        return response.end(
          fs.readFileSync(
            path.resolve(__dirname, "../../advanced-host/native-navigation.js"),
          ),
        );
      }
      if (request.url === "/") {
        const library =
          stage === "disabled" ? "/charting_library/" : "/" + version + "/";
        response.setHeader("content-type", "text/html");
        response.setHeader("cache-control", "no-store");
        return response.end(`<!doctype html><html><head><style>html,body,#chart{height:100%;margin:0}</style></head><body><div id="chart"></div><script>globalThis.MW_NATIVE_RESERVE_ENABLED=${stage !== "disabled"}</script><script src="${library}charting_library.js"></script><script src="/navigation.js"></script><script>
          const resolutions=['1','5','1D'], end=Date.now();
          const feed={onReady:cb=>setTimeout(()=>cb({supported_resolutions:resolutions}),0),resolveSymbol:(s,cb)=>setTimeout(()=>cb({name:s,ticker:s,description:s,type:'crypto',exchange:'TEST',session:'24x7',timezone:'Etc/UTC',minmov:1,pricescale:100,has_intraday:true,has_daily:true,supported_resolutions:resolutions}),0),getBars:(s,r,p,cb)=>setTimeout(()=>cb(Array.from({length:p.countBack},(_,i)=>({time:Math.floor(Math.min(end,p.to*1000)/300000)*300000-(p.countBack-i)*300000,open:100,high:102,low:99,close:101})),{noData:false}),0),subscribeBars:()=>{},unsubscribeBars:()=>{}};
          globalThis.widget=new TradingView.widget({container:'chart',library_path:'${library}',symbol:'MWP:TEST',interval:'5',datafeed:feed,autosize:true,disabled_features:['header_widget','left_toolbar','use_localstorage_for_settings','create_volume_indicator_by_default']});globalThis.ready=false;widget.onChartReady(()=>ready=true);
        </script></body></html>`);
      }
      const isOld = request.url.startsWith("/charting_library/");
      const asset = await read((isOld ? DISABLED : CANDIDATE) + request.url);
      report.requests.push({ stage, path: request.url, status: asset.status });
      response.statusCode = asset.status;
      for (const header of ["content-type", "cache-control"])
        if (asset.headers[header])
          response.setHeader(header, asset.headers[header]);
      // Reproduce the previous release's immutable, unversioned library cache.
      if (isOld)
        response.setHeader(
          "cache-control",
          "public, max-age=31536000, immutable",
        );
      response.end(asset.body);
    } catch (error) {
      response.statusCode = 502;
      response.end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => report.errors.push(e.stack));
    const url = "http://127.0.0.1:" + server.address().port;
    const load = async () => {
      await page.goto(url);
      await page.waitForFunction(
        () => ready && widget.activeChart().dataReady(),
      );
      await page.waitForTimeout(200);
      return page.evaluate(() => ({
        range: widget.activeChart().getVisibleRange(),
        navigation: MWNativeNavigation.diagnostics(),
      }));
    };
    report.disabled = await load();
    assert.equal(report.disabled.navigation.models, 0);
    const oldCount = report.requests.filter((r) =>
      r.path.startsWith("/charting_library/"),
    ).length;
    await load();
    assert.equal(
      report.requests.filter((r) => r.path.startsWith("/charting_library/"))
        .length,
      oldCount,
      "baseline assets were not cached in the browser",
    );
    stage = "candidate";
    report.candidate = await load();
    assert.equal(report.candidate.navigation.models, 1);
    assert.ok(
      report.requests.some(
        (r) => r.stage === "candidate" && r.path === "/" + version + bundlePath,
      ),
    );
    assert.ok(
      !report.requests.some(
        (r) =>
          r.stage === "candidate" && r.path.startsWith("/charting_library/"),
      ),
      "candidate referenced old immutable asset paths",
    );
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } finally {
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
