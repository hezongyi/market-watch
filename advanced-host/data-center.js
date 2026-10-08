/* Public toolbar/dialog host. Business UI and API session remain in the app. */
function chartDataCenter({ widget, appOrigin, workspace, epoch, send, resolve, suspendIndicators }) {
  const probe = widget.createButton({ align: "left", useTradingViewStyle: false });
  const doc = probe.ownerDocument;
  widget.removeButton(probe);
  const session = crypto.randomUUID(), channel = "mw-data-center-v1";
  const dialog = doc.createElement("dialog");
  dialog.className = "mw-data-center-dialog";
  dialog.setAttribute("aria-label", "数据中心");
  const frame = doc.createElement("iframe");
  frame.title = "数据中心管理";
  // Forms execute in the authenticated app's origin, under its own controller.
  frame.src = `${appOrigin}/chart-data-center?session=${encodeURIComponent(session)}`;
  dialog.append(frame);
  const style = doc.createElement("style");
  style.textContent = `.mw-data-center-dialog{width:min(1120px,calc(100vw - 32px));height:min(720px,calc(100dvh - 32px));max-width:none;max-height:none;padding:0;border:0;border-radius:6px;background:#1f1f1f;box-shadow:0 2px 4px rgb(0 0 0 / 40%);overflow:hidden;box-sizing:border-box}.mw-data-center-dialog[data-theme=light]{background:#fff;box-shadow:0 2px 4px rgb(0 0 0 / 20%)}.mw-data-center-dialog::backdrop{background:transparent}.mw-data-center-dialog iframe{width:100%;height:100%;border:0;display:block}.mw-data-center-button{padding:0 12px!important}.mw-data-center-button .js-button-text{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:100%}.mw-data-center-button svg{width:20px;height:20px;display:block;flex-shrink:0}.mw-data-center-button:focus-visible{outline:2px solid #2962ff;outline-offset:-3px}.mw-data-center-button[aria-expanded=true]{background:#2b2b2b}html:not(.theme-dark) .mw-data-center-button[aria-expanded=true]{background:#f2f2f2}`;
  doc.head.append(style);
  let mounted = false, childReady = false, target = null, disposed = false, applying = false;
  let remembered, pendingLocation;
  let lastFocus;
  const buttonId = widget.createButton({ align: "left", useTradingViewStyle: true, text: "数据中心", title: "数据中心", onClick: () => open() });
  const icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/></svg>`;
  function decorate() {
    for (const button of doc.querySelectorAll('button[data-name="custom-tradingview-styled-button"][aria-label="数据中心"]')) {
      if (!button.classList.contains("mw-data-center-button")) {
        button.classList.add("mw-data-center-button");
        (button.querySelector(".js-button-text") || button).insertAdjacentHTML("afterbegin", icon);
        button.setAttribute("aria-haspopup", "dialog");
      }
      const value = String(dialog.open);
      if (button.getAttribute("aria-expanded") !== value) button.setAttribute("aria-expanded", value);
    }
  }
  const observer = new MutationObserver(decorate);
  observer.observe(doc.body, { subtree: true, childList: true }); decorate();
  const childPost = value => frame.contentWindow?.postMessage({ channel, session, ...value }, appOrigin);
  const current = () => !!target && !target.invalid && !disposed && workspace()?.id === target.workspace && epoch() === target.epoch &&
    target.index < widget.chartsCount() && widget.chart(target.index) === target.chart && widget.activeChart() === target.chart &&
    target.chart.symbol() === target.symbol && target.chart.resolution() === target.resolution && widget.layout() === target.layout;
  function context() {
    if (!childReady || !target) return;
    childPost({ type: "context", context: { workspace: target.workspace, target: target.id, theme: widget.getTheme().toLowerCase(),
      symbolSync: widget.symbolSync().value(), intervalSync: widget.intervalSync().value(), location: pendingLocation || remembered } });
    pendingLocation = undefined;
  }
  function open(location) {
    if (disposed) return;
    if (dialog.open) { frame.focus(); return; }
    if (!workspace()?.id) return;
    suspendIndicators(); widget.closePopupsAndDialogs();
    for (const old of doc.querySelectorAll("dialog[open]")) old.close();
    target = { id: crypto.randomUUID(), workspace: workspace().id, epoch: epoch(), index: widget.activeChartIndex(), chart: widget.activeChart(),
      symbol: widget.activeChart().symbol(), resolution: widget.activeChart().resolution(), layout: widget.layout() };
    pendingLocation = location;
    lastFocus = doc.activeElement;
    dialog.dataset.theme = widget.getTheme().toLowerCase();
    if (!mounted) { doc.body.append(dialog); mounted = true; } // Do not read management data before first explicit open.
    dialog.showModal(); decorate(); context(); frame.focus();
    send({ type: "data-center-state", open: true, session });
  }
  function close() {
    if (!dialog.open) return;
    dialog.close(); decorate();
    const button = [...doc.querySelectorAll(".mw-data-center-button")].find(node => {
      const r = node.getBoundingClientRect(), hit = doc.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return r.width > 0 && (hit === node || node.contains(hit));
    });
    (button || lastFocus)?.focus();
    send({ type: "data-center-state", open: false, session });
    // Unmount the app to cancel reads and polling. Session navigation persists.
    dialog.remove(); mounted = false; childReady = false; target = null;
  }
  const timeout = (promise, ms) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("图表应用超时，请核查目标图格后重试。")), ms);
    Promise.resolve(promise).then(result => {clearTimeout(timer);resolve(result);}, error => {clearTimeout(timer);reject(error);});
  });
  async function apply(m) {
    if (applying) { childPost({ type: "apply-result", id: m.id, error: "正在应用行情，请等待结果" }); return; }
    applying = true;
    let error;
    const captured = target;
    const validTarget = () => captured && target === captured && !captured.invalid && !disposed &&
      workspace()?.id === captured.workspace && epoch() === captured.epoch &&
      captured.index < widget.chartsCount() && widget.chart(captured.index) === captured.chart &&
      widget.activeChart() === captured.chart && widget.layout() === captured.layout;
    try {
      if (!current() || m.target !== target.id || m.workspace !== target.workspace) throw Error("目标图格或工作区已变化，请关闭并重新打开数据中心。");
      const identity = MWSeries.decode(m.ticker);
      const resolution = {M1:"1",M5:"5",M15:"15",M30:"30",H1:"60",H4:"240",D1:"1D",W1:"1W",MN:"1M"}[m.frame];
      if (!resolution || !["provider","history","composite"].includes(identity.series_kind)) throw Error("无效行情或周期");
      const meta = await timeout(resolve({ instrument: identity.symbol, series_kind: identity.series_kind, timeframe: m.frame }), 15000);
      if (!current()) throw Error("目标图格已变化，请重新打开数据中心。");
      if (!meta.frames?.includes(m.frame)) throw Error("所选周期尚不可用");
      // Turning either lock back on immediately broadcasts the active chart.
      // Keep these two locks off so every other chart retains its identity.
      widget.symbolSync().setValue(false); widget.intervalSync().setValue(false);
      const others = Array.from({length:widget.chartsCount()},(_,i)=>widget.chart(i)).filter(c=>c!==target.chart).map(c=>[c,c.symbol(),c.resolution()]);
      const changed = await timeout(captured.chart.setSymbol(m.ticker, {doNotActivateChart:true}), 20000);
      if (!validTarget()) throw Error("目标图格或工作区已变化，停止后续应用。请重新打开数据中心。");
      if (changed === false && !MWSeries.same(captured.chart.symbol(), m.ticker)) throw Error("图表未接受所选行情，请重试");
      await timeout(captured.chart.setResolution(resolution, {doNotActivateChart:true}), 20000);
      if (!validTarget()) throw Error("目标图格或工作区已变化，请核查目标图格并重新打开数据中心。");
      if (!MWSeries.same(captured.chart.symbol(), m.ticker) || captured.chart.resolution() !== resolution) throw Error("图表未完成应用，请核查后重试");
      if (others.some(([chart,symbol,res])=>chart.symbol()!==symbol || chart.resolution()!==res)) throw Error("其他图格发生变化，请核查同步设置");
      target.symbol = target.chart.symbol(); target.resolution = target.chart.resolution();
    } catch (e) { error = String(e); }
    finally { applying = false; }
    childPost({ type: "apply-result", id: m.id, ...(error ? {error} : {}) });
  }
  const listener = event => {
    if (event.source !== frame.contentWindow || event.origin !== appOrigin || event.data?.channel !== channel || event.data.session !== session) return;
    const m = event.data;
    if (m.type === "ready") { childReady = true; context(); }
    else if (m.type === "close" && !applying) close();
    else if (m.type === "location" && typeof m.location === "string" && m.location.length <= 4000 && m.location.startsWith("/market-data")) remembered = m.location;
    else if (m.type === "apply" && typeof m.id === "string" && m.id.length <= 40 && typeof m.ticker === "string" && m.ticker.length <= 90) void apply(m);
    else if (m.type === "replay" && /^\/replay(?:\?dataset_version=[a-f0-9-]{36})?$/.test(m.path) && !applying) { send({type:"data-center-replay",path:m.path,session}); close(); }
  };
  window.addEventListener("message", listener);
  dialog.addEventListener("cancel", event => { event.preventDefault(); childPost({type:"request-close"}); });
  const theme = () => { dialog.dataset.theme = widget.getTheme().toLowerCase(); childPost({ type: "theme", theme: dialog.dataset.theme }); };
  widget.subscribe("chart_theme_changed", theme);
  const invalidate = () => { if (dialog.open && target) target.invalid = true; };
  const events = ["layout_changed", "chart_load_requested", "activeChartChanged"];
  for (const name of events) widget.subscribe(name, invalidate);
  return { open, dispose() { disposed = true; close(); observer.disconnect(); style.remove(); dialog.remove(); widget.removeButton(buttonId); window.removeEventListener("message",listener); widget.unsubscribe("chart_theme_changed",theme); for (const name of events) widget.unsubscribe(name,invalidate); } };
}
