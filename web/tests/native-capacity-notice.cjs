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
  // Progress is an explicitly requested operation view, never an automatic strip.
  await frame.evaluate(() => send({type:"history-load-details-open"}));
  async function open() {
    await native.getByRole("button", { name: "图表菜单", exact: true }).click();
    await native
      .getByRole("button", { name: "历史数据容量", exact: true })
      .click();
    await dialog.waitFor();
  }
  async function capacity(value) {
    await open();
    await dialog.getByLabel("单源容量（根）").fill(String(value));
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await frame.waitForFunction(
      (n) => MWNativeNavigation.diagnostics().limits.max_bars === n,
      value,
    );
  }
  await open();
  if ((await dialog.getByLabel("单源容量（根）").inputValue()) !== "200000") {
    await dialog.getByRole("button", { name: "恢复默认值" }).click();
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await open();
  }
  assert.equal(
    await dialog.getByLabel("单源容量（根）").inputValue(),
    "200000",
  );
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await capacity(80000);
  for (const study of ["Moving Average", "Relative Strength Index", "MACD"])
    await frame.evaluate(async (study) => {
      for (let i = 0; i < widget.chartsCount(); i++)
        await widget
          .chart(i)
          .createStudy(
            study,
            false,
            false,
            study === "Moving Average" ? { length: 200 } : {},
          );
    }, study);
  await settle();
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
      throw Error("weekly bar missing");
    }, target);
  const click = async () => {
    await page.mouse.move(b.x + x, b.y + b.height * 0.45);
    await page.mouse.down();
    await page.mouse.up();
  };
  await click();
  await page.waitForFunction(
    () => document.querySelector(".history-capacity-result")?.textContent.includes("实际已定位至"),
    null,
    { timeout: 120000 },
  );
  item.capacityRejected = {
    view: await snapshot(),
    notices: await frame.evaluate(() => activeNotices),
  };
  save();
  assert.ok(
    !item.capacityRejected.view.charts[1].range ||
      item.capacityRejected.view.charts[1].range.from > target,
  );
  assert.ok(!item.capacityRejected.notices.some((entry) => entry.text.includes("容量")),
    "capacity result belongs to the requested history detail view");
  await page.getByRole("button", { name: "关闭提示", exact: true }).click();
  await capacity(200000);
  const events = [];
  await page.exposeFunction("recordCapacityNotice", (value) =>
    events.push(value),
  );
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      const notice = document.querySelector(".advanced-loading-notice");
      if (notice)
        globalThis.recordCapacityNotice({
          at: Date.now(),
          text: notice.textContent,
        });
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    globalThis.__capacityNoticeObserver = observer;
  });
  const at = Date.now();
  await click();
  await frame.waitForFunction(
    (t) => {
      const r = widget.chart(1).getVisibleRange();
      return r.from <= t && r.to >= t;
    },
    target,
    { timeout: 120000 },
  );
  await settle();
  await page
    .locator(".advanced-loading-notice")
    .waitFor({ state: "hidden", timeout: 15000 });
  item.capacityRaised = {
    target,
    clickToReadyMs: Date.now() - at,
    view: await snapshot(),
    navigation: await frame.evaluate(() => MWNativeNavigation.diagnostics()),
    notices: events,
    performance: await frame.evaluate(() => ({
      ...__historyPerf,
      heap: performance.memory?.usedJSHeapSize,
    })),
  };
  save();
  if (item.capacityRaised.clickToReadyMs >= 5500) assert.ok(
    events.some(
      (e) =>
        e.text.includes("EURUSD") &&
        e.text.includes("M5") &&
        e.text.includes("请求") &&
        e.text.includes("UTC"),
    ),
    "loading lasting over five seconds must have complete notice",
  );
  assert.ok(
    item.capacityRaised.view.charts.every(
      (c) => c.studies.length === 3 && c.ready,
    ),
  );
  await capacity(80000);
  await frame.evaluate(
    async (t) =>
      widget
        .chart(1)
        .setVisibleRange(
          { from: t - 86400, to: t + 86400 },
          { rejectByTimeout: 120000 },
        ),
    target,
  );
  await settle();
  assert.ok(
    (await snapshot()).charts[1].range.from <= target,
    "lowering capacity retains cached navigation",
  );
  await capacity(200000);
  await open();
  assert.equal(
    await dialog.getByLabel("单源容量（根）").inputValue(),
    "200000",
  );
  await page.keyboard.press("Escape");
  const before = item.http.length;
  for (let i = 1; i <= 4; i++) {
    await page.mouse.move(b.x + x + i * 4, b.y + b.height * 0.45);
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(2500);
  item.capacityRaised.hoverReads = item.http.slice(before);
  assert.ok(
    item.capacityRaised.hoverReads.every(
      (r) => !r.query?.countBack || r.query.countBack < 20000,
    ),
  );
  item.capacityRaised.final = await snapshot();
  save();
  if (process.env.NATIVE_CAPACITY_COLD === "1") {
    const coldTarget = Date.parse("2024-03-11") / 1000;
    await frame.evaluate(async (t) => {
      widget.timeSync().setValue(false);
      await widget
        .chart(0)
        .setVisibleRange(
          { from: t - 30 * 86400, to: t + 30 * 86400 },
          { rejectByTimeout: 120000 },
        );
      widget.timeSync().setValue(true);
    }, coldTarget);
    const coldBox = await box(0, true),
      coldX = await frame.evaluate((t) => {
        const ts = widget.chart(0)._chartWidget.model().model().timeScale(),
          r = ts.points().range().value();
        for (let i = r.firstIndex; i <= r.lastIndex; i++)
          if (ts.points().valueAt(i) === t) return ts.indexToCoordinate(i);
        throw Error("cold weekly bar missing");
      }, coldTarget);
    const coldClick = async () => {
      await page.mouse.move(
        coldBox.x + coldX,
        coldBox.y + coldBox.height * 0.45,
      );
      await page.mouse.down();
      await page.mouse.up();
    };
    const from = events.length;
    await coldClick();
    await page.waitForFunction(
      () =>
        document
          .querySelector(".advanced-loading-notice")
          ?.textContent.includes("已缓存"),
      null,
      { timeout: 120000 },
    );
    await page
      .getByRole("button", { name: "取消历史加载", exact: true })
      .click();
    await page
      .locator(".advanced-loading-notice")
      .waitFor({ state: "hidden", timeout: 15000 });
    await settle();
    item.coldCancelled = {
      view: await snapshot(),
      notices: events.slice(from),
    };
    save();
    assert.ok(
      events.slice(from).some((e) => e.text.includes("已缓存")),
      "real worker pages visible before cancellation",
    );
    const at = Date.now();
    await coldClick();
    await frame.waitForFunction(
      (t) => {
        const r = widget.chart(1).getVisibleRange();
        return r.from <= t && r.to >= t;
      },
      coldTarget,
      { timeout: 180000 },
    );
    await settle();
    await page
      .locator(".advanced-loading-notice")
      .waitFor({ state: "hidden", timeout: 15000 });
    item.coldHistory = {
      target: coldTarget,
      clickToReadyMs: Date.now() - at,
      view: await snapshot(),
      notices: events.slice(from),
      navigation: await frame.evaluate(() => MWNativeNavigation.diagnostics()),
      performance: await frame.evaluate(() => ({
        ...__historyPerf,
        heap: performance.memory?.usedJSHeapSize,
      })),
    };
    save();
    assert.ok(
      item.coldHistory.view.charts.every(
        (c) => c.studies.length === 3 && c.ready,
      ),
    );
    assert.ok(
      item.coldHistory.navigation.resident > 150000,
      "large actual resident history exercised",
    );
  }
  // Same iframe layout restore must invalidate an in-flight dialog-open GET.
  const savedRecord = await frame.evaluate(async () => {
    await new Promise((resolve, reject) =>
      widget.saveChartToServer(resolve, reject),
    );
    const rows = await new Promise((resolve) => widget.getSavedCharts(resolve));
    return rows.find((row) => row.name === widget.layoutName());
  });
  assert.ok(savedRecord, "actual saved chart metadata");
  let intercepted;
  const interceptedPromise = new Promise((resolve) => (intercepted = resolve));
  await page.route("**/api/charts/history-capabilities", async (route) => {
    intercepted();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await route.continue();
  });
  await native.getByRole("button", { name: "图表菜单", exact: true }).click();
  await native
    .getByRole("button", { name: "历史数据容量", exact: true })
    .click();
  await interceptedPromise;
  await frame.evaluate(
    (record) => widget.loadChartFromServer(record),
    savedRecord,
  );
  await settle();
  await page.waitForTimeout(2500);
  assert.equal(
    await dialog.count(),
    0,
    "old epoch GET cannot resurrect dialog after layout restore",
  );
  await page
    .locator(".advanced-loading-notice")
    .waitFor({ state: "hidden", timeout: 15000 });
  item.sameIframeRestore = {
    view: await snapshot(),
    dialogCount: await dialog.count(),
  };
  save();
};
