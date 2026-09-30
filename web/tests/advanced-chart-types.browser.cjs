// Native chart-style switching and final HLCBars persistence on real development data.
const { chromium } = require("playwright");
const fs = require("fs");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1600, height: 950 },
  });
  const base = process.env.MARKET_WATCH_TEST_URL || "http://127.0.0.1:5188";
  const cutoff = Number(process.env.MARKET_WATCH_HISTORY_BEFORE || 0);
  if (cutoff)
    await page.route(/\/api\/(market-data\/history|charts\/data)$/, (route) => {
      const q = route.request().postDataJSON();
      return route.continue({
        postData: JSON.stringify({
          ...q,
          before: Math.min(q.before || cutoff, cutoff),
        }),
      });
    });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") console.log("CONSOLE", m.text().slice(0, 700));
  });
  page.on("response", async (r) => {
    if (
      r.url().includes("/api/charts/data") ||
      r.url().includes("/api/market-data/history")
    ) {
      const j = await r.json().catch(() => ({}));
      console.log(
        "RESPONSE",
        r.status(),
        r.url(),
        j.status,
        j.bars?.length,
        j.detail,
      );
    }
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/");
  await page
    .getByLabel("管理员密码")
    .fill(
      JSON.parse(
        fs.readFileSync(
          process.env.MARKET_WATCH_TEST_CREDENTIALS ||
            require("node:path").resolve(
              __dirname,
              "../../../market-watch/artifacts/local-credentials.json",
            ),
        ),
      ).password,
    );
  await page.getByRole("button", { name: "登录工作台" }).click();
  await page.waitForTimeout(1000);
  console.log(
    await page.evaluate(async () => {
      const session = await (await fetch("/api/session")).json();
      async function post(path, body) {
        let r = await fetch("/api" + path, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": session.csrf,
          },
          body: JSON.stringify(body),
        });
        return r.json();
      }
      const row = await post("/advanced-charts/workspaces", {
        name: "原生图表类型验收",
      });
      await post("/advanced-charts/workspaces/" + row.id + "/save", {
        name: row.name,
        revision: row.revision,
        document: {
          engine: "tv31",
          schemaVersion: 1,
          symbol: "OANDA:NZD_USD",
          interval: "5",
        },
      });
      const catalog = await (
        await fetch("/api/market-data/catalog?query=NZD_USD")
      ).json();
      return catalog;
    }),
  );
  await page.goto(base + "/advanced-charts");
  await page.waitForTimeout(15000);
  let frame = page.frames().find((f) => f.url().includes(":5187/?"));
  const assert=require("node:assert/strict");
  const definition=fs.readFileSync("../advanced-host/charting_library/charting_library.d.ts","utf8").match(/export declare enum ChartStyle \{([^}]+)\}/)[1];
  const styles=Array.from(definition.matchAll(/(\w+) = (\d+)/g),match=>({name:match[1],value:Number(match[2])}));
  for(const style of styles) {
    if(style.name==="VolCandle") {console.log("UNAVAILABLE_REAL_VOLUME",style);continue;}
    console.log("CHART_TYPE_START",style);
    await frame.evaluate(type=>widget.activeChart().setChartType(type),style.value);
    await frame.waitForFunction(type=>widget.activeChart().chartType()===type&&widget.activeChart().dataReady(),style.value,{timeout:60000});
    assert.equal(await frame.evaluate(()=>widget.activeChart().chartType()),style.value);
    console.log("CHART_TYPE_PASSED",style);
  }
  await page.waitForTimeout(2000);
  await frame.waitForFunction(()=>!nativeSaving&&!loading&&!rangeGuard?.busy());
  await frame.evaluate(()=>new Promise((ok,fail)=>widget.saveChartToServer(ok,error=>fail(Error(JSON.stringify(error))))));
  await page.reload();
  await page.waitForTimeout(15000);
  frame=page.frames().find(f=>f.url().includes(":5187/?"));
  await frame.waitForFunction(()=>ready&&!loading&&widget.activeChart().dataReady());
  assert.equal(await frame.evaluate(()=>widget.activeChart().chartType()),21);
  assert.deepEqual(errors,[]);
  console.log("CHART_TYPE_MATRIX_PASSED");
  await browser.close();
})().catch(error=>{console.error(error);process.exit(1)});
