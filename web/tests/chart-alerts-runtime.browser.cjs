const { chromium } = require("@playwright/test");
const { execFileSync } = require("node:child_process");
const fs = require("fs"),
  assert = require("node:assert/strict");
const APP = process.env.APP_ORIGIN || "https://localhost:19443";
const CHART = process.env.CHART_ORIGIN || "https://127.0.0.1:19444";
const PRIVATE =
  process.env.MW_ALERT_PRIVATE_DIR || "/tmp/mw-chart-alerts-acceptance";
const ENVIRONMENTS = {
  "/tmp/mw-chart-alerts-acceptance": [
    "https://localhost:19443",
    "https://127.0.0.1:19444",
  ],
  "/tmp/mw-chart-alerts-integration": [
    "https://localhost:19543",
    "https://127.0.0.1:19544",
  ],
};
assert.deepEqual(
  ENVIRONMENTS[PRIVATE],
  [APP, CHART],
  "Only corresponding named local acceptance endpoints and credentials are allowed",
);
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1600, height: 1000 },
    }),
    page = await context.newPage();
  const report = {
      scope:
        "actual Ubuntu Docker application, native widget and authenticated parent API; real Binance source",
      cases: [],
    },
    errors = [],
    leaked = [];
  page.on("request", (r) => {
    if (
      r.url().startsWith(CHART + "/") &&
      (r.headers().cookie || r.headers().authorization)
    )
      leaked.push(new URL(r.url()).pathname);
  });
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    for (let i = 0; i < 120; i++) {
      const ready = await context.request
        .get(APP + "/readyz")
        .catch(() => null);
      if (ready?.status() === 200) break;
      if (i === 119) throw Error("deployed HTTPS API readiness timeout");
      await page.waitForTimeout(500);
    }
    await page.goto(APP + "/");
    await page
      .getByLabel("管理员密码")
      .fill(JSON.parse(fs.readFileSync(PRIVATE + "/login.json")).password);
    const response = page.waitForResponse(
      (r) => r.url().endsWith("/api/login") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "登录工作台" }).click();
    assert.equal((await response).status(), 200);
    const workspace = await page.evaluate(async () => {
      const session = await (await fetch("/api/session")).json();
      async function post(path, body) {
        const r = await fetch("/api" + path, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": session.csrf,
          },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw Error(path + " " + r.status + " " + (await r.text()));
        return r.json();
      }
      const row = await post("/advanced-charts/workspaces", {
        name: "图表告警实际实例验收",
      });
      return post("/advanced-charts/workspaces/" + row.id + "/save", {
        name: row.name,
        revision: row.revision,
        document: {
          engine: "tv31",
          schemaVersion: 1,
          symbol: "MWP:BTCUSDT",
          interval: "1",
        },
      });
    });
    fs.writeFileSync(
      PRIVATE + "/runtime-workspace.json",
      JSON.stringify({ id: workspace.id }),
    );
    await page.goto(APP + "/advanced-charts");
    const frame = await new Promise(async (resolve, reject) => {
      for (let i = 0; i < 100; i++) {
        const f = page.frames().find((f) => f.url().startsWith(CHART + "/"));
        if (f) return resolve(f);
        await page.waitForTimeout(300);
      }
      reject(Error("chart frame missing"));
    });
    await frame.waitForFunction(
      () => ready && !loading && widget.activeChart().dataReady(),
      null,
      { timeout: 60000 },
    );

    report.cases.push("actual HTTPS login and platform native chart load");
    const nativeUI = frame.childFrames()[0];
    await nativeUI.getByText("创建告警", { exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    assert.equal(await dialog.getByLabel("触发次数").inputValue(), "1");
    const priceName = "真实实例价格告警 " + Date.now();
    await dialog.getByLabel("名称", { exact: true }).fill(priceName);
    await dialog.getByLabel("比较值", { exact: true }).fill("1000000");
    await dialog.getByLabel(/^判定/).selectOption("intrabar");
    await dialog.getByLabel("触发次数").selectOption("2");
    await dialog.getByRole("button", { name: /消息与通知/ }).click();
    await dialog.getByLabel("消息正文").fill("价格观察 {symbol}");
    await dialog.getByRole("button", { name: "应用到草稿" }).click();
    const created = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/chart-alerts") &&
        r.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "创建告警", exact: true }).click();
    const priceRow = await (await created).json();
    assert.ok(priceRow.id);
    assert.equal(priceRow.config.series_kind, "provider");
    assert.equal(priceRow.config.source, "binance");
    assert.equal(priceRow.config.max_triggers, 2);
    await dialog.waitFor({ state: "hidden" });
    report.price_alert = priceRow.id;
    report.cases.push(
      "native toolbar opens real unified form; source snapshot, finite count and message persist via authenticated API",
    );
    const api = async (path, body) =>
      page.evaluate(
        async ({ path, body }) => {
          const session = await (await fetch("/api/session")).json();
          const r = await fetch(
            "/api" + path,
            body
              ? {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "X-CSRF-Token": session.csrf,
                  },
                  body: JSON.stringify(body),
                }
              : {},
          );
          if (!r.ok) throw Error(path + " " + r.status);
          return r.json();
        },
        { path, body },
      );
    const until = async (check, description) => {
      for (let i = 0; i < 100; i++) {
        if (await check()) return;
        await page.waitForTimeout(250);
      }
      throw Error(description);
    };
    await until(
      async () =>
        (await api("/chart-alerts/" + priceRow.id)).health === "ready",
      "price worker ready",
    );
    assert.equal((await api("/chart-alerts/" + priceRow.id)).count, 0);
    const article = page
      .locator(".chart-alert-card")
      .filter({ hasText: priceName });
    await article.getByRole("button", { name: "暂停", exact: true }).click();
    await article.getByRole("button", { name: "恢复", exact: true }).click();
    await until(
      async () =>
        (await api("/chart-alerts/" + priceRow.id)).status === "active",
      "resumed",
    );
    const before = (await api("/chart-alerts")).length;
    await article.getByRole("button", { name: "复制为草稿" }).click();
    assert.equal((await api("/chart-alerts")).length, before);
    await dialog.getByRole("button", { name: "取消（保留草稿）" }).click();
    report.cases.push(
      "actual panel pause/resume uses persisted lifecycle; copying only opens a draft",
    );
    const drawing = await frame.evaluate(async () => {
      const chart = widget.activeChart();
      const range = chart.getVisibleRange();
      const id = await chart.createShape(
        { time: range.to - 600, price: 1000000 },
        { shape: "horizontal_line" },
      );
      await alertBridge.create({ chart, object: { type: "shape", id } });
      return id;
    });
    await dialog.waitFor();
    await dialog.getByLabel("名称", { exact: true }).fill("真实实例画线告警");
    const drawingResponse = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/chart-alerts") &&
        r.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "创建告警", exact: true }).click();
    let drawingRow = await (await drawingResponse).json();
    assert.equal(drawingRow.config.association.object_kind, "drawing");
    assert.equal(
      drawingRow.config.condition.right.line.kind,
      "horizontal_line",
    );
    await dialog.waitFor({ state: "hidden" });
    report.drawing_alert = drawingRow.id;
    await frame.waitForFunction(
      (id) => alertBridge.diagnostics().rows.some((row) => row.id === id),
      drawingRow.id,
      { timeout: 10000 },
    );
    await frame.evaluate(
      ({ id }) => {
        widget
          .activeChart()
          .getShapeById(id)
          .setPoints([
            {
              time: widget.activeChart().getShapeById(id).getPoints()[0].time,
              price: 1000001,
            },
          ]);
        widget
          .activeChart()
          .getShapeById(id)
          .setProperties({ linecolor: "#00cc00" });
      },
      { id: drawing },
    );
    await until(
      async () => (await api("/chart-alerts/" + drawingRow.id)).version === 2,
      "actual drawing edit persisted",
    );
    drawingRow = await api("/chart-alerts/" + drawingRow.id);
    assert.equal(
      Number(drawingRow.config.condition.right.line.points[0].price),
      1000001,
    );
    report.cases.push(
      "actual native drawing geometry saves through authenticated parent and generates a new persisted version",
    );
    // Real platform history and the deployed geometry endpoint, without route mocks.
    const actualBars = await frame.evaluate(async () => {
      const c = widget.activeChart();
      return (
        await query(c.symbol(), c.resolution(), {
          before: Date.now() + 60000,
          limit: 120,
        })
      ).bars;
    });
    const price = Number(actualBars.at(-1).close);
    const dragId = await frame.evaluate(
      async ({ price, bars }) => {
        const c = widget.activeChart();
        const id = await c.createShape(
          { time: bars.at(-10).chart_time / 1000, price },
          { shape: "horizontal_line" },
        );
        c.getShapeById(id).setProperties({
          linecolor: "#00cc00",
          linewidth: 4,
        });
        await alertBridge.create({ chart: c, object: { type: "shape", id } });
        return id;
      },
      { price, bars: actualBars },
    );
    await dialog.waitFor();
    await dialog
      .getByLabel("名称", { exact: true })
      .fill("真实鼠标拖动 " + Date.now());
    const dragCreated = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/chart-alerts") &&
        r.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "创建告警", exact: true }).click();
    const dragRow = await (await dragCreated).json();
    await dialog.waitFor({ state: "hidden" });
    await frame.waitForFunction(
      (id) => alertBridge.diagnostics().rows.some((r) => r.id === id),
      dragRow.id,
    );
    const dragShot = PRIVATE + "/runtime-drag-before.png";
    await page.screenshot({ path: dragShot });
    const box = await page
      .locator('iframe[title="专业图表工作区"]')
      .boundingBox();
    const x = Math.round(box.x + box.width * 0.55);
    const y = Number(
      execFileSync(
        "python",
        [
          "-c",
          `
from PIL import Image
import sys
im=Image.open(sys.argv[1]).convert('RGB'); x=int(sys.argv[2])
ys=[y for y in range(int(sys.argv[3])+50,int(sys.argv[4])-50) for xx in range(x-3,x+4) if (lambda r,g,b:r<30 and 150<g<230 and b<30)(*im.getpixel((xx,y)))]
assert ys,'native green line must be visible'
print(sum(ys)/len(ys))
`,
          dragShot,
          String(x),
          String(box.y),
          String(box.y + box.height),
        ],
        { encoding: "utf8" },
      ),
    );
    const edits = [];
    page.on("request", (r) => {
      if (r.url().endsWith("/chart-alerts/" + dragRow.id + "/edit"))
        edits.push(r.postDataJSON());
    });
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 30, { steps: 12 });
    await page.waitForTimeout(150);
    assert.equal(edits.length, 0);
    await page.mouse.up();
    await until(
      async () => (await api("/chart-alerts/" + dragRow.id)).version === 2,
      "real pointer release persisted",
    );
    assert.equal(edits.length, 1);
    report.drag = {
      alert: dragRow.id,
      writes_during_pointer_down: 0,
      edits_on_release: 1,
      version: 2,
    };
    report.cases.push(
      "actual mouse drag against deployed application previews without writes and commits exactly once on release",
    );
    await api("/chart-alerts/" + dragRow.id + "/lifecycle", {
      version: 2,
      control_revision: (await api("/chart-alerts/" + dragRow.id))
        .control_revision,
      request_id: crypto.randomUUID(),
      action: "pause",
    });
    await frame.evaluate((id) => widget.activeChart().removeEntity(id), dragId);
    report.sloping_alerts = [];
    for (const kind of ["trend_line", "ray"]) {
      const scale = kind === "ray" ? 1 : 0;
      await frame.evaluate(
        async ({ kind, scale, bars, price }) => {
          const c = widget.activeChart();
          c.getPanes()[0].getMainSourcePriceScale().setMode(scale);
          const points = [
            { time: bars.at(-25).chart_time / 1000, price: price * 0.9 },
            { time: bars.at(-5).chart_time / 1000, price: price * 0.95 },
          ];
          if (kind === "ray") {
            points[0].time = bars.at(-1).chart_time / 1000 + 10 * 60;
            points[1].time = bars.at(-1).chart_time / 1000 + 30 * 60;
            points.reverse();
          }
          const id = await c.createMultipointShape(points, {
            shape: kind,
            overrides: { extendRight: true },
          });
          await alertBridge.create({ chart: c, object: { type: "shape", id } });
        },
        { kind, scale, bars: actualBars, price },
      );
      await dialog.waitFor();
      await dialog
        .getByLabel("名称", { exact: true })
        .fill("真实斜线 " + kind + " " + Date.now());
      await dialog.getByLabel(/^判定/).selectOption("intrabar");
      const response = page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/chart-alerts") &&
          r.request().method() === "POST",
      );
      await dialog
        .getByRole("button", { name: "创建告警", exact: true })
        .click();
      const row = await (await response).json();
      assert.equal(row.config.condition.right.line.kind, kind);
      assert.equal(
        row.config.condition.right.line.scale,
        scale ? "log" : "linear",
      );
      assert.equal(
        Math.abs(row.config.condition.right.line.points[1].index),
        20,
      );
      await dialog.waitFor({ state: "hidden" });
      await until(
        async () => (await api("/chart-alerts/" + row.id)).health === "ready",
        "slope autonomous evaluation",
      );
      assert.equal((await api("/chart-alerts/" + row.id)).count, 0);
      report.sloping_alerts.push({
        id: row.id,
        kind,
        scale: scale ? "log" : "linear",
        health: "ready",
      });
    }
    await frame.evaluate(() =>
      widget.activeChart().getPanes()[0].getMainSourcePriceScale().setMode(0),
    );
    report.cases.push(
      "real-source linear trend and reversed log ray persist native bar-index geometry and reach ready autonomous evaluation",
    );
    report.indicator_alerts = [];
    for (const name of ["SMA", "EMA", "RSI", "MACD"]) {
      await frame.evaluate(async (name) => {
        const c = widget.activeChart();
        const id = await c.createStudy(
          "守望 Python " + name,
          false,
          false,
          {
            SMA: { period: 20 },
            EMA: { period: 20 },
            RSI: { period: 14 },
            MACD: { fast: 12, slow: 26, signal: 9 },
          }[name],
        );
        for (let i = 0; i < 100; i++) {
          if (alertCalculationOrigins.has(c.symbol() + "|" + c.resolution()))
            break;
          await new Promise((r) => setTimeout(r, 100));
        }
        await alertBridge.create({ chart: c, object: { type: "study", id } });
      }, name);
      await dialog.waitFor();
      await dialog
        .getByLabel("名称", { exact: true })
        .fill("真实指标 " + name + " " + Date.now());
      await dialog.getByLabel(/^判定/).selectOption("intrabar");
      await dialog.getByLabel("比较值", { exact: true }).fill("1000000");
      const response = page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/chart-alerts") &&
          r.request().method() === "POST",
      );
      await dialog
        .getByRole("button", { name: "创建告警", exact: true })
        .click();
      const row = await (await response).json();
      assert.equal(row.config.condition.left.indicator.name, name);
      assert.ok(Number.isSafeInteger(row.config.calculation_origin));
      await dialog.waitFor({ state: "hidden" });
      await until(
        async () => (await api("/chart-alerts/" + row.id)).health === "ready",
        "real indicator autonomous evaluation " + name,
      );
      assert.equal((await api("/chart-alerts/" + row.id)).count, 0);
      report.indicator_alerts.push({
        id: row.id,
        name,
        calculation_origin: row.config.calculation_origin,
        health: "ready",
      });
    }
    report.cases.push(
      "four actual native studies create parameter/history snapshots through authenticated parent and reach ready on real provider data",
    );
    await page.reload();
    await page.locator('iframe[title="专业图表工作区"]').waitFor();
    const restoredFrame = await new Promise(async (resolve, reject) => {
      for (let i = 0; i < 100; i++) {
        const f = page.frames().find((f) => f.url().startsWith(CHART + "/"));
        if (f) return resolve(f);
        await page.waitForTimeout(250);
      }
      reject(Error("refresh frame missing"));
    });
    await restoredFrame.waitForFunction(
      () => ready && !loading && widget.activeChart().dataReady(),
      null,
      { timeout: 60000 },
    );
    await restoredFrame.waitForFunction(
      () =>
        widget
          .activeChart()
          .getAllShapes()
          .some(
            (s) =>
              s.name === "horizontal_line" &&
              widget.activeChart().getShapeById(s.id).getPoints()[0].price ===
                1000001,
          ),
      null,
      { timeout: 15000 },
    );
    const current = await api("/chart-alerts/" + drawingRow.id);
    assert.equal(current.version, 2);
    assert.equal(current.status, "active");
    await restoredFrame.evaluate(() => {
      const chart = widget.activeChart(),
        shape = chart
          .getAllShapes()
          .find(
            (s) =>
              s.name === "horizontal_line" &&
              chart.getShapeById(s.id).getPoints()[0].price === 1000001,
          );
      chart.removeEntity(shape.id);
    });
    await until(
      async () =>
        (await api("/chart-alerts/" + drawingRow.id)).status === "paused",
      "actual explicit deletion",
    );
    report.cases.push(
      "actual page refresh restores backend drawing; explicit deletion pauses the persisted rule",
    );
    report.errors = errors;
    report.credentials_sent_to_chart = leaked;
    assert.deepEqual(leaked, []);
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      PRIVATE + "/runtime-browser.json",
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));

    await page.screenshot({
      path: PRIVATE + "/runtime-bootstrap.png",
    });
  } catch (error) {
    fs.rmSync(PRIVATE + "/runtime-browser.json", {
      force: true,
    });
    await page.screenshot({
      path: PRIVATE + "/runtime-browser-failure.png",
    });
    fs.writeFileSync(
      PRIVATE + "/runtime-browser-failure.txt",
      await page.locator("body").innerText(),
    );
    throw error;
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
