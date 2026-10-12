// Only the task-owned Ubuntu fixture; no production sessions or notifications.
const { chromium, expect } = require("@playwright/test");
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const base = "http://127.0.0.1:19971",
  chartOrigin = "http://127.0.0.1:19972";
const out = path.resolve(__dirname, "../../artifacts/production-ux-real");
fs.mkdirSync(out, { recursive: true });
const password = fs.readFileSync(
  "/tmp/mw-production-ux-20261012-private/password",
  "utf8",
);
const checks = [],
  measurements = [],
  runSuffix = Date.now();
async function bounds(page, locator) {
  const result = await locator.evaluate((e) => {
    const b = e.getBoundingClientRect(),
      v = visualViewport;
    return {
      box: { x: b.x, y: b.y, width: b.width, height: b.height },
      viewport: {
        x: v.offsetLeft,
        y: v.offsetTop,
        width: v.width,
        height: v.height,
      },
      layoutWidth: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  const { box: b, viewport: v } = result;
  assert(
    b.x >= v.x - 1 &&
      b.y >= v.y - 1 &&
      b.x + b.width <= v.x + v.width + 1 &&
      b.y + b.height <= v.y + v.height + 1,
    JSON.stringify(result),
  );
  assert(
    result.layoutWidth <= v.width + 1 && result.scrollWidth <= v.width + 1,
  );
  measurements.push(result);
}
(async () => {
  const browser = await chromium.launch({
    executablePath:
      "/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
    args: ["--no-sandbox"],
  });
  try {
    for (const [width, height] of [
      [375, 812],
      [390, 844],
      [844, 390],
    ]) {
      const context = await browser.newContext({
          viewport: { width, height },
          isMobile: true,
          hasTouch: true,
        }),
        page = await context.newPage();
      await page.goto(base);
      await page.getByLabel("管理员密码").fill(password);
      await page.getByRole("button", { name: "登录工作台" }).click();
      await expect(page.getByLabel("管理员密码")).toHaveCount(0);
      const response = await page.request.get(base + "/api/instruments"),
        instruments = await response.json();
      const inst = instruments.find((i) => i.logical_symbol === "XAUUSD");
      assert(inst && inst.id.startsWith("MD:"));
      const card = page
        .locator(".market-card")
        .filter({ hasText: "OANDA" })
        .filter({ hasText: "XAUUSD" });
      await expect(card).toHaveCount(1);
      await expect(card.locator("strong")).toHaveText("XAUUSD");
      await expect(card.locator(".instrument-icon")).toHaveText("Au");
      await card.tap();
      const trigger = page.getByRole("button", {
        name: "新建预警",
        exact: true,
      });
      await trigger.tap();
      const dialog = page.getByRole("dialog", { name: "设置一条预警" });
      await bounds(page, dialog);
      await bounds(
        page,
        dialog.getByRole("button", { name: "关闭", exact: true }),
      );
      await dialog
        .getByRole("combobox", { name: "行情输入", exact: true })
        .selectOption("legacy");
      await dialog
        .getByRole("combobox", { name: "策略", exact: true })
        .selectOption("price");
      await dialog
        .getByLabel("预警名称", { exact: true })
        .fill("Ubuntu UX " + width + " " + runSuffix);
      await dialog.getByLabel("目标价格", { exact: true }).fill("999999");
      await dialog.evaluate((e) => (e.scrollTop = e.scrollHeight));
      await bounds(
        page,
        dialog.getByRole("button", { name: "取消", exact: true }),
      );
      await bounds(
        page,
        dialog.getByRole("button", { name: "开启监控", exact: true }),
      );
      await page.screenshot({
        path: path.join(out, "watch-" + width + ".png"),
      });
      await dialog.getByRole("button", { name: "取消", exact: true }).tap();
      await expect(trigger).toBeFocused();
      const before = await (
        await page.request.get(base + "/api/watches")
      ).json();
      assert(
        !before.some((w) => w.name === "Ubuntu UX " + width + " " + runSuffix),
      );
      await trigger.tap();
      await dialog
        .getByRole("combobox", { name: "行情输入", exact: true })
        .selectOption("legacy");
      await dialog
        .getByRole("combobox", { name: "策略", exact: true })
        .selectOption("price");
      await dialog
        .getByLabel("预警名称", { exact: true })
        .fill("Ubuntu UX " + width + " " + runSuffix);
      await dialog.getByLabel("目标价格", { exact: true }).fill("999999");
      const saved = page.waitForResponse(
        (r) =>
          r.url() === base + "/api/watches" && r.request().method() === "POST",
      );
      await dialog.getByRole("button", { name: "开启监控", exact: true }).tap();
      assert.equal((await saved).status(), 201);
      await expect(dialog).not.toBeVisible();
      await expect(trigger).toBeFocused();
      await page.reload();
      await expect(
        page.getByText("Ubuntu UX " + width + " " + runSuffix, { exact: true }),
      ).toBeVisible();
      const rows = await (await page.request.get(base + "/api/watches")).json(),
        row = rows.find(
          (w) => w.name === "Ubuntu UX " + width + " " + runSuffix,
        );
      assert.equal(row.instrument_id, inst.id);
      const { csrf } = await (
        await page.request.get(base + "/api/session")
      ).json();
      assert(
        (
          await page.request.post(base + "/api/watches/" + row.id + "/cancel", {
            headers: { "X-CSRF-Token": csrf },
          })
        ).ok(),
      );
      checks.push(
        width +
          ": visual viewport, touch cancel, POST201, reload persistence and unchanged dataset binding",
      );
      await context.close();
    }
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    await page.goto(base);
    await page.getByLabel("管理员密码").fill(password);
    await page.getByRole("button", { name: "登录工作台" }).click();
    await expect(page.getByLabel("管理员密码")).toHaveCount(0);
    const health = await (await page.request.get(base + "/api/health")).json();
    assert(health.history_services.every((s) => s.status === "running"));
    assert.equal(health.legacy_import.status, "disabled");
    await page.getByRole("link", { name: "提醒与设置" }).click();
    await expect(page.getByLabel("历史服务运行状态")).toContainText(
      "自建历史发布",
    );
    await expect(page.getByLabel("历史服务运行状态")).toContainText(
      "平台图表加载",
    );
    await expect(
      page.getByText("未启用；不代表现行历史服务状态", { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: path.join(out, "health-running.png") });
    checks.push(
      "Actual current workers report independent fresh business heartbeat; legacy disabled shown separately",
    );
    fs.writeFileSync(
      path.join(out, "results.json"),
      JSON.stringify(
        {
          checks,
          measurements,
          health: health.history_services.map((s) => ({
            id: s.id,
            status: s.status,
          })),
        },
        null,
        2,
      ) + "\n",
    );
    console.log(JSON.stringify({ checks }, null, 2));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
