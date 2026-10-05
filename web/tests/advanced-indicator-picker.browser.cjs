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
  status: "running",
  scope: "Ubuntu Docker full stack, actual provider candles",
  cases: [],
  marketData: [],
  policyBlocks: [],
  errors: [],
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
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
    // This isolated instance has public Binance access only. The product's
    // default watchlist includes FX symbols requiring configured OANDA access.
    const initialPreferences = await (
      await context.request.get(APP + "/api/advanced-charts/preferences")
    ).json();
    const oldWatchlist = initialPreferences.find(
      (p) => p.kind === "setting" && p.name === "mw.watchlists.v1",
    );
    await post("advanced-charts/preferences/save", {
      kind: "setting",
      name: "mw.watchlists.v1",
      tool: "",
      revision: oldWatchlist?.revision || 0,
      content: {
        value: {
          lists: [
            {
              id: "indicator-binance-watchlist",
              title: "指标验收",
              symbols: ["MWP:BTCUSDT"],
            },
          ],
          active: "indicator-binance-watchlist",
        },
      },
    });
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
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      // Existing vendor sampling occasionally tries analytics (documented in
      // advanced-charts-integration.md). Record the exact CSP block separately;
      // no other console error is exempt and no successful external response is allowed.
      if (
        m
          .text()
          .startsWith(
            "Loading the script 'https://www.google-analytics.com/analytics.js' violates the following Content Security Policy directive:",
          ) &&
        m.text().endsWith("The action has been blocked.")
      )
        report.policyBlocks.push(m.text());
      else report.errors.push(m.text());
    });
    const indicatorResponses = [],
      responseTasks = new Set();
    const historyQueries = new Map();
    page.on("response", (response) => {
      if (response.url().startsWith("https://www.google-analytics.com/"))
        report.errors.push(
          "Unexpected external analytics response " + response.status(),
        );
      if (
        response.status() >= 400 &&
        response.url().startsWith(APP + "/api/")
      ) {
        const task = response
          .text()
          .then((body) => {
            report.errors.push(
              new URL(response.url()).pathname +
                " " +
                response.status() +
                " " +
                body +
                " query=" +
                JSON.stringify(response.request().postDataJSON()),
            );
          })
          .catch(() => {});
        responseTasks.add(task);
        task.finally(() => responseTasks.delete(task));
      }
      const endpoint = new URL(response.url()).pathname;
      if (
        endpoint !== "/api/charts/data" &&
        endpoint !== "/api/charts/history-loads" &&
        !/^\/api\/charts\/history-loads\/[^/]+\/result$/.test(endpoint)
      )
        return;
      const task = (async () => {
        let input, result;
        if (endpoint === "/api/charts/data") {
          input = response.request().postDataJSON();
          if (input?.indicators?.length) result = await response.json();
        } else {
          const payload = await response.json();
          if (endpoint === "/api/charts/history-loads") {
            input = response.request().postDataJSON()?.query;
            if (payload.load) historyQueries.set(payload.load.id, input);
          } else input = historyQueries.get(endpoint.split("/").at(-2));
          result = payload.result;
        }
        if (!input?.indicators?.length) return;
        assert.ok(response.ok(), "indicator data HTTP " + response.status());
        if (result) indicatorResponses.push({ input, result });
      })().catch((e) => report.errors.push(e.message));
      responseTasks.add(task);
      task.finally(() => responseTasks.delete(task));
    });
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
    await dialog
      .locator('[data-study-name="Moving Average"]')
      .getByRole("button", { name: /添加/ })
      .click();
    const nativeAdded = await host.evaluate(() =>
      widget.activeChart().getAllStudies(),
    );
    assert.equal(nativeAdded.length, 1);
    assert.equal(nativeAdded[0].name, "Moving Average");
    await host.evaluate(
      (id) => widget.activeChart().removeEntity(id),
      nativeAdded[0].id,
    );
    record("内置 SMA 经新窗口添加与移除");
    const py = dialog.locator('[data-study-name="守望 Python SMA"]');
    await py.getByRole("button", { name: /添加/ }).click();
    await py.getByRole("button", { name: /添加/ }).click();
    await dialog
      .getByRole("button", { name: "设置刚添加的指标", exact: true })
      .click();
    await ui.locator('[data-name="indicator-properties-dialog"]').waitFor();
    await host.evaluate(() => widget.closePopupsAndDialogs());
    await dialog.waitFor();
    assert.equal(await query.inputValue(), "SMA");
    record("添加后直接设置与返回");
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
    await ui.locator('[data-name="indicator-properties-dialog"]').waitFor();
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
    const expected = [
      ["SMA", 20],
      ["SMA", 60],
      ["EMA"],
      ["RSI"],
      ["MACD"],
      ["BBANDS"],
    ];
    const matchingResponse = ([name, period]) =>
      indicatorResponses.findLast(
        ({ input, result }) =>
          input.series_kind === "provider" &&
          input.instrument === "BTCUSDT" &&
          input.timeframe === "M5" &&
          input.indicators.some(
            (s) =>
              s.name === name &&
              (period === undefined || s.params.period === period),
          ) &&
          result.bars.length >= 100 &&
          result.indicators.some(
            (s) =>
              s.name === name &&
              s.series.length &&
              s.series.every(
                (plot) =>
                  plot.values.filter((v) => Number.isFinite(v.value)).length >=
                  50,
              ),
          ),
      );
    for (
      let attempt = 0;
      attempt < 240 && !expected.every((spec) => matchingResponse(spec));
      attempt++
    )
      await page.waitForTimeout(250);
    for (const spec of expected)
      assert.ok(
        matchingResponse(spec),
        "actual provider values " + spec.join("/"),
      );
    // This supplied v31 package lacks zh.20866 required by exportData. Public
    // crossHairMoved exposes displayed study values without accessing vendor internals.
    report.chartValueInterface =
      "public crossHairMoved.entityValues (5 decimal study precision)";
    const sharedFirst = Math.max(
      ...expected.map((spec) => matchingResponse(spec).result.bars[0].start),
    );
    const sharedLast =
      Math.min(
        ...expected.map(
          (spec) => matchingResponse(spec).result.bars.at(-1).start,
        ),
      ) - 300000;
    assert.ok(
      sharedLast - sharedFirst >= 3600000,
      "shared actual closed-candle coverage",
    );
    await dialog.getByRole("button", { name: "完成", exact: true }).click();
    await host.evaluate(
      async ({ from, to }) => {
        await widget.chart(0).setVisibleRange({ from, to });
        globalThis.acceptanceCrosshair = [];
        widget
          .chart(0)
          .crossHairMoved()
          .subscribe(null, (sample) => acceptanceCrosshair.push(sample));
        // Restore SMA(20) visibility so the public event includes its displayed values.
        widget
          .chart(0)
          .getAllStudies()
          .forEach((s) => widget.chart(0).getStudyById(s.id).setVisible(true));
      },
      {
        from: Math.max(sharedFirst, sharedLast - 7200000) / 1000,
        to: sharedLast / 1000,
      },
    );
    await host.waitForFunction(() => widget.chart(0).dataReady());
    const chartBox = await ui.locator(".chart-container").first().boundingBox();
    assert.ok(chartBox, "native chart plotting area");
    let crosshair = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      for (let i = 0; i < 12; i++) {
        await page.mouse.move(
          chartBox.x + chartBox.width * (0.3 + i * 0.035),
          chartBox.y + 130,
        );
        await page.waitForTimeout(80);
      }
      crosshair = await host.evaluate(() => acceptanceCrosshair);
      if (
        crosshair.some(
          (sample) =>
            sample.entityValues && Object.keys(sample.entityValues).length >= 7,
        )
      )
        break;
      await page.waitForTimeout(500);
    }
    for (const spec of expected) {
      const response = matchingResponse(spec);
      const { input, result } = response;
      const study = await host.evaluate(
        ([name, period]) =>
          widget
            .chart(0)
            .getAllStudies()
            .find(
              (s) =>
                s.name === "守望 Python " + name &&
                (period === undefined ||
                  widget
                    .chart(0)
                    .getStudyById(s.id)
                    .getInputValues()
                    .some((p) => p.id === "period" && p.value === period)),
            ),
        spec,
      );
      assert.ok(study, "study identity " + spec.join("/"));
      const indicator = result.indicators.find((s) => s.name === spec[0]);
      const samples = [];
      for (const plot of indicator.series) {
        const backend = new Map(plot.values.map((v) => [v.time, v.value]));
        const unique = new Map(
          crosshair.map((sample) => [sample.time, sample]),
        );
        const matched = [];
        for (const sample of unique.values()) {
          const displayed = sample.entityValues?.[study.id]?.values.find(
            (v) => v.title === plot.key,
          );
          const actual = displayed
            ? Number(
                displayed.value
                  .replace(/[,\u202f\u00a0]/g, "")
                  .replace("−", "-"),
              )
            : NaN;
          const value = backend.get(sample.time * 1000);
          if (!Number.isFinite(actual) || !Number.isFinite(value)) continue;
          assert.ok(
            Math.abs(actual - value) <= 1.1e-5,
            study.name +
              "/" +
              plot.key +
              " chart/backend mismatch: " +
              actual +
              " / " +
              value,
          );
          matched.push({
            time: sample.time,
            displayed: actual,
            backend: value,
          });
        }
        assert.ok(
          matched.length >= 5,
          study.name +
            "/" +
            plot.key +
            " needs 5 rendered closed-candle samples",
        );
        samples.push({ plot: plot.key, matched });
      }
      report.marketData.push({
        name: spec[0],
        params: input.indicators[0].params,
        bars: result.bars.length,
        first: result.bars[0].start,
        last: result.bars.at(-1).start,
        plots: indicator.series.map((s) => s.key),
        studyId: study.id,
        samples,
      });
    }
    record(
      "真实 BTCUSDT M5：六个实例全部曲线非空，公开十字光标值与后端逐点一致",
    );
    await ui.getByRole("button", { name: "指标", exact: true }).click();
    await dialog.waitFor();
    await query.fill("");
    await host.evaluate(() => widget.changeTheme("Dark"));
    await dialog.evaluate(
      (node) =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const darkBackground = await dialog.evaluate(
      (node) => getComputedStyle(node).backgroundColor,
    );
    await page.screenshot({ path: OUT + "-dark.png" });
    await host.evaluate(() => widget.changeTheme("Light"));
    await dialog.evaluate(
      (node) =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    assert.notEqual(
      await dialog.evaluate((node) => getComputedStyle(node).backgroundColor),
      darkBackground,
    );
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
    const raceIds = await host.evaluate(() => {
      const chart = widget.chart(0),
        create = chart.createStudy.bind(chart);
      const ids = chart.getAllStudies().map((s) => s.id);
      chart.createStudy = (...args) =>
        new Promise((resolve, reject) => {
          globalThis.releaseAcceptanceStudy = () => {
            chart.createStudy = create;
            return create(...args).then(resolve, reject);
          };
        });
      return ids;
    });
    await dialog.getByRole("button", { name: "全部", exact: true }).click();
    await query.fill("SMA");
    await py.getByRole("button", { name: /添加/ }).click();
    await host.waitForFunction(
      () => typeof releaseAcceptanceStudy === "function",
    );
    await host.evaluate(() => {
      widget.setActiveChart(1);
      releaseAcceptanceStudy();
    });
    await host.waitForFunction(
      () => widget.chart(0).getAllStudies().length === 7,
    );
    assert.equal(
      await host.evaluate(() => widget.chart(1).getAllStudies().length),
      0,
    );
    await host.evaluate((ids) => {
      const chart = widget.chart(0);
      chart
        .getAllStudies()
        .filter((s) => !ids.includes(s.id))
        .forEach((s) => chart.removeEntity(s.id));
      widget.setActiveChart(0);
    }, raceIds);
    record("延迟添加时切换活动图表，真实产品实例仍归属发起图表");
    await dialog
      .getByRole("button", { name: "当前图表已添加", exact: true })
      .click();
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
    const templateSignature = await host.evaluate(
      async (initial) => {
        const chart = widget.chart(0);
        const signature = chart
          .getAllStudies()
          .map((s) => ({
            name: s.name,
            inputs: chart.getStudyById(s.id).getInputValues(),
            styles: chart.getStudyById(s.id).getStyleValues(),
            visible: chart.getStudyById(s.id).isVisible(),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        const template = chart.createStudyTemplate({
          saveSymbol: false,
          saveInterval: false,
        });
        globalThis.acceptanceTemplates = nativePreferences(
          initial,
          (op, args) => request({ op, args }, "preferences"),
          false,
          (e) => {
            throw e;
          },
        ).templates;
        await acceptanceTemplates.saveStudyTemplate({
          name: "指标独立验收模板",
          content: JSON.stringify(template),
        });
        return signature;
      },
      await (
        await context.request.get(APP + "/api/advanced-charts/preferences")
      ).json(),
    );
    record("原生指标模板经正式 Adapter 保存到独立数据库");
    const savedIds = await host.evaluate(() =>
      widget
        .chart(0)
        .getAllStudies()
        .map((s) => s.id)
        .sort(),
    );
    const workspaceSaved = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/advanced-charts/native-charts/save") && r.ok(),
      { timeout: 30000 },
    );
    await host.evaluate(() => snapshot());
    await workspaceSaved;
    await host.waitForFunction(
      () => !nativeSaving && !manualSavePending,
      null,
      {
        timeout: 30000,
      },
    );
    await host.waitForFunction(() => !pending.size && !requests.length, null, {
      timeout: 45000,
    });
    await Promise.all([...responseTasks]);
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
    assert.deepEqual(
      await host.evaluate(() =>
        widget
          .chart(0)
          .getAllStudies()
          .map((s) => s.id)
          .sort(),
      ),
      savedIds,
    );
    assert.ok(
      restored.some(
        (s) =>
          s.name.includes("SMA") &&
          s.inputs.some((p) => p.id === "period" && p.value === 60),
      ),
    );
    record("工作区刷新恢复原 study ID 与参数");
    await host.evaluate(
      async (initial) => {
        const chart = widget.chart(0);
        globalThis.acceptanceTemplates = nativePreferences(
          initial,
          (op, args) => request({ op, args }, "preferences"),
          false,
          (e) => {
            throw e;
          },
        ).templates;
        const content = await acceptanceTemplates.getStudyTemplateContent({
          name: "指标独立验收模板",
        });
        chart.getAllStudies().forEach((s) => chart.removeEntity(s.id));
        chart.applyStudyTemplate(JSON.parse(content));
      },
      await (
        await context.request.get(APP + "/api/advanced-charts/preferences")
      ).json(),
    );
    await host.waitForFunction(
      (count) => widget.chart(0).getAllStudies().length === count,
      templateSignature.length,
    );
    const restoredTemplateSignature = await host.evaluate(() => {
      const chart = widget.chart(0);
      return chart
        .getAllStudies()
        .map((s) => ({
          name: s.name,
          inputs: chart.getStudyById(s.id).getInputValues(),
          styles: chart.getStudyById(s.id).getStyleValues(),
          visible: chart.getStudyById(s.id).isVisible(),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    });
    assert.deepEqual(restoredTemplateSignature, templateSignature);
    record("服务器模板刷新恢复参数、曲线样式与显隐");
    const legacy = JSON.parse(
      fs.readFileSync(
        "/tmp/mw-indicator-acceptance/legacy-fixture.json",
        "utf8",
      ),
    );
    assert.equal(legacy.symbol, "MWP:BTCUSDT");
    const signature = () =>
      host.evaluate(() =>
        widget
          .chart(0)
          .getAllStudies()
          .map((s) => {
            const api = widget.chart(0).getStudyById(s.id);
            return {
              id: s.id,
              name: s.name,
              inputs: api.getInputValues(),
              styles: api.getStyleValues(),
              visible: api.isVisible(),
            };
          }),
      );
    await host.evaluate((state) => widget.load(state), legacy.state);
    await host.waitForFunction(
      () =>
        widget.chart(0).getAllStudies().length === 8 &&
        widget.chart(0).dataReady(),
    );
    assert.deepEqual(await signature(), legacy.signature);
    const legacySaved = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/advanced-charts/native-charts/save") && r.ok(),
      { timeout: 30000 },
    );
    await host.evaluate(() => snapshot());
    await legacySaved;
    await host.waitForFunction(
      () => !nativeSaving && !manualSavePending,
      null,
      { timeout: 30000 },
    );
    await host.waitForFunction(() => !pending.size && !requests.length, null, {
      timeout: 45000,
    });
    await Promise.all([...responseTasks]);
    host = null;
    await page.reload();
    await ready();
    assert.deepEqual(await signature(), legacy.signature);
    record(
      "v1.7.0 旧布局经过真实数据库保存、刷新恢复：8 个实体 ID、参数、样式与显隐一致",
    );
    await host.evaluate(async (template) => {
      const chart = widget.chart(0);
      chart.getAllStudies().forEach((s) => chart.removeEntity(s.id));
      chart.applyStudyTemplate(template);
    }, legacy.template);
    await host.waitForFunction(
      () => widget.chart(0).getAllStudies().length === 8,
    );
    assert.deepEqual(
      (await signature()).map(({ id, ...rest }) => rest),
      legacy.signature.map(({ id, ...rest }) => rest),
    );
    record("v1.7.0 旧模板在真实产品中恢复 8 个指标参数与样式");
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
    await host.waitForFunction(() => !pending.size && !requests.length, null, {
      timeout: 45000,
    });
    await Promise.all([...responseTasks]);
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
    await Promise.all([...responseTasks]);
    assert.deepEqual(report.errors, []);
    record("无页面异常");
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.failure = error.message;
    throw error;
  } finally {
    fs.writeFileSync(OUT + ".json", JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch((e) => {
  report.status = "failed";
  report.failure = e.message;
  fs.writeFileSync(OUT + ".json", JSON.stringify(report, null, 2));
  console.error(e);
  process.exit(1);
});
