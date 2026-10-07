const { chromium } = require("@playwright/test"),
  fs = require("node:fs"),
  assert = require("node:assert/strict");
const APP = process.env.RANGE_APP || "https://192.168.7.232:16243",
  CHART = process.env.RANGE_CHART || "https://192.168.7.232:16244",
  OUT =
    process.env.RANGE_OUTPUT ||
    "/tmp/mw-sync-settings-implementation/acceptance.json";
const report = {
  at: new Date().toISOString(),
  APP,
  CHART,
  cases: [],
  errors: [],
};
let phase;
(async () => {
  const browser = await chromium.launch({
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
      "/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
    args: ["--no-sandbox"],
  });
  try {
    const f = await require("./fixtures/bar-range-acceptance.cjs")({
        browser,
        report,
        APP,
        CHART,
      }),
      { page, native, host } = f;
    const record = (name, data) => {
      phase = name;
      report.cases.push({ name, ...data });
    };
    const space = () =>
      host.evaluate(() =>
        Array.from({ length: widget.chartsCount() }, (_, i) =>
          widget.chart(i).getTimeScale().barSpacing(),
        ),
      );
    const menu = () =>
      native.getByRole("button", { name: "布局设置", exact: true }).click();
    const settings = async () => {
      await menu();
      await native.locator('[data-name="mw-sync-settings"]').click();
      return native.locator('[data-name="mw-sync-settings-dialog"]');
    };
    const activate = async (i) => {
      const b = await f.box(i);
      await page.mouse.click(b.x + b.width * 0.6, b.y + b.height * 0.85);
      const hint = native.getByRole("button", { name: "了解!", exact: true });
      if (await hint.isVisible()) await hint.click();
      await page.mouse.move(b.x + b.width * 0.6, b.y + b.height * 0.85);
      return b;
    };
    const equal = async () => {
      const values = await space();
      assert.ok(
        values.every((v) => Math.abs(v - values[0]) < 1e-6),
        JSON.stringify(values),
      );
      return values;
    };
    const save = async () => {
      await f.settle();
      await host.evaluate(() => snapshot());
      try {
        await host.waitForFunction(() => !nativeSaving && !dirty, null, {
          timeout: 60000,
        });
      } catch (error) {
        report.saveFailure = await host.evaluate(() => ({
          dirty,
          nativeSaving,
          manualSavePending,
          loading,
          editRevision,
          sync: MWSyncCoordinator.diagnostics(),
          range: rangeGuard.busy(),
          edge: edgeGuard.busy(),
          navigation: MWNativeNavigation.busy(),
        }));
        throw error;
      }
      await page.waitForTimeout(300);
    };
    const geometry = () =>
      host.evaluate(() =>
        Array.from({ length: widget.chartsCount() }, (_, i) => {
          const c = widget.chart(i),
            cw = c._chartWidget,
            p = cw.paneWidgets().find((p) => p.containsMainSeries()),
            tags = MWBarRangeMapping.labels(c);
          const rect = (e) =>
            e &&
            (() => {
              const r = e.getBoundingClientRect();
              return { x: r.x, y: r.y, width: r.width, height: r.height };
            })();
          return {
            i,
            pane: rect(p.canvasElement()),
            labels: tags,
            text: tags.filter(tag => tag.visible).map(tag => tag.text).join(""),
            spacing: c.getTimeScale().barSpacing(),
            range: c.getVisibleRange(),
            price: c
              .getPanes()
              .find((p) => p.hasMainSeries())
              .getMainSourcePriceScale()
              .getVisiblePriceRange(),
          };
        }),
      );
    const noOverlap = rows => {
      for (const row of rows) for (const tag of row.labels.filter(tag=>tag.visible)) {
        assert.ok(tag.box.y+tag.box.height<=tag.boundary-7 || tag.box.y>=tag.boundary+7,"label must stay outside rectangle");
        assert.ok(tag.box.x>=0 && tag.box.x+tag.box.width<=row.pane.width && tag.box.y>=0 && tag.box.y+tag.box.height<=row.pane.height);
        assert.ok(Number.isFinite(tag.barTime),"label must match an accepted real bar");
      }
    };
    const verifyLabels = rows => {
      noOverlap(rows);
      for(const row of rows) for(const tag of row.labels) {
        assert.match(tag.text,tag.kind==='high'?/^高 /:/^低 /);
        if(!tag.visible) assert.ok(['unmatched-extreme','outside-pane','occupied'].includes(tag.reason));
      }
    };
    await menu();
    assert.equal(
      await native
        .locator('[data-name="mw-bar-range-mapping"]')
        .getAttribute("aria-label"),
      "范围映射",
    );
    assert.equal(
      await native.locator('[data-name="mw-bar-range-style"]').count(),
      0,
    );
    await menu();
    record("menu rename and styles relocated");
    const before = await space();
    await menu();
    await native.locator('[data-name="mw-bar-width-sync"]').click();
    assert.equal(
      await native.locator('input[value="syncDateRangeLabel"]').isDisabled(),
      true,
    );
    await menu();
    assert.deepEqual(await space(), before);
    record("enable no-op and date disabled");
    await activate(0);
    await page.mouse.wheel(0, -180);
    await page.waitForTimeout(350);
    record("four-chart wheel", { spacing: await equal() });
    await host.evaluate(() => widget.setActiveChart(0));
    const nonActive = await f.box(3);
    await page.mouse.move(nonActive.x+nonActive.width*0.6,nonActive.y+nonActive.height*0.7);
    const beforeHoverWheel=await space();
    assert.equal(await host.evaluate(() => widget.activeChartIndex()),0);
    await page.mouse.wheel(0,-120);
    await page.waitForTimeout(350);
    const hoverWheel=await equal();
    assert.notEqual(hoverWheel[3],beforeHoverWheel[3]);
    assert.equal(await host.evaluate(() => widget.activeChartIndex()),0,"wheel should not need a focus change");
    record("wheel over non-active chart synchronizes without click",{before:beforeHoverWheel,after:hoverWheel});

    await page.keyboard.press("Control+ArrowUp");
    await page.waitForTimeout(400);
    record("shortcut animation", { spacing: await equal() });
    const initial = await space();
    await host.evaluate(() => {
      widget.setActiveChart(1);
      widget.chart(1).getTimeScale().setBarSpacing(12);
    });
    await page.waitForTimeout(100);
    const program = await space();
    assert.equal(program[0], initial[0]);
    assert.equal(program[1], 12);
    record("focus and program setter excluded");
    await activate(1);
    await page.keyboard.press("Control+ArrowDown");
    await page.waitForTimeout(60);
    await host.evaluate(() => widget.setActiveChart(2));
    await page.waitForTimeout(400);
    const cancelled = await space();
    assert.ok(cancelled.every(value => Math.abs(value-cancelled[1]) < 1e-6));
    record("actual native animation remains source through focus change", { spacing: cancelled });
    await activate(2);
    await page.keyboard.press("Control+ArrowUp");
    await page.waitForTimeout(60);
    await host.evaluate(() => widget.chart(0).getTimeScale().setBarSpacing(17));
    await page.waitForTimeout(400);
    record("animation with program setter", { spacing: await equal() });
    await native.getByRole("button", { name: "放大", exact: true }).click();
    const b = await f.box(2);
    await page.mouse.move(b.x + b.width * 0.25, b.y + b.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width * 0.75, b.y + b.height * 0.7, {
      steps: 12,
    });
    await page.mouse.up();
    await page.waitForTimeout(300);
    record("box zoom", { spacing: await equal() });
    const prePrice = await space();
    await host.evaluate(() =>
      widget
        .chart(2)
        .getPanes()
        .find((p) => p.hasMainSeries())
        .getMainSourcePriceScale()
        .setVisiblePriceRange({ from: 1.11, to: 1.15 }),
    );
    await page.waitForTimeout(100);
    assert.deepEqual(await space(), prePrice);
    record("price scale excluded");
    await menu();
    await native.locator('[data-name="mw-bar-width-sync"]').click();
    await native
      .locator('input[value="syncDateRangeLabel"]')
      .click({ force: true });
    await page.waitForTimeout(200);
    assert.equal(
      await native
        .locator('[data-name="mw-bar-width-sync"]')
        .getAttribute("aria-disabled"),
      "true",
    );
    await native
      .locator('input[value="syncDateRangeLabel"]')
      .click({ force: true });
    await menu();
    record("reverse mutual exclusion");
    let d = await settings();
    await d.locator('[name="style"]').selectOption("rectangle");
    await d.locator('[data-action="cancel"]').click();
    assert.equal(
      (await host.evaluate(() => MWBarRangeMapping.snapshot())).style,
      "background",
    );
    record("cancel draft");
    d = await settings();
    await d.locator('[name="style"]').selectOption("rectangle");
    await d.locator('[name="colorMode"]').selectOption("custom");
    await d.locator('[name="color"]').fill("#AABBCC");
    await d.locator('[name="transparencyMode"]').selectOption("custom");
    await d.locator('[name="transparency"]').fill("70");
    await d.locator('[data-action="confirm"]').click();
    record("atomic appearance", {
      config: await host.evaluate(() => MWBarRangeMapping.snapshot()),
    });
    await f.hoverLast(0);
    let rows = await geometry();
    noOverlap(rows);
    assert.equal(rows[0].text, "");
    assert.equal(rows[3].text, "");
    verifyLabels(rows);
    record("formatted exterior prices and source W1 exclusion", { rows });
    const geometryBefore = await geometry(),
      requests = f.history;
    await f.hoverLast(2);
    await f.hoverLast(0);
    assert.deepEqual(await geometry(), geometryBefore);
    assert.equal(f.history, requests);
    record("hover no geometry or history changes");
    await page.mouse.move(10, 10);
    await page.waitForTimeout(100);
    assert.ok((await geometry()).every((r) => r.text === ""));
    record("leave clears exterior tags");
    await f.hoverLast(0);
    await menu();
    await page.waitForTimeout(100);
    assert.ok((await geometry()).every((r) => r.text === ""));
    await menu();
    record("menu clears labels");
    for (const mode of [0, 1, 2, 3]) {
      await host.evaluate((mode) => {
        const s = widget
          .chart(1)
          .getPanes()
          .find((p) => p.hasMainSeries())
          .getMainSourcePriceScale();
        s.setMode(mode);
        s.setInverted(mode === 3);
      }, mode);
      await f.hoverLast(0);
      rows = await geometry();
      noOverlap(rows);
      verifyLabels(rows);
      record("axis mode " + mode, { rows });
    }
    for (const theme of ["Light", "Dark"]) {
      await host.evaluate((theme) => widget.changeTheme(theme), theme);
      await page.waitForTimeout(300);
      await f.hoverLast(0);
      rows = await geometry();
      noOverlap(rows);
      await page.screenshot({
        path: OUT.replace(".json", "-" + theme.toLowerCase() + ".png"),
      });
      record("theme " + theme, { rows });
    }
    for (const alpha of [0, 100]) {
      await host.evaluate(
        (alpha) =>
          MWBarRangeMapping.configure({
            colorMode: "theme",
            transparencyMode: "custom",
            transparency: alpha,
          }),
        alpha,
      );
      await f.hoverLast(0);
      verifyLabels(await geometry());
      record("transparency " + alpha, {
        color: await host.evaluate(() => MWBarRangeMapping.fillColor()),
      });
    }
    await host.evaluate(() => {
      MWBarRangeMapping.configure({ transparencyMode: "theme" });
      MWSyncCoordinator.configure({ date: true, time: true });
    });
    await f.settle();
    await save();
    const pause = await host.evaluate(async () => {
      const read = () => ({
        undo: widget._innerAPI().undoRedoState(),
        save: widget._innerAPI().hasChartChanges().value(),
        dirty,
        desired: MWSyncCoordinator.snapshot(),
        native: {
          date: widget.dateRangeSync().value(),
          time: widget.timeSync().value(),
        },
      });
      const before = read(),
        a = MWSyncCoordinator.acquirePause("a"),
        b = MWSyncCoordinator.acquirePause("b");
      a.release();
      a.release();
      const mid = read();
      const saved = await captureChartLayout(widget);
      b.release();
      await new Promise((r) => setTimeout(r, 200));
      return { before, mid, after: read(), captured: saved._mwSync };
    });
    assert.equal(pause.before.dirty, false, "clean precondition");
    assert.equal(pause.before.save, false, "native clean precondition");
    assert.equal(pause.mid.native.date, false);
    assert.equal(pause.mid.desired.date, true);
    assert.equal(pause.captured.date, true);
    assert.deepEqual(pause.after, pause.before);
    await page.waitForTimeout(5500);
    assert.equal(
      await host.evaluate(() => dirty),
      false,
      "late native Undo debounce dirtied saved layout",
    );
    record("clean nested pause and capture", { pause });
    await host.evaluate(() =>
      MWSyncCoordinator.configure({ date: false, time: false, barWidth: true }),
    );
    await save();
    const response = await f.ctx.request.get(
        APP + "/api/advanced-charts/workspaces",
      ),
      doc = (await response.json()).find((r) => r.id === f.w.id).document,
      content =
        typeof doc.state.content === "string"
          ? JSON.parse(doc.state.content)
          : doc.state;
    assert.equal(content._mwSync.barWidth, true);
    assert.equal(content._mwSync.date, false);
    assert.equal(content._mwBarRangeMapping.version, 2);
    assert.equal(content._mwBarRangeMapping.color, "#AABBCC");
    record("server saved appearance and logical sync", {
      config: content._mwBarRangeMapping,
      sync: content._mwSync,
    });
    for (const count of [2, 8]) {
      await host.evaluate(
        (count) => widget.setLayout(count === 2 ? "2h" : "8"),
        count,
      );
      await f.settle();
      await host.evaluate(async () => {
        for (let i = 0; i < widget.chartsCount(); i++)
          await widget
            .chart(i)
            .setResolution(i ? "5" : "60", { doNotActivateChart: true });
      });
      await f.settle();
      await activate(0);
      await page.mouse.wheel(0, -180);
      await page.waitForTimeout(300);
      await equal();
      await f.hoverLast(0);
      rows = await geometry();
      noOverlap(rows);
      record(count + " charts", { rows });
    }
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.waitForTimeout(400);
    await f.hoverLast(0);
    rows = await geometry();
    noOverlap(rows);
    record("narrow eight charts", { rows });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await host.evaluate(async () => {
      MWBarRangeMapping.configure({style:'rectangle',priceLabels:true});
      for(let i=0;i<widget.chartsCount();i++) {
        await widget.chart(i).setSymbol('MWP:BTCUSDT',{doNotActivateChart:true});
        await widget.chart(i).setResolution(i?'5':'60',{doNotActivateChart:true});
      }
    });
    await f.settle();await f.hoverLast(0);
    assert.equal(await host.evaluate(()=>MWBarRangeMapping.diagnostics().labelPanes),7,'performance precondition exercises all seven label projections');
    await page.mouse.move(10, 10);
    await host.evaluate(() => {
      globalThis.__metrics = { frames: [], frame: { work: 0, setters: {} },latencies:[],labelDraws:0,maxLabelPanes:0,lastStep:undefined,lastFrame:performance.now() };
      const step=MWNativeSync.step;
      MWNativeSync.step=function(token,fn){const before=token?.chart.getTimeScale().barSpacing();const out=step(token,fn);if(token&&!token.cancelled&&token.chart.getTimeScale().barSpacing()!==before)__metrics.lastStep=performance.now();return out};
      const next = timestamp => {
        __metrics.lastFrame=timestamp;
        __metrics.frames.push(__metrics.frame);
        __metrics.frame = { work: 0, setters: {} };
        __metrics.raf = requestAnimationFrame(next);
      };
      __metrics.raf = requestAnimationFrame(next);
      for (let i = 0; i < widget.chartsCount(); i++) {
        const s = widget.chart(i)._chartWidget.model().model().timeScale(),
          set = s.setBarSpacing;
        s.setBarSpacing = function (...args) {
          const start = performance.now();
          try {
            return set.apply(this, args);
          } finally {
            if(i!==widget.activeChartIndex()&&__metrics.lastStep!=null)__metrics.latencies.push({elapsed:start-__metrics.lastStep,frame:__metrics.lastFrame-__metrics.lastStep});
            __metrics.frame.work += performance.now() - start;
            __metrics.frame.setters[i] = (__metrics.frame.setters[i] || 0) + 1;
          }
        };
      }
      const draw = MWBarRangeMapping.draw;
      MWBarRangeMapping.draw = function (...args) {
        const start = performance.now();
        try {
          return draw.apply(this, args);
        } finally {
          __metrics.frame.work += performance.now() - start;
          const count=MWBarRangeMapping.diagnostics().labelPanes;
          if(count){__metrics.labelDraws++;__metrics.maxLabelPanes=Math.max(count,__metrics.maxLabelPanes);}
        }
      };
    });
    await f.hoverLast(0);
    const finish = Date.now() + 60000;
    let turns = 0;
    while (Date.now() < finish) {
      await page.mouse.wheel(0, turns++ % 2 ? -120 : 120);
      await page.waitForTimeout(100);
    }
    report.performance = await host.evaluate(() => {
      cancelAnimationFrame(__metrics.raf);
      const rows = __metrics.frames,
        work = rows.map((r) => r.work).sort((a, b) => a - b);
      return {
        frames: rows.length,
        labelDraws:__metrics.labelDraws,maxLabelPanes:__metrics.maxLabelPanes,
        p95: work[Math.floor(work.length * 0.95)],
        setterSamples: rows.flatMap((r) => Object.values(r.setters)).length,
        maxCalls: Math.max(...rows.flatMap((r) => Object.values(r.setters))),
        maxWork: Math.max(...work),
        latencySamples:__metrics.latencies.length,
        latencyP95:__metrics.latencies.map(r=>r.elapsed).sort((a,b)=>a-b)[Math.floor(__metrics.latencies.length*.95)],
        afterRafP95:__metrics.latencies.map(r=>r.elapsed-Math.max(0,r.frame)).sort((a,b)=>a-b)[Math.floor(__metrics.latencies.length*.95)],
      };
    });
    assert.ok(report.performance.p95 <= 8);
    assert.equal(report.performance.maxLabelPanes,7);
    assert.ok(report.performance.labelDraws>100,'performance run must exercise labels');
    assert.ok(
      report.performance.setterSamples > 100,
      "performance run did not exercise setters",
    );
    assert.ok(report.performance.maxCalls <= 1);
    assert.ok(report.performance.latencySamples>100);
    assert.ok(report.performance.afterRafP95<=8);
    record("eight chart 60 second performance", {
      performance: report.performance,
    });
    assert.deepEqual(report.errors, []);
    await f.ctx.close();
  } catch (e) {
    report.failure = e.stack;
    report.phase = phase;
    process.exitCode = 1;
  } finally {
    fs.mkdirSync(require("node:path").dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify({
        cases: report.cases.length,
        last: report.cases.at(-1)?.name,
        failure: report.failure,
        errors: report.errors,
      }),
    );
    await browser.close();
  }
})();
