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
  try {
    const page = await browser.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // Like the application, this fixture needs a trustworthy origin for
    // crypto.randomUUID(). An about:blank setContent page has no secure context.
    const fixtureURL = "http://localhost/symbol-flags-test";
    await page.route(fixtureURL, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<div data-symbol-full="MWP:EURUSD"><span class="symbolName-v31">EURUSD</span></div><div data-symbol-full="MWP:GBPUSD"><span class="symbolName-v31">GBPUSD</span></div>',
      }),
    );
    await page.goto(fixtureURL);
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
        () =>
          new Promise((resolve, reject) => (globalThis.rejectSave = reject)),
        () => {},
      );
    });
    const button = page.locator(".mw-symbol-flag").first();
    const emptyButton = page.locator(
      '.mw-symbol-flag[data-ticker="MWP:GBPUSD"]',
    );
    await expect(button).toHaveAttribute("title", "红色收藏");
    await page.locator('[data-symbol-full="MWP:GBPUSD"]').hover();
    await expect(emptyButton).toHaveCSS("opacity", "1");
    assert.equal(
      await emptyButton.evaluate((n) => getComputedStyle(n).color),
      "rgb(120, 123, 134)",
    );
    await page.mouse.move(300, 300);
    await expect(button).toHaveCSS("opacity", "1");
    await expect(emptyButton).toHaveCSS("opacity", "0");
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
    await page
      .getByRole("button", { name: "关闭", exact: true })
      .press("Escape");
    await expect(button).toBeFocused();
    await button.click();
    await page.getByRole("radio", { name: "绿色", exact: true }).click();
    await page.waitForFunction(
      () => typeof globalThis.rejectSave === "function",
    );
    await page.evaluate(() => {
      adapter.dispose();
      rejectSave(Error("late network rejection"));
    });
    await page.waitForTimeout(100);
    assert.deepEqual(errors, []);
    await expect(button).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    console.log(
      "flag virtual-row identity, keyboard and pending-disposal regression passed",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
