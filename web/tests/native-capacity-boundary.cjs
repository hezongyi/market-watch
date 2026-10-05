const assert = require("node:assert/strict");
module.exports = async ({
  page,
  frame,
  native,
  settle,
  box,
  snapshot,
  item,
  save,
}) => {
  const dialog = page.locator(".history-capacity-dialog");
  async function capacity(value) {
    await native.getByRole("button", { name: "图表菜单", exact: true }).click();
    await native
      .getByRole("button", { name: "历史数据容量", exact: true })
      .click();
    await dialog.waitFor();
    await dialog.getByLabel("单源容量（根）").fill(String(value));
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await frame.waitForFunction(
      (n) => MWNativeNavigation.diagnostics().limits.max_bars === n,
      value,
    );
  }
  await capacity(80000);
  await frame.evaluate(async () => {
    for (let i = 0; i < widget.chartsCount(); i++)
      for (const study of ["Moving Average", "Relative Strength Index", "MACD"])
        await widget
          .chart(i)
          .createStudy(
            study,
            false,
            false,
            study === "Moving Average" ? { length: 200 } : {},
          );
  });
  await settle();
  const events = [];
  await page.exposeFunction("recordBoundary", (value) => events.push(value));
  await page.evaluate(() =>
    addEventListener("message", (event) => {
      if (event.data?.type === "capacity-notice")
        globalThis.recordBoundary(event.data);
    }),
  );
  const target = Date.parse("2025-07-14") / 1000;
  await frame.evaluate(async (t) => {
    widget.timeSync().setValue(false);
    await widget
      .chart(0)
      .setVisibleRange(
        { from: t - 30 * 86400, to: t + 30 * 86400 },
        { rejectByTimeout: 120000 },
      );
    widget.timeSync().setValue(true);
  }, target);
  const b = await box(0, true),
    x = await frame.evaluate((t) => {
      const ts = widget.chart(0)._chartWidget.model().model().timeScale(),
        r = ts.points().range().value();
      for (let i = r.firstIndex; i <= r.lastIndex; i++)
        if (ts.points().valueAt(i) === t) return ts.indexToCoordinate(i);
      throw Error("weekly missing");
    }, target);
  const at = Date.now();
  await page.mouse.move(b.x + x, b.y + b.height * 0.45);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForFunction(
    () =>
      document
        .querySelector(".history-capacity-result")
        ?.textContent.includes("实际已定位至"),
    null,
    { timeout: 120000 },
  );
  await settle();
  item.boundary = {
    clickToReadyMs: Date.now() - at,
    events,
    view: await snapshot(),
    navigation: await frame.evaluate(() => MWNativeNavigation.diagnostics()),
    reserve: await frame.evaluate(() => MWNativeReserve.diagnostics()),
    notices: await frame.evaluate(() => activeNotices),
  };
  save();
  const done = events
    .filter((e) => e.phase === "limited" && e.resolution === "5")
    .at(-1);
  assert.ok(done, JSON.stringify(events));
  assert.equal(done.requested, target);
  const progress = events.filter(e => e.id === done.id && e.resolution === "5" && e.phase === "filling");
  assert.ok(progress.length > 0);
  const firstProgress = events.find(e => e.resolution === "5" && e.phase === "filling");
  assert.equal(done.started,firstProgress.started,
    "native indicator promotion continues the original boundary operation timer");
  assert.ok(progress.every(e => e.started === done.started),
    "real multi-batch operation preserves its own start time");
  assert.equal(done.loadedBars,done.totalBars,
    "real remaining-capacity fill reports aggregate bars rather than the last 20k batch");
  assert.ok(progress.every((e,i) => i === 0 || e.loadedBars >= progress[i-1].loadedBars),
    "operation progress does not restart on a new native batch");
  assert.ok(done.actual > target);
  assert.equal(
    done.resident,
    80000,
    "fills single-source quota rather than just cache edge",
  );
  const view = item.boundary.view.charts[1].range;
  assert.ok(
    view.from <= done.actual && view.to >= done.actual,
    "M5 viewport includes real boundary",
  );
  assert.ok(
    view.to < Date.parse("2026-10-01") / 1000,
    "M5 no longer stays at latest",
  );
  assert.ok(
    !item.boundary.notices.some((e) => e.text.includes("容量")),
    "no capacity modal remains",
  );
  await page.waitForTimeout(2500);
  assert.ok(
    await page.locator(".history-capacity-result").count(),
    "result persists after loading",
  );
  if (process.env.NATIVE_SYNC_OUTPUT)
    await page.screenshot({ path: process.env.NATIVE_SYNC_OUTPUT.replace(".json", "-notice.png") });
  await page.getByRole("button", { name: "关闭提示", exact: true }).click();
  await page
    .locator(".advanced-loading-notice")
    .waitFor({ state: "hidden", timeout: 15000 });
  const before = item.http.length;
  for (let i = 1; i <= 3; i++) {
    await page.mouse.move(b.x + x + i * 4, b.y + b.height * 0.45);
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(2000);
  item.boundary.hoverReads = item.http.slice(before);
  save();
  assert.ok(
    item.boundary.hoverReads.every(
      (r) => !r.query?.countBack || r.query.countBack < 20000,
    ),
  );
  await capacity(200000);
  if (process.env.NATIVE_BOUNDARY_MULTI === "1") {
    await frame.evaluate(async () => {
      widget.timeSync().setValue(false);
      await widget.chart(2).setResolution("15", { doNotActivateChart: true });
      widget.timeSync().setValue(true);
    });
    await settle();
    await capacity(20000);
    const multiStart = events.length;
    await page.mouse.move(b.x + x, b.y + b.height * 0.45);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".history-capacity-result").length >= 2 &&
        [...document.querySelectorAll(".history-capacity-result")].every((e) =>
          e.textContent.includes("实际已定位至"),
        ),
      null,
      { timeout: 120000 },
    );
    await settle();
    item.multiBoundary = {
      events: events.slice(multiStart),
      view: await snapshot(),
      navigation: await frame.evaluate(() => MWNativeNavigation.diagnostics()),
      notices: await frame.evaluate(() => activeNotices),
    };
    save();
    for (const resolution of ["5", "15"]) {
      const result = item.multiBoundary.events
        .filter((e) => e.phase === "limited" && e.resolution === resolution)
        .at(-1);
      assert.ok(result, JSON.stringify(item.multiBoundary.events));
      const chart = item.multiBoundary.view.charts.find(
        (c) => c.resolution === resolution,
      );
      assert.ok(
        chart.range.from <= result.actual && chart.range.to >= result.actual,
        "every overlimit chart locates its own real boundary",
      );
      assert.ok(result.actual > target);
    }
    assert.ok(!item.multiBoundary.notices.some((n) => n.text.includes("容量")));
    await page
      .getByRole("button", { name: "调整历史容量", exact: true })
      .click();
    await dialog.waitFor();
    await dialog.getByLabel("单源容量（根）").fill("200000");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "关闭提示", exact: true }).click();
    // A shared provider cache must not turn an idle pane into a navigation peer.
    await frame.evaluate(async () => {
      widget.timeSync().setValue(false);
      await widget.chart(2).setResolution("5", { doNotActivateChart: true });
      const latest = Date.parse("2026-10-02") / 1000;
      await widget.chart(2).setVisibleRange({ from: latest - 86400, to: latest }, { rejectByTimeout: 120000 });
    });
    await settle();
    await capacity(80000);
    const idleBefore = (await snapshot()).charts[2].range;
    await frame.evaluate(async (t) => {
      await widget.chart(1).setVisibleRange({ from:t - 86400,to:t + 86400 },
        {rejectByTimeout:120000}).catch(() => {});
    }, Date.parse("2024-03-11") / 1000);
    await page.waitForFunction(() =>
      document.querySelector(".history-capacity-result")?.textContent.includes("实际已定位至"),
      null, {timeout:120000});
    await settle();
    item.sharedIdleBoundary = { before:idleBefore, after:(await snapshot()).charts[2].range };
    save();
    assert.deepEqual(item.sharedIdleBoundary.after, idleBefore,
      "idle same-source pane retains its viewport when only its peer navigates beyond capacity");
    await capacity(200000);
    await page.getByRole("button", { name: "关闭提示", exact: true }).click();
  }
};
