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
    color: "#5A91FF",
    transparencyMode: "theme",
    transparency: 82,
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
    labelPaints.clear();
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
      if (
        typeof MWSeries !== "undefined" &&
        MWSeries.decode?.(retained.symbol)?.spec
      )
        continue;
      const k = key(retained.symbol, retained.resolution, retained.window);
      if (Number.isFinite(retained.from) && Number.isFinite(retained.to)) {
        current.add(k);
        const old = live.get(k);
        live.set(
          k,
          old
            ? {
                from: Math.min(old.from, retained.from),
                to: Math.max(old.to, retained.to),
              }
            : retained,
        );
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
  // Rectangle labels are painted by the existing pane overlay. Price-axis
  // objects, width, autoscale and chart layout remain untouched.
  const labelPaints = new Map();
  function clearLabel(pane) { labelPaints.delete(pane); }
  function priceLabels(chart, pane, context, projection) {
    if (!config.priceLabels) return;
    const { left, right, a, b, extrema, candles } = projection;
    const width = pane.width?.() ?? model(chart).timeScale().width();
    const height = pane.height(), dark = widget().getTheme().toLowerCase() === "dark";
    const fontSize = model(chart).properties?.().childs().scalesProperties.childs().fontSize.value() || 12;
    context.font = `${fontSize}px Arial,sans-serif`;
    context.textBaseline = "middle";
    const gap = 8, pad = 5, tagHeight = fontSize + 8;
    const canvasRect = pane.canvasElement().getBoundingClientRect();
    const legend = pane._legendWidget?.getElement?.();
    // Reserve the actual legend's bounds, including multi-line study legends.
    const obstacles = [...(pane.getElement?.().querySelectorAll('[data-name="legend"]') || [])]
      .map(el => el.getBoundingClientRect())
      .filter(rect => rect.width && rect.height)
      .map(rect => ({left:rect.left-canvasRect.left,right:rect.right-canvasRect.left,
        top:rect.top-canvasRect.top,bottom:rect.bottom-canvasRect.top}));
    if (legend?.getBoundingClientRect) {
      const rect = legend.getBoundingClientRect();
      obstacles.push({left:rect.left-canvasRect.left,right:rect.right-canvasRect.left,
        top:rect.top-canvasRect.top,bottom:rect.bottom-canvasRect.top});
    }
    const overlaps = (x,y,w,h,rect) => x < rect.right + 2 && x+w > rect.left-2
      && y < rect.bottom+2 && y+h > rect.top-2;
    const labels = [];
    for (const [kind, name, price, boundary, extreme] of [
      ["high","高",source.high,a,extrema.high],
      ["low","低",source.low,b,extrema.low],
    ]) {
      const text = name + " " + chart.priceFormatter().format(price);
      const item = { kind, text, price, boundary, visible:false, reason:"unmatched-extreme" };
      labels.push(item);
      if (!extreme) continue;
      item.barTime = extreme.time; item.barX = extreme.x;
      const w = Math.ceil(context.measureText(text).width) + pad*2;
      const topEdge = boundary <= (kind === "high" ? b : a);
      const y = topEdge ? boundary-gap-tagHeight : boundary+gap;
      const x = Math.max(2, Math.min(width-w-2, extreme.x-w/2));
      item.box = { x, y, width:w, height:tagHeight };
      const leaderStart = topEdge ? y+tagHeight : boundary+3;
      const leaderEnd = topEdge ? boundary-3 : y;
      item.leader = { x:extreme.x-0.5, y:leaderStart, width:1, height:leaderEnd-leaderStart };
      if (y < 2 || y+tagHeight > height-2 || w+4 > width || boundary < 0 || boundary > height) {
        item.reason = "outside-pane"; continue;
      }
      // Never move a label onto a different bar to find space. Check every
      // loaded visible wick under its box, including bars outside the mapping.
      const occupied = rect => overlaps(x,y,w,tagHeight,rect)
        || overlaps(item.leader.x,item.leader.y,item.leader.width,item.leader.height,rect);
      if (candles.some(occupied)
        || obstacles.some(occupied)
        || labels.some(other=>other!==item && other.visible && overlaps(x,y,w,tagHeight,
          {left:other.box.x,right:other.box.x+other.box.width,top:other.box.y,bottom:other.box.y+other.box.height}))) {
        item.reason = "occupied"; continue;
      }
      item.visible = true; item.reason = "";
      context.fillStyle = dark ? "#1F1F1F" : "#FFFFFF";
      context.fillRect(x,y,w,tagHeight);
      context.strokeStyle = dark ? "#5A91FF" : "#2962FF";
      context.lineWidth = 1; context.strokeRect(x+0.5,y+0.5,w-1,tagHeight-1);
      context.fillStyle = dark ? "#DBDBDB" : "#131722";
      context.fillText(text,x+pad,y+tagHeight/2);
      // Both the label and its short leader have passed the collision checks.
      context.beginPath(); context.moveTo(extreme.x,topEdge?y+tagHeight:y);
      context.lineTo(extreme.x,topEdge?boundary-3:boundary+3); context.stroke();
    }
    labelPaints.set(pane, labels);
  }
  function fillColor(value = config) {
    const dark = widget().getTheme().toLowerCase() === "dark";
    const hex =
      value.colorMode === "custom" ? value.color : dark ? "#5A91FF" : "#2962FF";
    const alpha =
      1 -
      (value.transparencyMode === "custom"
        ? value.transparency
        : dark
          ? 82
          : 88) /
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
        const pane = mainPane(chart);
        if (pane) labelPaints.delete(pane);
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
            labelPaints.clear();
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
    labelPaints.clear();
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
    labelPaints.clear();
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
  function project(chart, pane) {
    if (!pane || !active() || !source || chart === source.chart || !timeSeries(chart)
      || !MWSeries.same(chart.symbol(), source.symbol)
      || !chartBarRangeMapping.eligible(source.resolution, chart.resolution())) return;
    const m = model(chart);
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
      let left = Infinity, right = -Infinity;
      const extrema = {}, candles = [], series = m.mainSeries(), scale = series.priceScale(), value = series.firstValue();
      // Provider extrema are selected from unchanged OHLC values. A tolerance
      // could collapse distinct valid ticks (e.g. eight-decimal Yahoo prices).
      const match = (a,b) => a === b;
      for (let i = Math.min(first, last); i <= Math.max(first, last); i++) {
        const t = timeAt(i);
        if (!Number.isFinite(t)) continue;
        const publicTime =
          i <= range.lastIndex
            ? chart._convertIndexToPublicTime(i)
            : converter.convertInternalTimeToPublicTime(t);
        const time = publicTime * 1000, row = store?.rows.get(time);
        const center = ts.indexToCoordinate(i);
        // Actual native OHLC is needed outside the mapped interval too, so
        // labels cannot obscure a neighbouring candle in the same viewport.
        const nativeBar = config.style === "rectangle" && config.priceLabels ? series.bars().valueAt?.(i) : undefined;
        const high = nativeBar?.[2] ?? row?.high, low = nativeBar?.[3] ?? row?.low;
        if (config.style === "rectangle" && config.priceLabels && value != null && !scale.isEmpty() && Number.isFinite(high) && Number.isFinite(low)) {
          const yHigh = scale.priceToCoordinate(high,value), yLow = scale.priceToCoordinate(low,value);
          if (Number.isFinite(yHigh) && Number.isFinite(yLow)) candles.push({
            left:center-Math.max(1,ts.barSpacing()*0.4),right:center+Math.max(1,ts.barSpacing()*0.4),
            top:Math.min(yHigh,yLow),bottom:Math.max(yHigh,yLow),time,high,low,
          });
        }
        if (row && nativeBar && row.start >= source.start && row.end <= source.end && center >= 0 && center <= ts.width()) {
          for (const kind of ["high","low"]) if (match(row[kind],source[kind]) && match(kind === "high" ? high : low,source[kind]) && (!extrema[kind] || time < extrema[kind].time))
            extrema[kind] = {time,x:center};
        }
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
      if (config.style !== "rectangle") return { left, right };
      if (value == null || scale.isEmpty()) return;
      return { left, right, extrema, candles, a: scale.priceToCoordinate(source.high, value),
        b: scale.priceToCoordinate(source.low, value) };
  }
  function draw(pane, context, info) {
    if (!pane.containsMainSeries()) return;
    const chart = [...bindings.keys()].find(chart => model(chart) === pane.state().model());
    clearLabel(pane);
    if (!chart) return;
    const projection = project(chart, pane);
    if (!projection) return;
    const { left, right, a, b } = projection;
    let top = 0, bottom = pane.height();
    if (config.style === "rectangle") {
      top = Math.max(0, Math.min(a, b)); bottom = Math.min(bottom, Math.max(a, b));
      if (!(bottom > top)) return;
    }
      context.save();
      try {
      context.scale(
        info.bitmapSize.width / info.mediaSize.width,
        info.bitmapSize.height / info.mediaSize.height,
      );
      context.fillStyle = fillColor();
      context.fillRect(left, top, right - left, bottom - top);
      if (config.style === "rectangle") {
        context.strokeStyle = fillColor({ ...config, transparencyMode:"custom", transparency:35 });
        context.lineWidth = 1;
        context.strokeRect(left+0.5,top+0.5,Math.max(0,right-left-1),Math.max(0,bottom-top-1));
        priceLabels(chart,pane,context,projection);
      }
      } finally { context.restore(); }
  }
  return {
    observeBars,
    cachePurged: () => schedule(true),
    refreshCharts,
    hide,
    // Retain the installed height hook contract without reserving a bottom rail.
    railHeight: () => 0,
    labels: (chart) => (labelPaints.get(mainPane(chart)) || []).map(label => ({ ...label, box: label.box && { ...label.box } })),
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
      labelPaints.clear();
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
      bindings: bindings.size,
      rails: 0,
      labelPanes: labelPaints.size,
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
      labelPaints.clear();
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
