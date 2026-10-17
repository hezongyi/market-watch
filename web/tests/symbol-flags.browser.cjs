// The fixed-version adapter must survive native virtual-row reuse/disposal.
const { chromium, expect } = require("@playwright/test");
const assert = require("node:assert/strict"),
  fs = require("node:fs");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setContent(
    '<div data-symbol-full="MWP:EURUSD"><span class="symbolName-v31">EURUSD</span></div>',
  );
  await page.addScriptTag({
    content:
      fs.readFileSync("../advanced-host/series.js", "utf8") +
      "\n" +
      fs.readFileSync("../advanced-host/symbol-flags.js", "utf8"),
  });
  await page.evaluate(() => {
    globalThis.TradingView = {
      version: () => "TT v31.1.0 6b804c486857f27920cf761aa7eb6e29d9bb6362",
    };
    const widget = {
      createButton: () =>
        document.body.appendChild(document.createElement("button")),
      removeButton: (b) => b.remove(),
    };
    globalThis.adapter = MWSymbolFlags.attach(
      widget,
      {
        content: {
          value: {
            version: 1,
            flags: { "MWP:EURUSD": "red", "MWP:XAUUSD": "blue" },
          },
        },
      },
      false,
      () => new Promise((resolve, reject) => (globalThis.rejectSave = reject)),
      () => {},
    );
  });
  const button = page.locator(".mw-symbol-flag");
  await expect(button).toHaveAttribute("title", "红色收藏");
  await page.evaluate(
    () =>
      (document.querySelector("[data-symbol-full]").dataset.symbolFull =
        "MWP:XAUUSD"),
  );
  await expect(button).toHaveAttribute("title", "蓝色收藏");
  await expect(button).toHaveCount(1);
  await button.click();
  await expect(
    page.getByRole("radio", { name: "蓝色", exact: true }),
  ).toBeFocused();
  await page.getByRole("radio", { name: "蓝色", exact: true }).press("End");
  await expect(
    page.getByRole("button", { name: "关闭", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "关闭", exact: true }).press("Escape");
  await expect(button).toBeFocused();
  await button.click();
  await page.getByRole("radio", { name: "绿色", exact: true }).click();
  await page.evaluate(() => {
    adapter.dispose();
    rejectSave(Error("late network rejection"));
  });
  await page.waitForTimeout(100);
  assert.deepEqual(errors, []);
  await expect(button).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await browser.close();
  console.log(
    "flag virtual-row identity, keyboard and pending-disposal regression passed",
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
