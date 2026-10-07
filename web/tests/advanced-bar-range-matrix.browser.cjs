// Isolated product API/PG and actual provider candles; real mouse interaction.
const { chromium } = require("@playwright/test");
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const APP = process.env.RANGE_APP || "https://localhost:16043",
  CHART = process.env.RANGE_CHART || "https://localhost:16044";
const OUT =
  process.env.RANGE_OUTPUT || "/tmp/mw-range-mapping-acceptance/matrix.json";
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

    const periods = ["1", "5", "15", "30", "60", "240", "1D", "1W", "1M"];
    await host.evaluate(() => widget.setLayout("8"));
    await settle();
    for (const source of periods) {
      const others = periods.filter((r) => r !== source);
      for (let batch = 0; batch < 2; batch++) {
        const targets =
          batch === 0 ? others.slice(0, 7) : [others[7], ...others.slice(0, 6)];
        await page.mouse.move(10, 10);
        await host.evaluate(
          async ({ source, targets }) => {
            await widget
              .chart(0)
              .setResolution(source, { doNotActivateChart: true });
            for (let i = 1; i < 8; i++)
              await widget
                .chart(i)
                .setResolution(targets[i - 1], { doNotActivateChart: true });
          },
          { source, targets },
        );
        await settle();
        // Continuous history retains old corridors when changing periods.
        // This matrix compares eligible periods over their shared latest tail.
        await host.evaluate(() => {
          for(let i=0;i<widget.chartsCount();i++)
            widget.chart(i).getTimeScale().setRightOffset(10);
        });
        await settle();
        await host.waitForFunction(
          () =>
            MWNativeReserve.diagnostics().flights === 0 &&
            MWNativeReserve.diagnostics().threads.every((t) => !t.requesting),
          null,
          { timeout: 30000 },
        );
        await page.waitForTimeout(500);
        await host.evaluate(() => (__rangePaints.length = 0));
        const before = await state(),
          requests = fixture.history;
        await hoverLast(0);
        const result = await state();
        report.lastResult = {source,targets,result};
        assert.equal(result.mapper.source?.resolution, source);
        const eligible = (target) =>
          periods.indexOf(target) < periods.indexOf(source) &&
          !(source === "1M" && target === "1W");
        for (const [index,target] of targets.entries()) {
          const visible = result.charts[index+1].range, selected = result.mapper.source;
          // A just-opened trading day/week may not yet have its coarse source
          // bar. Eligible peers outside that real interval must remain empty.
          const intersects = visible.from*1000 < selected.end && visible.to*1000 > selected.start;
          assert.equal(
            result.paints.some((v) => v.resolution === target),
            eligible(target) && intersects,
            source + " → " + target,
          );
        }
        report.cases.push({
          source,
          targets,
          selected: result.mapper.source,
          painted: result.paints.map((p) => ({
            id: p.id,
            resolution: p.resolution,
            rect: p.rect,
          })),
          historyBefore: requests,
          historyAfter: fixture.history,
        });
        assert.deepEqual(result.charts, before.charts);
        assert.equal(fixture.history, requests);
      }
    }
    // Explicit positive overlap for D1 -> M1/M5. At a new session's open,
    // latest-tail matrix can correctly be outside the last delivered D1 bar.
    await page.mouse.move(10,10);
    await host.evaluate(() => widget.setLayout('4'));
    await settle();
    await host.evaluate(async () => {
      for(const [i,r] of [[0,'1D'],[1,'1'],[2,'5'],[3,'1W']])
        await widget.chart(i).setResolution(r,{doNotActivateChart:true});
    });
    await fixture.idle();
    await host.evaluate(async () => {
      const t=Date.parse('2026-09-28')/1000;
      for(let i=0;i<3;i++) await widget.chart(i).setVisibleRange({from:t-86400,to:t+3*86400},{rejectByTimeout:120000});
    });
    await fixture.idle();
    await host.evaluate(() => __rangePaints.length=0);
    await hoverLast(0);
    const overlap = await state();
    assert.equal(overlap.mapper.source?.resolution,'1D');
    for(const r of ['1','5'])
      assert.ok(overlap.paints.some(p=>p.resolution===r),'real shared history must paint D1 -> '+r);
    report.cases.push({phase:'D1-M1-M5-shared-history-positive',state:overlap});
    await page.mouse.move(10, 10);
    await host.evaluate(async () => {
      await widget.chart(0).setResolution("1M", { doNotActivateChart: true });
      await widget
        .chart(1)
        .setSymbol("MWP:XAUUSD", { doNotActivateChart: true });
      __rangePaints.length = 0;
    });
    await settle();
    await hoverLast(0);
    const mismatch = await state();
    assert.ok(!mismatch.paints.some((p) => p.id === undefined));
    const wrongId = await host.evaluate(() =>
      widget.chart(1)._chartWidget.model().model().id(),
    );
    assert.ok(!mismatch.paints.some((p) => p.id === wrongId));
    report.cases.push({ phase: "different-symbol", wrongId, state: mismatch });
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
