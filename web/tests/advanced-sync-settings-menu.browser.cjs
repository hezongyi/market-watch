// Compare cloned switches against the installed native skin in both themes.
const { chromium } = require("@playwright/test");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const APP = process.env.RANGE_APP || "https://192.168.7.232:16243";
const CHART = process.env.RANGE_CHART || "https://192.168.7.232:16244";
const OUT =
  process.env.RANGE_OUTPUT || "/tmp/mw-sync-settings-implementation/menu.json";
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
    for (const theme of ["Dark", "Light"]) {
      await host.evaluate((theme) => widget.changeTheme(theme), theme);
      await host.evaluate(()=>MWSyncCoordinator.configure({date:false,barWidth:false}));
      await native
        .getByRole("button", { name: "布局设置", exact: true })
        .click();
      const alignment = await native.locator('[data-name="mw-sync-settings"]').evaluate(el => {
        const label = document.querySelector('input[value="syncCrosshairLabel"]').closest('[data-role="menuitem"]').querySelector('[role="rowheader"]');
        const rect = el.getBoundingClientRect();
        return {text:el.textContent,textAlign:getComputedStyle(el).textAlign,justify:getComputedStyle(el).justifyContent,textX:rect.x+parseFloat(getComputedStyle(el).paddingLeft),nativeX:label.getBoundingClientRect().x,
          color:getComputedStyle(el).color,nativeColor:getComputedStyle(label).color};
      });
      assert.equal(alignment.text,'同步设置');assert.equal(alignment.textAlign,'left');assert.equal(alignment.justify,'flex-start');
      assert.ok(Math.abs(alignment.textX-alignment.nativeX)<1,'settings text aligns with native menu text');
      assert.equal(alignment.color,alignment.nativeColor);
      for (const name of ['mw-bar-range-mapping','mw-bar-width-sync']) {
        const help = native.locator(`[data-name="${name}-help"]`);
        const state = () => host.evaluate(() => [MWBarRangeMapping.snapshot().enabled,MWSyncCoordinator.snapshot().barWidth]);
        const before = await state(), purpose = await help.getAttribute('aria-label');
        await help.hover();
        await native.locator('[class*="common-tooltip__body"]').filter({hasText:purpose}).waitFor({state:'visible'});
        await native.waitForFunction(()=>{const t=document.querySelector('#common-tooltip-wrapper');return t&&getComputedStyle(t).opacity==='1'});
        await help.click();await help.press('Enter');await help.press('Space');
        assert.deepEqual(await state(),before,'help must not toggle synchronization');
        await page.mouse.move(10,10);
        await native.locator(`[data-name="${name}"]`).focus();
        await page.keyboard.press('Tab');
        assert.equal(await help.evaluate(el=>el.ownerDocument.activeElement===el),true);
        await native.locator('[class*="common-tooltip__body"]').filter({hasText:purpose}).waitFor({state:'visible'});
        await native.waitForFunction(()=>{const t=document.querySelector('#common-tooltip-wrapper');return t&&getComputedStyle(t).opacity==='1'});
        await page.keyboard.press('Tab');
        assert.equal(await help.evaluate(el=>el.ownerDocument.activeElement===el),false);
        // Native tooltips hide with opacity; Playwright's "visible" ignores it.
        await native.waitForFunction(()=>{const t=document.querySelector('#common-tooltip-wrapper');return !t||getComputedStyle(t).opacity==='0'});
        assert.deepEqual(await state(),before);
      }
      report.cases.push({name:theme+' native alignment color and isolated hover/keyboard help',alignment});
      for (const enabled of [false, true]) {
        await host.evaluate((enabled) => {
          widget.crosshairSync().setValue(true);
          MWSyncCoordinator.configure({
            date: false,
            time: enabled,
            barWidth: enabled,
          });
          MWBarRangeMapping.configure({ enabled });
        }, enabled);
        // Native and cloned switches can start their CSS transition at different
        // points in the React commit; compare their settled visual positions.
        await page.waitForTimeout(350);
        const snapshot = await native
          .locator('input[value="syncTrackLabel"]')
          .evaluate((input) => {
            const skin = (row) => {
              const el = row.querySelector('[class*="switchView-"]');
              const rect = el.getBoundingClientRect(),
                style = getComputedStyle(el);
              const children = [...el.querySelectorAll("*")].map((e) => {
                const r = e.getBoundingClientRect(),
                  s = getComputedStyle(e);
                return {
                  tag: e.tagName,
                  class: e.className,
                  width: r.width,
                  height: r.height,
                  x: r.x - rect.x,
                  y: r.y - rect.y,
                  background: s.backgroundColor,
                  transform: s.transform,
                  borderRadius: s.borderRadius,
                };
              });
              return {
                width: rect.width,
                height: rect.height,
                background: style.backgroundColor,
                children,
              };
            };
            return {
              native: skin(input.closest('[data-role="menuitem"]')),
              range: skin(
                document.querySelector('[data-name="mw-bar-range-mapping"]'),
              ),
              barWidth: skin(
                document.querySelector('[data-name="mw-bar-width-sync"]'),
              ),
              checked: input.checked,
              settingsLast: document.querySelector(
                '[data-name="mw-sync-settings"]',
              ).parentElement.lastElementChild.dataset.name,
            };
          });
        assert.equal(snapshot.checked, enabled);
        assert.deepEqual(snapshot.range, snapshot.native);
        assert.deepEqual(snapshot.barWidth, snapshot.native);
        assert.equal(snapshot.settingsLast, "mw-sync-settings");
        report.cases.push({
          name: theme + " native skin " + (enabled ? "checked" : "unchecked"),
          snapshot,
        });
        await page.screenshot({
          path: OUT.replace(".json", "-" + theme + "-" + enabled + ".png"),
        });
      }
      await host.evaluate(() =>
        MWSyncCoordinator.configure({
          date: true,
          time: true,
          barWidth: false,
        }),
      );
      assert.equal(
        await native
          .locator('[data-name="mw-bar-width-sync"]')
          .getAttribute("aria-disabled"),
        "true",
      );
      await native.locator('[data-name="mw-bar-width-sync"]').press("Space");
      assert.equal(
        await host.evaluate(() => MWSyncCoordinator.snapshot().barWidth),
        false,
      );
      report.cases.push({
        name: theme + " disabled bar width cannot be activated by Space",
      });
      await native
        .getByRole("button", { name: "布局设置", exact: true })
        .click();
    }
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
