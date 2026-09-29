/* All authenticated work is performed by the trusted parent, never this origin. */
const parentOrigin = new URLSearchParams(location.search).get("parent");
if (!parentOrigin || new URL(parentOrigin).origin !== parentOrigin)
  throw Error("Missing parent origin");
const send = (value) =>
  parent.postMessage({ channel: "mw-chart-v1", ...value }, parentOrigin);
const pending = new Map();
let seq = 0,
  widget,
  ready = false,
  loading = false,
  poll,
  savedDoc = {},
  dirty = false;
const resolutions = ["1", "5", "15", "30", "60", "240", "1D", "1W", "1M"];
const frames = {
  1: "M1",
  5: "M5",
  15: "M15",
  30: "M30",
  60: "H1",
  240: "H4",
  "1D": "D1",
  "1W": "W1",
  "1M": "MN",
};
const subscriptions = new Map();
const requests = [];
function drain() {
  while (pending.size < 4 && requests.length) {
    const { query, resolve, reject } = requests.shift();
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error("行情请求超时"));
      drain();
    }, 30000);
    pending.set(id, { resolve, reject, timer });
    send({ type: "data", id, query });
  }
}
function request(query) {
  return new Promise((resolve, reject) => {
    if (requests.length >= 64) return reject(Error("图表请求过多，请减少指标"));
    requests.push({ query, resolve, reject });
    drain();
  });
}
function dateAt(ms, zone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}
function stamp(bar, res, symbol) {
  if (!["1D", "1W", "1M"].includes(res)) return bar.start;
  const zone = symbol === "BTCUSDT" ? "Etc/UTC" : "America/New_York";
  // Daily timestamps are trading-date labels at UTC midnight, not session opens.
  let date = dateAt(
    res === "1D"
      ? bar.end - 1
      : bar.start + (symbol === "BTCUSDT" ? 0 : 86400000),
    zone,
  );
  if (res === "1M") date = date.slice(0, 7) + "-01";
  return Date.parse(date + "T00:00:00Z");
}
function decode(symbol) {
  if (!symbol.startsWith("MWPY_")) return { symbol };
  return JSON.parse(atob(symbol.slice(5)));
}
function barsOf(result, res, ticker) {
  const { symbol, spec, key } = decode(ticker);
  if (!spec)
    return result.bars.map((b) => ({
      time: stamp(b, res, symbol),
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: Number(b.close),
    }));
  const values = new Map(
    (result.indicators[0]?.series.find((s) => s.key === key)?.values || []).map(
      (v) => [v.time, v.value],
    ),
  );
  return result.bars.map((b) => {
    const v = values.get(b.start);
    return {
      time: stamp(b, res, symbol),
      open: v ?? 0,
      high: v ?? 0,
      low: v ?? 0,
      close: v ?? 0,
      volume: Number(v !== null && v !== undefined),
    };
  });
}
const cache = new Map();
function query(ticker, res, args) {
  const { symbol, spec } = decode(ticker);
  const q = {
    instrument: symbol,
    timeframe: frames[res],
    ...args,
    ...(spec ? { indicators: [spec] } : {}),
  };
  const key = JSON.stringify(q);
  const old = cache.get(key);
  if (old && Date.now() - old.time < 1000) return old.promise;
  const promise = request(q);
  cache.set(key, { time: Date.now(), promise });
  if (cache.size > 64) cache.delete(cache.keys().next().value);
  return promise;
}
const feed = {
  onReady: (cb) =>
    setTimeout(
      () =>
        cb({
          supported_resolutions: resolutions,
          supports_marks: false,
          supports_timescale_marks: false,
        }),
      0,
    ),
  searchSymbols: (input, exchange, type, cb) =>
    cb(
      ["EURUSD", "XAUUSD", "BTCUSDT"]
        .filter((s) => s.includes(input.toUpperCase()))
        .map((s) => ({
          symbol: s,
          ticker: s,
          description: s,
          exchange: "Market Watch",
          type: s === "BTCUSDT" ? "crypto" : "forex",
        })),
    ),
  resolveSymbol: (ticker, cb, err) =>
    setTimeout(() => {
      let symbol;
      try {
        symbol = decode(ticker).symbol;
      } catch (e) {
        return err("unknown_symbol");
      }
      if (!["EURUSD", "XAUUSD", "BTCUSDT"].includes(symbol))
        return err("unknown_symbol");
      cb({
        name: ticker,
        ticker,
        description: symbol + (symbol === "BTCUSDT" ? " · Last" : " · Bid"),
        exchange: "Market Watch",
        listed_exchange: "Market Watch",
        type: symbol === "BTCUSDT" ? "crypto" : "forex",
        session: symbol === "BTCUSDT" ? "24x7" : "1700-1700:23456",
        timezone: symbol === "BTCUSDT" ? "Etc/UTC" : "America/New_York",
        minmov: 1,
        pricescale: symbol === "EURUSD" ? 100000 : 100,
        has_intraday: true,
        intraday_multipliers: ["1", "5", "15", "30", "60", "240"],
        has_daily: true,
        daily_multipliers: ["1"],
        has_weekly_and_monthly: true,
        weekly_multipliers: ["1"],
        monthly_multipliers: ["1"],
        supported_resolutions: resolutions,
        format: "price",
        data_status: "streaming",
        has_empty_bars: false,
      });
    }, 0),
  getBars: async (s, res, p, cb, err) => {
    try {
      if (!frames[res]) throw Error("不支持的周期");
      let before =
          p.to * 1000 + (["1D", "1W", "1M"].includes(res) ? 2 * 86400000 : 0),
        all = [],
        more = true;
      for (
        let page = 0;
        page < 8 && more && all.length < Math.min(p.countBack, 2000);
        page++
      ) {
        const result = await query(s.ticker, res, {
          before,
          limit: Math.min(2000, Math.max(300, p.countBack)),
        });
        all = barsOf(result, res, s.ticker)
          .filter((b) => b.time < p.to * 1000)
          .concat(all);
        more = result.has_more;
        if (!result.bars.length) break;
        before = result.bars[0].start;
      }
      const unique = [...new Map(all.map((b) => [b.time, b])).values()].sort(
        (a, b) => a.time - b.time,
      );
      cb(unique, { noData: unique.length === 0 && !more });
    } catch (e) {
      err(String(e));
      send({ type: "error", error: String(e) });
    }
  },
  subscribeBars: (s, res, cb, id, reset) =>
    subscriptions.set(id, {
      symbol: s.ticker,
      res,
      cb,
      reset,
      last: 0,
      revision: null,
    }),
  unsubscribeBars: (id) => subscriptions.delete(id),
};
let polling = false;
async function tick() {
  if (polling) return;
  polling = true;
  try {
    const groups = new Map();
    for (const sub of subscriptions.values()) {
      let key = sub.symbol + sub.res;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(sub);
    }
    for (const group of groups.values()) {
      const first = group[0];
      try {
        const result = await query(first.symbol, first.res, { limit: 3 });
        const bars = barsOf(result, first.res, first.symbol);
        for (const sub of group) {
          if (sub.revision && sub.revision !== result.history_revision) {
            sub.reset();
            sub.last = 0;
          }
          sub.revision = result.history_revision;
          for (const bar of bars)
            if (bar.time >= sub.last) {
              sub.cb({ ...bar });
              sub.last = bar.time;
            }
        }
      } catch (e) {
        send({ type: "error", error: String(e) });
      }
    }
  } finally {
    polling = false;
  }
}
function snapshot() {
  if (!ready || loading) return;
  widget.save((state) =>
    send({
      type: "snapshot",
      document: {
        engine: "tv31",
        schemaVersion: 1,
        state,
        theme: savedDoc.theme || "Dark",
        templates: savedDoc.templates || {},
      },
    }),
  );
}
function boot(doc, readonly = false, catalog = {}) {
  savedDoc = doc;
  savedDoc.templates ||= {};
  loading = true;
  ready = false;
  widget = new TradingView.widget({
    save_load_adapter: {
      getAllStudyTemplates: async () =>
        Object.keys(savedDoc.templates).map((name) => ({ name })),
      getStudyTemplateContent: async ({ name }) => savedDoc.templates[name],
      saveStudyTemplate: async ({ name, content }) => {
        savedDoc.templates[name] = content;
        snapshot();
      },
      removeStudyTemplate: async ({ name }) => {
        delete savedDoc.templates[name];
        snapshot();
      },
    },
    custom_indicators_getter: (PineJS) =>
      Promise.resolve(pythonStudies(PineJS, catalog)),
    container: "chart",
    library_path: "/charting_library/",
    datafeed: feed,
    symbol: "XAUUSD",
    interval: "240",
    locale: "zh",
    autosize: true,
    theme: doc.theme || "Dark",
    saved_data: doc.state,
    auto_save_delay: 2,
    enabled_features: [
      "support_multicharts",
      "header_layouttoggle",
      "disable_resolution_rebuild",
      "study_templates",
    ],
    disabled_features: [
      "use_localstorage_for_settings",
      "header_saveload",
      "header_screenshot",
      "header_compare",
      "trading_account_manager",
      "order_panel",
      "broker_button",
      "show_object_tree",
      "create_volume_indicator_by_default",
      ...(readonly
        ? [
            "left_toolbar",
            "context_menus",
            "header_indicators",
            "header_settings",
          ]
        : []),
    ],
  });
  widget.onChartReady(() => {
    ready = true;
    loading = false;
    if (!doc.state) {
      widget.crosshairSync().setValue(true);
      widget.timeSync().setValue(true);
      widget.dateRangeSync().setValue(true);
      widget.intervalSync().setValue(false);
      widget.symbolSync().setValue(false);
    }
    widget.drawOnAllChartsEnabled().setValue(true);
    widget.subscribe("onAutoSaveNeeded", () => {
      dirty = true;
      snapshot();
    });
    send({ type: "ready" });
    poll = setInterval(() => {
      tick();
      snapshot();
    }, 15000);
  });
}
addEventListener("message", async (e) => {
  if (
    e.source !== parent ||
    e.origin !== parentOrigin ||
    e.data?.channel !== "mw-chart-v1"
  )
    return;
  const m = e.data;
  if (m.type === "result") {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    m.error ? p.reject(Error(m.error)) : p.resolve(m.result);
    drain();
  } else if (m.type === "init" && !widget)
    boot(m.document, m.readonly, m.catalog);
  else if (m.type === "save") snapshot();
  else if (m.type === "theme" && ready) {
    savedDoc.theme = m.theme;
    await widget.changeTheme(m.theme);
    snapshot();
  }
});
send({ type: "loaded" });
