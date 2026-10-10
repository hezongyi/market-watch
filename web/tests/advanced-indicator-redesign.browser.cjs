// Actual Ubuntu acceptance assets/API; changes are confined to an owned workspace.
const fs = require("node:fs"),
  path = require("node:path"),
  { expect } = require("@playwright/test"),
  f = require("./chart-data-center-fixture.cjs");
const out = path.join(f.root, "artifacts/indicator-ui");
fs.mkdirSync(out, { recursive: true });
(async () => {
  const b = await f.launch(),
    p = await b.newPage({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
    }),
    { host, native } = f.frames(p);
  const dialog = () =>
      native().locator(
        '[data-name="mw-indicator-dialog"],dialog.mw-indicator-fallback',
      ),
    picker = () => dialog().locator(".mw-indicator-picker"),
    query = () =>
      dialog().getByRole("searchbox", { name: "搜索指标", exact: true }),
    panel = () => dialog().locator(".mw-indicator-detail");
  const report = {
    environment:
      "Ubuntu isolated Docker; deployed native adapter and real APIs",
    passed: false,
    checks: [],
    errors: [],
  };
  let workspace,
    release = () => {};
  const onError = (e) => report.errors.push(e.message),
    record = (name) => {
      report.checks.push({ name });
      console.log("PASS", name);
    };
  const get = async (route) => {
    const r = await p.request.get(f.base + "/api" + route);
    expect(r.ok()).toBe(true);
    return r.json();
  };
  const open = async () => {
    await native().getByRole("button", { name: "指标", exact: true }).click();
    await expect(dialog()).toBeVisible();
  };
  const close = async () => {
    await dialog()
      .getByRole("button", { name: "关闭指标窗口", exact: true })
      .click();
    await expect(dialog()).toHaveCount(0);
  };
  const py = () => dialog().locator('[data-study-name="守望 Python SMA"]'),
    nativeSma = () => dialog().locator('[data-study-name="Moving Average"]');
  try {
    await p.goto(f.base + "/advanced-charts");
    await f.login(p);
    const { csrf } = await get("/session"),
      created = await p.request.post(
        f.base + "/api/advanced-charts/workspaces",
        {
          data: { name: "指标窗口改版验收", symbol: "MWP:EURUSD" },
          headers: { "X-CSRF-Token": csrf },
        },
      );
    expect(created.ok()).toBe(true);
    workspace = await created.json();
    await p.goto(f.base + "/advanced-charts");
    await expect.poll(() => !!native(), { timeout: 30000 }).toBe(true);
    await host().waitForFunction(
      () => ready && dataCenter && widget.activeChart().dataReady(),
      null,
      { timeout: 60000 },
    );
    p.on("pageerror", onError);
    const baseline = await host().evaluate(() => ({
      symbol: widget.activeChart().symbol(),
      resolution: widget.activeChart().resolution(),
      epoch: workspaceEpoch,
    }));
    // Indicators are opened first, before data center and main symbol search.
    await open();
    await expect(picker()).toHaveClass(/is-native/);
    await expect(dialog()).toHaveAttribute("data-name", "mw-indicator-dialog");
    await expect(
      dialog().locator("[data-native-component=search]"),
    ).toHaveCount(1);
    await expect(query()).toBeFocused();
    expect(await picker().locator("details,summary,select").count()).toBe(0);
    await query().fill("均线");
    expect(
      await dialog().locator("[data-study-name]").count(),
    ).toBeGreaterThanOrEqual(4);
    await query().fill("sma");
    await expect(dialog().locator("[data-study-name]")).toHaveCount(2);
    await dialog()
      .getByRole("button", { name: "我的 Python", exact: true })
      .click();
    await expect(dialog().locator("[data-study-name]")).toHaveCount(1);
    await query().fill("不存在的指标");
    await expect(
      dialog().getByText("没有匹配的指标", { exact: true }),
    ).toBeVisible();
    await dialog()
      .getByRole("button", { name: "清除筛选", exact: true })
      .click();
    await expect(query()).toHaveValue("");
    await query().fill("SMA");
    record(
      "cold first open uses native dialog/search; round categories, Chinese/English search, empty state and clear preserve identities",
    );
    const detailTrigger = py().getByRole("button", { name: /查看.*详情/ });
    await detailTrigger.click();
    await expect(panel()).toBeFocused();
    await expect(panel()).toContainText("用途：");
    await expect(panel()).toContainText("计算：");
    await expect(panel()).toContainText("20");
    await expect(panel()).toContainText("版本 1");
    await expect(panel().getByRole("button", { name: /添加/ })).toBeVisible();
    await p.screenshot({ path: path.join(out, "details-dark-1440.png") });
    await p.keyboard.press("Escape");
    await expect(panel()).toBeHidden();
    await expect(detailTrigger).toBeFocused();
    await expect(query()).toHaveValue("SMA");
    record(
      "indicator detail replaces triangles with panel; descriptions, calculation, input defaults and version remain readable; Escape only returns list",
    );
    await nativeSma().getByRole("button", { name: /添加/ }).click();
    await expect
      .poll(() =>
        host().evaluate(
          () =>
            widget
              .activeChart()
              .getAllStudies()
              .filter((s) => s.name === "Moving Average").length,
        ),
      )
      .toBe(1);
    await py().getByRole("button", { name: /添加/ }).click();
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
    await py().getByRole("button", { name: /添加/ }).click();
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
    const studies = await host().evaluate(() =>
        widget.activeChart().getAllStudies(),
      ),
      pyStudies = studies.filter((s) => s.name === "守望 Python SMA");
    expect(pyStudies[0].id).not.toBe(pyStudies[1].id);
    await dialog()
      .getByRole("button", { name: "设置刚添加的指标", exact: true })
      .click();
    await expect(dialog()).toHaveCount(0);
    await expect(
      native().locator('[data-name="indicator-properties-dialog"]'),
    ).toBeVisible();
    await host().evaluate(() => widget.closePopupsAndDialogs());
    await expect(dialog()).toBeVisible();
    await expect(query()).toHaveValue("SMA");
    record(
      "native/Python additions and intentional duplicates retain distinct IDs; native properties close returns to query",
    );
    await dialog()
      .getByRole("button", { name: "当前图表已添加", exact: true })
      .click();
    await expect(dialog().locator("[data-instance-id]")).toHaveCount(3);
    const instance = () =>
      dialog().locator(`[data-instance-id="${pyStudies[0].id}"]`);
    await instance().getByRole("button", { name: /隐藏/ }).click();
    expect(
      await host().evaluate(
        (id) => widget.activeChart().getStudyById(id).isVisible(),
        pyStudies[0].id,
      ),
    ).toBe(false);
    await instance().getByRole("button", { name: /显示/ }).click();
    await instance().getByRole("button", { name: /设置/ }).click();
    await expect(
      native().locator('[data-name="indicator-properties-dialog"]'),
    ).toBeVisible();
    await host().evaluate(() => widget.closePopupsAndDialogs());
    await expect(dialog()).toBeVisible();
    await instance().getByRole("button", { name: /移除/ }).click();
    await expect(dialog().locator("[data-instance-id]")).toHaveCount(2);
    expect(
      await dialog().evaluate((n) => n.contains(n.ownerDocument.activeElement)),
    ).toBe(true);
    record(
      "current chart list preserves per-instance settings, visibility/removal and focus after row replacement",
    );
    await dialog().getByRole("button", { name: "收藏", exact: true }).click();
    await dialog()
      .getByRole("button", { name: "打开原生收藏", exact: true })
      .click();
    await expect(dialog()).toHaveCount(0);
    await expect(
      native().locator('[data-name="indicators-dialog"]'),
    ).toBeVisible();
    await host().evaluate(() => widget.closePopupsAndDialogs());
    await expect(dialog()).toBeVisible();
    await expect(
      dialog().getByRole("button", { name: "收藏", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    record(
      "favorites retain native shared storage and native dialog; closing resumes the same category",
    );
    await dialog().getByRole("button", { name: "全部", exact: true }).click();
    await query().fill("SMA");
    await close();
    // Held create resolves against the chart captured at click, even if the active chart changes.
    await host().evaluate(() => widget.setLayout("2h"));
    await host().waitForFunction(
      () => widget.chartsCount() === 2 && widget.chart(1).dataReady(),
      null,
      { timeout: 60000 },
    );
    await host().evaluate(() => {
      widget
        .chart(1)
        .getAllStudies()
        .forEach((study) => widget.chart(1).removeEntity(study.id));
      widget.setActiveChart(0);
    });
    await open();
    const before = await host().evaluate(
      () => widget.chart(0).getAllStudies().length,
    );
    await host().evaluate(() => {
      const chart = widget.chart(0),
        original = chart.createStudy.bind(chart);
      window.releasePickerStudy = () => {};
      chart.createStudy = (...args) =>
        new Promise((resolve, reject) => {
          window.releasePickerStudy = () => {
            chart.createStudy = original;
            return original(...args).then(resolve, reject);
          };
        });
    });
    release = async () =>
      host()
        .evaluate(() => releasePickerStudy())
        .catch(() => {});
    await py().getByRole("button", { name: /添加/ }).click();
    await expect(py().getByRole("button", { name: /添加/ })).toBeDisabled();
    await py()
      .getByRole("button", { name: /添加/ })
      .evaluate((node) => {
        node.click();
        node.click();
      });
    await host().evaluate(() => widget.setActiveChart(1));
    await release();
    release = () => {};
    await expect
      .poll(() => host().evaluate(() => widget.chart(0).getAllStudies().length))
      .toBe(before + 1);
    expect(
      await host().evaluate(() => widget.chart(1).getAllStudies().length),
    ).toBe(0);
    await query().fill("");
    await dialog()
      .getByRole("button", { name: "当前图表已添加", exact: true })
      .click();
    await expect(
      dialog().getByText("当前图表尚未添加指标", { exact: true }),
    ).toBeVisible();
    await host().evaluate(() => widget.setActiveChart(0));
    await expect(dialog().locator("[data-instance-id]")).toHaveCount(
      before + 1,
    );
    record(
      "pending add disables duplicates and stays on captured chart; active chart list follows multi-chart selection",
    );
    await close();
    await host().evaluate(() => widget.setLayout("s"));
    await host().waitForFunction(
      () => widget.chartsCount() === 1 && widget.activeChart().dataReady(),
      null,
      { timeout: 60000 },
    );
    await host().evaluate(() => {
      const chart = widget.activeChart(),
        study = chart.getAllStudies().find((s) => s.name === "守望 Python SMA");
      chart
        .getStudyById(study.id)
        .setInputValues([{ id: "period", value: 37 }]);
    });
    const saved = await host().evaluate(
      () => new Promise((resolve) => widget.save(resolve)),
    );
    await host().evaluate(async (saved) => {
      await widget.load(saved);
    }, saved);
    await host().waitForFunction(() => widget.activeChart().dataReady(), null, {
      timeout: 60000,
    });
    expect(
      await host().evaluate(() =>
        widget
          .activeChart()
          .getAllStudies()
          .some(
            (s) =>
              s.name === "守望 Python SMA" &&
              widget
                .activeChart()
                .getStudyById(s.id)
                .getInputValues()
                .some((i) => i.id === "period" && i.value === 37),
          ),
      ),
    ).toBe(true);
    record(
      "native save/load retains study names and changed period; UI creates no alternate indicator identity",
    );
    await open();
    await dialog().getByRole("button", { name: "全部", exact: true }).click();
    await query().fill("SMA");
    for (const theme of ["Dark", "Light"]) {
      await host().evaluate((theme) => widget.changeTheme(theme), theme);
      for (const width of [1440, 768, 375]) {
        await p.setViewportSize({ width, height: 900 });
        await expect(
          dialog().getByRole("button", { name: "关闭指标窗口", exact: true }),
        ).toBeInViewport();
        expect(
          await picker().evaluate((n) => n.scrollWidth <= n.clientWidth + 1),
        ).toBe(true);
        await py()
          .getByRole("button", { name: /查看.*详情/ })
          .click();
        await expect(panel()).toBeInViewport();
        expect(
          await panel().evaluate((n) => n.scrollWidth <= n.clientWidth + 1),
        ).toBe(true);
        for (const key of ["Tab", "Shift+Tab"])
          for (let i = 0; i < 10; i++) {
            await p.keyboard.press(key);
            expect(
              await dialog().evaluate((n) =>
                n.contains(n.ownerDocument.activeElement),
              ),
            ).toBe(true);
            if (width < 850)
              expect(
                await panel().evaluate((n) =>
                  n.contains(n.ownerDocument.activeElement),
                ),
              ).toBe(true);
          }
        await p.screenshot({
          path: path.join(out, `details-${theme.toLowerCase()}-${width}.png`),
        });
        await p.keyboard.press("Escape");
        await expect(panel()).toBeHidden();
        await expect(
          py().getByRole("button", { name: /查看.*详情/ }),
        ).toBeFocused();
        await p.screenshot({
          path: path.join(out, `list-${theme.toLowerCase()}-${width}.png`),
        });
      }
    }
    record(
      "dark/light desktop/tablet/375px, native close, no overflow, detail keyboard containment and Escape focus pass",
    );
    await close();
    await p.setViewportSize({ width: 1440, height: 1000 });
    await host().evaluate(() =>
      dataCenter.open("/market-data?tab=platform&source=yahoo&query=MSFT"),
    );
    await expect(native().locator(".dc-window [data-symbol-name]")).toHaveCount(
      1,
    );
    await native()
      .getByRole("button", { name: "关闭数据中心", exact: true })
      .click();
    await host().evaluate(() =>
      widget.activeChart().executeActionById("symbolSearch"),
    );
    const symbol = native().locator('[data-name="symbol-search-items-dialog"]');
    await expect(
      symbol.getByRole("button", { name: "行情类型", exact: true }),
    ).toBeVisible();
    await symbol
      .getByRole("button", { name: "关闭商品代码搜索", exact: true })
      .click();
    record(
      "shared native loader preserves data center and main symbol-search filters after indicators cold-load first",
    );
    await host().evaluate(() => {
      window.realPickerVersion = TradingView.version;
      TradingView.version = () => "unsupported-indicator-ui";
    });
    await open();
    await expect(picker()).not.toHaveClass(/is-native/);
    await query().fill("SMA");
    await py()
      .getByRole("button", { name: /查看.*详情/ })
      .click();
    await expect(panel()).toContainText("用途：");
    await p.keyboard.press("Escape");
    await expect(panel()).toBeHidden();
    await close();
    await host().evaluate(() => {
      TradingView.version = realPickerVersion;
    });
    await open();
    await expect(picker()).toHaveClass(/is-native/);
    await close();
    record(
      "version mismatch retains complete compatibility picker; corrected version restores native path",
    );
    const after = await host().evaluate(() => ({
      symbol: widget.activeChart().symbol(),
      resolution: widget.activeChart().resolution(),
      epoch: workspaceEpoch,
    }));
    expect(after.symbol).toBe(baseline.symbol);
    expect(after.resolution).toBe(baseline.resolution);
    expect(report.errors).toEqual([]);
    report.passed = true;
  } catch (error) {
    report.errors.push(error.message);
    await p.screenshot({ path: path.join(out, "failed.png") }).catch(() => {});
    throw error;
  } finally {
    await release();
    p.off("pageerror", onError);
    if (workspace) {
      const before = await get("/advanced-charts/workspaces"),
        owned = before.find((row) => row.id === workspace.id);
      if (owned) {
        const { csrf } = await get("/session"),
          removed = await p.request.post(
            f.base + "/api/advanced-charts/workspaces/" + owned.id + "/delete",
            {
              data: { revision: owned.revision },
              headers: { "X-CSRF-Token": csrf },
            },
          );
        expect(removed.ok()).toBe(true);
        const after = await get("/advanced-charts/workspaces");
        expect(after.map((row) => row.id).sort()).toEqual(
          before
            .filter((row) => row.id !== workspace.id)
            .map((row) => row.id)
            .sort(),
        );
        report.cleanup = { onlyOwnedWorkspaceDeleted: true };
      }
    }
    fs.writeFileSync(
      path.join(out, "report.json"),
      JSON.stringify(report, null, 2),
    );
    await b.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
