// Task-owned Ubuntu Docker only; see docs/production-ux-fixes-20261012.md.
const { chromium, expect } = require("@playwright/test");
const fs = require("fs"),
  assert = require("assert/strict"),
  crypto = require("crypto");
const root = require("node:path").resolve(__dirname, "../.."),
  base = "http://127.0.0.1:19971",
  origin = "http://127.0.0.1:19972",
  out = root + "/artifacts/production-ux-real";
const id = (s) =>
  "DUKA:" + crypto.createHash("sha256").update(s).digest("hex").slice(0, 32);
(async () => {
  const b = await chromium.launch({
    executablePath:
      "/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
    args: ["--no-sandbox"],
  });
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } }),
    errors = [],
    checks = [];
  try {
    await p.goto(base + "/advanced-charts");
    await p
      .getByLabel("管理员密码")
      .fill(
        fs.readFileSync(
          "/tmp/mw-production-ux-20261012-private/password",
          "utf8",
        ),
      );
    await p.getByRole("button", { name: "登录工作台" }).click();
    await expect(p.getByLabel("管理员密码")).toHaveCount(0);
    await expect
      .poll(() => p.frames().some((f) => f.url().startsWith(origin + "/?")), {
        timeout: 30000,
      })
      .toBe(true);
    const h = p.frames().find((f) => f.url().startsWith(origin + "/?"));
    await h.waitForFunction(
      () => ready && widget.activeChart().dataReady(),
      null,
      { timeout: 45000 },
    );
    const n = p.frames().find((f) => f.url().startsWith("blob:"));
    p.on("pageerror", (e) => errors.push(e.message));
    const studyIds = await h.evaluate(async () => {
      const c = widget.activeChart();
      for (const s of c.getAllStudies()) c.removeEntity(s.id);
      const native = await c.createStudy("MACD", false, false, {
        in_0: 17,
        in_1: 31,
        in_2: 7,
      });
      const python = await c.createStudy("守望 Python MACD", false, false, {
        fast: 19,
        slow: 35,
        signal: 11,
      });
      return { native, python };
    });
    await n.getByRole("button", { name: "指标", exact: true }).click();
    const dialog = n.locator('[data-name="indicators-dialog"]');
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole("button", { name: "当前图表已添加", exact: true })
      .click();
    const nativeRow = dialog.locator(
        '[data-instance-id="' + studyIds.native + '"]',
      ),
      pyRow = dialog.locator('[data-instance-id="' + studyIds.python + '"]');
    const definitions = await h.evaluate(() => widget.getStudyInputs("MACD"));
    for (const [key, value] of [
      ["in_0", 17],
      ["in_1", 31],
      ["in_2", 7],
    ]) {
      const d = definitions.find((v) => v.id === key);
      await expect(nativeRow).toContainText(
        (d.localizedName || d.name) + " " + value,
      );
    }
    await expect(nativeRow).not.toContainText("in_0=");
    await expect(pyRow).toContainText("快线周期 19");
    await expect(pyRow).toContainText("慢线周期 35");
    await expect(pyRow).toContainText("信号周期 11");
    await p.screenshot({ path: out + "/native-indicator-actual-values.png" });
    await dialog
      .getByRole("button", { name: "关闭指标窗口", exact: true })
      .click();
    checks.push(
      "Actual licensed native Added window reads built-in localized metadata and Python metadata, preserving changed values",
    );
    await h.evaluate(async () => {
      await alertBridge.create();
    });
    const alert = n.locator(".chart-alert-dialog");
    await expect(alert).toBeVisible();
    await alert.getByRole("button", { name: "条件", exact: true }).click();
    await n.getByRole("option", { name: "指标输出", exact: true }).click();
    await alert.getByRole("button", { name: "指标", exact: true }).click();
    await n.getByRole("option", { name: "MACD", exact: true }).click();
    await expect(alert.getByLabel("快线周期", { exact: true })).toHaveValue(
      "12",
    );
    await expect(alert.getByLabel("慢线周期", { exact: true })).toHaveValue(
      "26",
    );
    await expect(alert.getByLabel("信号周期", { exact: true })).toHaveValue(
      "9",
    );
    await expect(alert).toContainText("手动选择指标时使用告警默认参数");
    await expect(alert).toContainText("同名内置指标不自动同步");
    await alert.getByLabel("快线周期", { exact: true }).fill("21");
    await p.screenshot({ path: out + "/manual-alert-parameter-snapshot.png" });
    await p.keyboard.press("Escape");
    await expect(alert).toHaveCount(0);
    checks.push(
      "Actual native manual MACD alert uses independent default parameters, readable metadata labels and explicit chart-matching explanation",
    );
    await h.evaluate(() =>
      dataCenter.open("/market-data?tab=platform&source=dukascopy&query=AAPL"),
    );
    const dc = n.locator(".dc-window");
    await expect(dc).toBeVisible();
    await dc.getByRole("tab", { name: "股票", exact: true }).click();
    await expect(dc).toContainText("AAPL.US/USD");
    await expect(dc).toContainText("具体合约类型待核实");
    await p.screenshot({ path: out + "/dukascopy-stock-filter.png" });
    await n.getByRole("button", { name: "关闭数据中心", exact: true }).click();
    checks.push(
      "Actual native platform search combines AAPL keyword, stock category and Dukascopy source",
    );
    await h.evaluate(() =>
      dataCenter.open("/market-data?tab=calendar&query=BTCUSDT"),
    );
    await expect(dc).toBeVisible();
    const rows = dc.locator(".dc-calendar-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "已登记品种" })).toHaveCount(1);
    await expect(rows.filter({ hasText: "来源目录" })).toHaveCount(1);
    await p.screenshot({ path: out + "/calendar-independent-targets.png" });
    await n.getByRole("button", { name: "关闭数据中心", exact: true }).click();
    checks.push(
      "Actual native calendar shows registered vs catalog independent review scopes",
    );
    await h.evaluate(() => {
      const s = widget.activeChart().getPanes()[0].getMainSourcePriceScale();
      s.setAutoScale(false);
      s.setVisiblePriceRange({ from: 1.114, to: 1.136 });
    });
    await h.evaluate(
      (symbol) =>
        new Promise((resolve) =>
          widget.activeChart().setSymbol(symbol, resolve),
        ),
      "MWP:" + id("AAPL.US/USD"),
    );
    await h.waitForFunction(() => widget.activeChart().dataReady(), null, {
      timeout: 45000,
    });
    const before = await h.evaluate(() => {
      const s = widget.activeChart().getPanes()[0].getMainSourcePriceScale();
      return { auto: s.isAutoScale(), range: s.getVisiblePriceRange() };
    });
    console.log("manual-scale after switch", before);
    if (!before.auto) {
      const box = await n.locator(".chart-container").first().boundingBox();
      await p.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.45, {
        button: "right",
      });
      await n.getByText("重置图表视图", { exact: true }).click();
    }
    await expect
      .poll(() =>
        h.evaluate(() =>
          widget
            .activeChart()
            .getPanes()[0]
            .getMainSourcePriceScale()
            .isAutoScale(),
        ),
      )
      .toBe(true);
    const after = await h.evaluate(() =>
      widget
        .activeChart()
        .getPanes()[0]
        .getMainSourcePriceScale()
        .getVisiblePriceRange(),
    );
    assert(after.from > 100);
    await p.screenshot({ path: out + "/manual-scale-restored.png" });
    checks.push(
      "S-02: existing native Reset chart view restores autoscale after synthetic FX to stock switch",
    );
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      out + "/native-results.json",
      JSON.stringify(
        {
          checks,
          errors,
          scope:
            "Actual licensed native UI and own Docker API/DB with explicitly synthetic price cache; not upstream price verification",
          studyIds,
          manualScale: { before, after },
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ checks }, null, 2));
  } catch (e) {
    await p.screenshot({ path: out + "/native-failed.png" }).catch(() => {});
    throw e;
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
