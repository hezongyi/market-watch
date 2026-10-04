// Full product + dedicated PostgreSQL + actual provider data. Requires this task's Compose project.
const { chromium } = require("@playwright/test");
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const APP = "https://localhost:18443",
  CHART = "https://localhost:18444";
const OUT =
  process.env.INDICATOR_ACCEPTANCE_OUTPUT ||
  "/tmp/mw-indicator-acceptance/full-stack";
const report = {
  at: new Date().toISOString(),
  scope: "Ubuntu Docker full stack, actual provider candles",
  cases: [],
  errors: [],
};
const record = (name) => {
  report.cases.push(name);
  fs.writeFileSync(OUT + ".json", JSON.stringify(report, null, 2));
};
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 950 },
  });
  try {
    const login = await context.request.post(APP + "/api/login", {
      data: JSON.parse(
        fs.readFileSync("/tmp/mw-indicator-acceptance/login.json"),
      ),
    });
    assert.ok(login.ok(), "isolated login " + login.status());
    const csrf = (await login.json()).csrf;
    const post = async (endpoint, data) => {
      const r = await context.request.post(APP + "/api/" + endpoint, {
        headers: { "X-CSRF-Token": csrf },
        data,
      });
      assert.ok(r.ok(), endpoint + " " + r.status());
      return r.json();
    };
    const workspace = await post("advanced-charts/workspaces", {
      name: "指标窗口独立验收",
    });
    await post(`advanced-charts/workspaces/${workspace.id}/save`, {
      name: workspace.name,
      revision: workspace.revision,
      document: {
        engine: "tv31",
        schemaVersion: 1,
        symbol: "MWP:BTCUSDT",
        series_kind: "provider",
        interval: "5",
      },
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => report.errors.push(e.message));
    let host, ui, dialog, query;
    const ready = async () => {
      await page.locator('iframe[title="专业图表工作区"]').waitFor();
      await page.waitForFunction(() =>
        [...document.querySelectorAll("iframe")].some((f) =>
          f.src.startsWith("https://localhost:18444/"),
        ),
      );
      for (let attempt = 0; attempt < 100 && !host; attempt++) {
        host = page.frames().find((f) => f.url().startsWith(CHART + "/"));
        if (!host) await page.waitForTimeout(100);
      }
      assert.ok(host);
      await host.waitForFunction(
        () => ready && !loading && widget.activeChart().dataReady(),
        null,
        { timeout: 60000 },
      );
      ui = host.childFrames()[0];
      assert.ok(ui);
      dialog = ui.getByRole("dialog", { name: "指标", exact: true });
      query = dialog.getByLabel("搜索指标");
    };
    await page.goto(APP + "/advanced-charts");
    await ready();
    await ui.getByRole("button", { name: "指标", exact: true }).click();
    await dialog.waitFor();
    await query.fill("均线");
    assert.ok((await dialog.locator("[data-study-name]").count()) >= 4);
    await query.fill("sma");
    assert.equal(await dialog.locator("[data-study-name]").count(), 2);
    record("中英文与别名搜索、原生/Python 来源区分");
    await dialog
      .getByRole("button", { name: "我的 Python", exact: true })
      .click();
    await query.fill("Moving Average Exponential");
    await dialog.getByText("没有匹配的指标", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "在全部指标中搜索" }).click();
    assert.ok((await dialog.locator("[data-study-name]").count()) > 0);
    record("分类空结果与全目录搜索");
    await query.fill("SMA");
    const py = dialog.locator('[data-study-name="守望 Python SMA"]');
    await py.getByRole("button", { name: /添加/ }).click();
    await py.getByRole("button", { name: /添加/ }).click();
    const studies = await host.evaluate(() =>
      widget.activeChart().getAllStudies(),
    );
    assert.equal(studies.length, 2);
    assert.notEqual(studies[0].id, studies[1].id);
    await host.evaluate(
      (id) =>
        widget
          .activeChart()
          .getStudyById(id)
          .setInputValues([{ id: "period", value: 60 }]),
      studies[1].id,
    );
    assert.equal(await query.inputValue(), "SMA");
    record("连续添加、独立实例 ID 与 SMA(20)/SMA(60)");
    await dialog
      .getByRole("button", { name: "当前图表已添加", exact: true })
      .click();
    assert.equal(await dialog.locator("[data-instance-id]").count(), 2);
    await dialog.getByText("period=60", { exact: true }).waitFor();
    await dialog
      .locator("[data-instance-id]")
      .first()
      .getByRole("button", { name: /隐藏/ })
      .click();
    assert.equal(
      await host.evaluate(
        (id) => widget.activeChart().getStudyById(id).isVisible(),
        studies[0].id,
      ),
      false,
    );
    await dialog
      .locator("[data-instance-id]")
      .first()
      .getByRole("button", { name: /设置/ })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await host.evaluate(() => widget.closePopupsAndDialogs());
    await dialog.waitFor();
    assert.equal(await query.inputValue(), "SMA");
    record("显隐、原生参数设置、返回保留查询");
    await dialog.getByRole("button", { name: "全部", exact: true }).click();
    for (const name of ["EMA", "RSI", "MACD", "BBANDS"]) {
      await query.fill(name);
      await dialog
        .locator(`[data-study-name="守望 Python ${name}"]`)
        .getByRole("button", { name: /添加/ })
        .click();
    }
    record("已有 EMA/RSI/MACD/BBANDS 添加");
    await query.fill("");
    await page.screenshot({ path: OUT + "-dark.png" });
    await host.evaluate(() => widget.changeTheme("Light"));
    await page.screenshot({ path: OUT + "-light.png" });
    await page.setViewportSize({ width: 375, height: 720 });
    await page.screenshot({ path: OUT + "-narrow.png" });
    const box = await dialog.boundingBox();
    assert.ok(box.x >= 0 && box.width <= 375);
    await query.focus();
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press("Tab");
      assert.ok(
        await dialog.evaluate((n) => n.contains(n.ownerDocument.activeElement)),
      );
    }
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    record("浅深色、375px、焦点约束与 Escape");
    await page.setViewportSize({ width: 1440, height: 950 });
    await host.evaluate(() => widget.setLayout("2h"));
    await host.waitForFunction(
      () => widget.chartsCount() === 2 && widget.chart(1).dataReady(),
    );
    await host.evaluate(() => {
      widget
        .chart(1)
        .getAllStudies()
        .forEach((s) => widget.chart(1).removeEntity(s.id));
      widget.setActiveChart(1);
      indicatorPicker.open();
    });
    await dialog
      .getByRole("button", { name: "当前图表已添加", exact: true })
      .click();
    assert.equal(await dialog.locator("[data-instance-id]").count(), 0);
    await host.evaluate(() => widget.setActiveChart(0));
    assert.ok((await dialog.locator("[data-instance-id]").count()) >= 6);
    record("活动图表切换刷新实例列表");
    await dialog
      .locator("[data-instance-id]")
      .first()
      .getByRole("button", { name: /移除/ })
      .click();
    assert.equal(
      await host.evaluate(() => widget.chart(0).getAllStudies().length),
      5,
    );
    record("移除仅作用于具体实例");
    await dialog.getByRole("button", { name: "完成", exact: true }).click();
    await host.evaluate(() => snapshot());
    await host.waitForFunction(() => !nativeSaving && !dirty, null, {
      timeout: 15000,
    });
    host = null;
    await page.reload();
    await ready();
    const restored = await host.evaluate(() =>
      widget
        .chart(0)
        .getAllStudies()
        .map((s) => ({
          name: s.name,
          inputs: widget.chart(0).getStudyById(s.id).getInputValues(),
        })),
    );
    assert.ok(
      restored.some(
        (s) =>
          s.name.includes("SMA") &&
          s.inputs.some((p) => p.id === "period" && p.value === 60),
      ),
    );
    record("工作区刷新恢复原 study ID 与参数");
    await ui.getByRole("button", { name: "指标", exact: true }).click();
    await dialog.getByRole("button", { name: "收藏", exact: true }).click();
    await dialog.getByRole("button", { name: "打开原生收藏" }).click();
    const star = ui
      .locator('span[aria-label="添加到收藏"],span[aria-label="从收藏中移除"]')
      .first();
    await star.waitFor();
    const favoriteRow = star.locator("..");
    const label = (await favoriteRow.innerText()).trim(),
      before = await star.getAttribute("aria-label");
    const preferencesBefore = await (
      await context.request.get(APP + "/api/advanced-charts/preferences")
    ).json();
    await favoriteRow.hover();
    await star.click();
    const after = await star.getAttribute("aria-label");
    assert.notEqual(after, before);
    let changed = false;
    for (let i = 0; i < 40; i++) {
      const preferences = await (
        await context.request.get(APP + "/api/advanced-charts/preferences")
      ).json();
      changed = preferences.some(
        (row) =>
          row.kind === "setting" &&
          !preferencesBefore.some(
            (old) =>
              old.name === row.name &&
              JSON.stringify(old.content) === JSON.stringify(row.content),
          ),
      );
      if (changed) break;
      await page.waitForTimeout(250);
    }
    assert.ok(changed, "native favorites saved by server adapter");
    host = null;
    await page.reload();
    await ready();
    await ui.getByRole("button", { name: "指标", exact: true }).click();
    await dialog.getByRole("button", { name: "收藏", exact: true }).click();
    await dialog.getByRole("button", { name: "打开原生收藏" }).click();
    const restoredStar = ui
      .getByText(label, { exact: true })
      .last()
      .locator("..")
      .locator('span[aria-label*="收藏"]');
    assert.equal(await restoredStar.getAttribute("aria-label"), after);
    await restoredStar.locator("..").hover();
    await restoredStar.click();
    await host.evaluate(() => widget.closePopupsAndDialogs());
    await dialog.waitFor();
    record("原生收藏服务器持久化、刷新恢复、返回新窗口");
    assert.deepEqual(report.errors, []);
    record("无页面异常");
  } finally {
    fs.writeFileSync(OUT + ".json", JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
