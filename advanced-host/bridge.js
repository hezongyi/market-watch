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
let rangeGuard, edgeGuard, demandReporter, progressivePages, progressivePoll, beforeInitialHistory, initialSymbol;
let prewarming = false;
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
const providerHistoryState = new Map();
const firstHistory = new Map();
const coldHistory = new Set();
const refreshingHistoryRanges = new Map();
const pendingHistory = new Map();
const indicatorHistoryNeeds = new Map();
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
let initialHistoryGate;
function drain() {
  while (pending.size < 4 && requests.length) {
    // Pointer-driven viewport checks must not sit behind queued prewarming.
    // Keep the same four in-flight limit and leave ongoing reads untouched.
    const quoteBusy = [...pending.values()].some(entry => entry.quote);
    const eligible = entry => entry.query.op !== 'quotes' || !quoteBusy;
    let interaction = requests.findIndex(entry => entry.query.op === "viewport");
    if (interaction < 0) interaction = requests.findIndex(entry =>
      entry.query.op === "historyCache" && !entry.query.background);
    if (interaction < 0) interaction = requests.findIndex(entry => !entry.query.op);
    if (interaction < 0) interaction = requests.findIndex(entry => entry.type === 'workspace');
    if (interaction < 0) interaction = requests.findIndex(eligible);
    if (interaction < 0) break;
    const { query, type, resolve, reject, isCurrent } =
      requests.splice(interaction, 1)[0];
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
    const entry = { resolve, reject, timer, cancellationTimer: null, quote: query.op === 'quotes' };
    pending.set(id, entry);
    if (isCurrent) {
      const check = () => {
        if (!pending.has(id)) return;
        if (isCurrent()) {
          entry.cancellationTimer = setTimeout(check, 100);
          return;
        }
        pending.delete(id);
        clearTimeout(timer);
        send({ type: "cancel-request", id });
        const error = Error("已取消旧图表的历史加载");
        error.code = "HISTORY_CANCELLED";
        reject(error);
        drain();
      };
      entry.cancellationTimer = setTimeout(check, 100);
    }
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
  return MWSeries.decode(symbol);
}
function barsOf(result, res, ticker) {
  const { symbol, spec, key } = decode(ticker);
  if (!spec)
    return result.bars.map((b) => ({
      time: b.chart_time ?? stamp(b, res, symbol),
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
      time: b.chart_time ?? stamp(b, res, symbol),
      open: v ?? 0,
      high: v ?? 0,
      low: v ?? 0,
      close: v ?? 0,
      volume: Number(v !== null && v !== undefined),
    };
  });
}
const managedSessions = new Map();
const maintenanceAsked = new Set();
const cache = new Map();
function datasetGeometry(ticker, res) {
  const matches = widget ? Array.from({length:widget.chartsCount()},(_,i)=>widget.chart(i))
    .filter(chart=>chartUsesSymbol(chart,ticker,res)) : [];
  // The shared datafeed has no pane identifier. Use the largest real plotting
  // capacity among matching panes; every matching pane gets enough history.
  const sizes = matches.map(chart=>({plot_width:chart.getTimeScale().width(),
    bar_spacing:chart.getTimeScale().barSpacing()})).filter(x=>x.plot_width>0 && x.bar_spacing>0);
  return sizes.sort((a,b)=>b.plot_width/b.bar_spacing-a.plot_width/a.bar_spacing)[0] ||
    {plot_width:960,bar_spacing:6};
}

function query(ticker, res, args) {
  const { symbol, spec, series_kind } = decode(ticker);
  const q = {
    instrument: symbol,
    series_kind,
    timeframe: frames[res],
    ...(series_kind === 'managed' ? {published:true,
      ...(managedSessions.get(symbol+'|'+res)?.start != null
        ? {dataset_start:managedSessions.get(symbol+'|'+res).start} : {})} : {}),
    ...args,
    ...(spec ? { indicators: [spec] } : {}),
  };
  const key = JSON.stringify(q);
  const old = cache.get(key);
  if (series_kind === 'managed' && old && Date.now() - old.time < 1000) return old.promise;
  const epoch = workspaceEpoch;
  // Native owns the lifetime of its period caches. A temporary period switch
  // does not cancel a getBars callback that it can reuse when switching back.
  const promise = request(q, "data", () => epoch === workspaceEpoch &&
    (series_kind === 'provider' || hasHistoryViewer({instrument:MWSeries.encode(symbol,series_kind),timeframe:frames[res]})));
  if (series_kind === 'managed') cache.set(key, { time: Date.now(), promise });
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
    const epoch = workspaceEpoch;
    // Details/watchlist quotes must not consume the bounded bridge/upstream
    // slots ahead of the first visible candle page. Failure also opens the gate.
    Promise.resolve(initialHistoryGate?.promise)
      .then(() => request({ op: "quotes", args: { symbols } }, "market",
        () => epoch === workspaceEpoch))
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
        ["provider", "managed"].flatMap(series_kind => rows.map((s) => ({
          symbol: MWSeries.encode(s.id, series_kind),
          ticker: MWSeries.encode(s.id, series_kind),
          description: s.label + (series_kind === "provider" ? " · 平台行情" : " · 自建行情") +
            (series_kind === "managed" && s.managed_status ? " · " + s.managed_status : "") +
            (s.supported ? "" : " · 日历待接入"),
          exchange: s.source.toUpperCase(),
          type: s.asset_type === "CRYPTO" ? "crypto" : "forex",
        }))),
      );
    } catch (e) {
      cb([]);
      send({ type: "error", error: String(e) });
    }
  },
  resolveSymbol: async (ticker, cb, err) => {
    try {
      const {symbol,series_kind} = decode(ticker);
      // One-time startup metadata rides with workspace configuration. Candle
      // demand and every subsequent symbol resolve still use the backend.
      const supplied = initialSymbol?.ticker === ticker ? initialSymbol.metadata : undefined;
      initialSymbol = undefined;
      if (supplied) {
        // Native datafeed callbacks must leave the calling task, even when
        // their payload arrived with the workspace configuration.
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      const meta = supplied || await request(
        { op: "resolve", args: { instrument: symbol, series_kind, timeframe: "M1" } },
        "market",
      );
      cb({
        name: ticker,
        ticker,
        description: meta.name + (series_kind === "provider" ? " · 平台行情 · " : " · 自建行情 · ") + meta.basis,
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
    const loadEpoch=workspaceEpoch;
    const completeTerminal=rangeGuard?.captureTerminalCompletion?.(
      chart=>chart.symbol()===s.ticker && chart.resolution()===res);
    const finishTerminal=()=>{
      // Empty/error loads may never emit native dataReady. Finish only the
      // captured public loading token after the native callback has returned.
      if(completeTerminal) setTimeout(()=>{
        if(loadEpoch===workspaceEpoch) completeTerminal();
      },0);
    };
    try {
      beforeInitialHistory?.();
      if (!frames[res]) throw Error("不支持的周期");
      if (decode(s.ticker).series_kind === "provider") {
        // Native requirements pass unchanged; the backend owns cache policy
        // and provider pagination, including demands larger than one page.
        const epoch = workspaceEpoch;
        const page = await query(s.ticker, res, {limit:p.countBack,
          countBack:p.countBack, from:p.from*1000, before:p.to*1000,
          firstDataRequest:p.firstDataRequest, client:clientId});
        if (epoch !== workspaceEpoch) {
          const error = Error("已取消旧图表的历史加载");
          error.code = "HISTORY_CANCELLED"; throw error;
        }
        const rows = barsOf(page, res, s.ticker);
        providerHistoryState.set(s.ticker+'|'+res, {revision:page.cache_revision||0,
          observed_at:page.as_of||0,cursor:rows.at(-1)?.time||0});
        const boundary = page.history_boundary === true;
        if (rows.length) {
          const key = s.ticker+'|'+res;
          lastHistory.set(key,Math.max(lastHistory.get(key)||0,rows.at(-1).time));
          firstHistory.set(key,Math.min(firstHistory.get(key)??Infinity,rows[0].time));
        }
        cb(rows,{noData:boundary});
        if(!rows.length) finishTerminal();
        return;
      }
      const identity = decode(s.ticker), symbol=identity.symbol;
      const requested = Math.max(1, Math.ceil(p.countBack));
      if (!Number.isSafeInteger(requested)) throw Error('无效历史根数');
      const key=symbol+'|'+res, epoch=workspaceEpoch;
      let session=managedSessions.get(key);
      const indicatorKey=identity.spec ? JSON.stringify(identity.spec) : null;
      if (!session || indicatorKey && !session.indicators?.has(indicatorKey)) {
        const geometry=datasetGeometry(s.ticker,res);
        const dataset=await request({op:'dataset',args:{instrument:symbol,timeframe:frames[res],
          ...geometry, ...(identity.spec ? {indicators:[identity.spec]} : {})}},'market');
        if(epoch!==workspaceEpoch) return;
        send({type:'managed-dataset',dataset});
        if (!dataset.ready) {
          if (dataset.reason==='unmaintained' && !nativeReadonly && !maintenanceAsked.has(symbol)) {
            maintenanceAsked.add(symbol);
            send({type:'maintenance-required',instrument:symbol,calendar:s.calendar});
          }
          cb([],{noData:true});
          finishTerminal();
          return;
        }
        session ||= {start:dataset.start,revision:dataset.revision,indicators:new Set()};
        if(indicatorKey) session.indicators.add(indicatorKey);
        managedSessions.set(key,session);
      }
      let before=p.to*1000 + (['1D','1W','1M'].includes(res) ? 2*86400000 : 0);
      let rows=[], boundary=false;
      while(rows.length < requested) {
        const page=await query(s.ticker,res,{before,limit:Math.min(2000,requested-rows.length)});
        if(epoch!==workspaceEpoch || !hasHistoryViewer({instrument:symbol,timeframe:frames[res]})) {
          const error=Error('已取消旧图表的历史加载');error.code='HISTORY_CANCELLED';throw error;
        }
        rows=barsOf(page,res,s.ticker).filter(bar=>bar.time<p.to*1000).concat(rows);
        boundary=!page.has_more;
        if(boundary) break;
        const next=page.bars[0]?.start;
        if(!(next<before)) throw Error('已发布历史分页未推进');
        before=next;
      }
      rows=[...new Map(rows.map(bar=>[bar.time,bar])).values()].sort((a,b)=>a.time-b.time);
      if(rows.length) {
        firstHistory.set(s.ticker+'|'+res,Math.min(firstHistory.get(s.ticker+'|'+res)??Infinity,rows[0].time));
        lastHistory.set(s.ticker+'|'+res,Math.max(lastHistory.get(s.ticker+'|'+res)||0,rows.at(-1).time));
      }
      cb(rows,{noData:boundary});
      if(!rows.length) finishTerminal();
    } catch (e) {
      err(String(e));
      finishTerminal();
      if (e.code !== "HISTORY_CANCELLED")
        send({ type: "error", error: String(e) });
    } finally {
      if (p.firstDataRequest && !decode(s.ticker).spec && initialHistoryGate?.epoch === loadEpoch)
        initialHistoryGate.resolve();
    }
  },
  subscribeBars: (s, res, cb, id, reset) => {
    feed.unsubscribeBars(id);
    const identity=decode(s.ticker);
    const sub={symbol:s.ticker,res,cb,reset,last:lastHistory.get(s.ticker+'|'+res)||0,revision:null};
    subscriptions.set(id,sub);
    if(identity.series_kind==='provider') {
      sub.providerListener=crypto.randomUUID();
      const state=providerHistoryState.get(s.ticker+'|'+res)||{};
      send({type:'provider-subscribe',args:{client:clientId,listener:sub.providerListener,
        instrument:identity.symbol,timeframe:frames[res],cursor:state.cursor||sub.last,
        revision:state.revision||0,observed_at:state.observed_at||0,
        indicators:identity.spec?[identity.spec]:[]}});
    }
  },
  unsubscribeBars: id => {
    const sub=subscriptions.get(id);
    if(sub?.providerListener)
      send({type:'provider-unsubscribe',args:{client:clientId,listener:sub.providerListener}});
    subscriptions.delete(id);
  },
};
let polling = false;
function chartUsesSymbol(chart, symbol, res) {
  if (chart.resolution() !== res) return false;
  if (MWSeries.same(chart.symbol(), symbol)) return true;
  for (const study of chart.getAllStudies?.() || []) {
    try {
      const inputs = chart.getStudyById(study.id).getInputValues();
      if (
        inputs.some((input) => input.id === "symbol" && MWSeries.same(input.value, symbol))
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
let historyReloading = false;
async function reloadHistory(symbol, res, relevant = () => true) {
  if (!ready || loading || historyReloading || rangeGuard?.busy() || edgeGuard?.busy()) return false;
  historyReloading = true;
  const epoch = workspaceEpoch;
  let invalidated = false;
  try {
    for (let i=0;i<widget.chartsCount();i++) {
      const chart=widget.chart(i);
      if (!chartUsesSymbol(chart,symbol,res) || !relevant(chart)) continue;
      const rangeKey=symbol+'|'+res;
      if (chart.getTimeScale().rightOffset()<0)
        refreshingHistoryRanges.set(rangeKey,chart.getVisibleRange());
      let restored;
      try { restored=await refreshChartHistory(widget,chart,()=>{
        if (invalidated) return;
        invalidated=true;
        let notified=false;
        for (const sub of subscriptions.values()) {
          if (MWSeries.same(sub.symbol,symbol) && sub.res===res) {
            sub.reset();notified=true;
          }
        }
        if (!notified) widget.resetCache();
      },()=>epoch===workspaceEpoch && chartUsesSymbol(chart,symbol,res));
      } finally { refreshingHistoryRanges.delete(rangeKey); }
      if (!restored) return false;
    }
    return true;
  } finally { historyReloading=false; }
}
async function refreshManagedHistory(instrument) {
  if(!ready || loading) return;
  if(historyReloading || rangeGuard?.busy() || edgeGuard?.busy()) {
    send({type:'error',error:'图表当前正在操作，请稍后再次刷新历史'});
    return;
  }
  const charts=Array.from({length:widget.chartsCount()},(_,i)=>widget.chart(i));
  const refreshed=new Set();
  for(const chart of charts) {
    const identity=decode(chart.symbol()), res=chart.resolution();
    if(identity.series_kind!=='managed' || instrument && identity.symbol!==instrument) continue;
    const key=identity.symbol+'|'+res;
    if(refreshed.has(key)) continue;
    refreshed.add(key);
    managedSessions.delete(key);
    cache.clear();
    if(!await reloadHistory(identity.symbol,res))
      send({type:'error',error:'图表当前正在操作，请稍后再次刷新历史'});
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
        send({ type: "feed-poll-state", key: "@quotes", error: "" });
      } catch (e) {
        send({ type: "feed-poll-state", key: "@quotes", error: "报价更新失败：" + String(e) });
      }
    } else {
      send({ type: "feed-poll-state", key: "@quotes", error: "" });
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
        const res = Object.keys(frames).find(
          (value) => frames[value] === args.timeframe,
        );
        if (!res || await reloadHistory(args.instrument, res)) pendingHistory.delete(key);
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
      const identity = decode(first.symbol);
      if (identity.series_kind === 'provider') continue;
      const symbol = MWSeries.encode(identity.symbol, identity.series_kind);
      if (!hasHistoryViewer({ instrument: symbol, timeframe: frames[first.res] })) {
        for (const sub of group) sub.pausedForLayout = true;
        continue;
      }
      if (group.some((sub) => sub.pausedForLayout)) {
        // Refill bars missed while the native pane retained a hidden subscription.
        if (await reloadHistory(symbol, first.res))
          for (const sub of group) sub.pausedForLayout = false;
        // A busy viewport may defer its historical reset; visible realtime
        // polling must still resume instead of waiting for that reset to finish.
      }
      try {
        if (identity.series_kind === 'managed' && !managedSessions.has(identity.symbol+'|'+first.res)) continue;
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
        let needsReload = group.some(sub=>sub.needsHistoryReload);
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
            sub.needsHistoryReload = true;
            continue;
          }
          if (!sub.last && bars.length) sub.last = bars.at(-1).time;
          sub.last=Math.max(sub.last||0,lastHistory.get(first.symbol+'|'+first.res)||0);
          for (const bar of bars)
            if (bar.time >= sub.last) {
              sub.cb({ ...bar });
              sub.last = bar.time;
            }
        }
        if (needsReload && await reloadHistory(symbol, first.res))
          for (const sub of group) sub.needsHistoryReload = false;
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
  symbolMetadata = null,
) {
  initialSymbol = symbolMetadata;
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
  let pendingSync = doc.state?._mwSync || chartState?._mwSync;
  const prepareLegacyViewports = (state) => {
    beforeInitialHistory = state && !pendingSync ? () => {
      beforeInitialHistory = undefined;
      pendingSync = deferLegacyChartSynchronization(widget);
    } : undefined;
  };
  prepareLegacyViewports(chartState);
  if (chartState) {
    chartState = { ...chartState };
    delete chartState._mwViewports;
    delete chartState._mwSync;
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
  // Preserve native/user bar spacing across interval changes. History load
  // policy belongs to the planner (D1 foreground, W1 background, MN local),
  // not to viewport resizing or cache resets on a period switch.
  const loadContent = layouts.getChartContent;
  const saveLayout = layouts.saveChart;
  let initialNativeSave = false;
  let busySaveNoticeShown = false;
  layouts.saveChart = async (data) => {
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
    // An explicit initial native save binds its returned server ID without
    // reloading the chart. Only this boot call may target the existing empty
    // workspace when the native library has no ID; later Save As stays a copy.
    if (initialNativeSave && data.id == null) data = {...data, id: workspace.id};
    const state = await captureChartLayout(widget);
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
        const raw = await captureChartLayout(widget);
        if (epoch !== workspaceEpoch) return;
        const state =
          typeof savedDoc.state?.content === "string"
            ? { ...savedDoc.state, content: JSON.stringify(raw) }
            : raw;
        state._mwViewports = viewports;
        state._mwSync = raw._mwSync;
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
      pendingSync = state._mwSync;
      prepareLegacyViewports(state);
      delete state._mwViewports;
      delete state._mwSync;
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
  initialHistoryGate?.resolve();
  initialHistoryGate = {epoch: workspaceEpoch};
  initialHistoryGate.promise = new Promise(resolve => {initialHistoryGate.resolve = resolve;});
  loading = true;
  ready = false;
  progressivePages?.dispose();
  progressivePages = undefined;
  managedSessions.clear();
  maintenanceAsked.clear();
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
        default_symbols: ["EURUSD", "XAUUSD", "BTCUSDT"].map(symbol=>MWSeries.encode(symbol,"provider")),
        readonly,
      },
    },
    compare_symbols: [
      { symbol: "MWP:EURUSD", title: "EUR/USD · 平台行情" },
      { symbol: "MWP:XAUUSD", title: "黄金 / 美元 · 平台行情" },
      { symbol: "MWP:BTCUSDT", title: "BTC/USDT · 平台行情" },
    ],
    symbol: doc.symbol || "XAUUSD",
    interval: doc.interval || "240",
    ...(!chartState && decode(doc.symbol || "XAUUSD").series_kind === "managed" && ["1D", "1W", "1M"].includes(doc.interval)
      ? { timeframe: "3M" }
      : {}),
    locale: "zh",
    custom_translate_function: original => {
      if (['No data here', 'No data', 'Loading', 'Loading...'].includes(original)) return '';
      return null;
    },
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
      "open_account_manager",
      "create_volume_indicator_by_default",
      ...(readonly
        ? [
            "left_toolbar",
            "trading_account_manager",
            "order_panel",
            "broker_button",
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
      if (workspace && !readonly) {
        try {
          await new Promise((resolve) =>
            widget.activeChart().dataReady(resolve),
          );
          // Leave the initial ready dispatch before binding the server identity.
          await new Promise((resolve) => setTimeout(resolve, 0));
          initialNativeSave = true;
          await new Promise((resolve, reject) => widget.saveChartToServer(resolve, reject,
            {chartName: workspace.name}));
        } catch (e) {
          send({ type: "error", error: "工作区初始化失败：" + String(e) });
          return;
        } finally {
          initialNativeSave = false;
        }
      }
    }
    widget
      .headerReady()
      .then(async () => {
        // The website's account menu is not included in the licensed library.
        // Use its public dropdown API for this chart's menu instead.
        const chartWidget = widget;
        await chartWidget.createDropdown({
          align: "left",
          title: "图表菜单",
          tooltip: "图表菜单：切换暗色或浅色主题",
          icon: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 4.5h12M3 9h12M3 13.5h12"/></svg>`,
          items: ["Dark", "Light"].map((theme) => ({
            title: theme === "Dark" ? "暗色主题" : "浅色主题",
            onSelect: () => chartWidget.changeTheme(theme).catch((e) =>
              send({ type: "error", error: "主题切换失败：" + String(e) }),
            ),
          })),
        });
        widget.createButton({
          align: "right",
          useTradingViewStyle: true,
          text: "导出 CSV",
          title: "导出行情及当前 Python 指标",
          onClick: () => {
            const chart = widget.activeChart();
            const {symbol:instrument,series_kind} = decode(chart.symbol());
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
                series_kind,
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
              body: "保存图表样式请使用顶部“保存样式”，同名会覆盖；应用和删除在“设置 → 模板”。原生模板菜单的“保存为…”暂不可用。导出请使用顶部“导出 CSV”，包含行情及所选 Python 指标，不包含原生内置指标值。原生数据导出暂不可用。账户管理器入口保留，交易暂未接入；展开为空不代表已连接账户。手机只读，临时操作不会保存到电脑工作区。行情按 M1 更新，并非逐笔报价；成交量、盘口、新闻、交易执行和图上预警暂未接入。",
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
    restoreChartSynchronization(widget, pendingSync);
    pendingSync = undefined;
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
      const sessionRequests = new Map();
      edgeGuard = edgeRangeSync(
        widget,
        () => loading || viewportRestoring || historyReloading || !!rangeGuard?.busy(),
        (error) =>
          send({ type: "error", error: "时间范围同步失败：" + String(error) }),
        async (chart, target) => {
          if (decode(chart.symbol()).series_kind === "provider") return target;
          const symbol = decode(chart.symbol()).symbol;
          if (target.to - target.from > 31 * 86400) return target;
          // An actual observed candle inside the target proves this is not
          // an entirely closed session. Ordinary pan/zoom needs no calendar RPC.
          const historyKey = chart.symbol() + '|' + chart.resolution();
          if ([firstHistory.get(historyKey),lastHistory.get(historyKey)].some(
            time => Number.isFinite(time) && time >= target.from*1000 && time < target.to*1000))
            return {...target,notice:""};
          const args = {instrument:symbol,start:Math.floor(target.from*1000),end:Math.ceil(target.to*1000)};
          const key = JSON.stringify(args);
          let lookup = sessionRequests.get(key);
          if (!lookup) {
            lookup = request({op:"viewport",args},"market");
            sessionRequests.set(key,lookup);
            lookup.finally(()=>{if(sessionRequests.get(key)===lookup)sessionRequests.delete(key);}).catch(()=>{});
          }
          const result = await lookup;
          const label = value => new Date(value * 1000).toISOString().slice(0, 16).replace("T", " ");
          const text = result.closed
            ? `${symbol}：目标区间休市，当前显示休市前行情（目标 ${label(target.from)} 至 ${label(target.to)} UTC）`
            : "";
          const step = Number(chart.resolution()) * 60;
          return result.closed ? {from: Math.min(result.start / 1000, result.end / 1000 - 2 * step), to: result.end / 1000 - step, notice: text} : {...target, notice: ""};
        },
        (chart, text) => send({type: "viewport-notice", key: String(Array.from({length: widget.chartsCount()}, (_, i) => widget.chart(i)).indexOf(chart)), text}),
      );
    };
    widget.subscribe("chart_load_requested", () => {
      send({type: "viewport-notice", key: "*", text: ""});
      edgeGuard?.dispose();
      edgeGuard = undefined;
      rangeGuard?.dispose();
      rangeGuard = undefined;
      workspaceEpoch++;
      for(const [id,sub] of subscriptions) if(sub.providerListener) feed.unsubscribeBars(id);
      providerHistoryState.clear();
      lastHistory.clear();
      firstHistory.clear();
      indicatorHistoryNeeds.clear();
      managedSessions.clear();
      maintenanceAsked.clear();
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
      restoreChartSynchronization(widget, pendingSync);
      pendingSync = undefined;
      loading = false;
      rangeGuard?.dispose();
      rangeGuard = rangeSyncLoadingGuard(widget);
      bindEdgeSync();
      bindViewports();
    });
    rangeGuard = rangeSyncLoadingGuard(widget);
    bindEdgeSync();
    bindViewports();
    widget.subscribe("layout_changed", () => {
      send({type: "viewport-notice", key: "*", text: ""});
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
    clearInterval(progressivePoll);
    widget.headerReady().then(()=> {
      widget.createButton({align:'right',useTradingViewStyle:true,text:'维护历史',
        title:'填写历史起点，并持续维护最新行情',onClick:()=> {
          const identity=decode(widget.activeChart().symbol());
          if(identity.series_kind==='managed') send({type:'maintenance-required',instrument:identity.symbol});
          else send({type:'history-plans-open'});
        }});
      widget.createButton({align:'right',useTradingViewStyle:true,text:'刷新历史',
        title:'载入新发布历史，保留柱宽与查看位置',onClick:()=>refreshManagedHistory()});
      widget.createButton({align:'right',useTradingViewStyle:true,text:'历史任务',
        title:'查看维护状态和各周期可用范围',onClick:()=>send({type:'history-plans-open'})});
    });
    demandReporter?.dispose();
    demandReporter=undefined;
    poll = setInterval(() => {
      tick();
      demandReporter?.tick();
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
  if(m.type==='provider-event') {
    const event=m.event,sub=[...subscriptions.values()].find(s=>s.providerListener===event?.listener);
    if(!sub) return;
    if(event.type==='reset') {
      sub.needsHistoryReload=true;
      if(await reloadHistory(sub.symbol,sub.res).catch(error=>send({type:'error',error:String(error)})))
        sub.needsHistoryReload=false;
    } else if(event.type==='bars') {
      if(sub.needsHistoryReload) {
        if(await reloadHistory(sub.symbol,sub.res))sub.needsHistoryReload=false;
        return;
      }
      const rows=barsOf({bars:event.bars,indicators:event.indicators||[]},sub.res,sub.symbol);
      for(const bar of rows) if(bar.time>=sub.last) {sub.cb({...bar});sub.last=bar.time;}
    } else if(event.type==='error') {
      send({type:'error',error:event.error||'平台行情暂不可用，后台重试中'});
    }
    return;
  }
  if (m.type === "result") {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    clearTimeout(p.cancellationTimer);
    m.error ? p.reject(Error(m.error)) : p.resolve(m.result);
    drain();
  } else if (m.type === "init" && !widget)
    boot(m.document, m.readonly, m.catalog, m.preferences, m.workspace, m.initial_symbol);
  else if (m.type === 'refresh-managed') await refreshManagedHistory(m.instrument);
  else if (m.type === "save") snapshot();
  else if (m.type === "theme" && ready) {
    savedDoc.theme = m.theme;
    await widget.changeTheme(m.theme);
    snapshot();
  }
});
send({ type: "loaded" });
