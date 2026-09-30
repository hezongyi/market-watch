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
  dirty = false,
  nativeMode = false,
  nativeSaving = false,
  workspaceEpoch = 0,
  nativeReadonly = false;
let rangeGuard, edgeGuard;
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
const quoteSubscriptions = new Map();
const lastHistory = new Map();
const firstHistory = new Map();
const pendingHistory = new Map();
const failedHistory = new Map();
let retryDialogOpen = false;
function rememberHistoryFailure(args, state) {
  if (state.failed_task_ids?.length)
    failedHistory.set(JSON.stringify(args), {
      args,
      ids: state.failed_task_ids,
    });
}
function offerHistoryRetry() {
  if (!ready || retryDialogOpen) return;
  for (const [key, entry] of failedHistory) {
    failedHistory.delete(key);
    if (!hasHistoryViewer(entry.args)) continue;
    retryDialogOpen = true;
    widget.showConfirmDialog({
      title: "历史行情拉取失败",
      body: entry.args.instrument + " 的历史任务已停止。是否重新尝试？",
      callback: async (confirmed) => {
        try {
          if (!confirmed || !hasHistoryViewer(entry.args)) return;
          for (const id of new Set(entry.ids))
            await request({ op: "retry", args: { id } }, "market");
          pendingHistory.set(key, entry.args);
          send({ type: "status", text: "已重新安排历史拉取" });
        } catch (e) {
          send({ type: "error", error: String(e) });
        } finally {
          retryDialogOpen = false;
        }
      },
    });
    break;
  }
}
const clientId = crypto.randomUUID();
const requests = [];
function drain() {
  while (pending.size < 4 && requests.length) {
    const { query, type, resolve, reject, isCurrent } = requests.shift();
    if (isCurrent && !isCurrent()) {
      const error = Error("已取消旧图表的历史加载");
      error.code = "HISTORY_CANCELLED";
      reject(error);
      continue;
    }
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error("行情请求超时"));
      drain();
    }, 30000);
    pending.set(id, { resolve, reject, timer });
    send({ type, id, query });
  }
}
function request(query, type = "data", isCurrent) {
  return new Promise((resolve, reject) => {
    if (requests.length >= 64) return reject(Error("图表请求过多，请减少指标"));
    requests.push({ query, type, resolve, reject, isCurrent });
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
// Share only in-flight planning reads; completed results must be polled fresh.
const historyRequests = new Map();
function historyQuery(args) {
  const epoch = workspaceEpoch;
  const key = JSON.stringify([
    epoch,
    args.instrument,
    args.timeframe,
    args.before,
    args.limit,
  ]);
  const existing = historyRequests.get(key);
  if (existing) return existing;
  const promise = request(
    { op: "history", args },
    "market",
    () => epoch === workspaceEpoch && hasHistoryViewer(args),
  );
  historyRequests.set(key, promise);
  const remove = () => {
    if (historyRequests.get(key) === promise) historyRequests.delete(key);
  };
  promise.then(remove, remove);
  return promise;
}
const feed = {
  getQuotes: (symbols, cb, err) => {
    if (!symbols.length) {
      queueMicrotask(() => cb([]));
      return;
    }
    request({ op: "quotes", args: { symbols } }, "market")
      .then((rows) => cb(rows.map(({ s, n, v }) => ({ s, n, v }))))
      .catch((e) => err(String(e)));
  },
  subscribeQuotes: (symbols, fastSymbols, cb, id) => {
    quoteSubscriptions.set(id, {
      symbols: [...new Set([...symbols, ...fastSymbols])],
      cb,
    });
  },
  unsubscribeQuotes: (id) => quoteSubscriptions.delete(id),
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
  searchSymbols: async (input, exchange, type, cb) => {
    try {
      const rows = await request(
        { op: "search", args: { query: input } },
        "market",
      );
      cb(
        rows.map((s) => ({
          symbol: s.id,
          ticker: s.id,
          description: s.label + (s.supported ? "" : " · 日历待接入"),
          exchange: s.source.toUpperCase(),
          type: s.asset_type === "CRYPTO" ? "crypto" : "forex",
        })),
      );
    } catch (e) {
      cb([]);
      send({ type: "error", error: String(e) });
    }
  },
  resolveSymbol: async (ticker, cb, err) => {
    try {
      const symbol = decode(ticker).symbol;
      const meta = await request(
        { op: "resolve", args: { instrument: symbol, timeframe: "M1" } },
        "market",
      );
      cb({
        name: ticker,
        ticker,
        description: meta.name + " · " + meta.basis,
        exchange: meta.source.toUpperCase(),
        listed_exchange: meta.source.toUpperCase(),
        type: meta.calendar === "utc0" ? "crypto" : "forex",
        session: meta.calendar === "utc0" ? "24x7" : "1700-1700:23456",
        timezone: meta.calendar === "utc0" ? "Etc/UTC" : "America/New_York",
        minmov: 1,
        pricescale: 10 ** meta.precision,
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
    } catch (e) {
      err(String(e));
      send({ type: "error", error: String(e) });
    }
  },
  getBars: async (s, res, p, cb, err) => {
    try {
      if (!frames[res]) throw Error("不支持的周期");
      const symbol = decode(s.ticker).symbol;
      const requested = Math.max(1, Math.ceil(p.countBack));
      if (!Number.isSafeInteger(requested)) throw Error("无效历史根数");
      const epoch = workspaceEpoch;
      const completeTerminal = rangeGuard?.captureTerminalCompletion(
        (chart) => chart.symbol() === s.ticker && chart.resolution() === res,
      );
      const finishTerminal = () => {
        // Let the native callback finish processing before restoring sync.
        setTimeout(() => {
          if (epoch === workspaceEpoch) completeTerminal?.();
        }, 0);
      };
      const checkActive = () => {
        if (
          epoch !== workspaceEpoch ||
          !hasHistoryViewer({ instrument: symbol, timeframe: frames[res] })
        ) {
          const error = Error("已取消旧图表的历史加载");
          error.code = "HISTORY_CANCELLED";
          throw error;
        }
      };
      let before =
        p.to * 1000 + (["1D", "1W", "1M"].includes(res) ? 2 * 86400000 : 0);
      let all = [],
        earliest = Infinity,
        localBoundary = false,
        cacheOnly = false;
      while (all.length < requested) {
        checkActive();
        const args = {
          instrument: symbol,
          timeframe: frames[res],
          before,
          limit: Math.min(2000, requested - all.length),
        };
        let status = await historyQuery(args);
        checkActive();
        while (status.status === "pending") {
          send({
            type: "status",
            text:
              (status.queue_class === "background"
                ? `周线历史尚未就绪，已加入后台队列 · ${symbol} · 预计耗时暂无法估算`
                : `正在拉取历史数据 · ${symbol} · 已读取 ${all.length} 根`) +
              (status.progress
                ? ` · 当前区间已处理 ${Math.floor(status.progress.completed_ms / 60000)} / ${Math.ceil(status.progress.total_ms / 60000)} 分钟`
                : ""),
          });
          if (frames[res] === "W1" && status.queue_class === "background") {
            // Yield this native request immediately. tick() polls only while
            // viewed, then invalidates the native cache when history is ready.
            // Queued server jobs continue independently of this chart callback.
            pendingHistory.set(JSON.stringify(args), args);
            cb([], { noData: true });
            finishTerminal();
            return;
          }
          await new Promise((r) => setTimeout(r, 1500));
          checkActive();
          status = await historyQuery(args);
          checkActive();
        }
        if (status.status === "error") {
          rememberHistoryFailure(args, status);
          offerHistoryRetry();
          if (frames[res] === "W1") {
            // Native error callbacks can strand a subsequent monthly switch.
            // Complete this unavailable weekly view; an explicit retry clears
            // its cache before reloading (see pendingHistory in tick).
            send({
              type: "status",
              text: `${symbol} 周线历史拉取失败，未完成补数；可重试或切换周期`,
            });
            cb([], { noData: true });
            finishTerminal();
            return;
          }
          throw Error(status.error || "历史拉取失败");
        }
        cacheOnly = status.local_only === true;
        if (status.status === "empty_interval" && !cacheOnly)
          throw Error("该区间未返回行情，尚未确认历史起点");
        // The planning response already includes the ordinary OHLC page.
        // Python synthetic symbols additionally require indicator calculation.
        const result = decode(s.ticker).spec
          ? await query(s.ticker, res, { before, limit: args.limit })
          : status;
        checkActive();
        // Never stitch cached islands across an interval not checked by the planner.
        const covered = {
          ...result,
          bars: result.bars.filter(
            (bar) => bar.start >= status.requested_start,
          ),
        };
        for (const bar of covered.bars)
          if (stamp(bar, res, symbol) < p.to * 1000)
            earliest = Math.min(earliest, bar.start);
        all = barsOf(covered, res, s.ticker)
          .filter((bar) => bar.time < p.to * 1000)
          .concat(all);
        localBoundary = cacheOnly && result.bars.length < args.limit;
        if (localBoundary) break;
        const next = covered.bars[0]?.start ?? status.next_cursor;
        if (!(next < before)) throw Error("历史分页未推进，请重试");
        before = next;
        if (all.length < requested)
          send({
            type: "status",
            text: `正在读取历史数据 · ${symbol} · 已读取 ${all.length} / ${requested} 根`,
          });
      }
      send({
        type: "status",
        text: cacheOnly
          ? all.length
            ? "月线由本地已有日线生成，缺失历史不自动补数"
            : "暂无本地月线数据；日线积累后可生成，未安排专门补数"
          : "行情已加载",
      });
      const unique = [...new Map(all.map((b) => [b.time, b])).values()].sort(
        (a, b) => a.time - b.time,
      );
      if (unique.length && Number.isFinite(earliest)) {
        const key = s.ticker + "|" + res;
        firstHistory.set(
          key,
          p.firstDataRequest
            ? earliest
            : Math.min(firstHistory.get(key) ?? earliest, earliest),
        );
      }
      if (unique.length)
        lastHistory.set(
          s.ticker + "|" + res,
          Math.max(
            lastHistory.get(s.ticker + "|" + res) || 0,
            unique.at(-1).time,
          ),
        );
      // For monthly cache-only views, noData denotes the local dataset boundary.
      // It makes no claim about the provider's remote history.
      cb(unique, { noData: localBoundary });
      if (!unique.length && localBoundary) finishTerminal();
    } catch (e) {
      err(String(e));
      if (e.code !== "HISTORY_CANCELLED")
        send({ type: "error", error: String(e) });
    }
  },
  subscribeBars: (s, res, cb, id, reset) =>
    subscriptions.set(id, {
      symbol: s.ticker,
      res,
      cb,
      reset,
      last: lastHistory.get(s.ticker + "|" + res) || 0,
      revision: null,
    }),
  unsubscribeBars: (id) => subscriptions.delete(id),
};
let polling = false;
function chartUsesSymbol(chart, symbol, res) {
  if (chart.resolution() !== res) return false;
  if (chart.symbol() === symbol) return true;
  for (const study of chart.getAllStudies?.() || []) {
    try {
      const inputs = chart.getStudyById(study.id).getInputValues();
      if (
        inputs.some((input) => input.id === "symbol" && input.value === symbol)
      )
        return true;
    } catch {
      // A study can disappear while its outstanding request completes.
    }
  }
  return false;
}
function hasHistoryViewer(args) {
  if (!ready) return true;
  for (let i = 0; i < widget.chartsCount(); i++) {
    const chart = widget.chart(i);
    if (
      frames[chart.resolution()] === args.timeframe &&
      chartUsesSymbol(chart, args.instrument, chart.resolution())
    )
      return true;
  }
  return false;
}
function reloadHistory(symbol, res) {
  for (const sub of subscriptions.values()) {
    if (decode(sub.symbol).symbol === symbol && sub.res === res) sub.reset();
  }
  if (!ready) return;
  for (let i = 0; i < widget.chartsCount(); i++) {
    const chart = widget.chart(i);
    if (chartUsesSymbol(chart, symbol, res)) chart.resetData();
  }
}
async function tick() {
  if (polling) return;
  polling = true;
  try {
    const quoteSymbols = [
      ...new Set([...quoteSubscriptions.values()].flatMap((s) => s.symbols)),
    ];
    if (quoteSymbols.length) {
      try {
        const rows = [];
        for (let i = 0; i < quoteSymbols.length; i += 100)
          rows.push(
            ...(await request(
              {
                op: "quotes",
                args: {
                  symbols: quoteSymbols.slice(i, i + 100),
                  client: clientId,
                },
              },
              "market",
            )),
          );
        for (const sub of quoteSubscriptions.values())
          sub.cb(
            rows
              .filter((r) => sub.symbols.includes(r.n))
              .map(({ s, n, v }) => ({ s, n, v })),
          );
      } catch (e) {
        send({ type: "error", error: String(e) });
      }
    }
    for (const [key, args] of [...pendingHistory]) {
      if (!hasHistoryViewer(args)) {
        pendingHistory.delete(key);
        continue;
      }
      let state;
      try {
        state = await historyQuery(args);
      } catch (e) {
        send({ type: "error", error: String(e) });
        continue;
      }
      if (pendingHistory.get(key) !== args) continue;
      if (!hasHistoryViewer(args)) {
        pendingHistory.delete(key);
        continue;
      }
      if (state.status === "error") {
        pendingHistory.delete(key);
        rememberHistoryFailure(args, state);
        send({ type: "error", error: state.error || "历史拉取失败" });
        continue;
      }
      if (state.status === "ready" || state.status === "empty_interval") {
        pendingHistory.delete(key);
        const res = Object.keys(frames).find(
          (value) => frames[value] === args.timeframe,
        );
        if (res) reloadHistory(args.instrument, res);
      }
    }
    const groups = new Map();
    for (const sub of subscriptions.values()) {
      let key = sub.symbol + sub.res;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(sub);
    }
    for (const group of groups.values()) {
      const first = group[0];
      const symbol = decode(first.symbol).symbol;
      if (!hasHistoryViewer({ instrument: symbol, timeframe: frames[first.res] })) {
        for (const sub of group) sub.pausedForLayout = true;
        continue;
      }
      if (group.some((sub) => sub.pausedForLayout)) {
        for (const sub of group) sub.pausedForLayout = false;
        // Refill bars missed while the native pane retained a hidden subscription.
        reloadHistory(symbol, first.res);
        continue;
      }
      await request(
        {
          op: "activity",
          args: { client: clientId, instrument: decode(first.symbol).symbol },
        },
        "market",
      );
      try {
        const result = await query(first.symbol, first.res, {
          limit: 3,
          track_history: true,
          revision_after: firstHistory.get(first.symbol + "|" + first.res),
          ...(first.historyBefore
            ? { revision_before: first.historyBefore }
            : {}),
        });
        const bars = barsOf(result, first.res, first.symbol);
        const check = result.history_check;
        let needsReload = false;
        for (const sub of group) {
          const changed =
            check &&
            sub.historyBefore === check.before &&
            sub.historyAfter === check.after &&
            sub.historyRevision &&
            sub.historyRevision !== check.revision;
          if (check) {
            sub.historyBefore = check.next_before;
            sub.historyAfter = check.after;
            sub.historyRevision = check.next_revision;
          }
          if (changed) {
            needsReload = true;
            continue;
          }
          if (!sub.last && bars.length) sub.last = bars.at(-1).time;
          for (const bar of bars)
            if (bar.time >= sub.last) {
              sub.cb({ ...bar });
              sub.last = bar.time;
            }
        }
        if (needsReload) reloadHistory(decode(first.symbol).symbol, first.res);
        send({ type: "feed-poll-state", key: first.symbol + "|" + first.res, error: "" });
      } catch (e) {
        send({ type: "feed-poll-state", key: first.symbol + "|" + first.res, error: String(e) });
      }
    }
  } finally {
    polling = false;
    offerHistoryRetry();
  }
}
function snapshot() {
  if (!ready || loading) return;
  if (rangeGuard?.busy() || edgeGuard?.busy()) {
    dirty = true;
    return;
  }
  if (nativeMode) {
    if (nativeReadonly || nativeSaving) return;
    send({ type: "native-saving" });
    nativeSaving = true;
    dirty = false;
    const epoch = workspaceEpoch;
    const failed = (e) => {
      nativeSaving = false;
      if (epoch === workspaceEpoch) dirty = true;
      send({ type: "error", error: String(e?.message || "工作区保存失败") });
    };
    try {
      widget.saveChartToServer(
        () => {
          nativeSaving = false;
          if (dirty) snapshot();
          else if (epoch === workspaceEpoch) send({ type: "native-saved" });
        },
        failed,
        { defaultChartName: savedDoc.nativeName || "我的图表" },
      );
    } catch (e) {
      failed(e);
    }
    return;
  }
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
function boot(
  doc,
  readonly = false,
  catalog = {},
  preferences = [],
  workspace = null,
) {
  // save_load_adapter content is a layout envelope; saved_data expects its chart state.
  const storedViewports = doc.state?._mwViewports;
  let chartState = doc.state;
  if (
    chartState &&
    !chartState.charts &&
    typeof chartState.content === "string"
  ) {
    try {
      chartState = JSON.parse(chartState.content);
    } catch (e) {
      send({ type: "error", error: "工作区内容无法解析：" + String(e) });
      return;
    }
  }
  let pendingViewports = storedViewports || chartState?._mwViewports;
  if (chartState) {
    chartState = { ...chartState };
    delete chartState._mwViewports;
  }
  let viewportRestoring = false;
  const restoreViewports = async () => {
    const viewports = pendingViewports;
    pendingViewports = undefined;
    if (!viewports) return;
    const epoch = workspaceEpoch;
    viewportRestoring = true;
    try {
      await restoreChartViewports(
        widget,
        viewports,
        () => epoch === workspaceEpoch,
      );
    } catch (e) {
      send({ type: "error", error: "视区恢复失败：" + String(e) });
    } finally {
      if (epoch === workspaceEpoch) viewportRestoring = false;
    }
  };
  // Rebuild via public APIs: merely hiding extra panes leaves the vendor's
  // period-switch series metadata unresolved. This snapshot never leaves memory.
  const rebuildMobileSingleChart = async () => {
    if (!readonly || widget.chartsCount() <= 1) return false;
    const epoch = workspaceEpoch;
    widget.setLayout("s");
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (epoch !== workspaceEpoch) return true;
    const single = await new Promise((resolve) => widget.save(resolve));
    if (epoch !== workspaceEpoch) return true;
    const current = currentNativeWorkspace;
    await widget.load(
      single,
      current
        ? {
            uid: current.id,
            name: current.name,
            description: current.name,
          }
        : undefined,
    );
    return true;
  };
  savedDoc = doc;
  savedDoc.nativeName = workspace?.name || "我的图表";
  nativeMode = true;
  nativeReadonly = readonly;
  let currentNativeWorkspace = workspace;
  const layouts = nativeWorkspaces(
    workspace,
    (op, args) => request({ op, args }, "workspace"),
    readonly,
    (row) => {
      currentNativeWorkspace = row;
      savedDoc = { ...row.document, nativeName: row.name };
    },
    (row) => {
      currentNativeWorkspace = row;
      savedDoc = { ...row.document, nativeName: row.name };
    },
  );
  const recordPeriodChange = (chart, resolution, parameters) => {
    const count = { "1D": 90, "1W": 13, "1M": 3 }[resolution];
    if (loading || !count || parameters?.timeframe || !chart.dataReady())
      return;
    // This public event runs before the old series is cleared. Reset while its
    // visible range still exists so the native request inherits the new budget.
    // Reloading the widget here would discard the user's undo history.
    const scale = chart.getTimeScale();
    scale.setBarSpacing(scale.width() / count);
    widget.resetCache();
    chart.resetData();
  };
  const loadContent = layouts.getChartContent;
  const saveLayout = layouts.saveChart;
  let busySaveNoticeShown = false;
  layouts.saveChart = (data) => {
    if (viewportRestoring || rangeGuard?.busy() || edgeGuard?.busy()) {
      dirty = true;
      if (!busySaveNoticeShown) {
        busySaveNoticeShown = true;
        widget.showNoticeDialog({
          title: "等待图表就绪",
          body: "图表正在切换，数据就绪后自动保存",
          callback: () => {},
        });
      }
      // Native save callbacks serialize rejection values; Error becomes {}.
      return Promise.reject("图表正在切换，数据就绪后自动保存");
    }
    busySaveNoticeShown = false;
    const state = JSON.parse(data.content);
    state._mwViewports = captureChartViewports(widget);
    return saveLayout({ ...data, content: JSON.stringify(state) });
  };
  let viewportTimer,
    viewportWrite = Promise.resolve();
  const viewportBindings = new Map();
  const persistViewport = () => {
    clearTimeout(viewportTimer);
    const epoch = workspaceEpoch;
    viewportWrite = viewportWrite
      .catch(() => {})
      .then(async () => {
        if (
          readonly ||
          !ready ||
          loading ||
          viewportRestoring ||
          rangeGuard?.busy() ||
          edgeGuard?.busy() ||
          epoch !== workspaceEpoch ||
          !currentNativeWorkspace?.id
        )
          return;
        const viewports = captureChartViewports(widget);
        if (
          JSON.stringify(savedDoc.state?._mwViewports) ===
          JSON.stringify(viewports)
        )
          return;
        const raw = await new Promise((resolve) => widget.save(resolve));
        if (epoch !== workspaceEpoch) return;
        const state =
          typeof savedDoc.state?.content === "string"
            ? { ...savedDoc.state, content: JSON.stringify(raw) }
            : raw;
        state._mwViewports = viewports;
        send({ type: "native-saving" });
        await saveLayout({
          id: currentNativeWorkspace.id,
          name: savedDoc.nativeName,
          symbol: widget.chart(0).symbol(),
          resolution: widget.chart(0).resolution(),
          content: JSON.stringify(state),
        });
        send({ type: "native-saved" });
      });
    return viewportWrite;
  };
  const bindViewports = () => {
    for (const [chart, changed] of viewportBindings)
      chart.onVisibleRangeChanged().unsubscribe(null, changed);
    viewportBindings.clear();
    if (readonly) return;
    for (let i = 0; i < widget.chartsCount(); i++) {
      const chart = widget.chart(i);
      const changed = () => {
        if (!ready || loading || viewportRestoring) return;
        clearTimeout(viewportTimer);
        viewportTimer = setTimeout(
          () =>
            persistViewport().catch((e) =>
              send({ type: "error", error: "视区保存失败：" + String(e) }),
            ),
          400,
        );
      };
      viewportBindings.set(chart, changed);
      chart.onVisibleRangeChanged().subscribe(null, changed);
    }
  };
  layouts.getChartContent = async (id) => {
    try {
      await persistViewport();
      const state = JSON.parse(await loadContent(id));
      pendingViewports = state._mwViewports;
      delete state._mwViewports;
      return JSON.stringify(nativeLayoutContent(state, currentNativeWorkspace));
    } catch (e) {
      loading = false;
      send({ type: "error", error: String(e) });
      throw e;
    }
  };
  const prefs = nativePreferences(
    preferences,
    (op, args) => request({ op, args }, "preferences"),
    readonly,
    (e) => send({ type: "error", error: String(e) }),
  );
  savedDoc = doc;
  savedDoc.templates ||= {};
  loading = true;
  ready = false;
  widget = new TradingView.widget({
    save_load_adapter: { ...prefs.templates, ...layouts },
    settings_adapter: prefs.settings,
    custom_indicators_getter: (PineJS) =>
      Promise.resolve(pythonStudies(PineJS, catalog)),
    container: "chart",
    library_path: "/charting_library/",
    datafeed: feed,
    widgetbar: {
      watchlist: true,
      details: true,
      datawindow: true,
      watchlist_settings: {
        default_symbols: ["EURUSD", "XAUUSD", "BTCUSDT"],
        readonly,
      },
    },
    compare_symbols: [
      { symbol: "EURUSD", title: "EUR/USD" },
      { symbol: "XAUUSD", title: "黄金 / 美元" },
      { symbol: "BTCUSDT", title: "BTC/USDT" },
    ],
    symbol: doc.symbol || "XAUUSD",
    interval: doc.interval || "240",
    ...(!chartState && ["1D", "1W", "1M"].includes(doc.interval)
      ? { timeframe: "3M" }
      : {}),
    locale: "zh",
    autosize: true,
    theme:
      preferences.find((p) => p.kind === "setting" && p.name === "mw.theme")
        ?.content.value ||
      doc.theme ||
      "Dark",
    saved_data: chartState,
    saved_data_meta_info: workspace
      ? { uid: workspace.id, name: workspace.name, description: workspace.name }
      : undefined,
    auto_save_delay: 2,
    enabled_features: [
      "support_multicharts",
      "determine_first_data_request_size_using_visible_range",
      "header_layouttoggle",
      "disable_resolution_rebuild",
      "study_templates",
      "items_favoriting",
      "chart_template_storage",
    ],
    disabled_features: [
      "use_localstorage_for_settings",
      "trading_account_manager",
      "order_panel",
      "broker_button",
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
  widget.onChartReady(async () => {
    if (!doc.state) {
      widget.crosshairSync().setValue(true);
      widget.timeSync().setValue(true);
      widget.dateRangeSync().setValue(true);
      widget.intervalSync().setValue(false);
      widget.symbolSync().setValue(false);
      if (workspace) {
        try {
          await new Promise((resolve) =>
            widget.activeChart().dataReady(resolve),
          );
          // Leave the library's initial ready dispatch before replacing its layout.
          await new Promise((resolve) => setTimeout(resolve, 0));
          const state = await new Promise((resolve) => widget.save(resolve));
          await widget.load(state, {
            uid: workspace.id,
            name: workspace.name,
            description: workspace.name,
          });
        } catch (e) {
          send({ type: "error", error: "工作区初始化失败：" + String(e) });
          return;
        }
      }
    }
    widget
      .headerReady()
      .then(() => {
        widget.createButton({
          align: "right",
          useTradingViewStyle: true,
          text: "导出 CSV",
          title: "导出行情及当前 Python 指标",
          onClick: () => {
            const chart = widget.activeChart();
            const instrument = decode(chart.symbol()).symbol;
            const indicators = [];
            for (const study of chart.getAllStudies()) {
              const name = Object.keys(catalog).find(
                (name) => study.name === "守望 Python " + name,
              );
              if (!name) continue;
              const inputs = chart.getStudyById(study.id).getInputValues();
              indicators.push({
                name,
                id: study.id,
                params: Object.fromEntries(
                  Object.keys(catalog[name].params).map((key) => [
                    key,
                    inputs.find((input) => input.id === key)?.value ??
                      catalog[name].params[key],
                  ]),
                ),
              });
            }
            send({
              type: "export-selection",
              selection: {
                instrument,
                theme: widget.getTheme(),
                timeframe: frames[chart.resolution()],
                indicators,
              },
            });
          },
        });
        widget.createButton({
          align: "right",
          useTradingViewStyle: true,
          text: "使用说明",
          title: "图表功能与替代入口说明",
          onClick: () =>
            widget.showNoticeDialog({
              title: "图表功能说明",
              body: "保存图表样式请使用顶部“保存样式”，同名会覆盖；应用和删除在“设置 → 模板”。原生模板菜单的“保存为…”暂不可用。导出请使用顶部“导出 CSV”，包含行情及所选 Python 指标，不包含原生内置指标值。原生数据导出暂不可用。手机只读，临时操作不会保存到电脑工作区。行情按 M1 更新，并非逐笔报价；成交量、盘口、新闻、交易执行和图上预警暂未接入。",
              callback: () => {},
            }),
        });
        widget.createButton({
          align: "right",
          useTradingViewStyle: true,
          text: "返回守望",
          title: "返回守望工作台",
          onClick: () => send({ type: "workspace-action", action: "home" }),
        });
      })
      .catch((e) => send({ type: "error", error: String(e) }));
    if (!readonly) {
      widget
        .headerReady()
        .then(() => {
          widget.createButton({
            align: "right",
            useTradingViewStyle: true,
            text: "保存样式",
            title: "保存图表样式模板",
            onClick: async () => {
              try {
                const epoch = workspaceEpoch;
                const index = widget.activeChartIndex();
                const state = await new Promise((resolve) =>
                  widget.save(resolve),
                );
                const content = chartStyleTemplate(state, index);
                const name = await request({}, "style-template-name");
                if (!name) return;
                if (epoch !== workspaceEpoch)
                  throw Error("工作区已切换，请重新保存样式");
                await prefs.templates.saveChartTemplate(name, content);
                widget.showNoticeDialog({
                  title: "样式已保存",
                  body: "在图表设置 → 模板中选择应用。",
                  callback: () => {},
                });
              } catch (error) {
                send({ type: "error", error: String(error) });
              }
            },
          });
          widget.createButton({
            align: "right",
            useTradingViewStyle: true,
            text: "新建工作区",
            title: "保存当前工作区并新建空白工作区",
            onClick: () => send({ type: "workspace-action", action: "create" }),
          });
        })
        .catch((e) =>
          send({ type: "error", error: "工作区入口加载失败：" + String(e) }),
        );
    }
    // Mobile is a temporary single-chart view of the saved desktop workspace.
    // Read-only adapters keep the original multi-chart document untouched.
    await restoreViewports();
    await rebuildMobileSingleChart();
    ready = true;
    loading = false;
    widget.subscribe("chart_theme_changed", (name, standard, onlyActive) => {
      if (readonly || !standard || onlyActive) return;
      const theme = String(name).toLowerCase() === "light" ? "Light" : "Dark";
      prefs
        .savePreference("setting", "mw.theme", theme)
        .catch((e) =>
          send({ type: "error", error: "主题保存失败：" + String(e) }),
        );
    });
    nativeWatchlists(
      widget,
      preferences.find(
        (p) => p.kind === "setting" && p.name === "mw.watchlists.v1",
      )?.content.value,
      readonly,
      (value) => prefs.savePreference("setting", "mw.watchlists.v1", value),
      (e) => send({ type: "error", error: "自选列表保存失败：" + String(e) }),
    ).catch((e) =>
      send({ type: "error", error: "自选列表初始化失败：" + String(e) }),
    );
    const bindEdgeSync = () => {
      edgeGuard?.dispose();
      edgeGuard = edgeRangeSync(
        widget,
        () => loading || viewportRestoring || !!rangeGuard?.busy(),
        (error) =>
          send({ type: "error", error: "时间范围同步失败：" + String(error) }),
      );
    };
    widget.subscribe("chart_load_requested", () => {
      edgeGuard?.dispose();
      edgeGuard = undefined;
      rangeGuard?.dispose();
      rangeGuard = undefined;
      workspaceEpoch++;
      viewportRestoring = false;
      loading = true;
      dirty = false;
    });
    widget.subscribe("chart_loaded", async () => {
      const epoch = workspaceEpoch;
      await restoreViewports();
      if (epoch !== workspaceEpoch) return;
      // load() emits chart_loaded again for the rebuilt single chart. Only that
      // final event may rebind guards and release the loading state.
      if (await rebuildMobileSingleChart()) return;
      if (epoch !== workspaceEpoch) return;
      loading = false;
      rangeGuard?.dispose();
      rangeGuard = rangeSyncLoadingGuard(widget, recordPeriodChange);
      bindEdgeSync();
      bindViewports();
    });
    rangeGuard = rangeSyncLoadingGuard(widget, recordPeriodChange);
    bindEdgeSync();
    bindViewports();
    widget.subscribe("layout_changed", () => {
      rangeGuard?.refresh();
      edgeGuard?.refresh();
      bindViewports();
    });
    widget.drawOnAllChartsEnabled().setValue(true);
    widget.subscribe("onAutoSaveNeeded", () => {
      dirty = true;
      snapshot();
    });
    send({ type: "ready" });
    poll = setInterval(() => {
      tick();
      if (dirty) snapshot();
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
    boot(m.document, m.readonly, m.catalog, m.preferences, m.workspace);
  else if (m.type === "save") snapshot();
  else if (m.type === "theme" && ready) {
    savedDoc.theme = m.theme;
    await widget.changeTheme(m.theme);
    snapshot();
  }
});
send({ type: "loaded" });
