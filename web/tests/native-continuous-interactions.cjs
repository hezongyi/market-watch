const assert = require("node:assert/strict");

module.exports = async function interactions({
  page,
  frame,
  native,
  settle,
  box,
  snapshot,
  crosshairs,
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

  // Exercise reverse synchronization: a minute source drives the higher panes.
  await frame.evaluate(() => {
    widget.crosshairSync().setValue(true);
    widget.timeSync().setValue(true);
  });
  await page.mouse.move(
    location.x + location.width / 2,
    location.y + location.height / 2,
  );
  await page.mouse.down();
  await page.mouse.up();
  const reverseTarget = await frame.evaluate((m5) => {
    const m = widget.chart(m5)._chartWidget.model().model();
    return m.timeScale().points().valueAt(m.crosshairSource().appliedIndex());
  }, m5);
  await frame.waitForFunction(
    (time) =>
      Array.from({ length: widget.chartsCount() }, (_, i) => {
        const range = widget.chart(i).getVisibleRange();
        return range.from <= time && range.to >= time;
      }).every(Boolean),
    reverseTarget,
    { timeout: 120000 },
  );
  await settle();
  audit.reverse = {
    target: reverseTarget,
    stationary: await crosshairs(),
    ranges: (await snapshot()).charts.map((c) => c.range),
  };
  await page.mouse.move(
    location.x + location.width / 2 + 20,
    location.y + location.height / 2,
  );
  await page.mouse.move(
    location.x + location.width / 2,
    location.y + location.height / 2,
  );
  await page.waitForTimeout(300);
  audit.reverse.afterMove = await crosshairs();
  for (let i = 0; i < audit.reverse.stationary.length; i++) {
    assert.equal(
      audit.reverse.stationary[i].time,
      audit.reverse.afterMove[i].time,
      "reverse sync stationary cursor stays aligned",
    );
    assert.ok(
      audit.reverse.stationary[i].visible &&
        audit.reverse.stationary[i].label.text,
      "reverse sync renders visible native time labels",
    );
  }
  await frame.evaluate(() => widget.timeSync().setValue(false));
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

  // Source identity changes invalidate peer replay while the pane stays alive.
  // Keep the pointer still throughout each public operation.
  await frame.evaluate(() => {
    widget.crosshairSync().setValue(true);
    widget.intervalSync().setValue(false);
    widget.symbolSync().setValue(false);
  });
  const identitySource = await box(3, true);
  const pointAtSource = async (offset) => {
    await page.mouse.move(
      identitySource.x + identitySource.width / 2 + offset,
      identitySource.y + identitySource.height / 2,
    );
    await page.waitForTimeout(300);
    const cursors = await frame.evaluate(
      () => MWNativeNavigation.diagnostics().cursors,
    );
    assert.ok(
      cursors.some((c) => Number.isFinite(c.time)),
      "source pointer must broadcast before identity changes",
    );
    return cursors;
  };
  const peersAfterChange = async () =>
    frame.evaluate(() => ({
      cursors: MWNativeNavigation.diagnostics().cursors,
      sourceTime: (() => {
        const m = widget.chart(3)._chartWidget.model().model();
        return m
          .timeScale()
          .points()
          .valueAt(m.crosshairSource().appliedIndex());
      })(),
      charts: Array.from({ length: widget.chartsCount() }, (_, i) => ({
        symbol: widget.chart(i).symbol(),
        res: widget.chart(i).resolution(),
      })),
    }));
  audit.sourcePeriod = { before: await pointAtSource(0) };
  await frame.evaluate(() =>
    widget.chart(3).setResolution("240", { doNotActivateChart: true }),
  );
  await settle();
  audit.sourcePeriod.after = await peersAfterChange();
  assert.equal(audit.sourcePeriod.after.charts[3].res, "240");
  assert.ok(
    audit.sourcePeriod.after.cursors.every(
      (c) =>
        c.time === undefined || c.time === audit.sourcePeriod.after.sourceTime,
    ),
    "source period change can only broadcast its current native cursor",
  );
  save();
  await frame.evaluate(() =>
    widget.chart(3).setResolution("1D", { doNotActivateChart: true }),
  );
  await settle();
  audit.sourceSymbol = { before: await pointAtSource(20) };
  save();
  await frame.evaluate(() =>
    Promise.race([
      widget.chart(3).setSymbol("MWP:XAUUSD", { doNotActivateChart: true }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(Error("source symbol change did not finish")),
          30000,
        ),
      ),
    ]),
  );
  await settle();
  audit.sourceSymbol.after = await peersAfterChange();
  assert.match(audit.sourceSymbol.after.charts[3].symbol, /XAUUSD/);
  assert.ok(
    audit.sourceSymbol.after.charts
      .slice(0, 3)
      .every((c) => c.symbol.includes("EURUSD")),
    "symbol change stays local to source pane",
  );
  assert.ok(
    audit.sourceSymbol.after.cursors.every(
      (c) =>
        c.time === undefined || c.time === audit.sourceSymbol.after.sourceTime,
    ),
    "source symbol change can only broadcast its current native cursor",
  );
  save();
  await frame.evaluate(() =>
    Promise.race([
      widget.chart(3).setSymbol("MWP:EURUSD", { doNotActivateChart: true }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(Error("source symbol restoration did not finish")),
          30000,
        ),
      ),
    ]),
  );
  await settle();
  await page.mouse.move(1500, 20);

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
  // Native range synchronization starts a peer operation asynchronously. Source
  // readiness alone can be observed before that operation has even begun.
  await frame.waitForFunction(
    (target) =>
      [0, 1].every((i) => {
        const range = widget.chart(i).getVisibleRange();
        return range.from <= target && range.to >= target;
      }),
    target,
    { timeout: 120000 },
  );
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
  audit.bidirectionalRanges = [];
  for (const [source, time] of [
    [1, target + 86400],
    [0, target],
  ]) {
    await frame.evaluate(
      async ({ source, time }) => {
        widget.setActiveChart(source);
        await widget
          .chart(source)
          .setVisibleRange(
            { from: time - 7200, to: time + 7200 },
            { rejectByTimeout: 120000 },
          );
      },
      { source, time },
    );
    await frame.waitForFunction(
      (time) =>
        [0, 1].every((i) => {
          const range = widget.chart(i).getVisibleRange();
          return range.from <= time && range.to >= time;
        }),
      time,
      { timeout: 120000 },
    );
    await settle();
    const ranges = await frame.evaluate(() =>
      [0, 1].map((i) => widget.chart(i).getVisibleRange()),
    );
    assert.ok(Math.abs(ranges[0].from - ranges[1].from) < 300);
    assert.ok(Math.abs(ranges[0].to - ranges[1].to) < 300);
    audit.bidirectionalRanges.push({ source, time, ranges });
    save();
  }
  audit.passed = true;
  save();
};
