// Tab to real modal buttons and activate them through the browser keyboard.
const { chromium } = require("@playwright/test");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const APP = process.env.RANGE_APP || "https://192.168.7.232:16243";
const CHART = process.env.RANGE_CHART || "https://192.168.7.232:16244";
const OUT =
  process.env.RANGE_OUTPUT || "/tmp/mw-sync-settings-implementation/modal.json";
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
    const { native, page, host } = f;
    const saved = await host.evaluate(() => {
      MWBarRangeMapping.configure({
        style: "rectangle",
        colorMode: "custom",
        color: "#123456",
        transparencyMode: "custom",
        transparency: 40,
      });
      return MWBarRangeMapping.snapshot();
    });
    const open = async () => {
      await native
        .getByRole("button", { name: "布局设置", exact: true })
        .click();
      await native.locator('[data-name="mw-sync-settings"]').click();
      return native.locator('[data-name="mw-sync-settings-dialog"]');
    };
    const tabTo = async (action) => {
      for (let i = 0; i < 25; i++) {
        if (
          await native
            .locator(`[data-action="${action}"]`)
            .evaluate((e) => e.ownerDocument.activeElement === e)
        )
          return;
        await page.keyboard.press("Tab");
      }
      assert.fail("Tab could not reach " + action);
    };
    for (const action of ["cancel", "close"]) {
      const dialog = await open();
      await dialog.locator('[name="transparency"]').fill("60");
      await tabTo(action);
      await page.keyboard.press("Enter");
      await dialog.waitFor({ state: "hidden" });
      assert.deepEqual(
        await host.evaluate(() => MWBarRangeMapping.snapshot()),
        saved,
      );
      report.cases.push({
        name: "Tab then Enter on " + action + " discards draft",
      });
    }
    let dialog = await open();
    await tabTo("defaults");
    await page.keyboard.press("Enter");
    assert.equal(await dialog.isVisible(), true);
    assert.equal(
      await dialog.locator('[name="style"]').inputValue(),
      "background",
    );
    assert.deepEqual(
      await host.evaluate(() => MWBarRangeMapping.snapshot()),
      saved,
    );
    await tabTo("cancel");
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(
      await host.evaluate(() => MWBarRangeMapping.snapshot()),
      saved,
    );
    report.cases.push({
      name: "Tab then Enter on defaults resets only draft; cancel preserves config",
    });
    dialog = await open();
    await dialog.locator('[name="transparency"]').fill("60");
    await tabTo("confirm");
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(
      await host.evaluate(() => MWBarRangeMapping.snapshot().transparency),
      60,
    );
    report.cases.push({ name: "Tab then Enter on confirm commits draft" });
    dialog = await open();
    await dialog.locator('[name="transparency"]').fill("80");
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(
      await host.evaluate(() => MWBarRangeMapping.snapshot().transparency),
      80,
    );
    report.cases.push({ name: "Enter in numeric input confirms draft" });
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
