// Real provider prices, native multi-axis layout, and trusted mouse hover.
const { chromium } = require("@playwright/test");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const APP = process.env.RANGE_APP || "https://192.168.7.232:16243";
const CHART = process.env.RANGE_CHART || "https://192.168.7.232:16244";
const OUT =
  process.env.RANGE_OUTPUT ||
  "/tmp/mw-sync-settings-implementation/geometry.json";
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
      browser: {
        newContext: (options) =>
          browser.newContext({ ...options, deviceScaleFactor: 2 }),
      },
      report,
      APP,
      CHART,
    });
    const { host, page } = f;
    const check = async (name) => {
      await f.idle();
      await f.hoverLast(0);
      await host.waitForFunction(
        () => !!MWBarRangeMapping.diagnostics().source,
      );
      const rows = await host.evaluate(() => {
        const source = MWBarRangeMapping.diagnostics().source;
        return Array.from({ length: widget.chartsCount() }, (_, i) => {
          const c = widget.chart(i),
            cw = c._chartWidget;
          const pane = cw.paneWidgets().find((p) => p.containsMainSeries());
          const rail = cw._parent.querySelector(
            '[data-name="mw-range-price-rail"]',
          );
          const rect = (e) => {
            const r = e.getBoundingClientRect();
            return {
              x: r.x,
              y: r.y,
              width: r.width,
              height: r.height,
              bottom: r.bottom,
            };
          };
          const lines = [...rail.children].map((e) => ({
            text: e.textContent,
            width: e.clientWidth,
            textWidth: e.scrollWidth,
            height: e.getBoundingClientRect().height,
          }));
          return {
            i,
            symbol: c.symbol(),
            dpr: cw.ownerDocument().defaultView.devicePixelRatio,
            pane: rect(pane.canvasElement()),
            slot: rect(cw._parent),
            rail: rect(rail),
            lines,
            high: c.priceFormatter().format(source.high),
            low: c.priceFormatter().format(source.low),
            leftScales: c
              .getPanes()
              .find((p) => p.hasMainSeries())
              .getLeftPriceScales().length,
            rightScales: c
              .getPanes()
              .find((p) => p.hasMainSeries())
              .getRightPriceScales().length,
          };
        });
      });
      for (const row of rows) {
        assert.ok(
          row.pane.bottom <= row.rail.y + 0.01,
          "rail overlaps candle pane",
        );
        assert.ok(
          row.rail.bottom <= row.slot.bottom + 0.01,
          "rail exceeds chart slot",
        );
        assert.equal(row.rail.height, 36);
        if (row.i === 0) assert.deepEqual(row.lines, []);
        else {
          assert.equal(
            row.lines.length,
            2,
            "eligible target lacks price labels",
          );
          assert.ok(row.lines[0].text.startsWith("高 " + row.high));
          assert.ok(row.lines[1].text.startsWith("低 " + row.low));
          assert.ok(
            row.lines.reduce((sum, l) => sum + l.height, 0) <=
              row.rail.height - 4,
          );
          for (const line of row.lines)
            assert.ok(
              line.textWidth <= line.width,
              "price text clipped in supported geometry",
            );
        }
      }
      report.cases.push({ name, rows });
      await page.screenshot({
        path: OUT.replace(".json", "-" + name + ".png"),
      });
      return rows;
    };
    await host.evaluate(async () => {
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
    await check("dpr2-long-real-prices");
    await host.evaluate(async () => {
      await widget
        .chart(1)
        .createStudy("Moving Average", true, false, undefined, undefined, {
          priceScale: "new-left",
        });
    });
    const multi = await check("native-multiple-axes");
    assert.ok(multi[1].leftScales > 0 && multi[1].rightScales > 0);
    await host.evaluate(() => widget.setLayout("8"));
    await f.settle();
    await host.evaluate(async () => {
      for (let i = 0; i < widget.chartsCount(); i++) {
        await widget
          .chart(i)
          .setSymbol("MWP:BTCUSDT", { doNotActivateChart: true });
        await widget
          .chart(i)
          .setResolution(i ? "5" : "60", { doNotActivateChart: true });
      }
    });
    await page.setViewportSize({ width: 1100, height: 800 });
    await check("eight-narrow-dpr2");
    const session = await f.ctx.newCDPSession(page);
    // Equivalent layout viewport and density for 125% browser zoom on DPR2.
    // This does not claim operating the browser's own zoom UI.
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: 880,
      height: 640,
      deviceScaleFactor: 2.5,
      mobile: false,
      screenWidth: 1100,
      screenHeight: 800,
    });
    await check("eight-125pct-equivalent-metrics");
    await host.evaluate(() => {
      const doc = widget.chart(0)._chartWidget.ownerDocument();
      const style = doc.createElement("style");
      style.textContent =
        ".mw-range-price-rail{font-size:16px!important;line-height:16px!important}";
      doc.head.appendChild(style);
    });
    await check("eight-16px-effective-label-font");
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
