import { attachNativeSystemMessages } from "../NativeSystemMessages";
import { createMessageFixture } from "./fixture";

declare const TradingView: any;
const feed = {
  onReady: (cb: any) =>
    setTimeout(
      () =>
        cb({
          supported_resolutions: ["60", "1D"],
          supports_marks: false,
          supports_timescale_marks: false,
        }),
      0,
    ),
  resolveSymbol: (name: string, cb: any) =>
    setTimeout(
      () =>
        cb({
          name,
          ticker: name,
          description: name === "EURUSD" ? "欧元 / 美元 · 示例行情" : name,
          type: "forex",
          session: "24x7",
          timezone: "Etc/UTC",
          minmov: 1,
          pricescale: 100000,
          has_intraday: true,
          supported_resolutions: ["60", "1D"],
          volume_precision: 0,
        }),
      0,
    ),
  getBars: (_symbol: any, res: string, p: any, cb: any) =>
    setTimeout(() => {
      const span = res === "1D" ? 86400 : 3600,
        rows = [];
      for (let i = p.countBack; i > 0; i--) {
        const t = Math.floor(p.to / span) - i;
        const close =
            1.08 + Math.sin(t * 0.13) * 0.003 + Math.sin(t * 0.043) * 0.002,
          open = close + Math.sin(t * 0.83) * 0.0007;
        rows.push({
          time: t * span * 1000,
          open,
          close,
          high:
            Math.max(open, close) + 0.00025 + Math.abs(Math.sin(t)) * 0.0004,
          low: Math.min(open, close) - 0.0003,
          volume: 300 + Math.round(Math.abs(Math.sin(t * 0.5)) * 1000),
        });
      }
      cb(rows, { noData: false });
    }, 0),
  subscribeBars: () => {},
  unsubscribeBars: () => {},
  getQuotes: (symbols: string[], cb: any) =>
    cb(
      symbols.map((n) => ({
        n,
        s: "ok",
        v: {
          lp: 1.08426,
          ch: 0.00053,
          chp: 0.05,
          short_name: n,
          exchange: "示例行情",
        },
      })),
    ),
  subscribeQuotes: () => {},
  unsubscribeQuotes: () => {},
};
const params = new URLSearchParams(location.search);
const widget = new TradingView.widget({
  container: "chart",
  library_path: "/charting_library_91bf3b2668480f58/",
  datafeed: feed,
  symbol: "EURUSD",
  interval: "60",
  locale: "zh",
  timezone: "Etc/UTC",
  autosize: true,
  theme: params.get("theme") === "light" ? "Light" : "Dark",
  widgetbar: {
    watchlist: true,
    details: true,
    datawindow: true,
    watchlist_settings: { default_symbols: ["EURUSD", "GBPUSD", "USDJPY"] },
  },
  disabled_features: [
    "use_localstorage_for_settings",
    "header_saveload",
    "create_volume_indicator_by_default",
    "open_account_manager",
  ],
  enabled_features: [],
});
let controller:
  Awaited<ReturnType<typeof attachNativeSystemMessages>> | undefined;
const fixture = createMessageFixture((state) => controller?.update(state));
widget.onChartReady(async () => {
  try {
    // Adopt exactly the stylesheet emitted with the shared presentation bundle.
    await widget.headerReady();
    const slot = widget.createButton({ useTradingViewStyle: false }),
      doc = slot.ownerDocument;
    widget.removeButton(slot);
    const sheet = doc.createElement("link");
    sheet.rel = "stylesheet";
    // The native frame's base URL is the chart origin, not this preview directory.
    sheet.href = new URL("./system-messages.css", location.href).href;
    await new Promise<void>((resolve, reject) => {
      sheet.onload = () => resolve();
      sheet.onerror = () => reject(Error("预览样式加载失败"));
      doc.head.append(sheet);
    });
    controller = await attachNativeSystemMessages({
      widget,
      state: fixture.state(),
      request: fixture.request,
      report: console.error,
      onLocate: () => {
        document.querySelector("#preview-status")!.textContent =
          "预览：已定位到当前示例图表";
      },
    });
    controller.open();
    document.querySelector("#preview-status")!.textContent =
      "预览就绪 · 样例消息仅保存在本页";
  } catch (error) {
    document.querySelector("#preview-status")!.textContent =
      "预览加载失败：" + String(error);
    console.error(error);
  }
});
document
  .querySelector("#reopen")!
  .addEventListener("click", () => controller?.open());
document.querySelector("#theme")!.addEventListener("click", async () => {
  const next =
    String(widget.getTheme()).toLowerCase() === "dark" ? "Light" : "Dark";
  await widget.changeTheme(next);
  document.querySelector("#theme")!.textContent =
    next === "Dark" ? "浅色主题" : "深色主题";
});
document
  .querySelector("#reset")!
  .addEventListener("click", () => location.reload());
document
  .querySelector("#close-guide")!
  .addEventListener("click", () =>
    document.querySelector("#preview-guide")!.setAttribute("hidden", ""),
  );
Object.assign(globalThis, {
  messagePreview: {
    widget,
    fixture,
    get controller() {
      return controller;
    },
  },
});
