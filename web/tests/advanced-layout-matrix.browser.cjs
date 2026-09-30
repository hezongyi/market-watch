// Development theme persistence regression. Sets shared preference to Light.
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
        name: "布局矩阵验收",
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
  const assert = require("node:assert/strict");
  const declaration = fs.readFileSync("../advanced-host/charting_library/charting_library.d.ts","utf8");
  const union = declaration.match(/export type MultipleChartsLayoutType = ([^;]+);/)[1];
  const layouts = ["s",...Array.from(union.matchAll(/"([^"]+)"/g),match=>match[1])];
  for (const layout of layouts) {
    await frame.evaluate(layout=>widget.setLayout(layout),layout);
    await frame.waitForFunction(layout=>widget.layout()===layout
      && Array.from({length:widget.chartsCount()},(_,i)=>widget.chart(i)).every(chart=>
        chart.dataReady() && chart.getTimeScale().width()>0),layout,{timeout:60000});
    const result=await frame.evaluate(()=>({layout:widget.layout(),count:widget.chartsCount()}));
    assert.ok(result.count>=1&&result.count<=8);
    if(result.count>1) {
      await frame.evaluate(()=>widget.activeChart().maximizeChart());
      await frame.waitForFunction(()=>widget.activeChart().isMaximized());
      await frame.evaluate(()=>widget.activeChart().restoreChart());
      await frame.waitForFunction(()=>!widget.activeChart().isMaximized());
    }
    console.log("LAYOUT_PASSED",result);
  }
  await frame.evaluate(()=>new Promise((resolve,reject)=>widget.saveChartToServer(resolve,reject)));
  await page.reload();
  await page.waitForTimeout(15000);
  frame=page.frames().find(f=>f.url().includes(":5187/?"));
  await frame.waitForFunction(()=>ready&&!loading&&widget.chartsCount()===8);
  assert.equal(await frame.evaluate(()=>widget.layout()),"8v");
  assert.deepEqual(errors,[]);
  console.log("LAYOUT_MATRIX_PASSED",layouts.length);
  await browser.close();
})().catch(error=>{console.error(error);process.exit(1)});
