/* Native dialog host. Authenticated operations remain in the trusted app. */
function chartDataCenter({ widget, appOrigin, workspace, epoch, send, resolve, suspendIndicators, managementRequest, searchSymbols }) {
  const probe = widget.createButton({ align: "left", useTradingViewStyle: false });
  const doc = probe.ownerDocument;
  widget.removeButton(probe);
  const session = crypto.randomUUID(), channel = "mw-data-center-v1";
  const resolutions = {M1:"1",M5:"5",M15:"15",M30:"30",H1:"60",H4:"240",D1:"1D",W1:"1W",MN:"1M"};
  const dialog = { open: false };
  const nativeUi = chartNativeUi(widget, doc, searchSymbols);
  const listeners = new Set();
  let nativeRoot, businessRoot, fallback, fallbackFrame, ui, opening = false, openGeneration = 0, assetPromise;
  const readControllers = new Set();
  const style = doc.createElement("style");
  style.textContent = `.mw-data-center-native{width:min(1120px,calc(100vw - 32px))!important;max-width:none!important}.mw-data-center-wrapper{width:100%;height:min(720px,calc(100dvh - 32px))}.mw-data-center-business{flex:1;min-height:0;position:relative}.mw-data-center-title{display:flex;align-items:center;gap:10px}.mw-data-center-title svg{width:24px;height:24px}.mw-data-center-button{padding:0 12px!important}.mw-data-center-button .js-button-text{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:100%}.mw-data-center-button svg{width:20px;height:20px;display:block;flex-shrink:0}.mw-data-center-button[aria-expanded=true]{background:#2b2b2b}html:not(.theme-dark) .mw-data-center-button[aria-expanded=true]{background:#f2f2f2}`;
  doc.head.append(style);
  function assets() {
    if (assetPromise) return assetPromise;
    assetPromise = new Promise((resolve, reject) => {
      const css = doc.createElement("link");css.rel="stylesheet";css.href="/data-center-native.css";
      const script = doc.createElement("script");script.src="/data-center-native.js";
      let finished=false,loaded=0,timer=setTimeout(failed,20000);
      function failed() {if(finished)return;finished=true;clearTimeout(timer);script.remove();css.remove();assetPromise=undefined;reject(Error("数据中心资源加载失败，请重试"));}
      function ready() {if(finished || ++loaded !== 2)return;if(!doc.defaultView.MWNativeCenter){failed();return;}finished=true;clearTimeout(timer);resolve();}
      script.onerror = css.onerror = failed;
      script.onload = css.onload = ready;
      doc.head.append(css,script);
    });
    return assetPromise;
  }
  let childReady = false, target = null, disposed = false, operation = null;
  let remembered, pendingLocation;
  let lastFocus;
  // A market load belongs to the chart after the selection dialog is closed.
  const notice = doc.createElement("div");
  notice.className = "mw-data-center-load";
  const message = doc.createElement("span");
  const retry = doc.createElement("button"); retry.textContent = "重试";
  const dismiss = doc.createElement("button"); dismiss.textContent = "关闭";
  dismiss.setAttribute("aria-label", "关闭行情加载提示");
  notice.append(message, retry, dismiss);
  const noticeStyle = doc.createElement("style");
  noticeStyle.textContent = `.mw-data-center-load{position:fixed;z-index:1000;top:52px;right:20px;max-width:min(440px,calc(100vw - 40px));display:flex;align-items:center;gap:12px;padding:12px 16px;border:1px solid #434343;border-radius:6px;background:#1f1f1f;color:#dbdbdb;font:13px -apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif;box-shadow:0 2px 4px rgb(0 0 0 / 40%)}.mw-data-center-load[data-theme=light]{background:#fff;color:#0f0f0f;border-color:#ccc;box-shadow:0 2px 4px rgb(0 0 0 / 20%)}.mw-data-center-load span{flex:1}.mw-data-center-load button{flex-shrink:0;border:1px solid currentColor;border-radius:4px;padding:4px 8px;font:inherit;background:transparent;color:inherit;cursor:pointer}.mw-data-center-load button:focus-visible{outline:2px solid #2962ff;outline-offset:2px}.mw-data-center-load button[hidden]{display:none}`;
  doc.head.append(noticeStyle);
  const owned = work => !disposed && operation === work && workspace()?.id === work.target.workspace && epoch() === work.target.epoch &&
    work.target.index < widget.chartsCount() && widget.chart(work.target.index) === work.target.chart &&
    widget.activeChart() === work.target.chart && widget.layout() === work.target.layout;
  const unchanged = work => owned(work) && work.target.chart.symbol() === work.target.symbol && work.target.chart.resolution() === work.target.resolution;
  function clearOperation() {
    if (operation) clearTimeout(operation.timer);
    operation = null; notice.remove();
  }
  function showLoad(work, text, error = false) {
    if (!owned(work)) return;
    message.textContent = text;
    notice.setAttribute("role", error ? "alert" : "status");
    notice.dataset.theme = widget.getTheme().toLowerCase();
    retry.hidden = !error;
    retry.onclick = () => {
      if (!owned(work) || !(unchanged(work) || MWSeries.same(work.target.chart.symbol(), work.request.ticker) &&
          work.target.chart.resolution() === resolutions[work.request.frame])) { clearOperation(); return; }
      // Retry only the still-selected chart, never an older workspace/layout.
      const captured = { ...work.target, symbol: work.target.chart.symbol(), resolution: work.target.chart.resolution() };
      clearOperation(); void startLoad(work.request, captured, true);
    };
    if (!notice.isConnected) doc.body.append(notice);
  }
  dismiss.onclick = () => notice.remove();
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
  const childPost = value => {
    if(fallbackFrame?.contentWindow) fallbackFrame.contentWindow.postMessage({channel,session,...value},appOrigin);
    for (const receive of [...listeners]) receive(value);
  };
  const current = () => !!target && !target.invalid && !disposed && workspace()?.id === target.workspace && epoch() === target.epoch &&
    target.index < widget.chartsCount() && widget.chart(target.index) === target.chart && widget.activeChart() === target.chart &&
    target.chart.symbol() === target.symbol && target.chart.resolution() === target.resolution && widget.layout() === target.layout;
  function context() {
    if (!childReady || !target) return;
    childPost({ type: "context", context: { workspace: target.workspace, target: target.id, theme: widget.getTheme().toLowerCase(),
      symbolSync: widget.symbolSync().value(), intervalSync: widget.intervalSync().value(), location: pendingLocation || remembered } });
    pendingLocation = undefined;
  }
  async function open(location) {
    if (disposed || opening) return;
    if (dialog.open) { doc.querySelector('[data-name="mw-data-center-dialog"]')?.focus(); return; }
    if (!workspace()?.id) return;
    opening = true;
    const generation = ++openGeneration;
    const openingWorkspace = workspace().id, openingEpoch = epoch();
    lastFocus = doc.activeElement;
    try {
      await Promise.all([assets(), nativeUi.load().then(value => { ui = value; })]);
      if (disposed || generation !== openGeneration || openingWorkspace !== workspace()?.id || openingEpoch !== epoch()) return;
      clearOperation(); suspendIndicators(); widget.closePopupsAndDialogs();
      target = { id: crypto.randomUUID(), workspace: workspace().id, epoch: epoch(), index: widget.activeChartIndex(), chart: widget.activeChart(),
        symbol: widget.activeChart().symbol(), resolution: widget.activeChart().resolution(), layout: widget.layout() };
      pendingLocation = location; dialog.open = true;
      send({ type: "data-center-state", open: true, session });
      const R=ui.react, mount=doc.createElement("div");
      const hosted = {
        ui, context: {workspace:target.workspace,target:target.id,theme:widget.getTheme().toLowerCase(),
          symbolSync:widget.symbolSync().value(),intervalSync:widget.intervalSync().value(),location:location||remembered},
        post: message=>{if(dialog.open && generation===openGeneration) handleMessage(message);}, subscribe(receive) {listeners.add(receive);return()=>listeners.delete(receive);},
        request(path, body, signal) {
          if (!dialog.open || disposed || generation!==openGeneration) return Promise.reject(Error("数据中心已关闭"));
          const controller = new AbortController();
          signal?.addEventListener("abort", () => controller.abort(), {once:true});
          if (signal?.aborted) controller.abort();
          if (body === undefined) readControllers.add(controller);
          return managementRequest({session,path,body}, controller.signal).finally(()=>readControllers.delete(controller));
        },
      };
      nativeRoot=ui.createRoot(R.createElement(ui.components.dialog, {
        isOpened:true, title:R.createElement("span",{className:"mw-data-center-title"},R.createElement("span",{dangerouslySetInnerHTML:{__html:icon}}),"数据中心"),
        dataName:"mw-data-center-dialog",dataDialogName:"数据中心",closeAriaLabel:"关闭数据中心",containerAriaLabel:"数据中心",
        className:"mw-data-center-native",wrapperClassName:"mw-data-center-wrapper",draggable:true,showSeparator:true,
        shouldReturnFocus:false,onClose:()=>childPost({type:"request-close"}),
        onKeyDown(event) { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); childPost({type:"request-close"}); } },
        render:()=>R.createElement("div",{className:"mw-data-center-business",ref:node=>{if(node && !businessRoot){businessRoot=doc.defaultView.MWNativeCenter.mount(node,hosted);}}}),
      }),mount);
      decorate();
    } catch(error) {
      if (!disposed && generation === openGeneration) {
        const oldBusiness=businessRoot,oldNative=nativeRoot;businessRoot=null;nativeRoot=null;listeners.clear();
        oldBusiness?.dispose();oldNative?.unmount();
        if(openingWorkspace!==workspace()?.id || openingEpoch!==epoch()) return;
        target={id:crypto.randomUUID(),workspace:workspace().id,epoch:epoch(),index:widget.activeChartIndex(),chart:widget.activeChart(),
          symbol:widget.activeChart().symbol(),resolution:widget.activeChart().resolution(),layout:widget.layout()};
        pendingLocation=location;dialog.open=true;opening=false;childReady=false;
        send({type:"data-center-state",open:true,session});
        fallback=doc.createElement("dialog");fallback.setAttribute("aria-label","数据中心兼容窗口");
        fallback.style.cssText="position:fixed;inset:0;margin:auto;padding:0;border:1px solid #777;border-radius:6px;width:min(1120px,calc(100vw - 32px));height:min(720px,calc(100dvh - 32px));max-width:none;max-height:none";
        fallbackFrame=doc.createElement("iframe");fallbackFrame.title="数据中心";
        fallbackFrame.style.cssText="width:100%;height:100%;border:0;display:block";
        fallbackFrame.src=appOrigin+"/chart-data-center?session="+session;
        fallback.addEventListener("cancel",event=>{event.preventDefault();childPost({type:"request-close"});});
        fallback.append(fallbackFrame);doc.body.append(fallback);fallback.showModal();decorate();
        send({type:"error",error:"原生界面适配暂不可用，已打开数据中心兼容窗口："+String(error.message||error)});
      }
    } finally { if(generation===openGeneration) opening=false; }
  }
  function close() {
    if (!dialog.open && !opening) return;
    ++openGeneration; opening=false; dialog.open=false;
    ui?.cancelPopups();
    for(const controller of readControllers) controller.abort();readControllers.clear();
    fallback?.remove();fallback=null;fallbackFrame=null;
    const oldBusiness=businessRoot,oldNative=nativeRoot;businessRoot=null;nativeRoot=null;listeners.clear();
    queueMicrotask(()=>{oldBusiness?.dispose();oldNative?.unmount();
      if(!dialog.open) doc.defaultView.requestAnimationFrame(()=>{if(!dialog.open)(button||lastFocus)?.focus();});
    });
    decorate();
    const button=[...doc.querySelectorAll(".mw-data-center-button")].find(node=>!node.disabled && !node.closest("[aria-hidden=true]") && node.getClientRects().length && doc.defaultView.getComputedStyle(node).visibility !== "hidden");
    (button||lastFocus)?.focus();
    send({type:"data-center-state",open:false,session});
    childReady=false;target=null;
  }
  const timeout = (promise, ms) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("行情加载超时，请重试。")), ms);
    Promise.resolve(promise).then(result => {clearTimeout(timer);resolve(result);}, error => {clearTimeout(timer);reject(error);});
  });
  async function startLoad(m, captured, reload = false) {
    const work = { request: m, target: captured, timer: null };
    operation = work;
    showLoad(work, "正在打开所选行情…");
    try {
      const identity = MWSeries.decode(m.ticker);
      const resolution = resolutions[m.frame];
      const meta = await timeout(resolve({ instrument: identity.symbol, series_kind: identity.series_kind, timeframe: m.frame }), 15000);
      if (!unchanged(work)) { if (operation === work) clearOperation(); return; }
      if (!meta.frames?.includes(m.frame)) throw Error("所选周期尚不可用");
      // Turning either lock back on immediately broadcasts the active chart.
      // Keep these two locks off so every other chart retains its identity.
      widget.symbolSync().setValue(false); widget.intervalSync().setValue(false);
      const others = Array.from({length:widget.chartsCount()},(_,i)=>widget.chart(i)).filter(c=>c!==captured.chart).map(c=>[c,c.symbol(),c.resolution()]);
      showLoad(work, `正在加载 ${meta.display_symbol || meta.symbol || "所选行情"}…`);
      const selected = () => owned(work) && MWSeries.same(captured.chart.symbol(), m.ticker) && captured.chart.resolution() === resolution;
      const completed = () => {
        if (!owned(work)) { if (operation === work) clearOperation(); return; }
        if (!selected()) { clearOperation(); return; }
        if (others.some(([chart,symbol,res])=>chart.symbol()!==symbol || chart.resolution()!==res)) {
          showLoad(work, "其他图格发生变化，请核查同步设置。", true); return;
        }
        clearOperation();
      };
      work.timer = setTimeout(() => {
        if (owned(work) && (unchanged(work) || MWSeries.same(captured.chart.symbol(), m.ticker)))
          showLoad(work, "行情仍在加载，可继续操作图表或重试。", true);
        else if (operation === work) clearOperation();
      }, 20000);
      // Native widget.setSymbol(symbol, period) also restores the old range;
      // across sources that can race the new series' time index. Keep the
      // proven per-chart sequence, outside the dialog, with a guard before
      // each mutation so a late symbol callback cannot change a newer period.
      if (!MWSeries.same(captured.chart.symbol(), m.ticker)) {
        const changed = await timeout(captured.chart.setSymbol(m.ticker, {doNotActivateChart:true}), 30000);
        if (changed === false && unchanged(work)) throw Error("图表未接受所选行情，请重试。");
      }
      if (!owned(work) || !MWSeries.same(captured.chart.symbol(), m.ticker) ||
          captured.chart.resolution() !== captured.resolution) {
        if (operation === work) clearOperation(); return;
      }
      if (captured.chart.resolution() !== resolution) {
        const changed = await timeout(captured.chart.setResolution(resolution, {doNotActivateChart:true}), 30000);
        if (changed === false && owned(work) && captured.chart.resolution() === captured.resolution)
          throw Error("图表未接受所选周期，请重试。");
      }
      if (selected()) {
        if (reload) captured.chart.resetData();
        if (!captured.chart.dataReady())
          await timeout(new Promise(done => captured.chart.dataReady(done)), 30000);
      }
      completed();
    } catch (e) {
      clearTimeout(work.timer);
      if (owned(work) && (unchanged(work) || MWSeries.same(captured.chart.symbol(), m.ticker)))
        showLoad(work, `打开行情失败：${String(e?.message || e).replace(/^(?:[A-Za-z]*Error:\s*)+/, "")}`, true);
      else if (operation === work) clearOperation();
    }
  }
  function apply(m) {
    try {
      if (!dialog.open || !current() || m.target !== target.id || m.workspace !== target.workspace) throw Error("目标图格或工作区已变化，请关闭并重新打开数据中心。");
      const identity = MWSeries.decode(m.ticker);
      if (!Object.hasOwn(resolutions, m.frame) || !["provider","history","composite"].includes(identity.series_kind)) throw Error("无效行情或周期");
      const captured = target;
      childPost({ type: "apply-result", id: m.id });
      close();
      void startLoad(m, captured);
    } catch (e) { childPost({ type: "apply-result", id: m.id, error: String(e) }); }
  }
  function handleMessage(m) {
    if (m.type === "ready") {childReady=true;context();}
    else if(m.type==="close") close();
    else if(m.type==="location" && typeof m.location==="string" && m.location.length<=4000 && m.location.startsWith("/market-data")) remembered=m.location;
    else if(m.type==="apply" && typeof m.id==="string" && m.id.length<=40 && typeof m.ticker==="string" && m.ticker.length<=90) void apply(m);
    else if(m.type==="replay" && /^\/replay(?:\?dataset_version=[a-f0-9-]{36})?$/.test(m.path)){send({type:"data-center-replay",path:m.path,session});close();}
  }
  const fallbackMessage=event=>{
    if(event.origin===appOrigin && event.source===fallbackFrame?.contentWindow && event.data?.channel===channel && event.data.session===session)
      handleMessage(event.data);
  };
  addEventListener("message",fallbackMessage);
  // Business controls live in independent React roots. The vendor shell's
  // keyboard controller cannot enumerate their tab stops; use DOM tab order
  // inside this shell while native menus/pickers retain their own controller.
  const modalKeys=event=>{
    if(!dialog.open || fallback || event.defaultPrevented || event.key!=="Tab") return;
    const root=doc.querySelector('[data-name="mw-data-center-dialog"]');
    if(!root || root.querySelector(".dc-unsaved")) return;
    const active=doc.activeElement;
    const nested=active?.closest('[role="dialog"],[role="listbox"]');
    if(nested && nested!==root && !root.contains(nested)) return;
    const nodes=[...root.querySelectorAll('button,a[href],input,select,textarea,summary,[tabindex]')].filter(node=>
      node.tabIndex>=0 && !node.matches(":disabled") && !node.closest('[inert],[aria-hidden="true"]') &&
      node.getClientRects().length && doc.defaultView.getComputedStyle(node).visibility!=="hidden");
    if(!nodes.length)return;
    const index=nodes.findIndex(node=>node===active || node.contains(active));
    const next=event.shiftKey ? (index<=0 ? nodes.length-1 : index-1) : (index+1)%nodes.length;
    event.preventDefault();event.stopPropagation();nodes[next].focus();
  };
  doc.addEventListener("keydown",modalKeys,true);
  const theme = () => { notice.dataset.theme = widget.getTheme().toLowerCase(); childPost({ type: "theme", theme: notice.dataset.theme }); };
  widget.subscribe("chart_theme_changed", theme);
  const invalidate = () => { if (dialog.open && target) target.invalid = true; clearOperation(); };
  const events = ["layout_changed", "chart_load_requested", "activeChartChanged"];
  for (const name of events) widget.subscribe(name, invalidate);
  return { open, nativeUi, dispose() { disposed = true; close(); clearOperation(); observer.disconnect();removeEventListener("message",fallbackMessage);doc.removeEventListener("keydown",modalKeys,true); style.remove(); noticeStyle.remove(); widget.removeButton(buttonId); widget.unsubscribe("chart_theme_changed",theme); for (const name of events) widget.unsubscribe(name,invalidate); } };
}
