// Development-only browser acceptance. Uses test workspaces in trading_alerts_dev.
const { chromium } = require("@playwright/test");
const fs = require("fs");
const assert = require("node:assert/strict");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      "/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
  });
  const externalResponses = [];
  const page = await browser.newPage({
    viewport: { width: 1600, height: 950 },
  });
  let errors = [],
    external = [],
    bad = [];
  page.on("response", (r) => {
    if (
      !r.url().startsWith("http://127.0.0.1:") &&
      !r.url().startsWith("data:") &&
      !r.url().startsWith("blob:")
    )
      externalResponses.push(r.url());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") bad.push(m.text().slice(0, 500));
  });
  page.on("request", (r) => {
    if (
      !r.url().startsWith("http://127.0.0.1:") &&
      !r.url().startsWith("data:") &&
      !r.url().startsWith("blob:")
    )
      external.push(r.url());
  });
  await page.goto("http://127.0.0.1:5188/");
  await page
    .getByLabel("管理员密码")
    .fill(
      JSON.parse(
        fs.readFileSync(
          "/home/quant/repos/market-watch/artifacts/local-credentials.json",
        ),
      ).password,
    );
  await page.getByRole("button", { name: "登录工作台" }).click();
  await page.waitForTimeout(1000);
  await page.evaluate(async () => {
    const session = await (await fetch("/api/session")).json();
    const r = await fetch("/api/advanced-charts/workspaces", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": session.csrf,
      },
      body: JSON.stringify({ name: "独立自动验收 " + Date.now() }),
    });
    if (!r.ok) throw Error("create failed");
  });
  await page.goto("http://127.0.0.1:5188/advanced-charts");
  await page.waitForTimeout(5000);
  let frame = page.frames().find((f) => f.url().includes(":5187/?"));
  await frame.waitForFunction(() => ready);
  console.log(
    "initial",
    await frame.evaluate(() => ({
      count: widget.chartsCount(),
      studies: widget.getStudiesList().filter((s) => s.includes("Python")),
    })),
  );
  console.log(
    "draw",
    await frame.evaluate(async () => {
      widget.setLayout("4");
      await new Promise((r) => setTimeout(r, 1500));
      const chart = widget.chart(0);
      chart.removeAllShapes();
      chart.removeAllStudies();
      const range = chart.getVisibleRange();
      const p = { time: range.to - 86400, price: 4200 };
      let shapes = {};
      for (const [tool, points] of Object.entries({
        horizontal_line: [p],
        trend_line: [p, { time: range.to, price: 4210 }],
        ray: [p, { time: range.to, price: 4210 }],
        rectangle: [p, { time: range.to, price: 4210 }],
        fib_retracement: [p, { time: range.to, price: 4210 }],
        text: [p],
        parallel_channel: [
          p,
          { time: range.to, price: 4210 },
          { time: range.to, price: 4220 },
        ],
        long_position: [p],
        short_position: [p],
      })) {
        try {
          shapes[tool] = await chart.createMultipointShape(points, {
            shape: tool,
            ...(tool === "text" ? { text: "验收" } : {}),
          });
        } catch (e) {
          shapes[tool] = String(e);
        }
      }
      return shapes;
    }),
  );
  console.log(
    "study",
    await frame.evaluate(async () => {
      try {
        return await widget
          .chart(0)
          .createStudy("守望 Python SMA", false, false, { period: 20 });
      } catch (e) {
        return String(e);
      }
    }),
  );
  await page.waitForTimeout(6000);
  console.log(
    "chartInfo",
    await frame.evaluate(() => ({
      shapes: [0, 1, 2, 3].map((i) => widget.chart(i).getAllShapes().length),
      studies: widget.chart(0).getAllStudies(),
    })),
  );
  await page.getByRole("button", { name: "立即保存" }).click();
  await page.waitForTimeout(1500);
  console.log("save", await page.locator("[role=status]").textContent());
  await page.screenshot({ path: "/tmp/advanced-four.png" });
  await page.reload();
  await page.waitForTimeout(6000);
  frame = page.frames().find((f) => f.url().includes(":5187/?"));
  console.log(
    "restored",
    await frame.evaluate(() => ({
      count: widget.chartsCount(),
      shapes: widget.chart(0).getAllShapes().length,
      studies: widget.chart(0).getAllStudies(),
    })),
  );
  await page.getByRole("button", { name: "深色 / 浅色" }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "/tmp/advanced-light.png" });
  console.log(JSON.stringify({ errors, external, bad }));
  assert.deepEqual(errors, []);
  assert.deepEqual(externalResponses, []);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
