// Isolated product API/PG and actual provider candles; real mouse interaction.
const { chromium } = require("@playwright/test");
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const APP = process.env.RANGE_APP || "https://localhost:16043",
  CHART = process.env.RANGE_CHART || "https://localhost:16044";
const OUT =
  process.env.RANGE_OUTPUT || "/tmp/mw-range-mapping-acceptance/calendar.json";
const report = {
  scope:
    "Actual provider candles, native calendar, actual mouse and recorded paint bounds",
  at: new Date().toISOString(),
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
    const fixture = await require("./fixtures/bar-range-acceptance.cjs")({
      browser,
      report,
      APP,
      CHART,
    });
    const { ctx, api, w, page, native, settle, box, hoverLast, state } =
      fixture;
    let { host } = fixture;

    const symbol = process.env.RANGE_SYMBOL || "MWP:EURUSD";
    const dates = process.env.RANGE_DATES?.split(",") || [
      "2024-03-01",
      "2020-02-01",
      "2023-12-01",
      "2024-12-01",
    ];
    for (const date of dates) {
      await page.mouse.move(10, 10);
      const start = Date.parse(date) / 1000,
        end =
          Date.UTC(
            new Date(start * 1000).getUTCFullYear(),
            new Date(start * 1000).getUTCMonth() + 1,
            1,
          ) / 1000;
      const yahoo = symbol.includes("YAHOO:");
      for (const [i, r] of [
        [0, "1M"],
        [1, "1D"],
        [2, yahoo ? "1D" : "60"],
        [3, "1W"],
      ]) {
        await host.evaluate(
          async ({ i, r }) => {
            if (widget.chart(i).resolution() !== r)
              await widget
                .chart(i)
                .setResolution(r, { doNotActivateChart: true });
          },
          { i, r },
        );
        await settle();
      }
      for (const [i, range] of [
        [0, { from: start - 90 * 86400, to: end + 30 * 86400 }],
        [1, { from: start - 7 * 86400, to: end + 7 * 86400 }],
        [
          2,
          yahoo
            ? { from: start - 7 * 86400, to: end + 7 * 86400 }
            : { from: start - 86400, to: start + 3 * 86400 },
        ],
        [3, { from: start - 60 * 86400, to: end + 30 * 86400 }],
      ]) {
        await host.evaluate(
          ({ i, range }) => widget.chart(i).setVisibleRange(range, {rejectByTimeout:120000}),
          { i, range },
        );
        await settle();
      }
      await host.waitForFunction(
        () =>
          MWNativeReserve.diagnostics().flights === 0 &&
          MWNativeReserve.diagnostics().threads.every((t) => !t.requesting),
        null,
        { timeout: 60000 },
      );
      // Native historical-window replacement can finish after the public
      // range promise. Establish a stable setup baseline before hover.
      let previous,
        stable = false;
      for (let attempt = 0; attempt < 15 && !stable; attempt++) {
        await settle();
        await page.waitForTimeout(700);
        const current = JSON.stringify((await state()).charts);
        stable = current === previous;
        previous = current;
      }
      assert.ok(stable, "calendar setup viewport did not settle");

      await host.evaluate(() => (__rangePaints.length = 0));
      const before = await state(),
        count = fixture.history;
      const b = await box(0),
        x = await host.evaluate((start) => {
          const c = widget.chart(0),
            ts = c._chartWidget.model().model().timeScale();
          return ts.indexToCoordinate(
            ts.timePointToIndex(c._convertTimeFromPublic(start), 0),
          );
        }, start);
      await page.mouse.move(b.x + x, b.y + b.height * 0.5);
      await page.waitForTimeout(200);
      const selected = await state();
      assert.equal(selected.mapper.source?.chartTime, start * 1000);
      assert.ok(selected.paints.some((p) => p.resolution === "1D"));
      assert.ok(!selected.paints.some((p) => p.resolution === "1W"));
      assert.deepEqual(selected.charts, before.charts);
      assert.equal(fixture.history, count);
      const source = selected.mapper.source;
      if (symbol === "MWP:EURUSD") {
        // Independently derive NY17 month boundaries, including DST/leap/year.
        const utcAtNY17 = (date) => {
          const formatter = new Intl.DateTimeFormat("en-US", {
            timeZone: "America/New_York",
            hour: "numeric",
            hourCycle: "h23",
          });
          let v = date + 17 * 3600000;
          for (let n = 0; n < 3; n++) {
            const hour = Number(formatter.format(new Date(v)));
            v += (17 - hour) * 3600000;
          }
          return v;
        };
        assert.equal(source.start, utcAtNY17((start - 86400) * 1000));
        assert.equal(source.end, utcAtNY17((end - 86400) * 1000));
      }
      if (symbol === "MWP:BTCUSDT") {
        assert.equal(source.start, start * 1000);
        assert.equal(source.end, end * 1000);
      } else if (symbol.includes("YAHOO:")) {
        // The cached NYSE Arca contract uses exchange-local midnight, not NY17.
        const midnight = (seconds) => {
          let t = seconds * 1000 + 5 * 3600000;
          const hour = Number(
            new Intl.DateTimeFormat("en-US", {
              timeZone: "America/New_York",
              hour: "numeric",
              hourCycle: "h23",
            }).format(new Date(t)),
          );
          return t - hour * 3600000;
        };
        assert.equal(source.start, midnight(start));
        assert.equal(source.end, midnight(end));
      }
      const baseline = selected.paints
        .filter((p) => p.resolution === "1D")
        .at(-1).rect;
      await host.evaluate(() =>
        widget.chart(1).getTimezoneApi().setTimezone("Asia/Tokyo"),
      );
      await page.waitForTimeout(200);
      const timezone = await state();
      assert.deepEqual(
        timezone.paints
          .filter((p) => p.resolution === "1D")
          .at(-1)
          .rect.slice(0, 3),
        baseline.slice(0, 3),
      );
      report.cases.push({ date, source, before, selected, timezone });
      await page.screenshot({
        path: OUT.replace(".json", "-" + date + ".png"),
      });
    }
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
