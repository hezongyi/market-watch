// Actual provider history, mouse input, painted canvas and semantic cursor.
const { chromium } = require("@playwright/test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const APP = process.env.RANGE_APP || "https://192.168.7.232:16743";
const CHART = process.env.RANGE_CHART || "https://192.168.7.232:16744";
const OUT = process.env.RANGE_OUTPUT || "/tmp/mw-range-v180/stability.json";
const report = {
  at: new Date().toISOString(),
  APP,
  CHART,
  cases: [],
  errors: [],
};
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
    });
    const { host, page } = f;
    await host.evaluate(async () => {
      MWSyncCoordinator.configure({
        date: false,
        time: false,
        barWidth: false,
      });
      for (const [i, res] of [
        [0, "1W"],
        [1, "5"],
        [2, "240"],
        [3, "1D"],
      ])
        await widget.chart(i).setResolution(res, { doNotActivateChart: true });
      MWBarRangeMapping.configure({ style: "rectangle", priceLabels: true });
    });
    await f.idle();
    await host.evaluate(() => {
      globalThis.__stability = { samples: [], resets: [], identities: [] };
      for (let i = 0; i < widget.chartsCount(); i++) {
        const c = widget.chart(i),
          cw = c._chartWidget,
          m = cw.model().model();
        __stability.identities.push({ cw, m });
        const reset = c.resetData;
        c.resetData = function (...args) {
          __stability.resets.push({ i, kind: "resetData" });
          return reset.apply(this, args);
        };
      }
      globalThis.__cursorState = () => {
        const mapper = MWBarRangeMapping.diagnostics(),
          source = mapper.source;
        const rows = Array.from({ length: widget.chartsCount() }, (_, i) => {
          const c = widget.chart(i),
            cw = c._chartWidget,
            m = cw.model().model(),
            ts = m.timeScale(),
            cross = m.crosshairSource();
          const index = cross.appliedIndex(),
            internal = ts.points().valueAt(index);
          const pane = cw.paneWidgets().find((p) => p.containsMainSeries()),
            canvas = pane.canvasElement();
          const rail = cw._parent.querySelector(
            '[data-name="mw-range-price-rail"]',
          );
          const label = { ...cross._timeAxisView._rendererData };
          return {
            i,
            resolution: c.resolution(),
            bars: m.mainSeries().bars().size(),
            symbol: c.symbol(),
            ready: c.dataReady(),
            index,
            internal,
            publicTime: Number.isFinite(internal)
              ? c._convertIndexToPublicTime(index) * 1000
              : null,
            slot: Number.isFinite(internal)
              ? m
                  .mainSeries()
                  .syncModel()
                  .mwRangeSlot(internal * 1000, true)
              : null,
            label: label.text,
            visible: !!cross.visible,
            rail: rail?.textContent || "",
            range: c.getVisibleRange(),
            spacing: c.getTimeScale().barSpacing(),
            offset: c.getTimeScale().rightOffset(),
            canvas: {
              width: canvas.width,
              height: canvas.height,
              connected: canvas.isConnected,
            },
            sameIdentity:
              cw === __stability.identities[i].cw &&
              m === __stability.identities[i].m,
          };
        });
        return { source, rows, resets: __stability.resets.length };
      };
      globalThis.__samplePaint = () => {
        const rows = __cursorState().rows;
        for (const row of rows) {
          const pane = widget
            .chart(row.i)
            ._chartWidget.paneWidgets()
            .find((p) => p.containsMainSeries());
          const canvas = pane.canvasElement(),
            data = canvas
              .getContext("2d")
              .getImageData(0, 0, canvas.width, canvas.height).data;
          let candlePixels = 0;
          for (let n = 0; n < data.length; n += 8) {
            const r = data[n],
              g = data[n + 1],
              b = data[n + 2];
            if (
              data[n + 3] > 150 &&
              ((r > 120 && r > g * 1.4 && r > b * 1.2) ||
                (g > 90 && g > r * 1.3 && b > r * 1.2))
            )
              candlePixels++;
          }
          row.candlePixels = candlePixels;
        }
        if (__stability.samples.length < 1000)
          __stability.samples.push({ at: performance.now(), rows });
        __stability.raf = requestAnimationFrame(__samplePaint);
      };
    });
    const read = () => host.evaluate(() => __cursorState());
    const check = async (name, index) => {
      await page.waitForTimeout(120);
      const s = await read();
      report.lastState = s;
      assert.ok(s.source, "valid source missing");
      assert.equal(
        s.source.chartTime,
        s.rows[index].publicTime,
        "range source differs from actual crosshair bar",
      );
      assert.ok(s.source.start < s.source.end);
      assert.equal(s.rows[index].rail, "", "source must not show target label");
      assert.ok(
        s.rows.every(
          (row) =>
            row.sameIdentity && row.canvas.connected && row.canvas.width > 0,
        ),
      );
      assert.equal(
        s.resets,
        0,
        "hover/navigation unexpectedly rebuilt a native source",
      );
      for (const row of s.rows)
        if (row.i !== index && row.rail) {
          // D/W/M date labels are trading-day labels; NY17 real intervals can
          // begin on the prior UTC evening. Peers point to a bar within that
          // interval, including native latest-bar clamping on a partial week.
          assert.ok(row.publicTime >= s.source.start && row.publicTime < s.source.end,
            "peer crosshair date lies outside the mapped source interval");
          assert.ok(row.label, "painted peer date label missing");
        }
      report.cases.push({ name, state: s });
      return s;
    };
    // Latest hover never needs history reconstruction.
    await f.idle();
    const hoverRequests = f.history;
    await f.hoverLast(0);
    await check("latest W1 source/crosshair/range", 0);
    await host.evaluate(() => requestAnimationFrame(__samplePaint));
    for (let i = 0; i < 50; i++) {
      const b = await f.box(0);
      await page.mouse.move(
        b.x + b.width * (0.55 + (i % 5) * 0.02),
        b.y + b.height * 0.45,
      );
    }
    await f.hoverLast(0);
    await page.waitForTimeout(1500);
    await host.evaluate(() => cancelAnimationFrame(__stability.raf));
    report.latestPaint = await host.evaluate(() =>
      __stability.samples.splice(0),
    );
    assert.ok(report.latestPaint.length > 30);
    assert.equal(f.history,hoverRequests,'latest hover must not start history loading');
    assert.ok(
      report.latestPaint.every((s) =>
        s.rows.every((r) => r.candlePixels > 0 && r.sameIdentity && r.ready),
      ),
      "blank/replaced candle frame during latest hover",
    );
    report.cases.push({
      name: "latest continuous hover: no blank candle frames or model replacement",
      frames: report.latestPaint.length,
    });
    // W1 click creates the real >20k continuous M5 corridor, mouse stays still.
    await page.mouse.move(10, 10);
    await host.evaluate(async () => {
      await widget
        .chart(0)
        .setVisibleRange({
          from: Date.parse("2025-10-01") / 1000,
          to: Date.parse("2026-02-01") / 1000,
        });
      MWSyncCoordinator.configure({ date: false, time: true, barWidth: false });
    });
    await f.settle();
    const b = await f.box(0),
      x = b.x + b.width * 0.5,
      y = b.y + b.height * 0.45;
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);
    await f.settle();
    await f.idle();
    const stationary = await check(
      "continuous far-history click with stationary mouse",
      0,
    );
    assert.ok(stationary.rows.find(row=>row.resolution === '5').bars > 20000,
      'far-history target must retain a real continuous corridor');
    await page.screenshot({ path: OUT.replace(".json", "-stationary.png") });
    await host.evaluate(() => requestAnimationFrame(__samplePaint));
    await page.waitForTimeout(2000);
    await host.evaluate(() => cancelAnimationFrame(__stability.raf));
    report.historicalPaint = await host.evaluate(() =>
      __stability.samples.splice(0),
    );
    assert.ok(
      report.historicalPaint.every((s) =>
        s.rows.every((r) => r.candlePixels > 0 && r.sameIdentity && r.ready),
      ),
      "blank/replaced candle frame with stationary historical cursor",
    );
    for (const sample of report.historicalPaint)
      for (const row of sample.rows) {
        assert.equal(row.publicTime, stationary.rows[row.i].publicTime,
          "stationary crosshair time jumped between painted frames");
        assert.equal(row.label, stationary.rows[row.i].label,
          "stationary crosshair date label flickered between painted frames");
        assert.equal(row.rail, stationary.rows[row.i].rail,
          "stationary mapped price information flickered between painted frames");
      }
    await page.mouse.move(x + 10, y);
    await page.mouse.move(x, y);
    const moved = await check("same pointer after history extension", 0);
    assert.deepEqual(
      moved.rows.map((r) => [r.publicTime, r.label]),
      stationary.rows.map((r) => [r.publicTime, r.label]),
      "stationary date label differs on next mouse move",
    );
    for (const theme of ["Light", "Dark"]) {
      await host.evaluate((t) => widget.changeTheme(t), theme);
      await page.waitForTimeout(250);
      await page.mouse.move(x + 5, y);
      await page.mouse.move(x, y);
      await check(theme + " historical source/date relation", 0);
    }
    // Intraday reverse source, source period change, and display timezone.
    await host.evaluate(() =>
      MWSyncCoordinator.configure({
        date: false,
        time: false,
        barWidth: false,
      }),
    );
    const reverseBox = await f.box(1);
    // Continuous history retains latest bars outside the historical viewport;
    // use an actually visible bar rather than its offscreen lastIndex.
    await page.mouse.move(reverseBox.x + reverseBox.width * 0.55, reverseBox.y + reverseBox.height * 0.45);
    await check("reverse M5 source keeps its own actual date", 1);
    await page.mouse.move(10, 10);
    await host.evaluate(async () =>
      widget.chart(0).setResolution("1M", { doNotActivateChart: true }),
    );
    await f.settle();
    await f.hoverLast(0);
    await check("MN source after period change", 0);
    await host.evaluate(() => {
      for (let i = 0; i < widget.chartsCount(); i++)
        widget.chart(i).getTimezoneApi().setTimezone("Asia/Tokyo");
    });
    await page.waitForTimeout(300);
    await f.hoverLast(0);
    await check("Tokyo label preserves UTC range semantics", 0);
    assert.deepEqual(report.errors, []);
    await f.ctx.close();
  } catch (e) {
    report.failure = e.stack;
    process.exitCode = 1;
  } finally {
    fs.mkdirSync(require("node:path").dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify({
        cases: report.cases.length,
        failure: report.failure,
        errors: report.errors,
      }),
    );
    await browser.close();
  }
})();
