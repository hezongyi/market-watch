// Task-owned Ubuntu Docker only; see docs/production-ux-fixes-20261012.md.
const { chromium, expect } = require("@playwright/test");
const fs = require("fs"),
  assert = require("assert/strict"),
  crypto = require("crypto");
const {
  root,
  base,
  origin,
  out,
  password,
} = require("./production-ux-env.cjs");
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
  p.on("pageerror", (e) => errors.push(e.message));
  try {
    await p.goto(base + "/advanced-charts");
    await p.getByLabel("管理员密码").fill(password);
    await p.getByRole("button", { name: "登录工作台" }).click();
    await expect(p.getByLabel("管理员密码")).toHaveCount(0);
    const previous = await (
      await p.request.get(base + "/api/chart-alerts")
    ).json();
    const session = await (await p.request.get(base + "/api/session")).json();
    for (const row of previous.filter(
      (r) => r.config.association?.workspace_id === "ux-synthetic-native",
    )) {
      const retired = await p.request.post(
        base + "/api/chart-alerts/" + row.id + "/lifecycle",
        {
          headers: { "X-CSRF-Token": session.csrf },
          data: {
            version: row.version,
            control_revision: row.control_revision,
            request_id: crypto.randomUUID(),
            action: "archive",
          },
        },
      );
      assert(retired.ok(), await retired.text());
    }
    await p.reload();
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
    // Binance's public alert calendar is supported; Dukascopy remains unverified.
    await h.evaluate(
      () =>
        new Promise((resolve) =>
          widget.activeChart().setSymbol("MWP:BTCUSDT", resolve),
        ),
    );
    const n = p.frames().find((f) => f.url().startsWith("blob:"));
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
    // The actual Python study has loaded the cached provider prices and uses
    // the real chart/alert calculation origin; do not inject a fabricated one.
    await expect
      .poll(
        () =>
          h.evaluate(
            () =>
              alertCalculationOrigins.get(
                MWSeries.encode(
                  MWSeries.decode(widget.activeChart().symbol()).symbol,
                  MWSeries.decode(widget.activeChart().symbol()).series_kind,
                ) +
                  "|" +
                  widget.activeChart().resolution(),
              ) ?? null,
          ),
        { timeout: 45000 },
      )
      .not.toBeNull();
    await h.evaluate(
      async (id) => alertBridge.create({ object: { type: "study", id } }),
      studyIds.python,
    );
    const objectAlert = n.locator(".chart-alert-dialog");
    await expect(objectAlert).toBeVisible();
    for (const [label, value] of [
      ["快线周期", "19"],
      ["慢线周期", "35"],
      ["信号周期", "11"],
    ])
      await expect(objectAlert.getByLabel(label, { exact: true })).toHaveValue(
        value,
      );
    await objectAlert.getByLabel("比较值", { exact: true }).fill("0");
    await objectAlert
      .getByRole("button", { name: "关系", exact: true })
      .click();
    await n.getByRole("option", { name: "高于", exact: true }).click();
    await p.setViewportSize({ width: 1366, height: 768 });
    await expect(
      objectAlert.getByRole("button", { name: "创建告警", exact: true }),
    ).toBeInViewport();
    await p.screenshot({ path: out + "/python-object-alert-1366.png" });
    await p.setViewportSize({ width: 1440, height: 1000 });
    await p.screenshot({ path: out + "/python-object-alert-snapshot.png" });
    const saveResponse = p.waitForResponse(
      (r) =>
        r.url() === base + "/api/chart-alerts" &&
        r.request().method() === "POST",
    );
    await objectAlert
      .getByRole("button", { name: "创建告警", exact: true })
      .click();
    const save = await saveResponse;
    assert.equal(save.status(), 201, await save.text());
    const saved = await save.json();
    assert.deepEqual(saved.config.condition.left.indicator.params, {
      fast: 19,
      slow: 35,
      signal: 11,
    });
    assert.equal(saved.config.association.object_kind, "indicator");
    assert.equal(
      saved.config.association.native_object_id,
      String(studyIds.python),
    );
    assert(Number.isSafeInteger(saved.config.calculation_origin));
    await expect(objectAlert).toHaveCount(0);
    await h.evaluate(
      (id) =>
        widget
          .activeChart()
          .getStudyById(id)
          .setInputValues([
            { id: "fast", value: 23 },
            { id: "slow", value: 39 },
            { id: "signal", value: 13 },
          ]),
      studyIds.python,
    );
    const reread = await (
      await p.request.get(base + "/api/chart-alerts/" + saved.id)
    ).json();
    assert.deepEqual(reread.config.condition.left.indicator.params, {
      fast: 19,
      slow: 35,
      signal: 11,
    });
    await p.screenshot({ path: out + "/python-alert-saved-independent.png" });
    checks.push(
      "Actual native Python object entry: real calculation origin, values19/35/11, UI POST201, association persists, changing chart to23/39/13 leaves saved snapshot unchanged",
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
    await alert.getByLabel("比较值", { exact: true }).fill("0");
    const manualSaveResponse = p.waitForResponse(
      (r) =>
        r.url() === base + "/api/chart-alerts" &&
        r.request().method() === "POST",
    );
    await alert.getByRole("button", { name: "创建告警", exact: true }).click();
    const manualSave = await manualSaveResponse;
    assert.equal(manualSave.status(), 201, await manualSave.text());
    const manualSaved = await manualSave.json();
    assert.deepEqual(manualSaved.config.condition.left.indicator.params, {
      fast: 21,
      slow: 26,
      signal: 9,
    });
    await expect(alert).toHaveCount(0);
    checks.push(
      "Actual native manual MACD alert uses independent default parameters, readable metadata labels and explicit chart-matching explanation; UI POST201 preserves21/26/9",
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
    for (const [symbol, token] of [
      ["0700", "0700.HK/HKD"],
      ["7203", "7203.JP/JPY"],
    ]) {
      await h.evaluate(
        (query) =>
          dataCenter.open(
            "/market-data?tab=platform&source=dukascopy&query=" + query,
          ),
        symbol,
      );
      await expect(dc).toBeVisible();
      await dc.getByRole("tab", { name: "股票", exact: true }).click();
      await expect(dc).toContainText(token);
      await expect(dc).toContainText("具体合约类型待核实");
      await p.screenshot({ path: out + "/dukascopy-stock-" + symbol + ".png" });
      await n
        .getByRole("button", { name: "关闭数据中心", exact: true })
        .click();
    }
    checks.push(
      "Actual native Dukascopy stock/source/keyword filters include representative Hong Kong0700 and Japan7203",
    );
    await h.evaluate(() =>
      dataCenter.open("/market-data?tab=calendar&source=oanda&query=EURUSD"),
    );
    await expect(dc).toBeVisible();
    const oandaRows = dc.locator(".dc-calendar-row");
    await expect
      .poll(() => oandaRows.filter({ hasText: "已登记品种" }).count())
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(() => oandaRows.filter({ hasText: "来源目录" }).count())
      .toBeGreaterThanOrEqual(1);
    await dc
      .locator(".dc-content")
      .evaluate((e) => {
        e.scrollTop = 0;
      })
      .catch(() => {});
    await p.screenshot({
      path: out + "/calendar-oanda-independent-overview.png",
    });
    for (const row of await oandaRows.all())
      await row.locator("summary").click();
    await expect(dc).toContainText("用于现有行情与策略绑定");
    await expect(dc).toContainText("用于来源检索及登记前核对");
    await expect(dc).toContainText("审核不会自动转移到同名品种");
    const registered = oandaRows.filter({ hasText: "已登记品种" }).first();
    await registered.locator("summary").scrollIntoViewIfNeeded();
    await p.screenshot({
      path: out + "/calendar-oanda-independent-targets.png",
    });
    const catalog = oandaRows.filter({ hasText: "来源目录" }).first();
    await catalog.locator("summary").scrollIntoViewIfNeeded();
    await p.screenshot({ path: out + "/calendar-oanda-catalog-target.png" });
    const calendar = await (
      await p.request.get(
        base + "/api/market-data/center/calendars?source=oanda&query=EURUSD",
      )
    ).json();
    assert.equal(
      new Set(calendar.items.map((row) => row.row_id)).size,
      calendar.items.length,
    );
    assert(calendar.items.every((row) => row.status !== "verified"));
    assert.equal(
      calendar.review_due,
      calendar.items.filter((row) =>
        ["unverified", "review_due", "expired", "not_yet_valid"].includes(
          row.status,
        ),
      ).length,
    );
    await n.getByRole("button", { name: "关闭数据中心", exact: true }).click();
    checks.push(
      "Actual native OANDA registered/catalog same-symbol scopes expanded: separate IDs/uses, independent review counts, unverified preserved",
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
      "S-02: existing native Reset chart view restores autoscale after synthetic BTC to stock switch with manual price range",
    );
    await p.reload();
    await expect
      .poll(() => p.frames().some((f) => f.url().startsWith(origin + "/?")), {
        timeout: 30000,
      })
      .toBe(true);
    const reloadHost = p
      .frames()
      .find((f) => f.url().startsWith(origin + "/?"));
    await reloadHost.waitForFunction(
      () => ready && widget.activeChart().dataReady(),
      null,
      { timeout: 45000 },
    );
    await reloadHost.waitForFunction(() => !!alertUI);
    await reloadHost.evaluate(() => alertUI.open());
    const persisted = await (
      await p.request.get(base + "/api/chart-alerts/" + saved.id)
    ).json();
    assert.deepEqual(persisted.config.condition.left.indicator.params, {
      fast: 19,
      slow: 35,
      signal: 11,
    });
    assert.equal(
      persisted.config.calculation_origin,
      saved.config.calculation_origin,
    );
    const manualPersisted = await (
      await p.request.get(base + "/api/chart-alerts/" + manualSaved.id)
    ).json();
    assert.deepEqual(manualPersisted.config.condition.left.indicator.params, {
      fast: 21,
      slow: 26,
      signal: 9,
    });
    await expect
      .poll(
        () =>
          p
            .frames()
            .find((f) => f.url().startsWith("blob:"))
            ?.locator(".chart-alert-card")
            .count() || 0,
      )
      .toBeGreaterThanOrEqual(2);
    await p.screenshot({ path: out + "/alerts-reloaded.png" });
    checks.push(
      "Actual saved Python and manual alert parameter snapshots persist across page reload",
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
