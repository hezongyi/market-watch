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
        name: "绘图分组保存验收",
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
  const expected = await frame.evaluate(async () => {
    const chart = widget.activeChart();
    const a = await chart.createShape(
      { time: 1790323200, price: 0.565 },
      { shape: "horizontal_line" },
    );
    const b = await chart.createMultipointShape(
      [
        { time: 1790323200, price: 0.563 },
        { time: 1790337600, price: 0.566 },
      ],
      { shape: "trend_line" },
    );
    chart.selection().add([a, b]);
    const groups = chart.shapesGroupController(),
      id = groups.createGroupFromSelection();
    groups.setGroupName(id, "回落入场分析");
    groups.setGroupLock(id, true);
    groups.setGroupVisibility(id, false);
    return {
      id,
      name: groups.getGroupName(id),
      members: groups.shapesInGroup(id),
      lock: groups.groupLock(id),
      visible: groups.groupVisibility(id),
    };
  });
  console.log("GROUP_BEFORE", expected);
  await page.waitForTimeout(2000);
  await frame.waitForFunction(
    () => !loading && !nativeSaving && !rangeGuard?.busy(),
  );
  await frame.evaluate(
    () =>
      new Promise((ok, fail) =>
        widget.saveChartToServer(ok, (error) =>
          fail(Error(JSON.stringify(error))),
        ),
      ),
  );
  await page.reload();
  await page.waitForTimeout(15000);
  frame = page.frames().find((f) => f.url().includes(":5187/?"));
  await frame.waitForFunction(
    () => ready && !loading && widget.activeChart().dataReady(),
  );
  const restored = await frame.evaluate((id) => {
    const groups = widget.activeChart().shapesGroupController();
    return {
      id,
      name: groups.getGroupName(id),
      members: groups.shapesInGroup(id),
      lock: groups.groupLock(id),
      visible: groups.groupVisibility(id),
    };
  }, expected.id);
  assert.deepEqual(restored, expected);
  const toggled = await frame.evaluate((id) => {
    const groups = widget.activeChart().shapesGroupController();
    groups.setGroupLock(id, false);
    groups.setGroupVisibility(id, true);
    return { lock: groups.groupLock(id), visible: groups.groupVisibility(id) };
  }, expected.id);
  assert.deepEqual(toggled, { lock: "Unlocked", visible: "Visible" });
  const native = page.frames().find((f) => f.url().startsWith("blob:"));
  if (!(await native.getByText("回落入场分析", { exact: true }).isVisible()))
    await native
      .getByRole("button", { name: "显示对象树", exact: true })
      .click();
  await native.getByText("回落入场分析", { exact: true }).waitFor();
  await page.screenshot({ path: "/tmp/mw-drawing-object-tree.png" });
  await frame.evaluate(
    (id) => widget.activeChart().removeEntity(id),
    expected.members[1],
  );
  await frame.waitForFunction(
    () => widget.activeChart().getAllShapes().length === 1,
  );
  await frame.evaluate(() => widget.activeChart().executeActionById("undo"));
  await frame.waitForFunction(
    () => widget.activeChart().getAllShapes().length === 2,
  );
  const undone = await frame.evaluate(
    (id) =>
      Array.from(
        widget.activeChart().shapesGroupController().shapesInGroup(id),
      ),
    expected.id,
  );
  assert.deepEqual(undone, expected.members);
  await frame.evaluate(() => widget.activeChart().executeActionById("redo"));
  await frame.waitForFunction(
    () => widget.activeChart().getAllShapes().length === 1,
  );
  await frame.evaluate(() => widget.activeChart().executeActionById("undo"));
  await frame.waitForFunction(
    () => widget.activeChart().getAllShapes().length === 2,
  );
  console.log("GROUP_DELETE_UNDO_REDO_PASSED");

  assert.deepEqual(errors, []);
  console.log("GROUP_RESTORED", restored, "GROUP_UNLOCKED_SHOWN", toggled);
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
