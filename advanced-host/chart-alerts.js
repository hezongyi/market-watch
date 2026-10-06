/* Public native adapters only. Authenticated writes are delegated to the parent. */
function chartAlertBridge({
  getWidget,
  getWorkspace,
  getEpoch,
  isLoading,
  readonly,
  metadata,
  frames,
  calculationOrigin = () => null,
  rpc,
  send,
  fail,
}) {
  let ids = new Map(),
    storedIds = [],
    rows = [],
    disposed = false,
    attached = false,
    suppress = 0;
  const objects = new Map(),
    bindings = new Map(),
    edits = new Map(),
    markers = new Map(),
    generations = new Map(),
    previewChanges = new Map(),
    reconciliations = new Map();
  const failedEdits = new Set();
  const recoveredSlots = new Map();
  let pointerDown = false;
  let pointerChart = null;
  let menuPoint = null;
  const generation = (chart) => `${getEpoch()}:${generations.get(chart) || 0}`;
  const chartList = () =>
    Array.from({ length: getWidget()?.chartsCount() || 0 }, (_, i) =>
      getWidget().chart(i),
    );
  function chartIdentity(chart) {
    if (!ids.has(chart)) {
      const index = chartList().indexOf(chart);
      ids.set(chart, storedIds[index] || crypto.randomUUID());
    }
    return ids.get(chart);
  }
  function associatedChart(a, row) {
    if (!a || a.workspace_id !== String(getWorkspace()?.id)) return null;
    const known = chartList().find(
      (chart) => chartIdentity(chart) === a.chart_id,
    );
    if (known) return known;
    // Backend association survives a refresh even when automatic layout save
    // was disabled. The slot is a hint, checked against source and timeframe.
    const hinted = chartList()[a.chart_index];
    if (
      hinted &&
      !storedIds.length &&
      row &&
      matches(hinted, row) &&
      (!recoveredSlots.has(a.chart_index) ||
        recoveredSlots.get(a.chart_index) === a.chart_id)
    ) {
      recoveredSlots.set(a.chart_index, a.chart_id);
      ids.set(hinted, a.chart_id);
      return hinted;
    }
    return null;
  }
  function snapshot(chart) {
    const identity = MWSeries.decode(chart.symbol()),
      meta = metadata(chart.symbol());
    if (!meta?.source || !frames[chart.resolution()])
      throw Error("请等待图表行情身份解析后创建告警");
    if (![0, 1, 2, 3].includes(chart.chartType()))
      throw Error(
        "当前变换图表不能按原始价格创建告警，请切回普通 K 线或价格线",
      );
    return {
      request_id: crypto.randomUUID(),
      instrument: identity.symbol,
      series_kind: identity.series_kind,
      timeframe: frames[chart.resolution()],
      source: meta.source,
      calculation_origin:
        calculationOrigin(chart.symbol(), chart.resolution()) ?? null,
      published: identity.series_kind === "managed",
      association: {
        workspace_id: String(getWorkspace().id),
        chart_id: chartIdentity(chart),
        chart_index: chartList().indexOf(chart),
        generation: generation(chart),
        object_id: null,
        object_kind: null,
        native_object_id: null,
      },
    };
  }
  function stillCurrent(chart, context) {
    return (
      !disposed &&
      !isLoading() &&
      context.association.workspace_id === String(getWorkspace()?.id) &&
      context.association.generation === generation(chart) &&
      chartList().includes(chart) &&
      MWSeries.same(
        chart.symbol(),
        MWSeries.encode(context.instrument, context.series_kind),
      ) &&
      frames[chart.resolution()] === context.timeframe
    );
  }
  function toolKind(name) {
    const text = String(name).toLowerCase().replace(/[ _-]/g, "");
    return {
      horizontalline: "horizontal_line",
      horzline: "horizontal_line",
      linetoolhorzline: "horizontal_line",
      水平线: "horizontal_line",
      horizontalray: "horizontal_ray",
      horzray: "horizontal_ray",
      linetoolhorzray: "horizontal_ray",
      水平射线: "horizontal_ray",
      trendline: "trend_line",
      linetooltrendline: "trend_line",
      趋势线: "trend_line",
      ray: "ray",
      linetoolray: "ray",
      射线: "ray",
    }[text];
  }
  async function geometry(chart, context, nativeId) {
    const entry = chart
      .getAllShapes()
      .find((item) => String(item.id) === String(nativeId));
    const kind = toolKind(entry?.name);
    if (!kind) throw Error("首批画线告警支持水平线、水平射线、趋势线和射线");
    const shape = chart.getShapeById(nativeId),
      props = shape.getProperties(),
      points = shape.getPoints();
    const reversed = points.length === 2 && points[1].time < points[0].time;
    const mode = chart.getPanes()[0]?.getMainSourcePriceScale()?.getMode();
    if (![0, 1].includes(mode))
      throw Error("百分比与基准价格轴尚未支持画线告警");
    const args = {
      instrument: context.instrument,
      source: context.source,
      series_kind: context.series_kind,
      timeframe: context.timeframe,
      published: context.series_kind === "managed",
      kind,
      scale: mode === 1 ? "log" : "linear",
      extend_left: (reversed ? props.extendRight : props.extendLeft) === true,
      extend_right: (reversed ? props.extendLeft : props.extendRight) === true,
      points: points.map((point) => ({
        time: Math.round(point.time * 1000),
        price: String(point.price),
      })),
    };
    const value = await rpc({ op: "geometry", args });
    if (!stillCurrent(chart, context))
      throw Error("图表已切换；已取消旧图表的画线请求");
    return value;
  }
  function indicator(chart, nativeId) {
    const entry = chart
      .getAllStudies()
      .find((item) => String(item.id) === String(nativeId));
    const name = String(entry?.name || "").match(
      /(?:MWPython|守望 Python |PY )(SMA|EMA|RSI|MACD)(?:@|$)/,
    )?.[1];
    if (!name) throw Error("仅支持已映射的守望 Python SMA、EMA、RSI、MACD");
    const params = Object.fromEntries(
      chart
        .getStudyById(nativeId)
        .getInputValues()
        .map((input) => [input.id, input.value]),
    );
    return {
      name,
      version: "1",
      params,
      output: name === "MACD" ? "macd" : "value",
    };
  }
  async function create({
    chart = getWidget().activeChart(),
    price,
    object,
    context: initialContext,
  } = {}) {
    if (readonly || disposed || isLoading()) return;
    try {
      const context = initialContext
        ? structuredClone(initialContext)
        : snapshot(chart);
      if (!stillCurrent(chart, context))
        throw Error("发起操作的图表已改变，请重新打开菜单");
      if (Number.isFinite(price) && price > 0) context.price = String(price);
      if (object?.type === "shape") {
        context.association.object_id = crypto.randomUUID();
        context.association.object_kind = "drawing";
        context.association.native_object_id = String(object.id);
        context.line = await geometry(chart, context, object.id);
      } else if (object?.type === "study") {
        if (context.calculation_origin === null)
          throw Error("请等待 Python 指标历史计算完成后创建告警");
        context.indicator = indicator(chart, object.id);
        context.association.object_id = crypto.randomUUID();
        context.association.object_kind = "indicator";
        context.association.native_object_id = String(object.id);
      }
      if (stillCurrent(chart, context))
        send({ type: "chart-alert-context", context });
    } catch (e) {
      fail(e);
    }
  }
  async function menu(items, actionsFactory, params) {
    if (readonly || isLoading()) return items;
    const chart =
      params.detail?.type === "priceScale"
        ? chartList()[params.detail.chartIndex]
        : getWidget().activeChart();
    const object = params.detail;
    if (!chart || (object?.type === "priceScale" && object.paneIndex !== 0))
      return items;
    if (
      object &&
      !["series", "shape", "study", "priceScale"].includes(object.type)
    )
      return items;
    let context;
    try {
      context = snapshot(chart);
    } catch {
      return items;
    }
    // Capture the initiating chart now; executing a menu item never re-reads
    // whichever pane became active during an asynchronous native operation.
    const price =
      (!object || object.type === "series") && menuPoint?.chart === chart
        ? menuPoint.price
        : undefined;
    menuPoint = null;
    const item = actionsFactory.createAction({
      actionId: "mw-chart-alert-create",
      label:
        object?.type === "shape"
          ? "在此画线上创建告警…"
          : object?.type === "study"
            ? "在此指标上创建告警…"
            : Number.isFinite(price)
              ? `在 ${price} 创建价格告警…`
              : "创建主价格系列告警…",
      onExecute: () => create({ chart, object, price, context }),
    });
    return [item, ...items];
  }
  function persist(state) {
    state._mwAlertCharts = chartList().map((chart) => chartIdentity(chart));
    return state;
  }
  function reset(state = {}) {
    ids = new Map();
    storedIds = Array.isArray(state._mwAlertCharts)
      ? state._mwAlertCharts.slice(0, 8)
      : [];
    objects.clear();
    edits.clear();
    markers.clear();
    failedEdits.clear();
    recoveredSlots.clear();
  }
  function matches(chart, row) {
    return (
      chart &&
      metadata(chart.symbol())?.source === row.config.source &&
      MWSeries.same(
        chart.symbol(),
        MWSeries.encode(row.config.instrument, row.config.series_kind),
      ) &&
      frames[chart.resolution()] === row.config.timeframe
    );
  }
  function sameLine(a, b) {
    // JSON key order and Decimal formatting are not drawing edits. Compare
    // geometry as exposed by the native Number-valued drawing interface.
    return (
      !!a &&
      !!b &&
      ["kind", "scale", "extend_left", "extend_right", "mapping_version"].every(
        (key) => a[key] === b[key],
      ) &&
      a.points.length === b.points.length &&
      a.points.every((point, i) => {
        const other = b.points[i];
        return (
          point.time === other.time &&
          point.index === other.index &&
          Number(point.price) === Number(other.price)
        );
      })
    );
  }
  async function submitDrawing(row, chart, nativeId) {
    const context = snapshot(chart),
      a = row.config.association;
    const next = await geometry(chart, context, nativeId);
    if (next.scale !== row.config.condition.right?.line?.scale) {
      associationNotice(
        row,
        "图表价格轴与告警快照不同；请切回原价格轴，或明确保存新坐标条件",
      );
      return;
    }
    if (sameLine(next, row.config.condition.right?.line)) {
      failedEdits.delete(row.id);
      associationNotice(row, "");
      return;
    }
    const q = {
      op: "edit",
      alert_id: row.id,
      version: row.version,
      object_id: a.object_id,
      chart_id: a.chart_id,
      workspace_id: a.workspace_id,
      generation: context.association.generation,
      line: next,
    };
    try {
      const saved = await rpc(q);
      replace(saved);
      failedEdits.delete(row.id);
      associationNotice(saved, "");
    } catch (e) {
      // A timed-out write may have committed. Read current truth before retry
      // or restore; never roll the graph back based on an unknown result.
      try {
        const saved = await rpc({ op: "read", alert_id: row.id });
        replace(saved);
        if (
          saved.version > row.version &&
          sameLine(saved.config.condition.right?.line, next)
        ) {
          failedEdits.delete(row.id);
          associationNotice(saved, "");
          return;
        }
      } catch {
        /* Preserve the local position; the panel exposes the saved version. */
      }
      failedEdits.add(row.id);
      associationNotice(
        row,
        "画线提交未确认；请核对后台实际版本后重试，或恢复后台画线。" +
          String(e),
      );
    }
  }
  function replace(row) {
    rows = rows.map((old) =>
      old.id === row.id && old.version <= row.version ? row : old,
    );
  }
  function drawingEvent(
    nativeId,
    type,
    initiatingChart = pointerDown ? pointerChart : getWidget().activeChart(),
  ) {
    if (readonly || suppress || disposed || isLoading()) return;
    for (const row of rows) {
      const a = row.config.association;
      if (
        a?.object_kind !== "drawing" ||
        !["active", "paused"].includes(row.status)
      )
        continue;
      const chart = associatedChart(a, row),
        id = objects.get(row.id) || a.native_object_id;
      if (chart !== initiatingChart) continue;
      if (String(nativeId) !== String(id) || !matches(chart, row)) continue;
      if (type === "remove") {
        // A symbol switch/layout destruction can remove local entities. Pause
        // only after the same pane is ready and confirms explicit absence.
        const epoch = generation(chart);
        setTimeout(() => {
          if (
            !disposed &&
            epoch === generation(chart) &&
            !isLoading() &&
            matches(chart, row) &&
            chart.dataReady() &&
            !chart.getAllShapes().some((s) => String(s.id) === String(id))
          )
            rpc({
              op: "lifecycle",
              alert_id: row.id,
              version: row.version,
              action: "drawing_deleted",
              object_id: a.object_id,
              chart_id: a.chart_id,
              workspace_id: a.workspace_id,
            })
              .then(replace)
              .catch(fail);
        }, 0);
      } else if (
        ["move", "points_changed", "properties_changed"].includes(type)
      ) {
        if (pointerDown) {
          previewChanges.set(row.id, { nativeId, type, chart });
          continue;
        }
        const previous = edits.get(row.id) || Promise.resolve();
        // Serial writes keep successive drag commits ordered. Each job looks
        // up the latest confirmed version, so an old response cannot overwrite it.
        const task = previous
          .catch(() => {})
          .then(() => {
            const current = rows.find((r) => r.id === row.id);
            return current && matches(chart, current)
              ? submitDrawing(current, chart, id)
              : undefined;
          });
        edits.set(row.id, task);
        task.catch(fail).finally(() => {
          if (edits.get(row.id) === task) edits.delete(row.id);
        });
      }
    }
  }
  function drawingHistoryEvent() {
    if (readonly || suppress || disposed || isLoading()) return;
    // Native undo/redo can change drawings without points_changed. Defer until
    // the history action has finished, and fence pane/workspace transitions.
    const pending = rows.map((row) => {
      const chart = associatedChart(row.config.association, row);
      return { row, chart, epoch: generation(chart) };
    });
    setTimeout(() => {
      for (const { row, chart, epoch } of pending) {
        const a = row.config.association;
        if (
          disposed ||
          isLoading() ||
          !chart ||
          !matches(chart, row) ||
          generation(chart) !== epoch ||
          a?.object_kind !== "drawing" ||
          failedEdits.has(row.id) ||
          !chart.dataReady()
        )
          continue;
        const id = objects.get(row.id) || a.native_object_id;
        const exists = chart
          .getAllShapes()
          .some((shape) => String(shape.id) === String(id));
        drawingEvent(id, exists ? "points_changed" : "remove", chart);
      }
    }, 0);
  }
  function attach() {
    if (attached || disposed) return;
    attached = true;
    getWidget().onContextMenu((_time, price) => {
      menuPoint = { chart: getWidget().activeChart(), price };
      return [];
    });
    getWidget().subscribe("drawing_event", drawingEvent);
    getWidget().subscribe("undo", drawingHistoryEvent);
    getWidget().subscribe("redo", drawingHistoryEvent);
    getWidget().subscribe("mouse_down", () => {
      pointerDown = true;
      pointerChart = getWidget().activeChart();
    });
    getWidget().subscribe("mouse_up", () => {
      pointerDown = false;
      const changes = [...previewChanges.values()];
      previewChanges.clear();
      for (const change of changes)
        drawingEvent(change.nativeId, change.type, change.chart);
      pointerChart = null;
    });
    getWidget().subscribe("onPlusClick", (p) => {
      if (
        p.symbol &&
        MWSeries.same(p.symbol, getWidget().activeChart().symbol())
      )
        create({ price: p.price });
    });
    refresh();
  }
  function refresh() {
    for (const chart of chartList())
      if (!bindings.has(chart)) {
        const fn = () =>
          generations.set(chart, (generations.get(chart) || 0) + 1);
        bindings.set(chart, fn);
        chart.onSymbolChanged().subscribe(null, fn);
        chart.onIntervalChanged().subscribe(null, fn);
      }
  }
  async function locate(row, event) {
    const a = row.config.association,
      chart = associatedChart(a, row);
    if (!matches(chart, row)) {
      fail(
        Error(
          "关联图表当前为其他品种或周期；切回该系列后可定位，告警继续在后台运行",
        ),
      );
      return;
    }
    try {
      await restoreDrawing(row, chart);
      if (event) {
        await chart.setVisibleRange({
          from: event.occurred_at / 1000 - 3600,
          to: event.occurred_at / 1000 + 3600,
        });
        suppress++;
        try {
          const id = await chart.createShape(
            { time: event.occurred_at / 1000, price: Number(event.price) },
            {
              shape: "arrow_down",
              text: `${row.name} · ${event.evidence.ordinal}`,
              disableSave: true,
              disableUndo: true,
              lock: true,
            },
          );
          markers.set(event.id, id);
        } finally {
          suppress--;
        }
      }
    } catch (e) {
      fail(e);
    }
  }
  async function restoreDrawing(row, chart) {
    const a = row.config.association,
      line = row.config.condition.right?.line;
    if (!line) return;
    const context = snapshot(chart),
      mode = chart.getPanes()[0]?.getMainSourcePriceScale()?.getMode();
    if (mode !== (line.scale === "log" ? 1 : 0))
      throw Error("关联画线的价格轴与已保存快照不同，请切回原价格轴或编辑告警");
    const points = line.points.map((p) => ({
      time: p.time / 1000,
      price: Number(p.price),
    }));
    const reversed = points.length === 2 && points[1].time < points[0].time;
    const extensions = {
      extendLeft: reversed ? line.extend_right : line.extend_left,
      extendRight: reversed ? line.extend_left : line.extend_right,
    };
    const id = objects.get(row.id) || a.native_object_id;
    const entry = chart.getAllShapes().find((s) => String(s.id) === String(id));
    suppress++;
    try {
      if (entry && toolKind(entry.name) === line.kind) {
        const shape = chart.getShapeById(id);
        if (JSON.stringify(shape.getPoints()) !== JSON.stringify(points))
          shape.setPoints(points);
        const props = shape.getProperties();
        if (
          ["trend_line", "ray"].includes(line.kind) &&
          (props.extendLeft !== extensions.extendLeft ||
            props.extendRight !== extensions.extendRight)
        )
          shape.setProperties(extensions);
      } else {
        const opts = {
          shape: line.kind,
          disableSave: true,
          disableUndo: true,
          overrides: extensions,
          text: row.name,
        };
        const created =
          points.length === 1
            ? await chart.createShape(points[0], opts)
            : await chart.createMultipointShape(points, opts);
        if (stillCurrent(chart, context)) objects.set(row.id, created);
      }
    } finally {
      suppress--;
    }
  }
  function associationNotice(row, text) {
    send({
      type: "chart-alert-association",
      workspace_id: row.config.association.workspace_id,
      alert_id: row.id,
      text,
    });
  }
  async function reconcile(row) {
    const a = row.config.association,
      chart = associatedChart(a, row);
    if (
      isLoading() ||
      !matches(chart, row) ||
      !chart.dataReady() ||
      pointerDown ||
      edits.has(row.id) ||
      failedEdits.has(row.id)
    )
      return;
    if (a.object_kind === "drawing") {
      if (row.health_reason === "关联画线已明确删除") return;
      await restoreDrawing(row, chart);
      associationNotice(row, "");
    } else if (a.object_kind === "indicator") {
      if (
        !chart
          .getAllStudies()
          .some((s) => String(s.id) === String(a.native_object_id))
      ) {
        associationNotice(row, "关联指标已移除；后台继续使用已保存参数快照");
        return;
      }
      const current = indicator(chart, a.native_object_id),
        saved = row.config.condition.left.indicator;
      const differs =
        !saved ||
        current.name !== saved.name ||
        Object.entries(saved.params).some(
          ([key, value]) => current.params[key] !== value,
        );
      const currentOrigin = calculationOrigin(
        chart.symbol(),
        chart.resolution(),
      );
      const savedOrigin = row.config.calculation_origin ?? row.runtime?.origin;
      associationNotice(
        row,
        differs
          ? "图表指标参数与告警快照不同；请在编辑表单中确认并保存新参数"
          : currentOrigin != null &&
              savedOrigin != null &&
              currentOrigin !== savedOrigin
            ? "图表与告警固定历史起点不同；请核对计算历史后编辑告警"
            : "",
      );
    }
  }
  async function drawingAction(alertId, action) {
    const row = rows.find((row) => row.id === alertId),
      chart = associatedChart(row?.config.association, row);
    if (
      readonly ||
      !row ||
      !matches(chart, row) ||
      isLoading() ||
      edits.has(row.id) ||
      pointerDown
    )
      return;
    const context = snapshot(chart);
    try {
      const saved = await rpc({ op: "read", alert_id: row.id });
      replace(saved);
      if (
        !stillCurrent(chart, context) ||
        !matches(chart, saved) ||
        saved.config.association?.object_id !== row.config.association.object_id
      )
        throw Error("关联图表或后台条件已改变，请重新核对");
      if (action === "restore") {
        await restoreDrawing(saved, chart);
        failedEdits.delete(row.id);
        associationNotice(saved, "");
      } else if (action === "retry")
        await submitDrawing(
          saved,
          chart,
          objects.get(row.id) || saved.config.association.native_object_id,
        );
    } catch (e) {
      associationNotice(row, String(e));
    }
  }
  function setRows(next) {
    rows = next
      .slice(0, 500)
      .filter(
        (row) =>
          row.config?.association?.workspace_id === String(getWorkspace()?.id),
      )
      .map((row) => {
        const previous = rows.find((old) => old.id === row.id);
        return previous?.version > row.version ? previous : row;
      });
    for (const row of rows)
      if (!reconciliations.has(row.id)) {
        const task = reconcile(row);
        reconciliations.set(row.id, task);
        task
          .catch((e) => associationNotice(row, String(e)))
          .finally(() => {
            if (reconciliations.get(row.id) === task)
              reconciliations.delete(row.id);
          });
      }
  }
  function destroy() {
    disposed = true;
    for (const [chart, fn] of bindings) {
      chart.onSymbolChanged().unsubscribe(null, fn);
      chart.onIntervalChanged().unsubscribe(null, fn);
    }
    bindings.clear();
  }
  return {
    create,
    menu,
    persist,
    reset,
    attach,
    refresh,
    setRows,
    locate,
    destroy,
    drawingEvent,
    drawingAction,
    geometry,
    diagnostics: () => ({
      charts: chartList().map((chart) => chartIdentity(chart)),
      rows: rows.map((row) => ({ id: row.id, version: row.version })),
    }),
  };
}
