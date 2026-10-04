// Public operations exercise shared native reads and teardown. Private state is
// observed only to measure residency; it is never mutated to make tests pass.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");

module.exports = async function lifecycle({
  browser,
  context,
  page,
  frame,
  native,
  settle,
  save,
  item,
}) {
  const audit = (item.lifecycleAudit = { shared: {}, cycles: [], soak: [] });
  const browserSession = await browser.newBrowserCDPSession();
  const session = await context.newCDPSession(page);
  const sample = async () => {
    await session.send("HeapProfiler.collectGarbage");
    const heap = await session.send("Runtime.getHeapUsage");
    const { processInfo } = await browserSession.send(
      "SystemInfo.getProcessInfo",
    );
    const pids = processInfo.map((p) => p.id);
    const rssKiB = execFileSync("ps", ["-o", "rss=", "-p", pids.join(",")], {
      encoding: "utf8",
    })
      .trim()
      .split(/\s+/)
      .reduce((sum, value) => sum + Number(value), 0);
    return {
      at: Date.now(),
      heap,
      rssKiB,
      ...(await frame.evaluate(() => ({
        navigation: MWNativeNavigation.diagnostics(),
        subscriptions: subscriptions.size,
        pendingRPC: pending.size,
        history: [...providerHistoryWork.values()].filter((w) => w.inflight)
          .length,
        reserve: MWNativeReserve.diagnostics(),
      }))),
    };
  };
  const range = (at) => ({ from: at - 1800, to: at + 1800 });
  await frame.evaluate(() => {
    widget.timeSync().setValue(false);
    widget.dateRangeSync().setValue(false);
    widget.symbolSync().setValue(false);
    widget.setLayout("2h");
  });
  await settle();
  await frame.evaluate(async () => {
    for (let i = 0; i < 2; i++)
      await widget.chart(i).setResolution("5", { doNotActivateChart: true });
  });
  await settle();
  const first = await frame.evaluate(() =>
    Math.min(
      ...[0, 1].map((i) => {
        const ts = widget.chart(i)._chartWidget.model().model().timeScale();
        return ts.points().valueAt(ts.points().range().value().firstIndex);
      }),
    ),
  );
  const target = first - 14 * 86400;
  audit.shared.first = first;
  audit.shared.target = target;
  save();
  let release,
    held = false;
  let acknowledge;
  const captured = new Promise((resolve) => {
    acknowledge = resolve;
  });
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const intercept = async (route) => {
    const q = route.request().postDataJSON().query;
    if (!held && q?.timeframe === "M5" && q.from < first * 1000) {
      held = true;
      acknowledge();
      await barrier;
    }
    return route.continue().catch(() => {});
  };
  await page.route("**/api/charts/history-loads", intercept);
  try {
    await frame.evaluate(
      ({ target }) => {
        globalThis.__sharedRange = [0, 1].map((i) =>
          widget
            .chart(i)
            .setVisibleRange(
              { from: target - 1800, to: target + 1800 },
              { rejectByTimeout: 60000 },
            )
            .then(
              () => "completed",
              (e) => e.code || String(e),
            ),
        );
      },
      { target },
    );
    try {
      await frame.waitForFunction(
        () =>
          MWNativeNavigation.diagnostics().cursors.filter(
            (c) => c.res === "5" && c.phase === "loading",
          ).length === 2,
      );
    } catch (error) {
      audit.shared.beforeFailure = await sample();
      save();
      throw error;
    }
    await Promise.race([
      captured,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(Error("shared history HTTP not captured")),
          10000,
        ),
      ),
    ]);
    assert.ok(held, "shared request must actually be held in product HTTP");
    await frame.evaluate(() =>
      widget.chart(0).executeActionById("timeScaleReset"),
    );
    audit.shared.afterCancel = await sample();
    assert.equal(
      audit.shared.afterCancel.navigation.pending,
      1,
      "one peer cancels its view while the other retains the shared read",
    );
    release();
    audit.shared.outcomes = await frame.evaluate(() =>
      Promise.all(__sharedRange),
    );
    await settle();
    audit.shared.ranges = await frame.evaluate(() =>
      [0, 1].map((i) => widget.chart(i).getVisibleRange()),
    );
    assert.equal(audit.shared.outcomes[0], "HISTORY_CANCELLED");
    assert.equal(audit.shared.outcomes[1], "completed");
    assert.ok(
      audit.shared.ranges[1].from <= target &&
        audit.shared.ranges[1].to >= target,
    );
    assert.ok(
      audit.shared.ranges[0].to > target + 7 * 86400,
      "shared completion must not pull the cancelled latest pane back",
    );
  } finally {
    release();
    await page.unroute("**/api/charts/history-loads", intercept);
  }
  save();

  // Collapse/expand, modify periods, add/remove studies and navigate repeatedly.
  // Each normalized sample measures the same one-pane H4 state after GC.
  const cycles = Number(process.env.NATIVE_LIFECYCLE_CYCLES || 6);
  for (let cycle = 0; cycle < cycles; cycle++) {
    const count = [2, 4, 8][cycle % 3];
    await frame.evaluate(
      (count) => widget.setLayout(count === 2 ? "2h" : String(count)),
      count,
    );
    await settle();
    await frame.evaluate(async (count) => {
      for (let i = 0; i < count; i++) {
        const chart = widget.chart(i);
        await chart.setResolution(["1W", "5", "240", "1D"][i % 4], {
          doNotActivateChart: true,
        });
      }
    }, count);
    await settle();
    const start = Date.now();
    await frame.evaluate(
      async ({ count, target }) => {
        for (let i = 0; i < count; i++) {
          const chart = widget.chart(i);
          await chart.setVisibleRange(
            { from: target - 86400, to: target + 86400 },
            { rejectByTimeout: 60000 },
          );
          const id = await chart.createStudy("Moving Average", false, false, {
            length: 21,
          });
          await chart.removeEntity(id);
        }
      },
      { count, target: Date.parse("2026-05-04") / 1000 },
    );
    await settle();
    if (cycle === 0) {
      audit.template = await frame.evaluate(async () => {
        const chart = widget.chart(0);
        const ids = await Promise.all(
          [21, 50, 200].map((length) =>
            chart.createStudy("Moving Average", false, false, { length }),
          ),
        );
        const template = chart.createStudyTemplate({
          saveSymbol: false,
          saveInterval: false,
        });
        for (const id of ids) chart.removeEntity(id);
        chart.applyStudyTemplate(template);
        return { expected: 3 };
      });
      await frame.waitForFunction(
        () => widget.chart(0).getAllStudies().length === 3,
      );
      await settle();
      audit.template.afterRestore = await frame.evaluate(() =>
        widget.chart(0).getAllStudies(),
      );
      await frame.evaluate(() => {
        const chart = widget.chart(0),
          ids = chart.getAllStudies().map((s) => s.id);
        const study = chart.getStudyById(ids[0]);
        const input = study.getInputValues().find((p) => p.id === "length");
        if (!input) throw Error("Moving Average length input missing");
        study.setInputValues([{ id: input.id, value: 100 }]);
      });
      await settle();
      audit.template.afterInput = await frame.evaluate(() => {
        const chart = widget.chart(0);
        return chart.getStudyById(chart.getAllStudies()[0].id).getInputValues();
      });
      assert.ok(
        audit.template.afterInput.some(
          (p) => p.id === "length" && p.value === 100,
        ),
      );
      await frame.evaluate(() => {
        const c = widget.chart(0);
        for (const s of c.getAllStudies()) c.removeEntity(s.id);
      });
      await settle();
      audit.capacityTemplate = await frame.evaluate(async () => {
        const source = widget.chart(0),
          target = widget.chart(1);
        const ids = [];
        for (let i = 0; i < 10; i++)
          ids.push(
            await source.createStudy("Moving Average", false, false, {
              length: 21 + i,
            }),
          );
        const template = source.createStudyTemplate({
          saveSymbol: false,
          saveInterval: false,
        });
        for (const id of ids) source.removeEntity(id);
        globalThis.__templateCapacityErrors = [];
        const record = (event) =>
          __templateCapacityErrors.push({
            code: event.detail.code,
            message: event.detail.message,
          });
        globalThis.__recordTemplateCapacity = record;
        addEventListener("mw-navigation-error", record);
        const before = target.getVisibleRange(),
          beforeStudies = target.getAllStudies();
        let error;
        try {
          target.applyStudyTemplate(template);
        } catch (e) {
          error = { code: e.code, message: e.message };
        }
        return {
          before,
          beforeStudies,
          errors: __templateCapacityErrors,
          error,
        };
      });
      await settle();
      audit.capacityTemplate.after = await frame.evaluate(() => ({
        studies: widget.chart(1).getAllStudies(),
        range: widget.chart(1).getVisibleRange(),
        invalid: widget
          .chart(1)
          ._chartWidget.model()
          .model()
          .mainSeries()
          .isSymbolInvalid(),
      }));
      audit.capacityTemplate.errors = await frame.evaluate(() => {
        removeEventListener("mw-navigation-error", __recordTemplateCapacity);
        return __templateCapacityErrors;
      });
      save();
      assert.ok(
        audit.capacityTemplate.errors.some(
          (e) => e.code === "NATIVE_HISTORY_CAPACITY_EXCEEDED",
        ),
        "over-budget template must reach real native admission",
      );
      assert.ok(
        audit.capacityTemplate.after.studies.length < 10,
        "template cannot silently exceed the workspace budget",
      );
      assert.equal(audit.capacityTemplate.after.invalid, false);
      assert.deepEqual(
        audit.capacityTemplate.after.studies,
        audit.capacityTemplate.beforeStudies,
        "refused template keeps the original studies",
      );
      assert.deepEqual(
        audit.capacityTemplate.after.range,
        audit.capacityTemplate.before,
        "refused template preserves the existing history viewport",
      );
      await frame.evaluate(() => {
        const c = widget.chart(1);
        for (const s of c.getAllStudies()) c.removeEntity(s.id);
      });
      await settle();
      audit.capacityTemplate.recovery = await frame.evaluate(async () => {
        const c = widget.chart(1),
          id = await c.createStudy("Moving Average", false, false, {
            length: 21,
          });
        c.removeEntity(id);
        return { created: true, range: c.getVisibleRange() };
      });
      await settle();
      save();
    }
    const expanded = await sample();
    assert.ok(
      expanded.navigation.models >= count && expanded.navigation.models <= 8,
      "native retained layouts stay within eight models",
    );
    assert.equal(expanded.navigation.pending, 0);
    await frame.evaluate(() => widget.setLayout("s"));
    await settle();
    await frame.evaluate(() =>
      widget.chart(0).setResolution("240", { doNotActivateChart: true }),
    );
    await settle();
    const normalized = await sample();
    assert.ok(
      normalized.navigation.models <= 8,
      "native retained layout models remain bounded",
    );
    assert.equal(normalized.navigation.pending, 0);
    assert.equal(normalized.history, 0);
    assert.ok(
      normalized.subscriptions <= 8,
      "native cached layouts retain bounded provider subscriptions",
    );
    assert.ok(
      normalized.navigation.threads <= 4,
      "native cached layout sources stay bounded",
    );
    audit.cycles.push({
      cycle,
      count,
      elapsedMs: Date.now() - start,
      expanded,
      normalized,
    });
    save();
  }
  const normalized = audit.cycles.map((c) => c.normalized);
  assert.ok(
    normalized.at(-1).heap.usedSize - normalized[0].heap.usedSize <
      48 * 1024 * 1024,
    "normalized JS live heap must stay bounded after repeated large loads and teardown",
  );
  assert.ok(
    normalized.at(-1).rssKiB - normalized[0].rssKiB < 256 * 1024,
    "normalized browser process RSS must stay bounded",
  );
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(10000);
    const state = await sample();
    audit.soak.push(state);
    save();
    assert.ok(state.navigation.models <= 8);
    assert.equal(state.navigation.pending, 0);
    assert.equal(state.history, 0);
  }
  await frame.evaluate(() => widget.remove());
  await page.waitForTimeout(1000);
  audit.destroyed = await frame.evaluate(() =>
    MWNativeNavigation.diagnostics(),
  );
  assert.equal(audit.destroyed.models, 0);
  assert.equal(audit.destroyed.threads, 0);
  assert.equal(audit.destroyed.pending, 0);
  audit.passed = true;
  save();
};
