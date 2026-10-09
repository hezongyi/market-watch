// Deployed native indicator controller; owned workspace, favorite bit restored.
const fs = require("node:fs"),
  path = require("node:path"),
  { expect } = require("@playwright/test"),
  f = require("./chart-data-center-fixture.cjs");
const out = path.join(f.root, "artifacts/native-indicators-tasks/indicators");
fs.mkdirSync(out, { recursive: true });
(async () => {
  const b = await f.launch(),
    p = await b.newPage({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
    }),
    { host, native } = f.frames(p);
  const dialog = () => native().locator('[data-name="indicators-dialog"]'),
    query = () => dialog().getByLabel("搜索指标", { exact: true }),
    py = () => dialog().locator('[data-study-name="守望 Python SMA"]'),
    panel = () => dialog().locator(".mw-native-indicator-detail");
  const report = {
    environment:
      "Ubuntu isolated Docker; actual native indicator controller, rows, stars and server settings",
    passed: false,
    checks: [],
    errors: [],
  };
  const record = (name) => {
    console.log("PASS", name);
    report.checks.push({ name });
  };
  let workspace,
    favoriteBefore,
    favoriteChanged = false;
  const get = async (route) => {
    const r = await p.request.get(f.base + "/api" + route);
    expect(r.ok()).toBe(true);
    return r.json();
  };
  const open = async () => {
    await native().getByRole("button", { name: "指标", exact: true }).click();
    await expect(dialog()).toBeVisible();
    await expect(
      dialog().locator(".mw-native-indicator-content"),
    ).toBeVisible();
  };
  const close = async () => {
    await dialog()
      .getByRole("button", { name: "关闭指标窗口", exact: true })
      .click();
    await expect(dialog()).toHaveCount(0);
  };
  const star = () =>
    py().locator('[aria-label="添加到收藏"],[aria-label="从收藏中移除"]');
  const favoriteValue = async () => {
    const prefs = await get("/advanced-charts/preferences");
    const row = prefs.find(
      (row) =>
        row.kind === "setting" &&
        row.name === "chart.favoriteLibraryIndicators",
    );
    return row
      ? JSON.parse(row.content.value).includes("守望 Python SMA")
      : false;
  };
  const ready = async () => {
    await expect.poll(() => !!native(), { timeout: 30000 }).toBe(true);
    await host().waitForFunction(
      () => ready && dataCenter && widget.activeChart().dataReady(),
      null,
      { timeout: 60000 },
    );
  };
  const category = async (name) => {
    if (
      await dialog().locator(".mw-native-indicator-category-select").isVisible()
    ) {
      await dialog()
        .getByRole("button", { name: "指标分类", exact: true })
        .click();
      await native().getByRole("option", { name, exact: true }).click();
    } else await dialog().getByRole("button", { name, exact: true }).click();
  };
  try {
    await p.goto(f.base + "/advanced-charts");
    await f.login(p);
    const { csrf } = await get("/session");
    const created = await p.request.post(
      f.base + "/api/advanced-charts/workspaces",
      {
        data: { name: "原生指标分类改版验收", symbol: "MWP:EURUSD" },
        headers: { "X-CSRF-Token": csrf },
      },
    );
    expect(created.ok()).toBe(true);
    workspace = await created.json();
    await p.goto(f.base + "/advanced-charts");
    await ready();
    p.on("pageerror", (e) => report.errors.push(e.message));
    await host().evaluate(() => {
      for (const study of widget.activeChart().getAllStudies())
        widget.activeChart().removeEntity(study.id);
    });
    await open();
    await expect(query()).toBeFocused();
    await expect(
      dialog().getByRole("navigation", { name: "指标分类" }),
    ).toBeVisible();
    await expect(dialog().locator('[data-role="list-item"]')).not.toHaveCount(
      0,
    );
    expect(
      await native().locator('[data-name="mw-indicator-dialog"]').count(),
    ).toBe(0);
    await query().fill("均线");
    await expect(
      dialog().locator('[data-study-name="Moving Average"]'),
    ).toBeVisible();
    await query().fill("PY SMA");
    await category("我的 Python");
    await expect(py()).toBeVisible();
    record(
      "cold toolbar open uses actual native indicators-dialog, search, native rows and left categories; Chinese and English aliases include existing Python identity",
    );
    await py()
      .getByRole("button", { name: "查看 SMA 简单均线详情", exact: true })
      .click();
    await expect(panel()).toContainText("默认输入");
    await expect(panel()).toContainText("20");
    await p.keyboard.press("Escape");
    await expect(panel()).toHaveCount(0);
    await expect(
      py().getByRole("button", { name: "查看 SMA 简单均线详情", exact: true }),
    ).toBeFocused();
    record(
      "native row details open shared layout without replacing native list; input defaults and Escape/focus remain correct",
    );
    await py().locator('[data-role="list-item"]').click();
    await expect
      .poll(() =>
        host().evaluate(
          () =>
            widget
              .activeChart()
              .getAllStudies()
              .filter((s) => s.name === "守望 Python SMA").length,
        ),
      )
      .toBe(1);
    await expect(py()).toHaveAttribute("aria-busy", "false");
    await py().locator('[data-role="list-item"]').click();
    await expect
      .poll(() =>
        host().evaluate(
          () =>
            widget
              .activeChart()
              .getAllStudies()
              .filter((s) => s.name === "守望 Python SMA").length,
        ),
      )
      .toBe(2);
    const pyIds = await host().evaluate(() =>
      widget
        .activeChart()
        .getAllStudies()
        .filter((s) => s.name === "守望 Python SMA")
        .map((s) => s.id),
    );
    expect(new Set(pyIds).size).toBe(2);
    await category("内置指标");
    await query().fill("SMA");
    const builtin = dialog().locator('[data-study-name="Moving Average"]');
    await expect(builtin).toBeVisible();
    const keyboardName = await dialog()
      .locator("[data-study-name]")
      .first()
      .getAttribute("data-study-name");
    await query().press("ArrowDown");
    await query().press("Enter");
    await expect
      .poll(() =>
        host().evaluate(
          (name) =>
            widget
              .activeChart()
              .getAllStudies()
              .filter((s) => s.name === name).length,
          keyboardName,
        ),
      )
      .toBe(1);
    record(
      "native row click permits intentional duplicate Python studies with distinct IDs; native ArrowDown/Enter adds built-in study",
    );
    await dialog()
      .getByRole("button", { name: "设置刚添加的指标", exact: true })
      .click();
    await expect(dialog()).toHaveCount(0);
    const properties = native().locator(
      '[data-name="indicator-properties-dialog"]',
    );
    await expect(properties).toBeVisible();
    await host().evaluate(() => widget.closePopupsAndDialogs());
    await expect(dialog()).toBeVisible();
    await expect(query()).toHaveValue("SMA");
    await expect(
      dialog().getByRole("button", { name: "内置指标", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    record(
      "native study properties close returns to same indicator category/query",
    );
    await category("当前图表已添加");
    await query().fill("");
    await expect(dialog().locator("[data-instance-id]")).toHaveCount(3);
    const first = dialog().locator("[data-instance-id]").first();
    await first.getByRole("button", { name: /^隐藏 / }).click();
    await expect(first.getByRole("button", { name: /^显示 / })).toBeVisible();
    await first.getByRole("button", { name: /^显示 / }).click();
    await first.getByRole("button", { name: /^设置 / }).click();
    await expect(properties).toBeVisible();
    await host().evaluate(() => widget.closePopupsAndDialogs());
    await expect(dialog()).toBeVisible();
    await dialog()
      .locator("[data-instance-id]")
      .first()
      .getByRole("button", { name: /^移除 / })
      .click();
    await expect(dialog().locator("[data-instance-id]")).toHaveCount(2);
    record(
      "current chart branch keeps exact-instance settings, visibility and removal inside same native window",
    );
    await category("我的 Python");
    await query().fill("SMA");
    favoriteBefore = await favoriteValue();
    await py().hover();
    await star().click();
    favoriteChanged = true;
    await expect.poll(favoriteValue, { timeout: 20000 }).toBe(!favoriteBefore);
    await category("收藏");
    if (!favoriteBefore) await expect(py()).toBeVisible();
    else await expect(py()).toHaveCount(0);
    expect(
      await dialog().getByRole("button", { name: "打开原生收藏" }).count(),
    ).toBe(0);
    await close();
    await p.reload();
    await ready();
    await open();
    await category("我的 Python");
    await query().fill("SMA");
    await expect(star()).toHaveAttribute(
      "aria-label",
      favoriteBefore ? "添加到收藏" : "从收藏中移除",
    );
    await py().hover();
    await star().click();
    await expect.poll(favoriteValue, { timeout: 20000 }).toBe(favoriteBefore);
    favoriteChanged = false;
    record(
      "native stars and favorites stay in same dialog; server settings persist across reload and original favorite bit is restored",
    );
    await py().locator('[data-role="list-item"]').click();
    await expect
      .poll(() =>
        host().evaluate(() =>
          widget
            .activeChart()
            .getAllStudies()
            .some((s) => s.name === "守望 Python SMA"),
        ),
      )
      .toBe(true);
    await close();
    const saved = await host().evaluate(
      () => new Promise((resolve) => widget.save(resolve)),
    );
    expect(JSON.stringify(saved)).toContain("守望 Python SMA");
    await host().evaluate((state) => widget.load(state), saved);
    await expect
      .poll(
        () =>
          host().evaluate(() =>
            widget
              .activeChart()
              .getAllStudies()
              .some((s) => s.name === "守望 Python SMA"),
          ),
        { timeout: 30000 },
      )
      .toBe(true);
    record(
      "native layout save/load preserves original Python study names and descriptors",
    );
    await host().evaluate(() => widget.setLayout("2h"));
    await host().waitForFunction(
      () => widget.chartsCount() === 2 && widget.chart(1).dataReady(),
      null,
      { timeout: 60000 },
    );
    await host().evaluate(() => {
      for (const study of widget.chart(1).getAllStudies())
        widget.chart(1).removeEntity(study.id);
      widget.setActiveChart(0);
    });
    await open();
    await category("我的 Python");
    await query().fill("SMA");
    const chart0Before = await host().evaluate(
      () =>
        widget
          .chart(0)
          .getAllStudies()
          .filter((s) => s.name === "守望 Python SMA").length,
    );
    await native().evaluate(() => {
      let req;
      webpackChunktradingview.push([
        ["mw-indicator-owned-test-" + crypto.randomUUID()],
        {},
        (value) => (req = value),
      ]);
      const parent = Object.getPrototypeOf(
          req(217583).IndicatorsLibraryContainer.prototype,
        ),
        original = parent._insertStudyImpl;
      window.releaseNativeIndicatorTest = () => {};
      parent._insertStudyImpl = async function (...args) {
        const value = await original.apply(this, args);
        await new Promise((resolve) => {
          window.releaseNativeIndicatorTest = () => {
            parent._insertStudyImpl = original;
            resolve();
          };
        });
        return value;
      };
    });
    await py().locator('[data-role="list-item"]').click();
    await expect(py()).toHaveAttribute("aria-busy", "true");
    await py().locator('[data-role="list-item"]').click();
    await host().evaluate(() => widget.setActiveChart(1));
    await native().evaluate(() => releaseNativeIndicatorTest());
    await expect(py()).toHaveAttribute("aria-busy", "false");
    expect(
      await host().evaluate(
        () =>
          widget
            .chart(0)
            .getAllStudies()
            .filter((s) => s.name === "守望 Python SMA").length,
      ),
    ).toBe(chart0Before + 1);
    expect(
      await host().evaluate(() => widget.chart(1).getAllStudies().length),
    ).toBe(0);
    await category("当前图表已添加");
    await query().fill("");
    await expect(dialog().locator("[data-instance-id]")).toHaveCount(0);
    await host().evaluate(() => widget.setActiveChart(0));
    await expect(dialog().locator("[data-instance-id]")).not.toHaveCount(0);
    await close();
    await host().evaluate(() => widget.setLayout("s"));
    await host().waitForFunction(
      () => widget.chartsCount() === 1 && widget.activeChart().dataReady(),
      null,
      { timeout: 60000 },
    );
    record(
      "held native insertion rejects pending duplicate and stays on captured chart; added list follows active chart",
    );
    for (const theme of ["Dark", "Light"]) {
      await host().evaluate((theme) => widget.changeTheme(theme), theme);
      for (const width of [1440, 768, 375]) {
        await p.setViewportSize({ width, height: 900 });
        await open();
        await category("我的 Python");
        await query().fill("SMA");
        await py()
          .getByRole("button", { name: "查看 SMA 简单均线详情", exact: true })
          .click();
        await expect(panel()).toBeInViewport();
        expect(
          await dialog()
            .locator(".mw-native-indicator-content")
            .evaluate((n) => n.scrollWidth <= n.clientWidth + 1),
        ).toBe(true);
        if (width < 850)
          for (const key of ["Tab", "Shift+Tab"])
            for (let i = 0; i < 6; i++) {
              await p.keyboard.press(key);
              expect(
                await native().evaluate(
                  () =>
                    !!document.activeElement.closest(
                      ".mw-native-indicator-detail",
                    ),
                ),
              ).toBe(true);
            }
        await p.screenshot({
          path: path.join(
            out,
            `indicators-${theme.toLowerCase()}-${width}.png`,
          ),
        });
        await p.keyboard.press("Escape");
        await expect(panel()).toHaveCount(0);
        if (width < 750) {
          await dialog()
            .getByRole("button", { name: "指标分类", exact: true })
            .click();
          await p.keyboard.press("Escape");
          await expect(dialog()).toBeVisible();
        }
        await close();
      }
    }
    record(
      "dark/light at desktop/tablet/375px: native sidebar or Select, readable details, no overflow, Tab containment and Escape popup priority",
    );
    await p.setViewportSize({ width: 1440, height: 1000 });
    await host().evaluate(() => dataCenter.open("/market-data?tab=platform"));
    await expect(native().locator(".dc-window")).toBeVisible();
    await native()
      .getByRole("button", { name: "关闭数据中心", exact: true })
      .click();
    await host().evaluate(() =>
      widget.activeChart().executeActionById("symbolSearch"),
    );
    const symbols = native().locator(
      '[data-name="symbol-search-items-dialog"]',
    );
    await expect(
      symbols.getByRole("button", { name: "行情类型", exact: true }),
    ).toBeVisible();
    await expect(
      symbols.getByRole("button", { name: "来源", exact: true }),
    ).toBeVisible();
    await symbols
      .getByRole("button", { name: "关闭商品代码搜索", exact: true })
      .click();
    record(
      "native indicator factory adaptation leaves data center and main symbol-search components intact",
    );
    await host().evaluate(() => {
      window.indicatorRealVersion = TradingView.version;
      TradingView.version = () => "native-indicator-incompatible";
    });
    await native().getByRole("button", { name: "指标", exact: true }).click();
    const fallback = native().locator("dialog.mw-indicator-fallback");
    await expect(fallback).toBeVisible();
    await fallback
      .getByRole("searchbox", { name: "搜索指标", exact: true })
      .fill("SMA");
    await expect(
      fallback.locator('[data-study-name="守望 Python SMA"]'),
    ).toBeVisible();
    await fallback
      .getByRole("button", { name: "关闭指标窗口", exact: true })
      .click();
    await host().evaluate(() => {
      TradingView.version = indicatorRealVersion;
    });
    await open();
    await close();
    record(
      "unsupported version uses complete compatibility picker and corrected version restores actual native dialog",
    );
    expect(report.errors).toEqual([]);
    report.passed = true;
  } catch (error) {
    report.errors.push(error.message);
    await p.screenshot({ path: path.join(out, "failed.png") }).catch(() => {});
    throw error;
  } finally {
    if (favoriteChanged) {
      await host()
        .evaluate(() => widget.closePopupsAndDialogs())
        .catch(() => {});
      await p.setViewportSize({ width: 1440, height: 1000 });
      await open();
      await category("我的 Python");
      await query().fill("SMA");
      await py().hover();
      if ((await favoriteValue()) !== favoriteBefore) {
        await star().click();
        await expect
          .poll(favoriteValue, { timeout: 20000 })
          .toBe(favoriteBefore);
      }
      report.cleanup = { favoriteBitRestored: true };
    }
    if (workspace) {
      const before = await get("/advanced-charts/workspaces"),
        owned = before.find((row) => row.id === workspace.id);
      if (owned) {
        const { csrf } = await get("/session"),
          deleted = await p.request.post(
            f.base + "/api/advanced-charts/workspaces/" + owned.id + "/delete",
            {
              data: { revision: owned.revision },
              headers: { "X-CSRF-Token": csrf },
            },
          );
        expect(deleted.ok()).toBe(true);
        const after = await get("/advanced-charts/workspaces");
        expect(after.map((row) => row.id).sort()).toEqual(
          before
            .filter((row) => row.id !== owned.id)
            .map((row) => row.id)
            .sort(),
        );
        report.cleanup = {
          ...report.cleanup,
          onlyOwnedWorkspaceDeleted: true,
          favoriteBitRestored:
            !favoriteChanged || (await favoriteValue()) === favoriteBefore,
        };
      }
    }
    fs.writeFileSync(
      path.join(out, "report.json"),
      JSON.stringify(report, null, 2),
    );
    await b.close();
  }
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
