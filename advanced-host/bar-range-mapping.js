/* Accepted candle intervals are authoritative. Native indices are coordinates,
 * never saved semantics. The verified pane hook draws below candle sources. */
function chartBarRangeMapping({
  widget: getWidget,
  initial,
  readonly = false,
  changed = () => {},
  frame = requestAnimationFrame,
  cancelFrame = cancelAnimationFrame,
} = {}) {
  const defaults = {
    version: 2,
    enabled: false,
    style: "background",
    colorMode: "theme",
    color: "#FFFFFF",
    transparencyMode: "theme",
    transparency: 88,
    priceLabels: true,
  };
  const validate = (value) => {
    if (![1, 2].includes(value?.version)) return { ...defaults };
    return {
      version: 2,
      enabled: value.enabled === true,
      style: ["background", "rectangle"].includes(value.style)
        ? value.style
        : "background",
      colorMode: value.colorMode === "custom" ? "custom" : "theme",
      color: /^#[0-9a-f]{6}$/i.test(value.color)
        ? value.color.toUpperCase()
        : defaults.color,
      transparencyMode:
        value.transparencyMode === "custom" ? "custom" : "theme",
      transparency:
        typeof value.transparency === "number" &&
        Number.isFinite(value.transparency)
          ? Math.max(0, Math.min(100, value.transparency))
          : defaults.transparency,
      priceLabels: value.priceLabels !== false,
    };
  };
  let config = validate(initial),
    disposed = false,
    suspended = false,
    raf = 0,
    epoch = 0,
    needsPrune = true;
  let doc, pointer, source, syncBinding;
  const rails = new Map();
  const stores = new Map(),
    tickets = new Map(),
    bindings = new Map(),
    listeners = new Set();
  const key = (symbol, resolution, window = "") => {
    const identity =
      typeof MWSeries !== "undefined" ? MWSeries.decode?.(symbol) : undefined;
    const canonical = identity
      ? MWSeries.encode(identity.symbol, identity.series_kind)
      : symbol;
    return `${canonical}|${resolution}|${window}`;
  };
  const widget = () =>
    typeof getWidget === "function" ? getWidget() : getWidget;
  const chartKey = (chart) =>
    key(
      chart.symbol(),
      chart.resolution(),
      globalThis.MWNativeNavigation?.chartWindow(chart)?.id,
    );
  const model = (chart) => chart._chartWidget.model().model();
  const timeSeries = (chart) => [0, 1, 2, 3, 9].includes(chart.chartType());
  const active = () =>
    !disposed &&
    !suspended &&
    config.enabled &&
    widget()?.crosshairSync().value();
  function repaint() {
    for (const chart of bindings.keys()) {
      try {
        model(chart).lightUpdate();
      } catch (_) {
        /* A native pane can already have exited. */
      }
    }
  }
  const signature = () =>
    source &&
    `${source.key}|${source.generation}|${source.chartTime}|${source.start}|${source.end}|${source.high}|${source.low}`;
  function hide() {
    source = undefined;
    pointer = undefined;
    epoch++;
    for (const rail of rails.values()) rail.replaceChildren();
    cancelFrame(raf);
    raf = 0;
    repaint();
  }
  function schedule(pruning = false) {
    needsPrune ||= pruning === true;
    if (disposed || suspended || raf) return;
    raf = frame(() => {
      raf = 0;
      if (needsPrune) {
        prune();
        needsPrune = false;
      }
      updateSource();
      repaint();
    });
  }
  function mainPane(chart) {
    return chart._chartWidget
      .paneWidgets()
      .find((pane) => pane.containsMainSeries());
  }
  function prune() {
    if (!bindings.size) return;
    const live = new Map(),
      current = new Set();
    for (const retained of globalThis.MWNativeReserve?.acceptedRanges() || []) {
      if (typeof MWSeries !== "undefined" && MWSeries.decode?.(retained.symbol)?.spec) continue;
      const k = key(retained.symbol, retained.resolution, retained.window);
      if (Number.isFinite(retained.from) && Number.isFinite(retained.to)) {
        current.add(k);
        const old = live.get(k);
        live.set(k,old ? {from:Math.min(old.from,retained.from),to:Math.max(old.to,retained.to)} : retained);
      }
    }
    for (const chart of bindings.keys()) {
      try {
        current.add(chartKey(chart));
        if (!chart.dataReady()) continue;
        const bars = model(chart).mainSeries().bars(),
          first = bars.firstIndex(),
          last = bars.lastIndex();
        if (first == null || last == null) continue;
        const ts = model(chart).timeScale(),
          converter = chart._getTimeConverter();
        const from = chart._convertIndexToPublicTime(first) * 1000;
        const to = chart._convertIndexToPublicTime(last) * 1000;
        const k = chartKey(chart),
          range = live.get(k);
        live.set(
          k,
          range
            ? { from: Math.min(from, range.from), to: Math.max(to, range.to) }
            : { from, to },
        );
      } catch (_) {}
    }
    for (const k of tickets.keys()) if (!current.has(k)) tickets.delete(k);
    for (const [k, store] of stores) {
      const range = live.get(k);
      if (!range) {
        if (!current.has(k)) stores.delete(k);
        continue;
      }
      for (const time of store.rows.keys())
        if (time < range.from || time > range.to) store.rows.delete(time);
    }
  }
  function updateSource() {
    if (!active() || !pointer || !bindings.has(pointer.chart)) {
      source = undefined;
      return;
    }
    const chart = pointer.chart;
    try {
      const m = model(chart),
        ts = m.timeScale(),
        pane = mainPane(chart),
        canvas = pane?.canvasElement();
      if (!canvas?.isConnected || !chart.dataReady() || !timeSeries(chart)) {
        source = undefined;
        return;
      }
      const rect = canvas.getBoundingClientRect(),
        x = pointer.x - rect.left,
        y = pointer.y - rect.top;
      if (x < 0 || x >= rect.width || y < 0 || y >= rect.height) {
        source = undefined;
        return;
      }
      const index = ts.coordinateToIndex(x);
      if (!m.mainSeries().bars().contains(index)) {
        source = undefined;
        return;
      }
      if (
        doc &&
        doc.elementFromPoint(pointer.x, pointer.y)?.tagName !== "CANVAS"
      ) {
        source = undefined;
        return;
      }
      const chartTime = chart._convertIndexToPublicTime(index) * 1000;
      const store = stores.get(chartKey(chart)),
        bar = store?.rows.get(chartTime);
      source = bar
        ? {
            chart,
            key: chartKey(chart),
            generation: store.generation,
            symbol: chart.symbol(),
            resolution: chart.resolution(),
            chartTime,
            ...bar,
          }
        : undefined;
    } catch (_) {
      source = undefined;
    }
  }
  function move(event) {
    if (!active() || event.pointerType === "touch") {
      hide();
      return;
    }
    const target = event.target;
    if (
      target.closest?.(
        'button, [role="menu"], [role="menuitem"], [role="dialog"], [data-name^="mw-"], [data-qa-id="legend"]',
      ) ||
      target.tagName !== "CANVAS"
    ) {
      hide();
      return;
    }
    for (const chart of bindings.keys()) {
      const pane = mainPane(chart),
        rect = pane?.canvasElement().getBoundingClientRect();
      if (
        rect &&
        event.clientX >= rect.left &&
        event.clientX < rect.right &&
        event.clientY >= rect.top &&
        event.clientY < rect.bottom
      ) {
        const previous = signature();
        pointer = { chart, x: event.clientX, y: event.clientY };
        updateSource();
        if (previous !== signature()) schedule();
        return;
      }
    }
    hide();
  }
  function notify() {
    for (const listener of listeners) listener({ ...config });
  }
  function reserved(chart) {
    return (
      !disposed &&
      config.enabled &&
      config.style === "rectangle" &&
      config.priceLabels &&
      widget()?.crosshairSync().value() &&
      timeSeries(chart)
    );
  }
  function refreshRails() {
    for (const [cw, rail] of rails) {
      if (
        ![...bindings.keys()].some((c) => c._chartWidget === cw && reserved(c))
      ) {
        rail.remove();
        rails.delete(cw);
        try {
          cw.model().model().fullUpdate();
        } catch {}
      }
    }
    for (const chart of bindings.keys()) {
      const cw = chart._chartWidget;
      if (!reserved(chart) || rails.has(cw)) continue;
      const rail = cw.ownerDocument().createElement("div");
      rail.dataset.name = "mw-range-price-rail";
      rail.className = "mw-range-price-rail";
      rail.style.cssText =
        "position:absolute;bottom:0;left:0;right:0;height:36px;box-sizing:border-box;pointer-events:none;display:flex;flex-direction:column;justify-content:center;padding:2px 8px;font:12px/16px Arial,sans-serif;overflow:hidden";
      cw._parent.appendChild(rail);
      rails.set(cw, rail);
      cw.model().model().fullUpdate();
    }
  }
  function clearLabel(pane) {
    const rail = [...rails].find(([cw]) =>
      cw.paneWidgets().includes(pane),
    )?.[1];
    if (rail?.childNodes.length) rail.replaceChildren();
  }
  function priceLabel(chart, pane, scale, value) {
    const rail = rails.get(chart._chartWidget);
    if (!rail || !source || !config.priceLabels) return;
    const high = scale.priceToCoordinate(source.high, value),
      low = scale.priceToCoordinate(source.low, value);
    const text = (price, y, name) =>
      name +
      " " +
      chart.priceFormatter().format(price) +
      (y < 0 || y > pane.height() ? "（" + name + "价在屏外）" : "");
    const lines = [text(source.high, high, "高"), text(source.low, low, "低")];
    if (rail.textContent !== lines.join("")) {
      rail.replaceChildren(
        ...lines.map((text) => {
          const e = rail.ownerDocument.createElement("div");
          e.textContent = text;
          e.style.cssText =
            "white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
          e.title = text;
          return e;
        }),
      );
    }
    const dark = widget().getTheme().toLowerCase() === "dark";
    rail.style.background = dark ? "#131722" : "#FFFFFF";
    rail.style.color = dark ? "#D1D4DC" : "#131722";
  }
  function fillColor(value = config) {
    const dark = widget().getTheme().toLowerCase() === "dark";
    const hex =
      value.colorMode === "custom"
        ? value.color
        : dark
          ? "#FFFFFF"
          : "#6B7280";
    const alpha =
      1 -
      (value.transparencyMode === "custom"
        ? value.transparency
        : dark
          ? 88
          : 85) /
        100;
    return `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${alpha})`;
  }
  function refreshCharts() {
    if (disposed || !widget()) return;
    suspended = false;
    if (!syncBinding) {
      syncBinding = widget().crosshairSync();
      syncBinding.subscribe(syncChanged);
    }
    const charts = new Set(
      Array.from({ length: widget().chartsCount() }, (_, i) =>
        widget().chart(i),
      ),
    );
    for (const [chart, cleanup] of bindings)
      if (!charts.has(chart)) {
        cleanup();
        bindings.delete(chart);
        if (pointer?.chart === chart) hide();
      }
    for (const chart of charts)
      if (!bindings.has(chart)) {
        const subscriptions = [];
        const subscribe = (event, fn) => {
          event.subscribe(null, fn);
          subscriptions.push(() => event.unsubscribe(null, fn));
        };
        const reset = () => {
          if (pointer?.chart === chart) hide();
          schedule(true);
        };
        subscribe(chart.onSymbolChanged(), reset);
        subscribe(chart.onIntervalChanged(), reset);
        if (chart.onChartTypeChanged)
          subscribe(chart.onChartTypeChanged(), () => {
            hide();
            refreshRails();
            schedule(true);
          });
        subscribe(chart.onVisibleRangeChanged(), schedule);
        subscribe(chart.onDataLoaded(), () => schedule(true));
        subscribe(chart.crossHairMoved(), () => {
          if (pointer?.chart !== chart) return;
          const previous = signature();
          updateSource();
          if (previous !== signature()) schedule();
        });
        const cw = chart._chartWidget;
        bindings.set(chart, () => subscriptions.forEach((fn) => fn()));
        if (!doc) {
          doc = cw.ownerDocument();
          doc.addEventListener("pointermove", move, true);
          doc.addEventListener("pointerout", leave, true);
          doc.addEventListener("focusin", hide);
          doc.defaultView.addEventListener("blur", hide);
        }
      }
    refreshRails();
    schedule(true);
  }
  function leave(event) {
    // Native menus can appear under a stationary pointer. Clearing at the
    // actual canvas exit prevents a delayed frame from resurrecting it.
    if (
      event.target.tagName === "CANVAS" &&
      event.relatedTarget?.tagName !== "CANVAS"
    )
      hide();
  }
  const syncChanged = () => {
    hide();
    refreshRails();
    notify();
  };
  function observeBars({
    symbol,
    resolution,
    window = "",
    bars,
    reset = false,
    ticket,
  }) {
    if (
      disposed ||
      !bars?.length ||
      (typeof MWSeries !== "undefined"
        ? MWSeries.decode?.(symbol)?.spec
        : false)
    )
      return;
    const k = key(symbol, resolution, window);
    if (ticket && tickets.get(k) !== ticket) return;
    let store = stores.get(k);
    if (!store || reset)
      stores.set(
        k,
        (store = { generation: (store?.generation || 0) + 1, rows: new Map() }),
      );
    for (const b of bars) {
      const time = Number(b.chart_time),
        start = Number(b.start),
        end = Number(b.end),
        high = Number(b.high),
        low = Number(b.low);
      if (
        [b.chart_time, b.start, b.end, b.high, b.low].every(
          (v) => v !== null && v !== undefined && v !== "",
        ) &&
        [time, start, end, high, low].every(Number.isFinite) &&
        end > start &&
        high >= low
      )
        store.rows.set(time, {
          start,
          end,
          high,
          low,
          complete: b.complete === true,
        });
    }
    schedule(true);
  }
  function draw(pane, context, info) {
    if (!pane.containsMainSeries()) return;
    let labelShown = false;
    try {
      if (!active() || !source || !pane.containsMainSeries()) return;
      const m = pane.state().model();
      const chart = [...bindings.keys()].find((chart) => model(chart) === m);
      if (
        !chart ||
        chart === source.chart ||
        !timeSeries(chart) ||
        !MWSeries.same(chart.symbol(), source.symbol) ||
        !chartBarRangeMapping.eligible(source.resolution, chart.resolution())
      )
        return;
      const sourceStore = stores.get(source.key);
      if (!sourceStore || sourceStore.generation !== source.generation) return;
      const ts = m.timeScale(),
        points = ts.points(),
        sync = m.mainSeries().syncModel();
      const range = points.range().value();
      if (!range || !sync?.isValid()) return;
      const converter = chart._getTimeConverter(),
        store = stores.get(chartKey(chart));
      const timeAt = (index) =>
        points.valueAt(index) ??
        points.roughTime(index, sync.projectTime.bind(sync));
      const first = Math.floor(ts.coordinateToFloatIndex(0)) - 1,
        last = Math.ceil(ts.coordinateToFloatIndex(ts.width())) + 1;
      let left = Infinity,
        right = -Infinity;
      for (let i = Math.min(first, last); i <= Math.max(first, last); i++) {
        const t = timeAt(i);
        if (!Number.isFinite(t)) continue;
        const publicTime =
          i <= range.lastIndex
            ? chart._convertIndexToPublicTime(i)
            : converter.convertInternalTimeToPublicTime(t);
        const row = store?.rows.get(publicTime * 1000);
        let start = row?.start,
          end = row?.end;
        if (!row) {
          // Only extrapolate future slots using the library's exchange calendar.
          // Unknown historical metadata must never be approximated.
          if (i <= range.lastIndex) continue;
          const slot = sync.mwRangeSlot?.(t * 1000, true);
          if (!slot) continue;
          start = slot.start;
          end = slot.end;
        }
        const from = Math.max(source.start, start),
          to = Math.min(source.end, end);
        if (!(to > from && end > start)) continue;
        const x = ts.indexToCoordinate(i) - ts.barSpacing() / 2;
        left = Math.min(
          left,
          x + ((from - start) / (end - start)) * ts.barSpacing(),
        );
        right = Math.max(
          right,
          x + ((to - start) / (end - start)) * ts.barSpacing(),
        );
      }
      left = Math.max(0, left);
      right = Math.min(ts.width(), right);
      if (!(right > left)) return;
      let top = 0,
        bottom = pane.height();
      if (config.style === "rectangle") {
        const series = m.mainSeries(),
          scale = series.priceScale(),
          value = series.firstValue();
        if (value == null || scale.isEmpty()) return;
        const a = scale.priceToCoordinate(source.high, value),
          b = scale.priceToCoordinate(source.low, value);
        priceLabel(chart, pane, scale, value);
        labelShown = true;
        top = Math.max(0, Math.min(a, b));
        bottom = Math.min(bottom, Math.max(a, b));
        if (!(bottom > top)) return;
      }
      context.save();
      context.scale(
        info.bitmapSize.width / info.mediaSize.width,
        info.bitmapSize.height / info.mediaSize.height,
      );
      context.fillStyle = fillColor();
      context.fillRect(left, top, right - left, bottom - top);
      context.restore();
    } finally {
      if (!labelShown) clearLabel(pane);
    }
  }
  return {
    observeBars,
    cachePurged: () => schedule(true),
    refreshCharts,
    hide,
    railHeight: (cw) => (rails.has(cw) ? 36 : 0),
    defaults: () => ({ ...defaults }),
    fillColor,

    draw,
    capture(symbol, resolution, window = "") {
      const k = key(symbol, resolution, window);
      if (!tickets.has(k)) tickets.set(k, {});
      return tickets.get(k);
    },
    configure(value, restore = false) {
      const next = validate({ ...config, ...value });
      if (JSON.stringify(next) === JSON.stringify(config)) return;
      hide();
      config = next;
      refreshRails();
      notify();
      if (!restore && !readonly) changed();
    },
    invalidate(symbol, resolution, window = "") {
      globalThis.MWSyncCoordinator?.invalidate();
      const k = key(symbol, resolution, window);
      stores.delete(k);
      tickets.set(k, {});
      hide();
    },
    suspend() {
      suspended = true;
      hide();
      stores.clear();
      tickets.clear();
    },
    snapshot: () => ({ ...config }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    diagnostics: () => ({
      epoch,
      source: source && {
        symbol: source.symbol,
        resolution: source.resolution,
        chartTime: source.chartTime,
        start: source.start,
        end: source.end,
        high: source.high,
        low: source.low,
      },
      bindings:bindings.size,
      rails:rails.size,
      stores: [...stores].map(([key, s]) => ({
        key,
        size: s.rows.size,
        generation: s.generation,
      })),
    }),
    dispose() {
      if (disposed) return;
      hide();
      disposed = true;
      syncBinding?.unsubscribe(syncChanged);
      for (const cleanup of bindings.values()) cleanup();
      bindings.clear();
      stores.clear();
      tickets.clear();
      for (const rail of rails.values()) rail.remove();
      rails.clear();
      listeners.clear();
      doc?.removeEventListener("pointermove", move, true);
      doc?.removeEventListener("pointerout", leave, true);
      doc?.removeEventListener("focusin", hide);
      doc?.defaultView.removeEventListener("blur", hide);
    },
  };
}
chartBarRangeMapping.eligible = (source, target) => {
  const rank = ["1", "5", "15", "30", "60", "240", "1D", "1W", "1M"];
  const a = rank.indexOf(source),
    b = rank.indexOf(target);
  return b >= 0 && a > b && !(source === "1M" && target === "1W");
};
// Installed into the private native main-pane paint path after SHA validation.
globalThis.MWBarRangeRenderer = {
  draw: (...args) => {
    try {
      globalThis.MWBarRangeMapping?.draw(...args);
    } catch (error) {
      globalThis.MWBarRangeMapping?.suspend();
      console.error("K线范围映射绘制失败", error);
    }
  },
};
