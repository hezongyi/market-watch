/* v31.1.0 display adapter. Private scale geometry is confined to this file.
 * Order primitives are presentation only: no broker, drawing, save or undo API. */
function nativeAlertPriceLines({
  current,
  archive,
  move,
  read,
  edit,
  action,
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
    entry.details?.remove();
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
    if(entry.details)entry.details.style.display = visible && entry.expanded ? "flex" : "none";
  }
  function caption(entry) {
    const text = typeof chartAlertPricePresentation === "function" ? chartAlertPricePresentation(entry.chart,entry.price).text : String(entry.price);
    return `${entry.row.status==='paused'?'Ⅱ ':attention(entry.row)?'! ':''}${text}${entry.busy?' · 保存中':entry.uncertain?(entry.pendingAction?' · 操作待核实':' · 改价待核实'):entry.failure?' · 未保存':''}`;
  }
  function attention(row) { return row.status === 'active' && row.execution?.state === 'blocked'; }
  function canMove(entry) {
    return !readonly && typeof move === "function" && !entry.busy && !entry.uncertain &&
      entry.row.config.series_kind === "composite" &&
      !entry.row.config.condition.offset && !entry.row.config.association?.object_kind &&
      !entry.dead && current(entry.row, entry.chart, entry.epoch);
  }
  function descriptionText(row) {
    return `${row.name} · ${row.config.mode === 'close' ? (row.config.timeframe + ' 收盘') : '盘中'} · ${row.count || 0}/${row.max_triggers || row.config.max_triggers || 1}${attention(row)?' · '+(row.execution.message || row.health_reason || '需要处理，请检查实时设置'):''}`;
  }
  function controls(entry) {
    const enabled = canMove(entry);
    entry.line.setEditable(enabled);
    entry.label.style.cursor = enabled ? "ns-resize" : "default";
    entry.label.setAttribute("aria-busy", String(!!entry.busy));
    entry.label.title = entry.row.name + (enabled ? "；拖动改价，点击管理，Escape取消" : "");
    entry.remove.disabled = readonly || !!entry.busy || !!entry.uncertain;
    if(entry.editButton)entry.editButton.disabled=readonly || !!entry.busy || !!entry.uncertain;
    if(entry.toggleButton){entry.toggleButton.disabled=readonly || !!entry.busy || !!entry.uncertain;entry.toggleButton.textContent=entry.row.status==='paused'?'恢复':'暂停';}
    if(entry.recheck)entry.recheck.hidden=!entry.uncertain;
  }
  function actionFailure(entry, error) {
    if (entry.dead) return;
    if (error?.currentRow) entry.row=error.currentRow;
    entry.uncertain=!!error?.outcomeUnknown;
    if(entry.uncertain) entry.uncertainBase ||= entry.row;
    entry.failure=!entry.uncertain;
    entry.expanded=true;
    restore(entry);
    entry.description.textContent=entry.uncertain?'操作待核实，请读取后台结果后再操作。':'操作未完成；已保留后台确认状态。';
    report(entry.row,entry.description.textContent);
  }
  function restore(entry) {
    entry.preview = null;
    entry.gestureRow = null;
    entry.price = threshold(entry.row);
    if (entry.price === null || !["active", "paused"].includes(entry.row.status)) {
      destroyEntry(entry.key);
      return;
    }
    entry.line.setPrice(entry.price);
    entry.text.textContent = caption(entry);
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
    entry.pendingAction=false;
    entry.failure=false;
    entry.text.textContent=caption(entry);
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
        entry.uncertain=!!error?.outcomeUnknown;
        if(entry.uncertain)entry.uncertainBase=row;
        entry.failure=!entry.uncertain;
        if(entry.uncertain){entry.preview=presented;entry.price=Number(presented.value);entry.text.textContent=caption(entry);}
        else restore(entry);
        entry.expanded=true;
        if(entry.description)entry.description.textContent=entry.uncertain?"改价待核实；暂时不能继续改价，请重新读取后台结果。":"未保存，已显示后台确认价格。";
        report(entry.row, entry.uncertain ? "改价待核实，请重新读取后台结果" : "改价未保存，已读取后台价格：" + String(error));
      }
    } finally {
      if (!entry.dead) { entry.busy = false; entry.text.textContent=caption(entry);controls(entry);schedule(entry); }
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
      if (event.button !== 0 || event.target.closest("button") || entry.dead || !current(entry.row,entry.chart,entry.epoch)) return;
      event.preventDefault();
      event.stopPropagation();
      entry.cancelledMove = false;
      const bounds = entry.label.getBoundingClientRect();
      pointer = { id: event.pointerId, y: event.clientY, offsetY: event.clientY - (bounds.top + bounds.height / 2), moved: false, draggable:canMove(entry) };
      if(pointer.draggable)entry.gestureRow = entry.row;
      entry.label.focus({ preventScroll: true });
      entry.label.setPointerCapture(event.pointerId);
    };
    const moving = (event) => {
      if (!pointer || pointer.id !== event.pointerId) return;
      if (!pointer.draggable) return;
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
      if (moved) void finish(entry); else {if(!entry.uncertain && !entry.busy)restore(entry);entry.expanded=!entry.expanded;schedule(entry);}
    };
    const cancel = () => { if (!entry.uncertain && !entry.busy && (pointer || entry.preview)) { entry.cancelledMove = true; end(); restore(entry); } else end(); };
    const lost = () => {if(pointer)cancel();};
    const escape = (event) => {
      if (event.key === "Escape" && !entry.uncertain && !entry.busy && (pointer || entry.preview)) {
        event.preventDefault(); event.stopPropagation(); cancel();
      }
    };
    entry.label.addEventListener("pointerdown", down);
    entry.doc.addEventListener("pointermove", moving, true);
    entry.doc.addEventListener("pointerup", up, true);
    entry.label.addEventListener("pointercancel", cancel);
    entry.label.addEventListener("lostpointercapture", lost);
    entry.doc.addEventListener("keydown", escape, true);
    entry.view.addEventListener("blur", cancel);
    entry.cleanups.push(() => {
      end();
      entry.label.removeEventListener("pointerdown", down);
      entry.doc.removeEventListener("pointermove", moving, true);
      entry.doc.removeEventListener("pointerup", up, true);
      entry.label.removeEventListener("pointercancel", cancel);
      entry.label.removeEventListener("lostpointercapture", lost);
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
      destroyEntry(entry.key);
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
      if(entry.details){
        entry.details.style.left=left+"px";
        entry.details.style.top=Math.min(bounds.bottom-96,Math.max(bounds.top,top+18))+"px";
        entry.details.style.maxWidth=Math.max(120,bounds.width-20)+"px";
      }
      entry.dot.style.left = bounds.right - 5 + "px";
      entry.dot.style.top = top + "px";
      const light =
        entry.doc.documentElement.classList.contains("theme-light") ||
        !entry.doc.documentElement.classList.contains("theme-dark");
      const color = entry.row.status==='paused' ? (light?'#969da8':'#787f8c') : attention(entry.row) ? (light?'#99621d':'#d5ac76') : (light ? "#526d96" : "#96afd5"),
        background = light ? "#fff" : "#0f0f0f";
      entry.label.style.color = entry.dot.style.color = color;
      entry.label.style.background = background;
      entry.line?.setLineColor(color).setBodyTextColor(color);
      if(entry.details){entry.details.style.background=background;entry.details.style.color=light?'#303744':'#d1d4dc';entry.details.style.borderColor=color;}
    } catch (error) {
      visibility(entry, false);
      if (!entry.reported) {
        entry.reported = true;
        report(entry.row, "价格线暂不可展示：" + String(error));
      }
    }
  }
  async function add(row, chart, epoch, price, key) {
    const entry = {
      row,
      key,
      chart,
      epoch,
      price,
      dead: false,
      cleanups: [],
      raf: 0,
    };
    entries.set(key, entry);
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
      if(!entry.doc.querySelector('style[data-mw-alert-hitarea]')) {
        const style=entry.doc.createElement('style');style.dataset.mwAlertHitarea='';
        style.textContent='[data-name="mw-alert-price-label"]::before{content:"";position:absolute;inset:-8px -4px}';
        entry.doc.head.append(style);
      }
      const line = await chart.createOrderLine();
      if (entry.dead || disposed || !current(row, chart, epoch)) {
        line.remove();
        if (entries.get(key) === entry) destroyEntry(key);
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
      label.tabIndex = 0;
      label.setAttribute("role","button");label.setAttribute("aria-label","管理价格告警："+row.name);
      label.style.cssText =
        "position:fixed;z-index:12;display:none;align-items:center;gap:4px;transform:translateY(-50%);min-height:28px;border:1px solid currentColor;border-radius:5px;padding:2px 7px;font:12px/20px Arial,sans-serif;box-sizing:border-box;pointer-events:auto;user-select:none;touch-action:none";
      text.textContent = caption(entry);
      text.style.cssText =
        "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      label.title = row.name;
      remove.disabled = readonly;
      remove.type = "button";
      remove.setAttribute("aria-label", "结束告警：" + row.name);
      remove.style.cssText =
        "border:0;border-left:1px solid currentColor;background:transparent;color:inherit;padding:4px;margin:-4px -4px -4px 0;min-width:24px;min-height:24px;cursor:pointer;display:flex;align-items:center;justify-content:center";
      remove.textContent="结束告警";
      remove.onpointerdown = (e) => e.stopPropagation();
      remove.onclick = async (e) => {
        e.stopPropagation();
        if (remove.disabled || !current(entry.row, chart, epoch)) return;
        entry.busy = true;entry.pendingAction=true;controls(entry);
        try {
          await archive(entry.row);
          if (entries.get(key) === entry) destroyEntry(key);
        } catch (error) {
          if (!entry.dead) {
            actionFailure(entry,error);
          }
        } finally {if(!entry.dead){entry.busy=false;controls(entry);entry.text.textContent=caption(entry);schedule(entry);}}
      };
      const bell=entry.doc.createElement("span");bell.setAttribute("aria-hidden","true");
      bell.innerHTML='<svg width="12" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>';
      label.append(bell,text);
      const details=entry.doc.createElement("div"),description=entry.doc.createElement("span"),actions=entry.doc.createElement("div");
      entry.details=details;entry.description=description;
      details.dataset.name="mw-alert-price-actions";details.dataset.alertId=row.id;
      details.style.cssText="position:fixed;z-index:30;display:none;flex-direction:column;gap:6px;padding:10px;border:1px solid;border-radius:8px;font:12px/1.5 sans-serif;box-shadow:0 5px 20px #0002";
      description.textContent=descriptionText(row);
      actions.style.cssText="display:flex;gap:6px;flex-wrap:wrap";
      const toggle=entry.doc.createElement("button"),editButton=entry.doc.createElement("button"),recheck=entry.doc.createElement("button"),close=entry.doc.createElement("button");
      entry.toggleButton=toggle;entry.editButton=editButton;entry.recheck=recheck;
      toggle.textContent=row.status==='paused'?'恢复':'暂停';toggle.hidden=typeof action!=="function";
      toggle.onclick=async()=>{if(toggle.disabled)return;entry.busy=true;entry.pendingAction=true;controls(entry);try{entry.row=await action(entry.row,entry.row.status==='paused'?'resume':'pause');restore(entry);}catch(error){actionFailure(entry,error);}finally{if(!entry.dead){entry.busy=false;controls(entry);entry.text.textContent=caption(entry);schedule(entry);}}};
      editButton.textContent="编辑";editButton.hidden=typeof edit!=="function";editButton.onclick=()=>{entry.expanded=false;schedule(entry);edit?.(entry.row);};
      recheck.textContent="核验结果";recheck.hidden=true;recheck.onclick=async()=>{recheck.disabled=true;try{const saved=await read(entry.row);if(entry.dead)return;if(entry.uncertainBase && saved.version<=entry.uncertainBase.version && saved.control_revision<=entry.uncertainBase.control_revision){entry.description.textContent='后台仍未确认本次操作，请稍后再核验。';return;}entry.row=saved;entry.uncertain=false;entry.uncertainBase=null;entry.failure=false;entry.pendingAction=false;restore(entry);report(saved,"");entry.description.textContent=descriptionText(saved);}catch(error){report(entry.row,"操作仍待核实，请联网后重试");}finally{if(!entry.dead){recheck.disabled=false;controls(entry);schedule(entry);}}};
      close.textContent="关闭";close.onclick=()=>{entry.expanded=false;schedule(entry);};
      for(const button of [toggle,editButton,recheck,remove,close]){button.type="button";button.style.cssText="border:0;border-radius:5px;padding:4px 8px;background:transparent;color:inherit;min-height:40px;cursor:pointer";}
      actions.append(toggle,editButton,recheck,remove,close);details.append(description,actions);entry.doc.body.append(details);
      const keydown=event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();entry.expanded=!entry.expanded;schedule(entry);}if(event.key==='Escape'){entry.expanded=false;schedule(entry);}};
      label.addEventListener('keydown',keydown);entry.cleanups.push(()=>label.removeEventListener('keydown',keydown));
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
        destroyEntry(key);
      });
      listen(entry, chart.onSymbolChanged(), () => destroyEntry(key));
      listen(entry, chart.onIntervalChanged(), () => destroyEntry(key));
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
      if (entries.get(key) === entry) destroyEntry(key);
      if (reportFailure) report(row, "价格线暂不可展示：" + String(error));
    }
  }
  return {
    sync(candidates) {
      if (disposed) return;
      const live = new Set();
      for (const { row, chart, epoch, key = row.id } of candidates) {
        const price = threshold(row);
        if (
          price === null ||
          !chart ||
          !["active", "paused"].includes(row.status) ||
          !current(row, chart, epoch)
        )
          continue;
        live.add(key);
        const previous = entries.get(key);
        if (
          previous &&
          previous.chart === chart &&
          previous.epoch === epoch &&
          threshold(previous.row) === price
        ) {
          previous.row = row;
          if (previous.label) {
            if (!previous.preview && !previous.busy) previous.text.textContent = caption(previous);
            if (!previous.failure && !previous.uncertain) previous.description.textContent = descriptionText(row);
            controls(previous);
            previous.label
              .setAttribute("aria-label", "管理价格告警：" + row.name);
            previous.remove.setAttribute("aria-label","结束告警："+row.name);
            schedule(previous);
          }
          continue;
        }
        destroyEntry(key);
        void add(row, chart, epoch, price, key);
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
