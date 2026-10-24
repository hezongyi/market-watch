/* v31.1.0 display adapter. Private scale geometry is confined to this file.
 * Order primitives are presentation only: no broker, drawing, save or undo API. */
function nativeAlertPriceLines({
  current,
  archive,
  move,
  readonly = false,
  report = () => {},
}) {
  const entries = new Map();
  let disposed = false;
  const version = globalThis.TradingView?.version?.() || "";
  const supported =
    /\bv31\.1\.0\b/.test(version) &&
    version.includes("6b804c486857f27920cf761aa7eb6e29d9bb6362");
  function threshold(row) {
    const c = row.config.condition;
    if (
      c.left?.kind !== "price" ||
      c.right?.kind !== "constant" ||
      !["cross", "cross_up", "cross_down", "above", "below"].includes(
        c.relation,
      )
    )
      return null;
    const raw = c.offset ? row.runtime?.offset?.threshold : c.right.value;
    return typeof raw === "string" && raw.trim() && Number.isFinite(Number(raw))
      ? Number(raw)
      : null;
  }
  function release(entry) {
    entry.dead = true;
    if (entry.raf) entry.view.cancelAnimationFrame(entry.raf);
    entry.cleanups.splice(0).forEach((fn) => fn());
    entry.resize?.disconnect();
    entry.line?.remove();
    entry.label?.remove();
    entry.dot?.remove();
  }
  function destroyEntry(id) {
    const entry = entries.get(id);
    if (entry) {
      entries.delete(id);
      release(entry);
    }
  }
  function schedule(entry) {
    if (entry.dead || entry.raf) return;
    entry.raf = entry.view.requestAnimationFrame(() => {
      entry.raf = 0;
      position(entry);
    });
  }
  function listen(entry, event, fn = () => schedule(entry)) {
    if (!event?.subscribe || !event?.unsubscribe)
      throw Error("原生价格轴事件契约不匹配");
    event.subscribe(entry, fn);
    entry.cleanups.push(() => event.unsubscribe(entry, fn));
  }
  function visibility(entry, visible) {
    entry.label.style.display = visible ? "flex" : "none";
    entry.dot.style.display = visible ? "block" : "none";
  }
  function canMove(entry) {
    return !readonly && typeof move === "function" && !entry.busy &&
      !entry.row.config.condition.offset && !entry.row.config.association?.object_kind &&
      !entry.dead && current(entry.row, entry.chart, entry.epoch);
  }
  function controls(entry) {
    const enabled = canMove(entry);
    entry.line.setEditable(enabled);
    entry.label.style.cursor = enabled ? "ns-resize" : "default";
    entry.label.setAttribute("aria-busy", String(!!entry.busy));
    entry.label.title = entry.row.name + (enabled ? "；上下拖动调整价格，Escape取消" : "");
    entry.remove.disabled = readonly || !!entry.busy;
  }
  function restore(entry) {
    entry.preview = null;
    entry.gestureRow = null;
    entry.price = threshold(entry.row);
    if (entry.price === null || !["active", "paused"].includes(entry.row.status)) {
      destroyEntry(entry.row.id);
      return;
    }
    entry.line.setPrice(entry.price);
    entry.text.textContent = entry.row.name;
    schedule(entry);
  }
  function preview(entry, price) {
    if (!canMove(entry) || !Number.isFinite(price) || price <= 0) return;
    const presented = chartAlertPricePresentation(entry.chart, price);
    entry.gestureRow ||= entry.row;
    entry.preview = presented;
    entry.price = Number(presented.value);
    entry.line.setPrice(entry.price);
    entry.text.textContent = `${entry.row.name} → ${presented.text}`;
    schedule(entry);
  }
  async function finish(entry) {
    if (!canMove(entry) || !entry.preview) return;
    const presented = entry.preview, row = entry.gestureRow || entry.row;
    if (Number(presented.value) === threshold(row)) { restore(entry); return; }
    entry.preview = null;
    entry.gestureRow = null;
    entry.busy = true;
    controls(entry);
    try {
      const saved = await move(row, presented.value, {
        previousText: chartAlertPricePresentation(entry.chart, threshold(row)).text,
        text: presented.text,
      });
      if (entry.dead || disposed || !current(entry.row, entry.chart, entry.epoch)) return;
      entry.row = saved;
      restore(entry);
      report(saved, "");
    } catch (error) {
      if (!entry.dead && !disposed && current(entry.row, entry.chart, entry.epoch)) {
        if (error?.currentRow) entry.row = error.currentRow;
        restore(entry);
        report(entry.row, "改价未确认，已恢复最后确认价格；请核对后重试：" + String(error));
      }
    } finally {
      if (!entry.dead) { entry.busy = false; controls(entry); }
    }
  }
  function bindDragging(entry) {
    let pointer = null;
    const end = () => {
      if (!pointer) return;
      const id = pointer.id;
      pointer = null;
      try { entry.label.releasePointerCapture(id); } catch { /* Node may have been removed. */ }
    };
    const down = (event) => {
      if (event.button !== 0 || event.target.closest("button") || !canMove(entry)) return;
      event.preventDefault();
      event.stopPropagation();
      entry.cancelledMove = false;
      const bounds = entry.label.getBoundingClientRect();
      pointer = { id: event.pointerId, y: event.clientY, offsetY: event.clientY - (bounds.top + bounds.height / 2), moved: false };
      entry.gestureRow = entry.row;
      entry.label.setPointerCapture(event.pointerId);
    };
    const moving = (event) => {
      if (!pointer || pointer.id !== event.pointerId) return;
      if (!canMove(entry)) { end(); restore(entry); return; }
      event.preventDefault();
      event.stopPropagation();
      if (!pointer.moved && Math.abs(event.clientY - pointer.y) < 3) return;
      pointer.moved = true;
      try {
        const widget = entry.chart._chartWidget, series = widget.model().model().mainSeries();
        const canvas = widget.paneWidgets().find(pane => pane.containsMainSeries()).canvasElement();
        const bounds = canvas.getBoundingClientRect(), y = Math.max(0, Math.min(bounds.height, event.clientY - pointer.offsetY - bounds.top));
        preview(entry, series.priceScale().coordinateToPrice(y, series.firstValue()));
      } catch (error) { end(); restore(entry); report(entry.row, "无法调整告警价格：" + String(error)); }
    };
    const up = (event) => {
      if (!pointer || pointer.id !== event.pointerId) return;
      event.stopPropagation();
      const moved = pointer.moved;
      end();
      if (moved) void finish(entry); else restore(entry);
    };
    const cancel = () => { if (pointer || entry.preview) { entry.cancelledMove = true; end(); restore(entry); } };
    const escape = (event) => {
      if (event.key === "Escape" && (pointer || entry.preview)) {
        event.preventDefault(); event.stopPropagation(); cancel();
      }
    };
    entry.label.addEventListener("pointerdown", down);
    entry.doc.addEventListener("pointermove", moving, true);
    entry.doc.addEventListener("pointerup", up, true);
    entry.label.addEventListener("pointercancel", cancel);
    entry.label.addEventListener("lostpointercapture", cancel);
    entry.doc.addEventListener("keydown", escape, true);
    entry.view.addEventListener("blur", cancel);
    entry.cleanups.push(() => {
      end();
      entry.label.removeEventListener("pointerdown", down);
      entry.doc.removeEventListener("pointermove", moving, true);
      entry.doc.removeEventListener("pointerup", up, true);
      entry.label.removeEventListener("pointercancel", cancel);
      entry.label.removeEventListener("lostpointercapture", cancel);
      entry.doc.removeEventListener("keydown", escape, true);
      entry.view.removeEventListener("blur", cancel);
    });
    entry.line.onMoving(() => {
      if (entry.cancelledMove) { restore(entry); return; }
      try { preview(entry, entry.line.getPrice()); }
      catch (error) { restore(entry); report(entry.row, "无法调整告警价格：" + String(error)); }
    });
    entry.line.onMove(() => {
      if (entry.cancelledMove) { entry.cancelledMove = false; restore(entry); }
      else void finish(entry);
    });
  }
  function position(entry) {
    if (entry.dead || disposed) return;
    if (!current(entry.row, entry.chart, entry.epoch)) {
      destroyEntry(entry.row.id);
      return;
    }
    try {
      const widget = entry.chart._chartWidget,
        model = widget.model().model(),
        series = model.mainSeries();
      const pane = widget
          .paneWidgets()
          .find((pane) => pane.containsMainSeries()),
        canvas = pane?.canvasElement();
      if (!canvas?.isConnected || !entry.chart.dataReady()) {
        visibility(entry, false);
        return;
      }
      const scale = series.priceScale(),
        first = series.firstValue();
      if (first == null || scale.isEmpty()) {
        visibility(entry, false);
        return;
      }
      const y = scale.priceToCoordinate(entry.price, first),
        bounds = canvas.getBoundingClientRect();
      if (!Number.isFinite(y) || y < 0 || y > bounds.height) {
        visibility(entry, false);
        return;
      }
      visibility(entry, true);
      const left = bounds.left + 6,
        top = bounds.top + y;
      entry.label.style.left = left + "px";
      entry.label.style.top = top + "px";
      entry.label.style.maxWidth = Math.max(0, bounds.width - 28) + "px";
      entry.dot.style.left = bounds.right - 5 + "px";
      entry.dot.style.top = top + "px";
      const light =
        entry.doc.documentElement.classList.contains("theme-light") ||
        !entry.doc.documentElement.classList.contains("theme-dark");
      const color = light ? "#434651" : "#b2b5be",
        background = light ? "#fff" : "#0f0f0f";
      entry.label.style.color = entry.dot.style.color = color;
      entry.label.style.background = background;
      entry.line?.setLineColor(color).setBodyTextColor(color);
    } catch (error) {
      visibility(entry, false);
      if (!entry.reported) {
        entry.reported = true;
        report(entry.row, "价格线暂不可展示：" + String(error));
      }
    }
  }
  async function add(row, chart, epoch, price) {
    const entry = {
      row,
      chart,
      epoch,
      price,
      dead: false,
      cleanups: [],
      raf: 0,
    };
    entries.set(row.id, entry);
    try {
      if (!supported) throw Error("不支持当前图表库的价格几何");
      const model = chart._chartWidget.model().model(),
        series = model.mainSeries();
      const pane = chart._chartWidget
        .paneWidgets()
        .find((pane) => pane.containsMainSeries());
      const canvas = pane?.canvasElement();
      if (!canvas) throw Error("主价格窗格尚未就绪");
      entry.doc = canvas.ownerDocument;
      entry.view = entry.doc.defaultView;
      const line = await chart.createOrderLine();
      if (entry.dead || disposed || !current(row, chart, epoch)) {
        line.remove();
        if (entries.get(row.id) === entry) destroyEntry(row.id);
        return;
      }
      entry.line = line;
      line
        .setPrice(price)
        .setText("")
        .setQuantity("")
        .setEditable(false)
        .setCancellable(false)
        .setLineStyle(2)
        .setLineWidth(1)
        .setLineLength(0, "pixel")
        .setExtendLeft(true);
      const label = entry.doc.createElement("div"),
        text = entry.doc.createElement("span"),
        remove = entry.doc.createElement("button");
      entry.label = label;
      entry.text = text;
      entry.remove = remove;
      label.dataset.name = "mw-alert-price-label";
      label.dataset.alertId = row.id;
      label.style.cssText =
        "position:fixed;z-index:12;display:none;align-items:center;gap:4px;transform:translateY(-50%);height:20px;border:1px solid currentColor;border-radius:3px;padding:0 2px 0 4px;font:12px/18px Arial,sans-serif;box-sizing:border-box;pointer-events:auto;user-select:none;touch-action:none";
      text.textContent = row.name;
      text.style.cssText =
        "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      label.title = row.name;
      remove.disabled = readonly;
      remove.type = "button";
      remove.setAttribute("aria-label", "删除告警：" + row.name);
      remove.style.cssText =
        "border:0;border-left:1px solid currentColor;background:transparent;color:inherit;padding:4px;margin:-4px -4px -4px 0;min-width:24px;min-height:24px;cursor:pointer;display:flex;align-items:center;justify-content:center";
      remove.innerHTML =
        '<svg data-name="mw-alert-trash" width="12" height="14" viewBox="0 0 12 14" fill="none" stroke="currentColor" stroke-width="1" stroke-linejoin="round" aria-hidden="true"><path d="M1 3.5h10M4 3.5V1.5h4v2M2 3.5l1 9h6l1-9"/></svg>';
      remove.onpointerdown = (e) => e.stopPropagation();
      remove.onclick = async (e) => {
        e.stopPropagation();
        if (remove.disabled || !current(entry.row, chart, epoch)) return;
        remove.disabled = true;
        try {
          await archive(entry.row);
          if (entries.get(row.id) === entry) destroyEntry(row.id);
        } catch (error) {
          if (!entry.dead) {
            remove.disabled = false;
            report(entry.row, "删除未确认，价格线保留：" + String(error));
          }
        }
      };
      label.append(text, remove);
      entry.doc.body.append(label);
      const dot = entry.doc.createElement("span");
      entry.dot = dot;
      dot.dataset.name = "mw-alert-price-dot";
      dot.dataset.alertId = row.id;
      dot.style.cssText =
        "position:fixed;z-index:12;width:4px;height:4px;border:1px solid #2962ff;background:#0f0f0f;border-radius:50%;transform:translate(-50%,-50%);pointer-events:none";
      entry.doc.body.append(dot);
      bindDragging(entry);
      controls(entry);
      const scale = series.priceScale();
      for (const event of [
        scale.priceRangeChanged(),
        scale.modeChanged(),
        scale.properties().childs().isInverted,
        scale.internalHeightChanged(),
        series.dataEvents().dataUpdated(),
        chart.onVisibleRangeChanged(),
      ])
        listen(entry, event);
      listen(entry, series.priceScaleChanged(), () => {
        destroyEntry(row.id);
      });
      listen(entry, chart.onSymbolChanged(), () => destroyEntry(row.id));
      listen(entry, chart.onIntervalChanged(), () => destroyEntry(row.id));
      entry.resize = new entry.view.ResizeObserver(() => schedule(entry));
      entry.resize.observe(canvas);
      const themeObserver = new entry.view.MutationObserver(() =>
        schedule(entry),
      );
      themeObserver.observe(entry.doc.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });
      entry.cleanups.push(() => themeObserver.disconnect());
      const resized = () => schedule(entry);
      entry.view.addEventListener("resize", resized);
      entry.cleanups.push(() =>
        entry.view.removeEventListener("resize", resized),
      );
      schedule(entry);
    } catch (error) {
      const reportFailure =
        !disposed && !entry.dead && current(row, chart, epoch);
      if (entries.get(row.id) === entry) destroyEntry(row.id);
      if (reportFailure) report(row, "价格线暂不可展示：" + String(error));
    }
  }
  return {
    sync(candidates) {
      if (disposed) return;
      const live = new Set();
      for (const { row, chart, epoch } of candidates) {
        const price = threshold(row);
        if (
          price === null ||
          !chart ||
          !["active", "paused"].includes(row.status) ||
          !current(row, chart, epoch)
        )
          continue;
        live.add(row.id);
        const previous = entries.get(row.id);
        if (
          previous &&
          previous.chart === chart &&
          previous.epoch === epoch &&
          threshold(previous.row) === price
        ) {
          previous.row = row;
          if (previous.label) {
            if (!previous.preview && !previous.busy) previous.text.textContent = row.name;
            controls(previous);
            previous.label
              .querySelector("button")
              .setAttribute("aria-label", "删除告警：" + row.name);
            schedule(previous);
          }
          continue;
        }
        destroyEntry(row.id);
        void add(row, chart, epoch, price);
      }
      for (const id of entries.keys()) if (!live.has(id)) destroyEntry(id);
    },
    clear() {
      for (const id of [...entries.keys()]) destroyEntry(id);
    },
    destroy() {
      disposed = true;
      this.clear();
    },
    diagnostics: () => ({ entries: entries.size }),
  };
}
