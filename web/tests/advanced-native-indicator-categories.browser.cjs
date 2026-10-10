// Actual licensed library; intercepted static resources and synthetic candles.
// API/UI integration only; this does not replace Docker/full-stack acceptance.
const { chromium } = require("@playwright/test");
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const ROOT = path.resolve(__dirname, "../../advanced-host");
const OUT =
  process.env.INDICATOR_NATIVE_OUTPUT || "/tmp/mw-native-indicator-categories";
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
    <script src="/charting_library/charting_library.js"></script><script src="/indicators.js"></script><script src="/native-ui.js"></script><script src="/native-indicator-dialog.js"></script><script src="/indicator-picker.js"></script><script>
    const catalog=${JSON.stringify(catalog)};
    const feed={onReady:cb=>setTimeout(()=>cb({supported_resolutions:['5','60','1D']}),0),
      resolveSymbol:(name,cb)=>setTimeout(()=>cb({name,ticker:name,description:name,type:'crypto',session:'24x7',timezone:'Etc/UTC',minmov:1,pricescale:100,has_intraday:true,supported_resolutions:['5','60','1D'],volume_precision:0}),0),
      getBars:(symbol,res,period,cb)=>{const step=res==='5'?300:3600,bars=[];for(let i=0;i<period.countBack;i++){const time=(period.to-period.countBack*step+i*step)*1000;const close=100+Math.sin(time/10000000)*2;bars.push({time,open:close-1,high:close+2,low:close-2,close,volume:100});}setTimeout(()=>cb(bars,{noData:false}),0);},subscribeBars(){},unsubscribeBars(){}};
    const widget=new TradingView.widget({container:'chart',library_path:'/charting_library/',datafeed:feed,locale:'zh',symbol:'TEST',interval:'5',autosize:true,theme:'Dark',custom_css_url:'/chart-menu.css',disabled_features:['header_indicators','use_localstorage_for_settings'],enabled_features:['support_multicharts','items_favoriting'],custom_indicators_getter:async p=>pythonStudies(p,catalog)});
    let picker;widget.onChartReady(async()=>{await widget.headerReady();const probe=widget.createButton({useTradingViewStyle:false}),nativeUi=chartNativeUi(widget,probe.ownerDocument);widget.removeButton(probe);picker=chartIndicatorPicker(widget,catalog,e=>{throw e;},()=>nativeUi);});
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
    await page.waitForFunction(() => widget.activeChart().dataReady());
    await page.evaluate(() => {
      for (const study of widget.activeChart().getAllStudies())
        widget.activeChart().removeEntity(study.id);
    });
    const ui = page.frames().find((frame) => frame !== page.mainFrame());
    await ui.getByRole("button", { name: "指标", exact: true }).click();
    const dialog = ui.locator('[data-name="indicators-dialog"]');
    await dialog.waitFor({ timeout: 30000 });

    fs.mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: path.join(OUT, "first-open.png") });
    const query = dialog.getByLabel("搜索指标", { exact: true });
    await query.fill("SMA");
    await dialog
      .getByRole("button", { name: "我的 Python", exact: true })
      .click();
    const py = dialog.locator('[data-study-name="守望 Python SMA"]');

    await py.waitFor();

    await py.locator('[data-role="list-item"]').click();
    await page.waitForFunction(
      () => widget.activeChart().getAllStudies().length === 1,
    );
    await py.locator('[data-role="list-item"]').click();
    await page.waitForFunction(
      () => widget.activeChart().getAllStudies().length === 2,
    );
    const star = py.getByLabel("添加到收藏", { exact: true });
    await star.click();
    await dialog.getByRole("button", { name: "收藏", exact: true }).click();
    assert.equal(
      await dialog.locator('[data-study-name="守望 Python SMA"]').count(),
      1,
    );
    await dialog
      .getByRole("button", { name: "查看 SMA 简单均线详情", exact: true })
      .click();
    await dialog.locator(".mw-native-indicator-detail").waitFor();
    await page.screenshot({ path: path.join(OUT, "detail.png") });
    await page.keyboard.press("Escape");
    await dialog
      .getByRole("button", { name: "当前图表已添加", exact: true })
      .click();
    assert.equal(await dialog.locator("[data-instance-id]").count(), 2);
    await dialog
      .getByRole("button", { name: "设置刚添加的指标", exact: true })
      .click();
    await ui.locator('[data-name="indicator-properties-dialog"]').waitFor();
    await page.evaluate(() => widget.closePopupsAndDialogs());
    await dialog.waitFor();
    assert.equal(await query.inputValue(), "SMA");
    await page.screenshot({ path: path.join(OUT, "added.png") });
    for (const theme of ["Dark", "Light"]) {
      await page.evaluate((theme) => widget.changeTheme(theme), theme);
      for (const width of [1440, 768, 375]) {
        await page.setViewportSize({ width, height: 900 });
        if (width < 750) {
          await dialog
            .getByRole("button", { name: "指标分类", exact: true })
            .click();
          await ui.getByRole("option", { name: "收藏", exact: true }).click();
        } else
          await dialog
            .getByRole("button", { name: "收藏", exact: true })
            .click();
        await dialog
          .getByRole("button", { name: "查看 SMA 简单均线详情", exact: true })
          .click();
        const detail = dialog.locator(".mw-native-indicator-detail");
        await detail.waitFor();
        assert.equal(
          await detail.evaluate((n) => n.scrollWidth <= n.clientWidth + 1),
          true,
        );
        assert.equal(
          await dialog
            .locator(".mw-native-indicator-content")
            .evaluate((n) => n.scrollWidth <= n.clientWidth + 1),
          true,
        );
        if (width < 850)
          for (const key of ["Tab", "Shift+Tab"])
            for (let i = 0; i < 5; i++) {
              await page.keyboard.press(key);
              assert.equal(
                await ui.evaluate(
                  () =>
                    !!document.activeElement.closest(
                      ".mw-native-indicator-detail",
                    ),
                ),
                true,
              );
            }
        await page.screenshot({
          path: path.join(OUT, `detail-${theme.toLowerCase()}-${width}.png`),
        });
        await page.keyboard.press("Escape");
        if (width < 750) {
          await dialog
            .getByRole("button", { name: "指标分类", exact: true })
            .click();
          await page.keyboard.press("Escape");
          assert.equal(await dialog.isVisible(), true);
        }
      }
    }
    assert.deepEqual(errors, []);
    console.log(
      "PASS native categories, add, favorite, detail, added and settings return",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
