const assert = require("node:assert/strict");

module.exports = async function interactions({
  page,
  frame,
  native,
  settle,
  box,
  snapshot,
  item,
  save,
}) {
  const audit = (item.interactions = {});
  await frame.evaluate(() => widget.timeSync().setValue(false));
  const m5 = await frame.evaluate(() =>
    Array.from({ length: widget.chartsCount() }, (_, i) => i).find(
      (i) => widget.chart(i).resolution() === "5",
    ),
  );
  const location = await box(m5, true);
  await page.mouse.click(
    location.x + location.width / 2,
    location.y + location.height / 2,
  );
  await page.keyboard.press("Alt+g");
  const input = native.getByPlaceholder("YYYY-MM-DD");
  await input.waitFor();
  await input.fill("2025-12-02");
  await native.locator("button[name=submit]").click();
  const target = Date.parse("2025-12-02") / 1000;
  await frame.waitForFunction(
    ({ m5, target }) => {
      const range = widget.chart(m5).getVisibleRange();
      return range.from <= target + 86400 && range.to >= target;
    },
    { m5, target },
    { timeout: 120000 },
  );
  await settle();
  audit.dateDialog = {
    date: "2025-12-02",
    range: (await snapshot()).charts[m5].range,
  };
  save();

  await frame.evaluate(() => {
    globalThis.__externalCursorPaints = [];
    for (let i = 0; i < widget.chartsCount(); i++) {
      const m = widget.chart(i)._chartWidget.model().model(),
        original = m.setCurrentPosition;
      m.setCurrentPosition = function (...args) {
        if (this._isSettingsExternalPosition)
          __externalCursorPaints.push({ id: this.id(), at: performance.now() });
        return original.apply(this, args);
      };
    }
    widget.crosshairSync().setValue(false);
  });
  await page.mouse.move(1500, 20);
  await frame.evaluate(
    ({ m5, target }) =>
      widget
        .chart(m5)
        .setVisibleRange(
          { from: target - 1800, to: target + 1800 },
          { rejectByTimeout: 120000 },
        ),
    { m5, target },
  );
  await settle();
  audit.syncOff = await frame.evaluate(() => ({
    enabled: widget.crosshairSync().value(),
    navigation: MWNativeNavigation.diagnostics(),
    externalPaints: __externalCursorPaints,
    charts: Array.from({ length: widget.chartsCount() }, (_, i) => {
      const m = widget.chart(i)._chartWidget.model().model();
      return {
        visible: m.crosshairSource().visible,
        timeLabel: m.crosshairSource()._timeAxisView._rendererData.visible,
      };
    }),
  }));
  assert.equal(audit.syncOff.enabled, false);
  assert.ok(
    audit.syncOff.navigation.cursors.every((c) => c.time === undefined),
    "off sync cannot retain semantic replay",
  );
  assert.equal(
    audit.syncOff.externalPaints.length,
    0,
    "off sync cannot repaint an old external cursor after real navigation",
  );
  save();

  // A real pointer establishes the source cursor. Remove its pane through
  // public layout APIs and actually unload the native layout cache.
  await frame.evaluate(() => widget.crosshairSync().setValue(true));
  const source = await box(3, true);
  await page.mouse.move(
    source.x + source.width / 2,
    source.y + source.height / 2,
  );
  await page.waitForTimeout(300);
  audit.beforeClose = await frame.evaluate(() =>
    MWNativeNavigation.diagnostics(),
  );
  assert.ok(
    audit.beforeClose.cursors.some((c) => Number.isFinite(c.time)),
    "pointer must establish a real sync cursor",
  );
  await frame.evaluate(() => {
    widget.setActiveChart(0);
    widget.setLayout("s");
    widget.unloadUnusedCharts();
  });
  await settle();
  await page.mouse.move(1500, 20);
  await frame.evaluate(() =>
    widget.chart(0).executeActionById("timeScaleReset"),
  );
  await settle();
  audit.afterClose = await frame.evaluate(() => ({
    navigation: MWNativeNavigation.diagnostics(),
    count: widget.chartsCount(),
    visible: widget.chart(0)._chartWidget.model().model().crosshairSource()
      .visible,
  }));
  assert.equal(audit.afterClose.count, 1);
  assert.equal(
    audit.afterClose.navigation.models,
    1,
    "closed source models are actually unloaded",
  );
  assert.ok(
    audit.afterClose.navigation.cursors.every((c) => c.time === undefined),
    "closed source cannot replay old semantic cursor",
  );
  assert.equal(audit.afterClose.visible, false);
  save();

  // All supported native resolutions on the provider tail stay within budget.
  audit.periods = [];
  for (const res of ["1", "5", "15", "30", "60", "240", "1D", "1W", "1M"]) {
    await frame.evaluate(
      (res) => widget.chart(0).setResolution(res, { doNotActivateChart: true }),
      res,
    );
    await settle();
    const state = await frame.evaluate(() => {
      const c = widget.chart(0),
        m = c._chartWidget.model().model();
      return {
        res: c.resolution(),
        range: c.getVisibleRange(),
        ready: c.dataReady(),
        invalid: m.mainSeries().isSymbolInvalid(),
      };
    });
    assert.equal(state.res, res);
    assert.equal(state.invalid, false);
    assert.equal(state.ready, true);
    assert.ok(state.range.to > state.range.from);
    audit.periods.push(state);
    save();
  }

  await frame.evaluate(() => {
    widget.setLayout("2h");
    widget.timeSync().setValue(false);
    widget.dateRangeSync().setValue(false);
    widget.crosshairSync().setValue(false);
  });
  await settle();
  await frame.evaluate(async () => {
    for (let i = 0; i < 2; i++)
      await widget.chart(i).setResolution("5", { doNotActivateChart: true });
  });
  await settle();
  await frame.evaluate(async (target) => {
    widget.dateRangeSync().setValue(true);
    await widget
      .chart(0)
      .setVisibleRange(
        { from: target - 7200, to: target + 7200 },
        { rejectByTimeout: 120000 },
      );
  }, target);
  await settle();
  audit.dateRangeSync = await frame.evaluate(() =>
    [0, 1].map((i) => widget.chart(i).getVisibleRange()),
  );
  for (const range of audit.dateRangeSync)
    assert.ok(
      range.from <= target && range.to >= target,
      "range sync must reach the historical target on both panes",
    );
  assert.ok(
    Math.abs(audit.dateRangeSync[0].from - audit.dateRangeSync[1].from) < 300,
  );
  assert.ok(
    Math.abs(audit.dateRangeSync[0].to - audit.dateRangeSync[1].to) < 300,
  );
  audit.passed = true;
  save();
};
