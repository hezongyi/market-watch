// Real provider acceptance of left/right retreat; only native view settings and actual mouse input.
const { chromium } = require("@playwright/test"),
  fs = require("node:fs"),
  assert = require("node:assert/strict");
const APP = process.env.RANGE_APP || "https://192.168.7.232:16843",
  CHART = process.env.RANGE_CHART || "https://192.168.7.232:16844",
  OUT =
    process.env.RANGE_OUTPUT || "/tmp/mw-range-horizontal-retreat/result.json";
(async () => {
  const browser = await chromium.launch({
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
      "/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
    args: ["--no-sandbox"],
  });
  const report = {
    at: new Date().toISOString(),
    APP,
    CHART,
    errors: [],
    cases: [],
    samples: [],
    method:
      "Real BTCUSDT H1 → M5, native visible range and price range; actual mouse hover, no injected bars or obstacles",
  };
  try {
    const f = await require("./fixtures/bar-range-acceptance.cjs")({
      browser,
      report,
      APP,
      CHART,
    });
    await f.host.evaluate(async () => {
      MWBarRangeMapping.configure({ style: "rectangle", priceLabels: true });
      for (let i = 0; i < widget.chartsCount(); i++) {
        await widget
          .chart(i)
          .setSymbol("MWP:BTCUSDT", { doNotActivateChart: true });
        await widget
          .chart(i)
          .setResolution(i ? "5" : "60", { doNotActivateChart: true });
      }
    });
    await f.settle();
    for (let offset = 1; offset <= 12; offset++) {
      await f.page.mouse.move(10, 10);
      const source = await f.host.evaluate((o) => {
        const c = widget.chart(0),
          m = c._chartWidget.model().model(),
          n = m.mainSeries().bars().lastIndex() - o,
          v = m.mainSeries().bars().valueAt(n);
        return {
          n,
          time: c._convertIndexToPublicTime(n),
          high: v[2],
          low: v[3],
          x: m.timeScale().indexToCoordinate(n),
        };
      }, offset);
      const box = await f.box(0);
      if (source.x < 0 || source.x > box.width) continue;
      await f.host.evaluate(async (s) => {
        for (let i = 1; i < widget.chartsCount(); i++) {
          const c = widget.chart(i);
          await c.setVisibleRange(
            { from: s.time - 3600 * i, to: s.time + 3600 * (i + 1) },
            { rejectByTimeout: 20000 },
          );
          const p = c
            .getPanes()
            .find((p) => p.hasMainSeries())
            .getMainSourcePriceScale();
          p.setAutoScale(false);
          const span = s.high - s.low;
          p.setVisiblePriceRange({
            from: s.low - span * 0.7,
            to: s.high + span * 0.7,
          });
        }
      }, source);
      await f.settle();
      await f.page.mouse.move(box.x + source.x, box.y + box.height * 0.55);
      await f.page.waitForTimeout(250);
      const rows = await f.host.evaluate(() =>
        Array.from({ length: widget.chartsCount() - 1 }, (_, i) => {
          const c = widget.chart(i + 1),
            m = c._chartWidget.model().model();
          const p = c._chartWidget
              .paneWidgets()
              .find((p) => p.containsMainSeries()),
            s = m.mainSeries(),
            ts = m.timeScale(),
            scale = s.priceScale(),
            value = s.firstValue(),
            candles = [];
          for (
            let n = Math.floor(ts.coordinateToFloatIndex(0)) - 1;
            n <= Math.ceil(ts.coordinateToFloatIndex(ts.width())) + 1;
            n++
          ) {
            const v = s.bars().valueAt(n);
            if (!v) continue;
            const x = ts.indexToCoordinate(n),
              a = scale.priceToCoordinate(v[2], value),
              b = scale.priceToCoordinate(v[3], value);
            candles.push({
              time: c._convertIndexToPublicTime(n) * 1000,
              x,
              high: v[2],
              low: v[3],
              left: x - Math.max(1, ts.barSpacing() * 0.4),
              right: x + Math.max(1, ts.barSpacing() * 0.4),
              top: Math.min(a, b),
              bottom: Math.max(a, b),
            });
          }
          const r = p.canvasElement().getBoundingClientRect(),
            l = p._legendWidget.getElement().getBoundingClientRect();
          return {
            i: i + 1,
            width: ts.width(),
            labels: MWBarRangeMapping.labels(c),
            candles,
            legend: {
              left: l.left - r.left,
              right: l.right - r.left,
              top: l.top - r.top,
              bottom: l.bottom - r.top,
            },
            range: c.getVisibleRange(),
            price: c
              .getPanes()
              .find((p) => p.hasMainSeries())
              .getMainSourcePriceScale()
              .getVisiblePriceRange(),
          };
        }),
      );
      const overlaps = (a, b) =>
        a.x < b.right + 2 &&
        a.x + a.width > b.left - 2 &&
        a.y < b.bottom + 2 &&
        a.y + a.height > b.top - 2;
      for (const row of rows)
        for (const t of row.labels.filter((t) => t.visible)) {
          const other = row.labels.find((l) => l.kind !== t.kind);
          assert.ok(
            Math.abs(
              t.box.y -
                (t.boundary <= other.boundary
                  ? t.boundary - 8 - t.box.height
                  : t.boundary + 8),
            ) < 0.01,
            "vertical position stays fixed",
          );
          const bar = row.candles.find((c) => c.time === t.barTime);
          assert.ok(bar, "anchor must be a real visible bar");
          assert.equal(bar[t.kind], t.price);
          assert.ok(Math.abs(bar.x - t.barX) < 0.01);
          const blockers = [...row.candles, row.legend];
          for (const l of row.labels)
            if (l !== t && l.visible) {
              blockers.push({
                left: l.box.x,
                right: l.box.x + l.box.width,
                top: l.box.y,
                bottom: l.box.y + l.box.height,
              });
              blockers.push(
                ...l.leaders.map((s) => ({
                  left: s.x,
                  right: s.x + s.width,
                  top: s.y,
                  bottom: s.y + s.height,
                })),
              );
            }
          assert.ok(
            blockers.every(
              (b) =>
                !overlaps(t.box, b) && t.leaders.every((l) => !overlaps(l, b)),
            ),
            "tag and all elbow segments avoid candles, legend and other label",
          );
        }
      report.samples.push({ offset, source, rows });
      console.log(
        JSON.stringify({
          offset,
          labels: rows.map((r) =>
            r.labels.map((t) => ({
              kind: t.kind,
              visible: t.visible,
              reason: t.reason,
              dx: t.box && t.box.x - (t.barX - t.box.width / 2),
            })),
          ),
        }),
      );
      if (
        rows.some(
          (r) =>
            r.labels.filter((t) => t.visible).length === 2 &&
            r.labels.some(
              (t) =>
                t.visible &&
                Math.abs(
                  t.box.x -
                    Math.max(
                      2,
                      Math.min(
                        r.width - t.box.width - 2,
                        t.barX - t.box.width / 2,
                      ),
                    ),
                ) > 0.1,
            ),
        )
      ) {
        fs.mkdirSync(require("node:path").dirname(OUT), { recursive: true });
        await f.page.screenshot({ path: OUT.replace(".json", ".png") });
        report.retreatBoth = true;
        report.cases.push({
          name: "actual horizontal retreat with both prices visible",
        });
        break;
      }
    }
    assert.ok(
      report.retreatBoth,
      "actual chart should show both with horizontal retreat",
    );
    assert.deepEqual(report.errors, []);
    await f.ctx.close();
  } catch (e) {
    report.failure = e.stack;
    process.exitCode = 1;
  } finally {
    fs.mkdirSync(require("node:path").dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    await browser.close();
  }
})();
