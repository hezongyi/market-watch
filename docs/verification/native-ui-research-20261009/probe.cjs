/** Read-only native UI research; run from repository root.
 * Requires the installed licensed TT v31.1.0 library and Playwright Chromium.
 * The intercepted page uses a synthetic feed. No login or business API write.
 * Internal module IDs below are tied to the recorded runtime manifest.
 */
const fs = require("node:fs");
const { expect } = require("../../../web/node_modules/@playwright/test");
const f = require("../../../web/tests/chart-data-center-fixture.cjs");
fs.mkdirSync("artifacts/native-ui-research", { recursive: true });
(async () => {
  const b = await f.launch();
  const p = await b.newPage({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
  });
  const report = {
    environment:
      "Ubuntu chart origin installed library; synthetic read-only widget",
    dialogs: [],
    errors: [],
  };
  p.on("pageerror", (e) => report.errors.push(e.message));
  p.on("console", (m) => {
    if (m.type() === "error") console.log("BROWSER", m.text().slice(0, 500));
  });
  p.on("response", (r) => {
    if (r.status() >= 400) console.log("HTTP", r.status(), r.url());
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="chart" style="height:100vh"></div><script src="/charting_library/charting_library.js"></script><script>
const feed={onReady:cb=>setTimeout(()=>cb({supported_resolutions:['1','60','1D'],exchanges:[{value:'TEST',name:'TEST',desc:'研究来源'}],symbols_types:[{name:'全部',value:''},{name:'外汇',value:'forex'}]}),0),searchSymbols:(q,e,t,cb)=>setTimeout(()=>cb([{symbol:'GBP/USD',ticker:'TEST:GBPUSD',description:'只读 UI 调研',exchange:'TEST',type:'forex'}]),0),resolveSymbol:(s,cb)=>setTimeout(()=>cb({name:s,ticker:s,description:'只读 UI 调研',type:'forex',session:'24x7',timezone:'Etc/UTC',exchange:'TEST',minmov:1,pricescale:100000,has_intraday:true,supported_resolutions:['1','60','1D'],volume_precision:0,data_status:'endofday'}),0),getBars:(s,r,p,cb)=>{const step=r==='1'?60:r==='1D'?86400:3600,bars=[];for(let i=0;i<p.countBack;i++){bars.push({time:(p.to-p.countBack*step+i*step)*1000,open:1.1,high:1.12,low:1.09,close:1.11,volume:100});}setTimeout(()=>cb(bars,{noData:false}),0);},subscribeBars:()=>{},unsubscribeBars:()=>{}};
window.widget=new TradingView.widget({container:'chart',library_path:'/charting_library/',datafeed:feed,symbol:'TEST:EURUSD',interval:'60',locale:'zh',autosize:true,theme:'Dark',disabled_features:['use_localstorage_for_settings','create_volume_indicator_by_default']});window.ready=false;widget.onChartReady(()=>window.ready=true);
</script></body></html>`;
  await p.route(f.chartOrigin + "/native-ui-research", (r) =>
    r.fulfill({ contentType: "text/html", body: html }),
  );
  const native = () => p.frames().find((x) => x.url().startsWith("blob:"));
  try {
    await p.goto(f.chartOrigin + "/native-ui-research");
    await p.waitForFunction(() => ready, null, { timeout: 20000 });
    report.version = await p.evaluate(() => TradingView.version?.());
    const scan = async (name, selector) => {
      const d =
        selector === "@symbol-search"
          ? native().getByRole("dialog", { name: "商品代码搜索" })
          : native().locator(selector);
      await expect(d).toBeVisible();
      report.dialogs.push(
        await d.evaluate((e, name) => {
          const anc = [];
          let par = e;
          for (let i = 0; par && i < 5; i++, par = par.parentElement)
            anc.push({
              tag: par.tagName,
              classes: par.className,
              name: par.dataset.name,
              role: par.getAttribute("role"),
            });
          const r = e.getBoundingClientRect();
          return {
            name,
            tag: e.tagName,
            classes: e.className,
            bounds: { width: r.width, height: r.height },
            ancestors: anc,
            buttons: [...e.querySelectorAll("button")]
              .slice(0, 25)
              .map((n) => ({
                name: n.dataset.name,
                text: n.textContent.trim().slice(0, 50),
                role: n.getAttribute("role"),
              })),
            inputs: [...e.querySelectorAll("input")]
              .slice(0, 12)
              .map((n) => ({
                type: n.type,
                placeholder: n.placeholder,
                classes: n.className,
                name: n.dataset.name,
              })),
            tabs: [...e.querySelectorAll("[role=tab]")].map((n) =>
              n.textContent.trim(),
            ),
          };
        }, name),
      );
      await p.screenshot({ path: `artifacts/native-ui-research/${name}.png` });
    };
    for (const [name, action, selector] of [
      [
        "chart-settings",
        "chartProperties",
        '[data-name="series-properties-dialog"]',
      ],
      ["symbol-search", "symbolSearch", "@symbol-search"],
      ["indicators", "insertIndicator", '[data-name="indicators-dialog"]'],
    ]) {
      await p.evaluate(
        (a) => widget.activeChart().executeActionById(a),
        action,
      );
      await scan(name, selector);
      await p.evaluate(() => widget.closePopupsAndDialogs());
    }
    await p.evaluate(() =>
      widget.showNoticeDialog({
        title: "原生外壳调研",
        body: "只读验证",
        callback: () => {},
      }),
    );
    await scan("notice", '[data-name="warning-dialog"]');
    await p.evaluate(() => widget.closePopupsAndDialogs());
    await p.evaluate(() =>
      widget.showConfirmDialog({
        title: "原生确认调研",
        body: "不提交任何操作",
        callback: () => {},
      }),
    );
    await scan("confirmation", '[data-name="confirm-dialog"]');
    await p.evaluate(() => widget.closePopupsAndDialogs());
    report.exports = await native().evaluate(() => {
      let req;
      self.webpackChunktradingview.push([
        ["mw-research-" + Date.now()],
        {},
        (r) => (req = r),
      ]);
      const terms = [
        "GeneralChartPropertiesDialogRenderer",
        "DialogSidebarItem",
        "SymbolSearchDialog",
        "SymbolSearchDialogContent",
        "SearchBar",
        "SimpleDialog",
        "AdaptivePopupDialog",
        "PopupDialog",
        "InputControl",
        "Checkbox",
        "Select",
      ];
      const out = [];
      for (const [id, m] of Object.entries(req.m)) {
        const src = String(m),
          found = terms.filter((t) => src.includes(t));
        if (!found.length || src.length > 50000) continue;
        try {
          const e = req(id);
          const keys = Object.keys(e);
          if (!keys.some((k) => terms.some((t) => k.includes(t)))) continue;
          out.push({ id, exports: keys });
        } catch (e) {}
        if (out.length >= 60) break;
      }
      return out;
    });
    report.loadedAssets = await native().evaluate(() =>
      performance
        .getEntriesByType("resource")
        .filter((e) => /\.(js|css)(?:$|\?)/.test(e.name))
        .map((e) => new URL(e.name).pathname),
    );
    report.picker = {
      before: await p.evaluate(() => widget.activeChart().symbol()),
    };
    report.picker.exports = await native().evaluate(() => {
      let req;
      self.webpackChunktradingview.push([
        ["mw-picker-" + Date.now()],
        {},
        (r) => (req = r),
      ]);
      const impl = req(21021);
      window.__mwSelections = [];
      window.__mwPickerClosed = false;
      window.__mwPicker = impl.showSymbolSearchItemsDialog({
        dialogTitle: "只读品种选择验证",
        defaultValue: "GBP",
        showSpreadActions: false,
        disableRecents: true,
        onSearchComplete: (rows) =>
          window.__mwSelections.push(
            rows.map((row) => ({
              symbol: row.symbol,
              ticker: row.result?.ticker,
            })),
          ),
        onClose: () => (window.__mwPickerClosed = true),
      });
      return Object.keys(impl);
    });
    const picker = native().getByRole("dialog", { name: "只读品种选择验证" });
    await expect(picker).toBeVisible();
    await expect(picker.getByText("GBP/USD", { exact: true })).toBeVisible();
    await p.screenshot({
      path: "artifacts/native-ui-research/pure-picker.png",
    });
    await picker.getByText("GBP/USD", { exact: true }).click();
    await expect
      .poll(() => native().evaluate(() => window.__mwSelections.length))
      .toBe(1);
    report.picker.selections = await native().evaluate(
      () => window.__mwSelections,
    );
    report.picker.closed = await native().evaluate(
      () => window.__mwPickerClosed,
    );
    report.picker.after = await p.evaluate(() => widget.activeChart().symbol());
    expect(report.picker.after).toBe(report.picker.before);
    expect(report.picker.selections[0][0].ticker).toBe("TEST:GBPUSD");
    await native().evaluate(() => window.__mwPicker?.close());
    report.picker.passed = true;
    report.sharedShell = {
      before: await p.evaluate(() => widget.activeChart().symbol()),
    };
    report.sharedShell.exports = await native().evaluate(() => {
      let req;
      self.webpackChunktradingview.push([
        ["mw-shell-" + Date.now()],
        {},
        (r) => (req = r),
      ]);
      const R = req(779474),
        { AdaptivePopupDialog } = req(450259),
        { DialogSidebarItem, DialogSidebarWrapper } = req(649867),
        { DialogSearch } = req(357723),
        { createReactRoot } = req(590263);
      window.__mwShellClosed = false;
      const skin = document.createElement("style");
      skin.textContent =
        ".mw-native-research-dialog{width:920px!important;max-width:calc(100vw - 40px)!important}.mw-native-research-wrapper{width:100%}";
      document.head.append(skin);
      const mount = document.createElement("div");
      let root;
      const close = () => {
        window.__mwShellClosed = true;
        root.unmount();
        mount.remove();
        skin.remove();
      };
      function Demo() {
        const [tab, setTab] = R.useState("平台品种"),
          [query, setQuery] = R.useState("");
        const content = () =>
          R.createElement(
            DialogSidebarWrapper,
            { style: { height: 480 } },
            R.createElement(
              "nav",
              { className: req(40806).container },
              ["平台品种", "自建行情"].map((t) =>
                R.createElement(DialogSidebarItem, {
                  key: t,
                  role: "button",
                  tabIndex: 0,
                  title: t,
                  isActive: tab === t,
                  onClick: () => setTab(t),
                }),
              ),
            ),
            R.createElement(
              "section",
              { style: { flex: 1, minWidth: 0 } },
              R.createElement(DialogSearch, {
                value: query,
                onChange: (e) => setQuery(e.target.value),
                placeholder: "搜索代码或名称",
                "aria-label": "原生组件品种查询",
              }),
              R.createElement(
                "p",
                { "data-name": "mw-research-state", style: { padding: 20 } },
                tab + " · " + query,
              ),
            ),
          );
        return R.createElement(AdaptivePopupDialog, {
          isOpened: true,
          title: "数据中心组件调研",
          dataName: "mw-native-research-shell",
          onClose: close,
          draggable: true,
          shouldReturnFocus: true,
          className: "mw-native-research-dialog",
          wrapperClassName: "mw-native-research-wrapper",
          showSeparator: true,
          render: content,
        });
      }
      root = createReactRoot(R.createElement(Demo), mount);
      return {
        popup: Object.keys(req(450259)),
        sidebar: Object.keys(req(649867)),
        search: Object.keys(req(357723)),
      };
    });
    const shell = native().getByRole("dialog", { name: "数据中心组件调研" });
    await expect(shell).toBeVisible();
    await shell
      .getByRole("searchbox", { name: "原生组件品种查询" })
      .fill("微软");
    await expect(shell.locator('[data-name="mw-research-state"]')).toHaveText(
      "平台品种 · 微软",
    );
    await shell.getByRole("button", { name: "自建行情", exact: true }).click();
    await expect(shell.locator('[data-name="mw-research-state"]')).toHaveText(
      "自建行情 · 微软",
    );
    await p.screenshot({
      path: "artifacts/native-ui-research/shared-shell.png",
    });
    report.sharedShell.darkBackground = await shell.evaluate(
      (e) => getComputedStyle(e.parentElement).backgroundColor,
    );
    expect(report.sharedShell.darkBackground).toBe("rgb(31, 31, 31)");
    const shellBounds = await shell.boundingBox();
    expect(shellBounds.width).toBe(920);
    const title = shell.getByText("数据中心组件调研", { exact: true });
    const titleBounds = await title.boundingBox();
    await p.mouse.move(
      titleBounds.x + titleBounds.width / 2,
      titleBounds.y + titleBounds.height / 2,
    );
    await p.mouse.down();
    await p.mouse.move(
      titleBounds.x + titleBounds.width / 2 + 60,
      titleBounds.y + titleBounds.height / 2 + 30,
      { steps: 8 },
    );
    await p.mouse.up();
    const moved = await shell.boundingBox();
    report.sharedShell.dragged = Math.abs(moved.x - shellBounds.x) > 40;
    expect(report.sharedShell.dragged).toBe(true);
    await p.evaluate(() => widget.changeTheme("Light"));
    await expect.poll(() => p.evaluate(() => widget.getTheme())).toBe("light");
    await p.screenshot({
      path: "artifacts/native-ui-research/shared-shell-light.png",
    });
    report.sharedShell.lightTheme = await p.evaluate(() => widget.getTheme());
    report.sharedShell.lightBackground = await shell.evaluate(
      (e) => getComputedStyle(e.parentElement).backgroundColor,
    );
    expect(report.sharedShell.lightBackground).toBe("rgb(255, 255, 255)");
    await shell.getByRole("button", { name: "关闭菜单" }).click();
    await expect(shell).not.toBeVisible();
    report.sharedShell.closed = await native().evaluate(
      () => window.__mwShellClosed,
    );
    report.sharedShell.after = await p.evaluate(() =>
      widget.activeChart().symbol(),
    );
    expect(report.sharedShell.after).toBe(report.sharedShell.before);
    report.sharedShell.passed = true;
    report.passed = true;
    console.log(
      JSON.stringify(
        {
          version: report.version,
          dialogs: report.dialogs.map((d) => ({
            name: d.name,
            tabs: d.tabs,
            buttons: d.buttons.length,
            inputs: d.inputs.length,
          })),
          exports: report.exports,
          picker: report.picker,
          sharedShell: report.sharedShell,
          errors: report.errors,
        },
        null,
        2,
      ),
    );
  } catch (e) {
    report.failure = e.message;
    console.log(
      "DIAGNOSTIC",
      await p.evaluate(() => ({
        ready: window.ready,
        widget: !!window.widget,
        frames: [...document.querySelectorAll("iframe")].map((e) => e.src),
        body: document.body.textContent.slice(0, 100),
      })),
    );
    throw e;
  } finally {
    fs.writeFileSync(
      "artifacts/native-ui-research/runtime-dialogs.json",
      JSON.stringify(report, null, 2),
    );
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
