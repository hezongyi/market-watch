const { chromium } = require("@playwright/test"),
  fs = require("node:fs"),
  assert = require("node:assert/strict");
const APP = process.env.RANGE_APP || "https://192.168.7.232:16243",
  CHART = process.env.RANGE_CHART || "https://192.168.7.232:16244",
  OUT =
    process.env.RANGE_OUTPUT ||
    "/tmp/mw-sync-settings-implementation/choices.json";
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
    const { host, native, page } = f;
    const state = () =>
      host.evaluate(() => ({
        logic: MWSyncCoordinator.snapshot(),
        date: widget.dateRangeSync().value(),
        time: widget.timeSync().value(),
        undo: widget._innerAPI().undoRedoState(),
        dirty,
        nativeDirty: widget._innerAPI().hasChartChanges().value(),
      }));
    for (const [key, selector] of [
      ["date", "syncDateRangeLabel"],
      ["time", "syncTrackLabel"],
    ]) {
      await host.evaluate(() =>
        MWSyncCoordinator.configure(
          { date: false, time: false, barWidth: false },
          true,
        ),
      );
      await f.settle();
      await native
        .getByRole("button", { name: "布局设置", exact: true })
        .click();
      const row = native
        .locator(`input[value="${selector}"]`)
        .locator('xpath=ancestor::*[@data-role="menuitem"]');
      await row.click();
      await f.settle();
      let s = await state();
      assert.equal(s.logic[key], true);
      assert.equal(s[key], true);
      const enabled = s;
      await host.evaluate(
        (key) =>
          (globalThis.__choicePause = MWSyncCoordinator.acquirePause(
            "acceptance-menu",
            [key],
          )),
        key,
      );
      assert.equal(
        await native.locator(`input[value="${selector}"]`).isChecked(),
        true,
      );
      s = await state();
      assert.equal(s[key], false);
      assert.deepEqual(s.undo, enabled.undo);
      await row.click();
      s = await state();
      assert.equal(s.logic[key], false);
      assert.equal(s[key], false);
      await host.evaluate(() => widget._innerAPI().undo());
      s = await state();
      assert.equal(s.logic[key], true);
      assert.equal(s[key], false);
      await host.evaluate(() => widget._innerAPI().redo());
      s = await state();
      assert.equal(s.logic[key], false);
      assert.equal(s[key], false);
      await row.focus();
      await page.keyboard.press("Enter");
      s = await state();
      assert.equal(s.logic[key], true);
      assert.equal(s[key], false);
      await host.evaluate(() => __choicePause.release());
      await f.settle();
      s = await state();
      assert.equal(s.logic[key], true);
      assert.equal(s[key], true);
      await native
        .getByRole("button", { name: "布局设置", exact: true })
        .click();
      const pause = await host.evaluate((key) => {
        globalThis.__choicePause = MWSyncCoordinator.acquirePause(
          "acceptance-undo",
          [key],
        );
        return MWSyncCoordinator.snapshot();
      }, key);
      assert.equal(pause[key], true);
      // Real native Undo/Redo affects logical selection while execution stays paused.
      await host.evaluate(() => widget._innerAPI().undo());
      s = await state();
      assert.equal(s.logic[key], false);
      assert.equal(s[key], false);
      await host.evaluate(() => widget._innerAPI().redo());
      s = await state();
      assert.equal(s.logic[key], true);
      assert.equal(s[key], false);
      await host.evaluate(() => __choicePause.release());
      await f.settle();
      s = await state();
      assert.equal(s[key], true);
      report.cases.push({
        name: key + " actual menu click/Enter and paused native Undo/Redo",
        enabled,
        final: s,
      });
    }
    // A native time Undo must preserve a later independent bar-width choice.
    await host.evaluate(() =>
      MWSyncCoordinator.configure(
        { date: false, time: false, barWidth: false },
        true,
      ),
    );
    await native.getByRole("button", { name: "布局设置", exact: true }).click();
    await native
      .locator('input[value="syncTrackLabel"]')
      .locator('xpath=ancestor::*[@data-role="menuitem"]')
      .click();
    await native.locator('[data-name="mw-bar-width-sync"]').click();
    await host.evaluate(() => widget._innerAPI().undo());
    let mixed = await state();
    assert.equal(mixed.logic.time, false);
    assert.equal(mixed.logic.barWidth, true);
    await host.evaluate(() => widget._innerAPI().redo());
    mixed = await state();
    assert.equal(mixed.logic.time, true);
    assert.equal(mixed.logic.barWidth, true);
    await native.getByRole("button", { name: "布局设置", exact: true }).click();
    report.cases.push({
      name: "time Undo/Redo preserves independent bar width mode",
      mixed,
    });
    await host.evaluate(() =>
      MWSyncCoordinator.configure(
        { date: false, time: true, barWidth: true },
        true,
      ),
    );
    await native.getByRole("button", { name: "布局设置", exact: true }).click();
    assert.equal(
      await native.locator('input[value="syncDateRangeLabel"]').isDisabled(),
      true,
    );
    assert.equal(
      await native.locator('input[value="syncTrackLabel"]').isDisabled(),
      false,
    );
    report.cases.push({
      name: "date/bar width mutual exclusion leaves time enabled",
    });
    assert.deepEqual(report.errors, []);
    await f.ctx.close();
  } catch (e) {
    report.failure = e.stack;
    process.exitCode = 1;
  } finally {
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
