// Isolated product API/PG and actual provider candles; real mouse interaction.
const { chromium } = require("@playwright/test");
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const APP = process.env.RANGE_APP || "https://localhost:16043",
  CHART = process.env.RANGE_CHART || "https://localhost:16044";
const OUT =
  process.env.RANGE_OUTPUT || "/tmp/mw-range-mapping-acceptance/browser.json";
const report = { at: new Date().toISOString(), cases: [], errors: [] };
(async () => {
  const browser = await chromium.launch({
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
      "/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
    args: ["--no-sandbox"],
  });
  try {
    const fixture = await require("./fixtures/bar-range-acceptance.cjs")({
      browser,
      report,
      APP,
      CHART,
    });
    const { ctx, api, w, page, native, settle, box, hoverLast, state } =
      fixture;
    let { host } = fixture;
    const assertGeometry = (before,after) => {
      assert.equal(after.charts.length,before.charts.length);
      after.charts.forEach((chart,i) => {
        const {price,...geometry}=chart, {price:oldPrice,...oldGeometry}=before.charts[i];
        assert.deepEqual(geometry,oldGeometry,'mapping modified chart geometry');
        if(before.marketSignatures[i]===after.marketSignatures[i])
          assert.deepEqual(price,oldPrice,'mapping modified price range without any real candle update');
      });
    };
    await hoverLast(0);
    report.cases.push({ phase: "month-hover", state: await state() });
    assert.ok(
      report.cases.at(-1).state.mapper.source,
      "valid month source missing",
    );
    assert.ok(
      report.cases.at(-1).state.paints.some((v) => v.resolution === "5"),
      "M5 not painted",
    );
    assert.ok(
      report.cases.at(-1).state.paints.some((v) => v.resolution === "1D"),
      "D1 not painted",
    );
    assert.ok(
      !report.cases.at(-1).state.paints.some((v) => v.resolution === "1W"),
      "MN painted W1",
    );
    await page.screenshot({ path: OUT.replace(".json", "-month.png") });
    await fixture.idle();
    const before = await state(),
      requests = fixture.history,
      b = await box(0);
    for (let n = 0; n < 30; n++)
      await page.mouse.move(
        b.x + b.width * 0.45 + n * 3,
        b.y + b.height * 0.55,
      );
    await page.waitForTimeout(500);
    const after = await state();
    report.cases.push({
      phase: "continuous",
      before,
      after,
      historyBefore: requests,
      historyAfter: fixture.history,
    });
    assertGeometry(before,after);
    assert.equal(fixture.history, requests, "hover added historical requests");
    await page.mouse.move(10, 10);
    await page.waitForTimeout(80);
    assert.equal((await state()).mapper.source, undefined);
    report.cases.push({ phase: "leave", state: await state() });
    await native.getByRole("button", { name: "布局设置", exact: true }).click();
    await native.locator('[data-name="mw-sync-settings"]').click();
    await native.locator('[data-name="mw-sync-settings-dialog"] select[name="style"]').selectOption('rectangle');
    await native.locator('[data-name="mw-sync-settings-dialog"] [data-action="confirm"]').click();
    await hoverLast(0);
    report.cases.push({ phase: "rectangle", state: await state() });
    await page.screenshot({ path: OUT.replace(".json", "-rectangle.png") });
    await hoverLast(2);
    assert.equal((await state()).mapper.source.resolution, "5");
    report.cases.push({ phase: "switch-source", state: await state() });
    const dragBox = await box(2);
    await page.mouse.move(
      dragBox.x + dragBox.width * 0.6,
      dragBox.y + dragBox.height * 0.5,
    );
    await page.mouse.down();
    await page.mouse.move(
      dragBox.x + dragBox.width * 0.25,
      dragBox.y + dragBox.height * 0.5,
      { steps: 40 },
    );
    await page.screenshot({ path: OUT.replace(".json", "-held.png") });
    await page.mouse.up();
    await settle();
    report.cases.push({ phase: "held-drag", state: await state() });

    for (const count of [2, 8]) {
      await page.mouse.move(10, 10);
      await host.evaluate((count) => {
        widget.setLayout(count === 2 ? "2h" : String(count));
        MWBarRangeMapping.configure({ style: "background" });
      }, count);
      await settle();
      await host.evaluate(async () => {
        for (let i = 0; i < widget.chartsCount(); i++)
          await widget
            .chart(i)
            .setResolution(i === 0 ? "1M" : i === 1 ? "1D" : "5", {
              doNotActivateChart: true,
            });
      });
      await settle();
      await hoverLast(0);
      const result = await state();
      assert.ok(result.mapper.source);
      report.cases.push({ phase: "layout-" + count, state: result });
      await page.screenshot({
        path: OUT.replace(".json", "-" + count + "-month.png"),
      });
    }

    // Eight visible peers: measure actual input-to-paint, no simulated callbacks.
    await host.evaluate(async () => {
      for (let i = 0; i < 8; i++)
        await widget
          .chart(i)
          .setResolution(i === 0 ? "5" : "1", { doNotActivateChart: true });
    });
    await settle();
    await host.evaluate(() => {
      globalThis.__rangeEvents = [];
      globalThis.__rangeDurations = [];
      globalThis.__rangeLatencies = [];
      let previous;
      const doc = widget.chart(0)._chartWidget.ownerDocument();
      doc.addEventListener(
        "pointermove",
        () => {
          const source = MWBarRangeMapping.diagnostics().source;
          const key = source?.resolution + "|" + source?.chartTime;
          if (source && key !== previous) {
            previous = key;
            __rangeEvents.push({ key, at: performance.now() });
          }
        },
        true,
      );
      const draw = MWBarRangeMapping.draw;
      MWBarRangeMapping.draw = function (...args) {
        const start = performance.now();
        const event = __rangeEvents.at(-1);
        if (
          event &&
          !event.painted &&
          args[0].state().model().interval() === "1"
        ) {
          event.painted = true;
          __rangeLatencies.push(start - event.at);
        }
        try {
          return draw.apply(this, args);
        } finally {
          __rangeDurations.push(performance.now() - start);
        }
      };
    });
    await hoverLast(0);
    const perfBox = await box(0),
      lastX = await host.evaluate(() => {
        const m = widget.chart(0)._chartWidget.model().model();
        return m
          .timeScale()
          .indexToCoordinate(m.mainSeries().bars().lastIndex());
      });
    await fixture.idle();
    const perfRequests = fixture.history,
      perfBefore = await state();
    for (let i = 0; i < 100; i++)
      await page.mouse.move(
        perfBox.x + lastX - (i % 12) * 6,
        perfBox.y + perfBox.height * 0.55,
      );
    await page.waitForTimeout(200);
    const perfAfter = await state();
    const performanceResult = await host.evaluate(() => {
      const durations = __rangeDurations.slice().sort((a, b) => a - b),
        latencies = __rangeLatencies.slice().sort((a, b) => a - b);
      return {
        inputPaintSamples: latencies.length,
        inputPaintP95: latencies[Math.floor(latencies.length * 0.95)],
        inputPaintMax: latencies.at(-1),
        samples: durations.length,
        drawP95: durations[Math.floor(durations.length * 0.95)],
        drawMax: durations.at(-1),
        events: __rangeEvents.length,
        stores: MWBarRangeMapping.diagnostics().stores,
      };
    });
    assertGeometry(perfBefore,perfAfter);
    assert.equal(fixture.history, perfRequests);
    report.cases.push({
      phase: "eight-performance",
      performance: performanceResult,
      historyBefore: perfRequests,
      historyAfter: fixture.history,
    });
    await page.screenshot({
      path: OUT.replace(".json", "-eight-performance.png"),
    });
    // Bounded renderer observations; sample the shared page/chart renderer after GC.
    const cdp = await ctx.newCDPSession(page);
    const memory = [];
    await fixture.idle();
    const stressRequests = fixture.history;
    const resourceSnapshot = () => host.evaluate(() => ({
      stores: MWBarRangeMapping.diagnostics().stores,
      threads: MWNativeReserve.diagnostics().threads.map(t => ({key:t.key,cache:t.cache})),
      accepted: Array.from({length:widget.chartsCount()},(_,i) => {
        const c=widget.chart(i),m=c._chartWidget.model().model();
        return {key:MWNativeNavigation.modelKey(m),cache:m.mainSeries().bars().size()};
      }),
    }));
    const stressSnapshot = await resourceSnapshot();
    const {stores:stressStores,accepted:stressAccepted} = stressSnapshot;
    for (let batch = 0; batch < 5; batch++) {
      await host.evaluate(() => {
        __rangeEvents.length = 0;
        __rangeDurations.length = 0;
        __rangeLatencies.length = 0;
      });
      for (let n = 0; n < 400; n++)
        await page.mouse.move(
          perfBox.x + lastX - (n % 12) * 6,
          perfBox.y + perfBox.height * 0.55,
        );
      await cdp.send("HeapProfiler.collectGarbage");
      memory.push({
        batch,
        ...(await cdp.send("Runtime.getHeapUsage")),
        stores: (await state()).mapper.stores,
      });
    }
    assert.equal(fixture.history, stressRequests);
    const finalSnapshot = await resourceSnapshot();
    const {stores:finalStores,accepted:finalAccepted} = finalSnapshot;
    report.stressResources = {before:stressSnapshot,after:finalSnapshot};
    assert.ok(finalStores.every(s=>stressStores.some(before=>before.key===s.key)), 'hover must not invent a metadata source');
    for (const before of stressStores) {
      const after = finalStores.find(s=>s.key === before.key);
      const nativeKey = before.key;
      const oldCache = stressAccepted.find(t=>t.key === nativeKey)?.cache ?? 0;
      const newCache = finalAccepted.find(t=>t.key === nativeKey)?.cache ?? 0;
      if (!after) {
        assert.equal(newCache,0,'only obsolete delivered sources may release metadata');
        continue;
      }
      assert.equal(after.generation,before.generation,"hover must not reset accepted metadata");
      assert.ok(Number.isFinite(oldCache) && Number.isFinite(newCache));
      assert.equal(after.size-before.size,newCache-oldCache,"metadata growth must exactly match real native accepted bars");
    }
    assert.ok(
      memory.at(-1).usedSize < memory[0].usedSize + 5 * 1024 * 1024,
      "retained renderer heap grew beyond 5MiB budget",
    );
    report.cases.push({
      phase: "eight-sustained",
      moves: 2000,
      memory,
      stressAccepted, finalAccepted,
      historyBefore: stressRequests,
      historyAfter: fixture.history,
    });
    // The native 10s idle purge keeps Thread objects. Obsolete empty threads
    // must not retain metadata, while live delivered candles remain available.
    await page.mouse.move(10,10);
    await page.waitForTimeout(11000);
    const reclaimed = await resourceSnapshot();
    for(const store of reclaimed.stores)
      assert.ok(reclaimed.accepted.some(t=>t.key===store.key && t.cache>0) ||
        reclaimed.threads.some(t=>t.key===store.key && t.cache>0),
        'empty obsolete thread retained mapping metadata');
    report.cases.push({phase:'idle-cache-purge-reclaims-obsolete-metadata',resources:reclaimed});
    await cdp.detach();
    await page.mouse.down();
    await page.mouse.move(perfBox.x + 10, perfBox.y + perfBox.height * 0.55, {
      steps: 60,
    });
    await page.screenshot({ path: OUT.replace(".json", "-eight-held.png") });
    await page.mouse.up();
    await settle();
    report.cases.push({ phase: "eight-held-drag", state: await state() });
    await page.mouse.move(10, 10);
    await host.evaluate(() => {
      widget.setLayout("2h");
      MWBarRangeMapping.configure({ style: "rectangle" });
    });
    await settle();
    for (const r of ["1", "5", "15", "30", "60", "240", "1D", "1W", "1M"]) {
      await host.evaluate(async (r) => {
        await widget.chart(0).setResolution(r, { doNotActivateChart: true });
        await widget.chart(1).setResolution("1", { doNotActivateChart: true });
        __rangePaints.length = 0;
      }, r);
      await settle();
      await hoverLast(0);
      const result = await state();
      report.cases.push({ phase: "period-" + r, state: result });
      assert.equal(result.mapper.source?.resolution, r);
    }

    await page.mouse.move(10, 10);
    await host.evaluate(async () => {
      await widget.chart(0).setResolution("60", { doNotActivateChart: true });
      await widget.chart(1).setResolution("1", { doNotActivateChart: true });
    });
    await settle();
    for (const theme of ["Light", "Dark"])
      for (const mode of [0, 1, 2])
        for (const inverted of [false, true]) {
          await page.mouse.move(10, 10);
          await host.evaluate(
            async ({ theme, mode, inverted }) => {
              await widget.changeTheme(theme);
              const p = widget
                .chart(1)
                .getPanes()
                .find((p) => p.hasMainSeries())
                .getMainSourcePriceScale();
              p.setMode(mode);
              p.setInverted(inverted);
              __rangePaints.length = 0;
            },
            { theme, mode, inverted },
          );
          await page.waitForTimeout(100);
          const before = await state();
          await hoverLast(0);
          const after = await state();
          assert.ok(after.paints.some((p) => p.resolution === "1"));
          assertGeometry(before,after);
          report.cases.push({
            phase: "price-theme",
            theme,
            mode,
            inverted,
            state: after,
          });
        }

    // Compare an actual target canvas pixel with the same crosshair and
    // viewport: turning the feature off must restore the pre-fill pixel.
    await page.mouse.move(10, 10);
    await host.evaluate(() => {
      const p = widget
        .chart(1)
        .getPanes()
        .find((p) => p.hasMainSeries())
        .getMainSourcePriceScale();
      p.setMode(0);
      p.setInverted(false);
      MWBarRangeMapping.configure({ style: "background", enabled: true });
    });
    await hoverLast(0);
    const sample = await host.evaluate(() => {
      const c = widget.chart(1),
        m = c._chartWidget.model().model();
      const rect = __rangePaints.filter((p) => p.id === m.id()).at(-1).rect;
      const canvas = c._chartWidget
        .paneWidgets()
        .find((p) => p.containsMainSeries())
        .canvasElement();
      const bounds = canvas.getBoundingClientRect();
      return {
        x: Math.floor(((rect[0] + rect[2] / 2) * canvas.width) / bounds.width),
        y: Math.floor((12 * canvas.height) / bounds.height),
      };
    });
    const pixel = () =>
      host.evaluate(({ x, y }) => {
        const canvas = widget
          .chart(1)
          ._chartWidget.paneWidgets()
          .find((p) => p.containsMainSeries())
          .canvasElement();
        return [...canvas.getContext("2d").getImageData(x, y, 1, 1).data];
      }, sample);
    const filledPixel = await pixel();
    await host.evaluate(() => MWBarRangeMapping.configure({ enabled: false }));
    await page.waitForTimeout(100);
    const clearedPixel = await pixel();
    assert.notDeepEqual(
      filledPixel,
      clearedPixel,
      "fill did not change actual target pixel",
    );
    await host.evaluate(() => MWBarRangeMapping.configure({ enabled: true }));
    await hoverLast(0);
    assert.deepEqual(await pixel(), filledPixel);
    await page.mouse.move(10, 10);
    await page.waitForTimeout(100);
    assert.equal((await state()).mapper.source, undefined);
    assert.deepEqual(
      await pixel(),
      clearedPixel,
      "canvas retained fill after pointer exit",
    );
    report.cases.push({
      phase: "pixel-cleared",
      sample,
      filledPixel,
      clearedPixel,
    });
    const futureBox = await box(0);
    await page.mouse.move(
      futureBox.x + futureBox.width - 15,
      futureBox.y + futureBox.height * 0.5,
    );
    await page.waitForTimeout(100);
    assert.equal(
      (await state()).mapper.source,
      undefined,
      "future blank became a source",
    );
    report.cases.push({ phase: "future-no-source", state: await state() });
    await page.mouse.move(10, 10);
    await host.evaluate(() => widget.chart(1).setChartType(4));
    await settle();
    await host.evaluate(() => (__rangePaints.length = 0));
    await hoverLast(0);
    assert.ok(
      !(await state()).paints.some((p) => p.resolution === "1"),
      "synthetic target painted",
    );
    report.cases.push({
      phase: "synthetic-target-excluded",
      state: await state(),
    });
    await page.mouse.move(10, 10);
    await host.evaluate(() => {
      widget.chart(1).setChartType(1);
      MWBarRangeMapping.configure({ style: "rectangle" });
    });
    await settle();
    await hoverLast(0);
    // Controlled accepted provider update based on an actually loaded candle.
    // This is an isolated transport fixture, not a claim about natural market ticks.
    const liveBefore = await state();
    const current = liveBefore.mapper.source;
    const sub = await host.evaluate(() => {
      const c = widget.chart(0),
        s = [...subscriptions.values()].find(
          (s) =>
            MWSeries.same(s.symbol, c.symbol()) && s.res === c.resolution(),
        );
      const h = providerHistoryState.get(s.symbol + "|" + s.res);
      return {
        listener: s.providerListener,
        revision: h?.revision || 0,
        as_of: h?.observed_at || 0,
      };
    });
    const bar = {
      chart_time: current.chartTime,
      start: current.start,
      end: current.end,
      high: current.high + 0.001,
      low: current.low - 0.001,
      open: (current.high + current.low) / 2,
      close: (current.high + current.low) / 2,
      complete: false,
    };
    await page.evaluate(
      ({ chart, sub, bar }) =>
        document
          .querySelector('iframe[src^="' + chart + '"]')
          .contentWindow.postMessage(
            {
              channel: "mw-chart-v1",
              type: "provider-event",
              event: {
                ...sub,
                type: "bars",
                bars: [bar],
                cursor: bar.chart_time,
              },
            },
            chart,
          ),
      { chart: CHART, sub, bar },
    );
    await page.waitForTimeout(300);
    const liveAfter = await state();
    assert.equal(liveAfter.mapper.source.high, bar.high);
    assert.equal(liveAfter.mapper.source.low, bar.low);
    assert.deepEqual(liveAfter.charts[1], liveBefore.charts[1]);
    report.cases.push({
      phase: "accepted-realtime-fixture",
      bar,
      source: liveAfter.mapper.source,
      paints: liveAfter.paints,
    });
    await page.mouse.move(10, 10);
    await host.evaluate(() => widget.crosshairSync().setValue(false));
    assert.equal((await state()).mapper.source, undefined);
    await native.getByRole("button", { name: "布局设置", exact: true }).click();
    assert.equal(
      await native
        .locator('[data-name="mw-bar-range-mapping"]')
        .getAttribute("aria-disabled"),
      "true",
    );
    await native.getByRole("button", { name: "布局设置", exact: true }).click();
    await host.evaluate(() => widget.crosshairSync().setValue(true));
    await hoverLast(0);
    await native.getByRole("button", { name: "布局设置", exact: true }).click();
    const entry = native.locator('[data-name="mw-bar-range-mapping"]');
    await entry.focus();
    await entry.press("Enter");
    assert.equal(await entry.getAttribute("aria-checked"), "false");
    await entry.press("Enter");
    assert.equal(await entry.getAttribute("aria-checked"), "true");
    await native.getByRole("button", { name: "布局设置", exact: true }).click();
    await page.mouse.move(10, 10);
    await host.evaluate(() =>
      MWBarRangeMapping.configure({ style: "background" }),
    );
    await page.waitForTimeout(2500);
    await host.evaluate(
      () =>
        new Promise((resolve, reject) =>
          widget.saveChartToServer(resolve, reject),
        ),
    );
    await page.waitForTimeout(200);
    await hoverLast(0);
    await page.mouse.move(10, 10);
    await page.waitForTimeout(100);
    assert.equal((await state()).dirty, false, "hover dirtied saved workspace");
    const stored = await ctx.request.get(
      APP + "/api/advanced-charts/workspaces",
    );
    const saved = (await stored.json()).find((row) => row.id === w.id);
    const content =
      typeof saved.document.state?.content === "string"
        ? JSON.parse(saved.document.state.content)
        : saved.document.state;
    assert.equal(content._mwBarRangeMapping.enabled, true);
    assert.equal(content._mwBarRangeMapping.style, "background");
    report.cases.push({
      phase: "saved-config",
      config: content._mwBarRangeMapping,
    });
    await page.reload();
    host = undefined;
    for (let n = 0; n < 300 && !host; n++) {
      host = page.frames().find((f) => f.url().startsWith(CHART + "/"));
      if (!host) await page.waitForTimeout(100);
    }
    fixture.setHost(host);
    await settle();
    const restored = await host.evaluate(() => ({
      config: MWBarRangeMapping.snapshot(),
      state: MWBarRangeMapping.diagnostics(),
    }));
    assert.equal(restored.config.enabled, true);
    assert.equal(restored.state.source, undefined);
    report.cases.push({ phase: "restore-config", restored });
    await ctx.close();
    assert.deepEqual(report.errors, []);
  } catch (e) {
    report.failure = e.stack;
    process.exitCode = 1;
  } finally {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    await browser.close();
    console.log(
      JSON.stringify({
        cases: report.cases.length,
        errors: report.errors,
        failure: report.failure,
      }),
    );
  }
})();
