// Actual licensed library; intercepted static resources and synthetic candles.
// API/UI integration only; this does not replace Docker/full-stack acceptance.
const { chromium } = require("@playwright/test");
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const ROOT = path.resolve(__dirname, "../../advanced-host");
const OUT =
  process.env.INDICATOR_NATIVE_OUTPUT || "/tmp/mw-indicator-acceptance/native";
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 950 },
  });
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.log("PAGE_ERROR", e.message);
  });
  page.on("console", (m) => {
    if (m.type() === "error") {
      errors.push(m.text());
      console.log("CONSOLE_ERROR", m.text());
    }
  });
  const catalog = {
    SMA: {
      label: "SMA 简单均线",
      pane: "main",
      aliases: ["SMA", "均线"],
      params: { period: 20 },
      series: [{ key: "value", type: "line" }],
    },
  };
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><div id="chart" style="height:100vh"></div>
    <script src="/charting_library/charting_library.js"></script><script src="/indicators.js"></script><script src="/native-ui.js"></script><script src="/indicator-picker.js"></script><script>
    const catalog=${JSON.stringify(catalog)};
    const feed={onReady:cb=>setTimeout(()=>cb({supported_resolutions:['5','60','1D']}),0),
      resolveSymbol:(name,cb)=>setTimeout(()=>cb({name,ticker:name,description:name,type:'crypto',session:'24x7',timezone:'Etc/UTC',minmov:1,pricescale:100,has_intraday:true,supported_resolutions:['5','60','1D'],volume_precision:0}),0),
      getBars:(symbol,res,period,cb)=>{const step=res==='5'?300:3600,bars=[];for(let i=0;i<period.countBack;i++){const time=(period.to-period.countBack*step+i*step)*1000;const close=100+Math.sin(time/10000000)*2;bars.push({time,open:close-1,high:close+2,low:close-2,close,volume:100});}setTimeout(()=>cb(bars,{noData:false}),0);},subscribeBars(){},unsubscribeBars(){}};
    const widget=new TradingView.widget({container:'chart',library_path:'/charting_library/',datafeed:feed,locale:'zh',symbol:'TEST',interval:'5',autosize:true,theme:'Dark',custom_css_url:'/chart-menu.css',disabled_features:['header_indicators','use_localstorage_for_settings'],enabled_features:['support_multicharts'],custom_indicators_getter:async p=>pythonStudies(p,catalog)});
    let picker;widget.onChartReady(async()=>{await widget.headerReady();picker=chartIndicatorPicker(widget,catalog,e=>{throw e;});});
    </script></body></html>`;
  await page.route("https://indicator.test/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/")
      return route.fulfill({ body: html, contentType: "text/html" });
    const file = path.join(ROOT, decodeURIComponent(url.pathname));
    if (!file.startsWith(ROOT + "/") || !fs.existsSync(file))
      return route.fulfill({ status: 404, body: "" });
    return route.fulfill({
      body: fs.readFileSync(file),
      contentType: file.endsWith(".js")
        ? "application/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : file.endsWith(".html")
            ? "text/html"
            : "application/octet-stream",
    });
  });
  try {
    await page.goto("https://indicator.test/");
    await page.waitForFunction(
      () => typeof picker !== "undefined" && picker,
      null,
      { timeout: 30000 },
    );
    let ui;
    const chartUi = page.frames().find((f) => f !== page.mainFrame());
    await chartUi.getByRole("button", { name: "指标", exact: true }).click();
    for (const f of page.frames())
      if (await f.locator(".mw-indicator-picker").count()) ui = f;
    assert.ok(ui);
    const dialog = ui.getByRole("dialog", { name: "指标", exact: true });
    await dialog.waitFor();
    const query = dialog.getByLabel("搜索指标");
    await query.fill("SMA");
    const rows = dialog.locator("[data-study-name]");
    assert.equal(await rows.count(), 2);
    const py = dialog.locator('[data-study-name="守望 Python SMA"]');
    await py.getByRole("button", { name: /添加/ }).click();
    await py.getByRole("button", { name: /添加/ }).click();
    await dialog
      .getByRole("button", { name: "设置刚添加的指标", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await ui.locator('[data-name="indicator-properties-dialog"]').waitFor();
    await page.evaluate(() => widget.closePopupsAndDialogs());
    await dialog.waitFor();
    assert.equal(await query.inputValue(), "SMA");
    await dialog
      .getByRole("button", { name: "当前图表已添加", exact: true })
      .click();
    assert.equal(await dialog.locator("[data-instance-id]").count(), 2);
    const added = await page.evaluate(() =>
      widget.activeChart().getAllStudies(),
    );
    assert.notEqual(added[0].id, added[1].id);
    await dialog.getByRole("button", { name: "完成", exact: true }).click();
    await page.evaluate(() => {
      globalThis.pickerCrosshairSamples = [];
      widget
        .activeChart()
        .crossHairMoved()
        .subscribe(null, (sample) => pickerCrosshairSamples.push(sample));
    });
    for (let attempt = 0; attempt < 10; attempt++) {
      await page.mouse.move(700 + attempt * 20, 250);
      await page.waitForTimeout(150);
      if (
        await page.evaluate(
          (ids) =>
            pickerCrosshairSamples.some((sample) =>
              ids.every((id) =>
                sample.entityValues?.[id]?.values.some((plot) =>
                  Number.isFinite(Number(plot.value)),
                ),
              ),
            ),
          added.map((s) => s.id),
        )
      )
        break;
    }
    assert.ok(
      await page.evaluate(
        (ids) =>
          pickerCrosshairSamples.some((sample) =>
            ids.every((id) =>
              sample.entityValues?.[id]?.values.some((plot) =>
                Number.isFinite(Number(plot.value)),
              ),
            ),
          ),
        added.map((s) => s.id),
      ),
      "public crosshair event exposes values for both study entities",
    );
    await chartUi.getByRole("button", { name: "指标", exact: true }).click();
    await dialog.waitFor();
    await dialog
      .locator("[data-instance-id]")
      .first()
      .getByRole("button", { name: /隐藏/ })
      .click();
    assert.equal(
      await page.evaluate(
        (id) => widget.activeChart().getStudyById(id).isVisible(),
        added[0].id,
      ),
      false,
    );
    await dialog
      .locator("[data-instance-id]")
      .first()
      .getByRole("button", { name: /设置/ })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await page.waitForTimeout(300);
    await ui.locator('[data-name="indicator-properties-dialog"]').waitFor();
    await page.evaluate(() => widget.closePopupsAndDialogs());
    await dialog.waitFor({ timeout: 5000 });
    assert.equal(await query.inputValue(), "SMA");
    await dialog
      .locator("[data-instance-id]")
      .first()
      .getByRole("button", { name: /移除/ })
      .click();
    assert.equal(await dialog.locator("[data-instance-id]").count(), 1);
    assert.ok(
      await dialog.evaluate((n) => n.contains(n.ownerDocument.activeElement)),
      "removal keeps focus in modal",
    );
    await dialog.getByRole("button", { name: "全部", exact: true }).click();
    await dialog
      .getByRole("button", { name: "我的 Python", exact: true })
      .click();
    await query.fill("Bollinger");
    await dialog.getByText("没有匹配的指标", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "在全部指标中搜索" }).click();
    assert.ok((await dialog.locator("[data-study-name]").count()) >= 1);
    await query.fill("");
    await page.screenshot({ path: OUT + "-dark.png" });
    await page.evaluate(() => widget.changeTheme("Light"));
    await page.screenshot({ path: OUT + "-light.png" });
    await page.setViewportSize({ width: 375, height: 720 });
    await page.screenshot({ path: OUT + "-narrow.png" });
    const box = await dialog.boundingBox();
    assert.ok(box.width <= 375 && box.x >= 0);
    const dimensions = await dialog.evaluate((n) => ({
      scroll: n.scrollWidth,
      width: n.clientWidth,
    }));
    assert.equal(dimensions.scroll, dimensions.width, "no horizontal overflow");
    await dialog.getByRole("button", { name: "我的 Python", exact: true }).click();
    assert.equal(await dialog.locator("[data-study-name]").count(), 1);
    await query.focus();
    for (let i = 0; i < 16; i++) {
      await page.keyboard.press("Tab");
      assert.ok(
        await dialog.evaluate((n) => n.contains(n.ownerDocument.activeElement)),
        "Tab focus stays in dialog",
      );
    }
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.ok(
      await ui
        .getByRole("button", { name: "指标", exact: true })
        .evaluate((n) => n === n.ownerDocument.activeElement),
      "close returns focus to trigger",
    );
    await page.setViewportSize({ width: 1440, height: 950 });
    await page.evaluate(() => widget.setLayout("2h"));
    await page.waitForFunction(
      () => widget.chartsCount() === 2 && widget.chart(1).dataReady(),
    );
    await page.evaluate(() => {
      widget
        .chart(1)
        .getAllStudies()
        .forEach((s) => widget.chart(1).removeEntity(s.id));
      widget.setActiveChart(1);
      picker.open();
    });
    await dialog
      .getByRole("button", { name: "当前图表已添加", exact: true })
      .click();
    // Volume is a default native study in this harness. Check Python instances only.
    assert.equal(
      await dialog
        .locator("[data-instance-id]")
        .filter({ hasText: "SMA" })
        .count(),
      0,
    );
    await page.evaluate(() => widget.setActiveChart(0));
    assert.equal(
      await dialog
        .locator("[data-instance-id]")
        .filter({ hasText: "SMA" })
        .count(),
      1,
    );
    await dialog.getByRole("button", { name: "全部", exact: true }).click();
    await query.fill("SMA");
    await page.evaluate(() => {
      const chart = widget.chart(0),
        create = chart.createStudy.bind(chart);
      chart.createStudy = (...args) =>
        new Promise((resolve, reject) => {
          globalThis.releaseStudy = () => create(...args).then(resolve, reject);
        });
    });
    await dialog.getByRole("status").evaluate((n) => {
      n.textContent = "";
    });
    await py.getByRole("button", { name: /添加/ }).click();
    await page.waitForFunction(() => typeof releaseStudy === "function");
    await page.evaluate(() => {
      widget.setActiveChart(1);
      releaseStudy();
    });
    await dialog
      .getByRole("status")
      .getByText(/已添加/)
      .waitFor();
    await page.waitForFunction(
      () =>
        widget
          .chart(0)
          .getAllStudies()
          .filter((s) => s.name.includes("SMA")).length === 2,
    );
    assert.equal(
      await page.evaluate(
        () =>
          widget
            .chart(1)
            .getAllStudies()
            .filter((s) => s.name.includes("SMA")).length,
      ),
      0,
      "pending addition stays on originating chart",
    );
    await dialog.getByRole("button", { name: "完成", exact: true }).click();
    await page.evaluate(async () => {
      widget.setActiveChart(0);
      const study = widget
        .chart(0)
        .getAllStudies()
        .find((s) => s.name.includes("SMA"));
      widget
        .chart(0)
        .getStudyById(study.id)
        .setInputValues([{ id: "period", value: 60 }]);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const state = await new Promise((resolve) => widget.save(resolve));
      await widget.load(state);
    });
    await page.waitForFunction(() => widget.chart(0).dataReady());
    const restored = await page.evaluate(() =>
      widget
        .chart(0)
        .getAllStudies()
        .map((study) => ({
          name: study.name,
          inputs: widget.chart(0).getStudyById(study.id).getInputValues(),
        })),
    );
    assert.ok(
      restored.some(
        (study) =>
          study.name === "守望 Python SMA" &&
          study.inputs.some(
            (input) => input.id === "period" && input.value === 60,
          ),
      ),
      "native saved study identity and parameter restore",
    );
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      OUT + ".json",
      JSON.stringify(
        {
          at: new Date().toISOString(),
          scope:
            "real v31 library, intercepted assets, synthetic candles; no Docker/full-stack claim",
          passed: [
            "public header button",
            "Chinese/English search and source",
            "continuous duplicate additions",
            "public crosshair event values for both study entities",
            "instance visibility/removal",
            "native properties return with query",
            "direct settings after addition",
            "category empty results",
            "Light/Dark",
            "375px category tabs and no overflow",
            "Tab loop/Escape/focus return",
            "active chart instances",
            "pending addition captured chart",
            "native study identity and input save/load",
          ],
          pageErrors: errors,
        },
        null,
        2,
      ),
    );
    console.log("Actual native library picker integration passed");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
