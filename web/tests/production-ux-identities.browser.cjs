const { chromium, expect } = require("@playwright/test");
const fs = require("node:fs"),
  assert = require("node:assert/strict");
const { base, out, password } = require("./production-ux-env.cjs");
(async () => {
  const b = await chromium.launch({
    executablePath:
      "/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
    args: ["--no-sandbox"],
  });
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } }),
    checks = [];
  try {
    await p.goto(base);
    await p.getByLabel("管理员密码").fill(password);
    await p.getByRole("button", { name: "登录工作台" }).click();
    await expect(p.getByLabel("管理员密码")).toHaveCount(0);
    const instruments = await (
      await p.request.get(base + "/api/instruments")
    ).json();
    for (const symbol of ["XAUUSD", "EURUSD"]) {
      const managed = p
        .locator(".market-card")
        .filter({ hasText: "OANDA" })
        .filter({ hasText: symbol });
      await expect(managed).toHaveCount(1);
      await expect(managed.locator("strong")).toHaveText(symbol);
      await expect(managed.locator(".instrument-icon")).toHaveText(
        symbol === "XAUUSD" ? "Au" : "€",
      );
      const ordinary = p
        .locator(".market-card")
        .filter({ hasText: "Dukascopy" })
        .filter({ hasText: symbol });
      await expect(ordinary).toHaveCount(1);
      await expect(ordinary.locator("strong")).toHaveText(symbol);
      await expect(ordinary).toContainText("环境未核实");
    }
    await p.screenshot({
      path: out + "/home-identities-desktop.png",
      fullPage: true,
    });
    const card = p
      .locator(".market-card")
      .filter({ hasText: "OANDA" })
      .filter({ hasText: "EURUSD" });
    await card.click();
    await p.getByRole("button", { name: "M5", exact: true }).click();
    const triggers = [
      p.getByRole("button", { name: "新建预警", exact: true }),
      p.getByRole("button", { name: "创建第一条预警", exact: true }),
    ];
    for (const [width, height] of [
      [375, 812],
      [390, 844],
      [844, 390],
      [1440, 1000],
    ]) {
      await p.setViewportSize({ width, height });
      assert(
        await p.evaluate(
          () => document.documentElement.scrollWidth <= visualViewport.width,
        ),
      );
      for (let ti = 0; ti < triggers.length; ti++) {
        const trigger = triggers[ti];
        await expect(trigger).toHaveCount(1);
        for (const open of ["click", "Enter", "Space"])
          for (const close of ["Escape", "取消", "关闭"]) {
            await trigger.scrollIntoViewIfNeeded();
            await trigger.focus();
            if (open === "click") await trigger.click();
            else await p.keyboard.press(open);
            const d = p.getByRole("dialog", { name: "设置一条预警" });
            await expect(d).toBeVisible();
            await expect(
              d.getByRole("combobox", { name: "确认周期", exact: true }),
            ).toHaveValue("M5");
            await expect(d).toContainText("当前看盘：");
            await expect(
              d.getByRole("button", { name: "开启监控", exact: true }),
            ).toBeDisabled();
            if (close === "Escape") await p.keyboard.press("Escape");
            else
              await d.getByRole("button", { name: close, exact: true }).click();
            await expect(trigger).toBeFocused();
          }
      }
      await p.evaluate(() => window.scrollTo(0, 0));
      await p.screenshot({
        path: out + "/home-identities-" + width + ".png",
        fullPage: true,
      });
      checks.push(
        width +
          ": actual ordinary/registered identities, long ID boundaries, selected M5 context, explicit composite selection required, click/Enter/Space × Esc/cancel/close focus on both available triggers",
      );
    }
    const compositeResponse = await (
      await p.request.get(
        base + "/api/market-data/series/search?kind=composite&query=EURUSD",
      )
    ).json();
    assert(compositeResponse.length > 0);
    const chosen = compositeResponse.find((r) => r.created);
    assert(chosen);
    await p.setViewportSize({ width: 1440, height: 1000 });
    await triggers[0].click();
    const d = p.getByRole("dialog", { name: "设置一条预警" });
    const picker = d.getByRole("combobox", { name: "品种", exact: true });
    await expect(
      picker.locator('option[value="' + chosen.id + '"]'),
    ).toBeAttached();
    await picker.selectOption(chosen.id);
    await expect(d).toContainText("OANDA → OANDA Practice");
    await expect(d).toContainText("NY17");
    await d
      .getByRole("combobox", { name: "策略", exact: true })
      .selectOption("price");
    await d.getByLabel("目标价格", { exact: true }).fill("999999");
    await p.screenshot({
      path: out + "/composite-watch-explicit-identity.png",
    });
    await d.getByRole("button", { name: "取消", exact: true }).click();
    await expect(triggers[0]).toBeFocused();
    checks.push(
      "Actual persisted composite mapping: readable source/Bid/NY17, explicit series choice, no same-symbol automatic binding",
    );
    fs.writeFileSync(
      out + "/identity-results.json",
      JSON.stringify(
        {
          checks,
          instruments: instruments.map((i) => ({
            id: i.id,
            logical_symbol: i.logical_symbol,
            source: i.source,
          })),
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ checks }));
  } catch (e) {
    await p.screenshot({
      path: out + "/identities-failed.png",
      fullPage: true,
    });
    throw e;
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
