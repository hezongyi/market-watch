// Actual HTTP cache migration on one origin, with old/new isolated chart
// servers as read-only upstreams. No Playwright routing disables the cache.
const { chromium } = require("@playwright/test");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { createHash } = require("node:crypto"),
  { execFileSync } = require("node:child_process");
const assert = require("node:assert/strict");
const OUT = process.env.NATIVE_CACHE_OUTPUT || "/tmp/native-content-cache.json";
const oldOrigin = process.env.NATIVE_CACHE_OLD || "https://192.168.7.232:16144";
const newOrigin = process.env.NATIVE_CACHE_NEW || "https://192.168.7.232:16344";
const port = Number(process.env.NATIVE_CACHE_PORT || 16544);
const report = {
  scope:
    "same-origin browser HTTP cache migration, isolated proxy, synthetic bars",
  stages: [],
};
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mw-native-cache-"));
fs.chmodSync(directory, 0o755);
const name = "mw-native-cache-" + process.pid;
const docker = (args) =>
  execFileSync("sg", ["docker", "-c", args], { encoding: "utf8" }).trim();
const save = () => fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
(async () => {
  let browser,
    projectStarted = false;
  try {
    browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
      headless: true,
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const roots = [];
    for (const origin of [oldOrigin, newOrigin]) {
      const response = await context.request.get(origin + "/");
      assert.ok(response.ok());
      const match = (await response.text()).match(
        /\/charting_library_[a-f0-9]{16}\//,
      );
      assert.ok(match);
      roots.push(match[0]);
    }
    assert.notEqual(roots[0], roots[1]);
    report.versions = roots;
    const proxy = roots
      .map(
        (root, i) =>
          `location ${root} { proxy_pass ${[oldOrigin, newOrigin][i]}; proxy_ssl_verify off; proxy_hide_header Cache-Control; add_header Cache-Control "public, max-age=31536000, immutable" always; }`,
      )
      .join("\n");
    fs.writeFileSync(
      path.join(directory, "default.conf"),
      `server { listen 80; root /fixture; add_header Cache-Control no-store always; ${proxy} }`,
    );
    const html = (
      root,
    ) => `<!doctype html><div id="chart" style="height:600px"></div><script src="${root}charting_library.js"></script><script>
      globalThis.loaded=false;
      const feed={onReady:cb=>setTimeout(()=>cb({supported_resolutions:['5']}),0),
        resolveSymbol:(name,cb)=>setTimeout(()=>cb({name,ticker:name,description:name,type:'forex',session:'24x7',timezone:'Etc/UTC',minmov:1,pricescale:100000,has_intraday:true,supported_resolutions:['5']}),0),
        getBars:(s,r,p,cb)=>{const bars=Array.from({length:p.countBack},(_,i)=>({time:(p.to-(p.countBack-i)*300)*1000,open:1.1,high:1.2,low:1,close:1.15}));setTimeout(()=>cb(bars,{noData:false}),0)},
        subscribeBars(){},unsubscribeBars(){}};
      globalThis.widget=new TradingView.widget({container:'chart',library_path:'${root}',symbol:'EURUSD',interval:'5',datafeed:feed,autosize:true});
      widget.onChartReady(()=>widget.activeChart().dataReady(()=>loaded=true));
    </script>`;
    fs.writeFileSync(path.join(directory, "index.html"), html(roots[0]));
    fs.writeFileSync(
      path.join(directory, "compose.yaml"),
      `name: ${name}
services:
  proxy:
    image: nginx:1.28-alpine
    labels: {mw-task: native-content-cache}
    ports: ['127.0.0.1:${port}:80']
    volumes:
      - ./:/fixture:ro
      - ./default.conf:/etc/nginx/conf.d/default.conf:ro
`,
    );
    projectStarted = true;
    docker(`docker compose -f ${directory}/compose.yaml up -d`);
    const page = await context.newPage(),
      session = await context.newCDPSession(page);
    await session.send("Network.enable");
    const requests = new Map(),
      cached = new Set();
    let stage;
    session.on("Network.requestWillBeSent", (e) =>
      requests.set(e.requestId, e.request.url),
    );
    session.on("Network.requestServedFromCache", (e) =>
      cached.add(requests.get(e.requestId)),
    );
    page.on("pageerror", (e) => {
      (stage.errors ||= []).push(e.message);
    });
    const library = "bundles/library.e2f8b3a016c9e1a0b7a5.js";
    for (const [label, index] of [
      ["old-cold", 0],
      ["old-warm", 0],
      ["new-after-old", 1],
      ["new-warm", 1],
    ]) {
      stage = { label, version: roots[index], scripts: [], cached: [] };
      report.stages.push(stage);
      cached.clear();
      fs.writeFileSync(path.join(directory, "index.html"), html(roots[index]));
      const seen = [];
      const listener = (r) => {
        if (r.url().endsWith(library)) seen.push(r);
      };
      page.on("response", listener);
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForFunction(() => loaded, null, { timeout: 30000 });
      assert.equal(seen.length, 1, "one matching native bundle per widget");
      for (const response of seen) {
        const digest = createHash("sha256")
          .update(await response.body())
          .digest("hex");
        stage.scripts.push({
          path: new URL(response.url()).pathname,
          sha256: digest,
        });
        assert.equal(
          digest.slice(0, 16),
          roots[index].match(/[a-f0-9]{16}/)[0],
          "executed library bytes match the content version",
        );
      }
      stage.cached = [...cached].map((url) => new URL(url).pathname);
      if (label.endsWith("warm"))
        assert.ok(
          stage.cached.some((p) => p.endsWith(library)),
          "warm navigation must genuinely exercise HTTP cache",
        );
      assert.deepEqual(stage.errors || [], []);
      stage.passed = true;
      page.off("response", listener);
      save();
    }
    report.passed = true;
    save();
  } finally {
    await browser?.close();
    if (projectStarted)
      docker(`docker compose -f ${directory}/compose.yaml down`);
    fs.rmSync(directory, { recursive: true, force: true });
    save();
  }
})().catch((error) => {
  report.error = String(error);
  save();
  console.error(error);
  process.exitCode = 1;
});
