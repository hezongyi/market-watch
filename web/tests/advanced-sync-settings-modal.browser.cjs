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
    const focus = () => dialog.evaluate(el => el.contains(el.ownerDocument.activeElement));
    for (const key of ['Tab','Shift+Tab']) {
      for(let i=0;i<20;i++){await page.keyboard.press(key);assert.ok(await focus(),'focus remains in native modal');}
    }
    const combo = dialog.getByRole('combobox',{name:'显示方式'});
    await combo.focus();await page.keyboard.press('Enter');
    await native.getByRole('listbox',{name:'显示方式'}).waitFor({state:'visible'});
    await page.keyboard.press('Tab');
    await native.getByRole('listbox',{name:'显示方式'}).waitFor({state:'hidden'});
    assert.ok(await focus());
    // Exercise actual option clicks: the hidden select alone cannot detect
    // native NoticeDialog outside-click dismissal of a body portal.
    for(const name of ['淡色背景','高低价矩形']) {
      await combo.click();await native.getByRole('option',{name,exact:true}).click();
      assert.ok(await dialog.isVisible(),'choosing a style keeps the native modal open');
      assert.equal(await dialog.locator('[name="style"]').inputValue(),name==='高低价矩形'?'rectangle':'background');
    }
    const box = await dialog.locator('.box-vgla_e5o').boundingBox();
    assert.ok(box.width===18&&box.height===18,'native checkbox has its full square skin');
    const mark=await dialog.locator('.checkedMark-vgla_e5o svg').boundingBox();
    assert.ok(mark.x>=box.x&&mark.x+mark.width<=box.x+box.width&&mark.y>=box.y&&mark.y+mark.height<=box.y+box.height,'entire native check mark is inside its box');
    await page.screenshot({path:OUT.replace('.json','-native.png')});
    report.cases.push({name:'native checkbox and modal/dropdown keyboard focus',box});
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
