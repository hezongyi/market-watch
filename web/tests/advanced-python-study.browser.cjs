// Development native fullscreen permissions regression.
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
  await page.goto("http://127.0.0.1:5188/");
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
        name: "按需历史验收 NZDUSD",
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
  await page.goto("http://127.0.0.1:5188/advanced-charts");
  await page.waitForTimeout(15000);
  const frame = page.frames().find((f) => f.url().includes(":5187/?"));
  await page.waitForTimeout(1000);
  const assert = require("node:assert/strict");
  const calculated = [];
  page.on("response", async (response) => {
    if (!response.url().includes("/api/charts/data")) return;
    const data = await response.json().catch(() => null);
    if (data?.indicators?.length) calculated.push(data);
  });
  const study = await frame.evaluate(async () => {
    const id = await widget
      .chart(0)
      .createStudy("守望 Python SMA", false, false, { period: 20 });
    return { id, inputs: widget.chart(0).getStudyById(id).getInputValues() };
  });
  assert.ok(study.id);
  for (let i = 0; i < 30 && !calculated.length; i++)
    await page.waitForTimeout(1000);
  assert.ok(
    calculated.length,
    "Python study must request backend indicator values",
  );
  const sma = calculated.find((d) =>
    d.indicators.some((s) => s.name === "SMA"),
  );
  assert.ok(sma);
  assert.ok(
    sma.indicators
      .find((s) => s.name === "SMA")
      .series[0].values.some((v) => Number.isFinite(v.value)),
  );
  await frame.evaluate(
    () => new Promise((ok, fail) => widget.saveChartToServer(ok, fail)),
  );
  await page.reload();
  await page.waitForTimeout(15000);
  const restoredFrame = page.frames().find((f) => f.url().includes(":5187/?"));
  const restored = await restoredFrame.evaluate(() =>
    widget
      .chart(0)
      .getAllStudies()
      .map((s) => ({
        name: s.name,
        inputs: widget.chart(0).getStudyById(s.id).getInputValues(),
      })),
  );
  console.log("PYTHON_STUDIES", JSON.stringify(restored));
  assert.ok(
    restored.some(
      (s) =>
        s.name.includes("Python SMA") &&
        s.inputs.some((i) => i.id === "period" && i.value === 20),
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    "Python SMA created, backend returned finite values, study and period restored after reload",
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
