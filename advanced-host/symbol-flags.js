/* Independent account preference; list membership and chart documents are untouched. */
const MWSymbolFlags = (() => {
  const name = "mw.symbol-flags.v1",
    version = "6b804c486857f27920cf761aa7eb6e29d9bb6362";
  const colors = {
    red: ["红色", "#f23645"],
    blue: ["蓝色", "#2962ff"],
    green: ["绿色", "#089981"],
    yellow: ["黄色", "#f5c842"],
    purple: ["紫色", "#9c6ade"],
    cyan: ["青色", "#00bcd4"],
    pink: ["粉色", "#ed72aa"],
  };
  function identity(ticker) {
    const decoded = MWSeries.decode(ticker);
    if (decoded.spec) throw Error("指标不是可收藏品种");
    return MWSeries.encode(decoded.symbol, decoded.series_kind);
  }
  function parse(value) {
    if (value == null) return {};
    if (
      value.version !== 1 ||
      !value.flags ||
      typeof value.flags !== "object" ||
      Array.isArray(value.flags)
    )
      throw Error("收藏偏好版本不兼容，已保留原数据");
    const result = Object.create(null);
    for (const [ticker, color] of Object.entries(value.flags)) {
      if (!Object.hasOwn(colors, color) || identity(ticker) !== ticker)
        throw Error("收藏偏好无效，已保留原数据");
      result[ticker] = color;
    }
    return result;
  }
  function store(initial, rpc) {
    let row = initial,
      flags = parse(row?.content?.value),
      queue = Promise.resolve();
    const reload = async () => {
      row = await rpc("read");
      flags = parse(row?.content?.value);
      return flags;
    };
    return {
      get: () => ({ ...flags }),
      reload,
      set(ticker, color) {
        ticker = identity(ticker);
        if (color !== null && !Object.hasOwn(colors, color))
          return Promise.reject(Error("未知收藏颜色"));
        const task = queue.then(async () => {
          for (let attempt = 0; ; attempt++) {
            const merged = { ...flags };
            if (color === null) delete merged[ticker];
            else merged[ticker] = color;
            try {
              row = await rpc("save", {
                kind: "setting",
                name,
                tool: "",
                revision: row?.revision || 0,
                content: { value: { version: 1, flags: merged } },
              });
              flags = parse(row.content.value);
              return flags;
            } catch (error) {
              if (error.status !== 409 || attempt >= 2) throw error;
              // Rebase only this explicit symbol edit; preserve other windows' flags.
              await reload();
            }
          }
        });
        queue = task.catch(() => {});
        return task;
      },
    };
  }
  function attach(widget, initial, readonly, rpc, report) {
    if (!String(globalThis.TradingView?.version?.()).includes(version)) {
      report(Error("当前图表库版本不支持行内收藏增强，原生自选表仍可使用"));
      return { dispose() {} };
    }
    const state = store(initial, rpc),
      slot = widget.createButton({ align: "left", useTradingViewStyle: false }),
      doc = slot.ownerDocument;
    widget.removeButton(slot);
    let disposed = false,
      scheduled = false,
      popup,
      trigger,
      pendingEdit,
      writing = false;
    const buttons = new Set();
    const style = doc.createElement("style");
    style.textContent = `.mw-symbol-flag{display:inline-flex;align-items:center;justify-content:center;flex:0 0 24px;width:24px;height:24px;min-width:24px;padding:2px!important;margin-right:2px;border:0;background:transparent;color:#787b86;cursor:pointer}.mw-symbol-flag svg{width:14px;height:14px;fill:var(--flag-color,transparent);stroke:var(--flag-stroke,currentColor)}.mw-symbol-flag:focus-visible,.mw-flag-palette button:focus-visible{outline:2px solid #2962ff;outline-offset:1px}.mw-flag-palette{position:fixed;z-index:10000;width:240px;padding:12px;background:#fff;color:#131722;border:1px solid #787b86;border-radius:6px;box-shadow:0 8px 24px #0004;font:13px -apple-system,BlinkMacSystemFont,sans-serif}.theme-dark .mw-flag-palette{background:#1e1e1e;color:#eee}.mw-flag-colors{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.mw-flag-palette button{min-width:28px;min-height:32px;border:1px solid #787b86;border-radius:4px;background:transparent;color:inherit;cursor:pointer}.mw-flag-palette button[aria-checked=true]{outline:2px solid #2962ff;outline-offset:2px}.mw-flag-palette button:disabled{opacity:.6;cursor:default}.mw-flag-clear{width:100%;margin-top:12px}.mw-flag-status{margin-top:8px;line-height:1.6;overflow-wrap:anywhere}`;
    doc.head.append(style);
    const close = (focus = false) => {
      if (writing) return;
      popup?.remove();
      popup = null;
      pendingEdit = null;
      if (trigger?.isConnected) {
        trigger.setAttribute("aria-expanded", "false");
        if (focus) trigger.focus();
      }
      trigger = null;
    };
    const icon =
      '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M4 16V3m0 0c3-3 6 3 10 0v7c-4 3-7-3-10 0Z" fill-rule="evenodd" stroke-width="1.4"/></svg>';
    const paint = () => {
      if (disposed) return;
      scheduled = false;
      for (const button of buttons)
        if (!button.isConnected) buttons.delete(button);
      for (const row of doc.querySelectorAll("[data-symbol-full]")) {
        let ticker;
        try {
          ticker = identity(row.dataset.symbolFull);
        } catch {
          continue;
        }
        const cell =
          row.querySelector('[class*="symbolName-"]') ||
          row.querySelector('[class*="symbolNameText-"]')?.parentElement;
        if (!cell) continue;
        let button = row.querySelector(".mw-symbol-flag");
        if (!button) {
          button = doc.createElement("button");
          button.type = "button";
          button.className = "mw-symbol-flag";
          button.innerHTML = icon;
          button.setAttribute("aria-haspopup", "dialog");
          button.setAttribute("aria-expanded", "false");
          for (const type of [
            "pointerdown",
            "mousedown",
            "dblclick",
            "dragstart",
          ])
            button.addEventListener(type, (e) => {
              e.stopPropagation();
              if (type === "dragstart") e.preventDefault();
            });
          button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            open(button);
          });
          button.addEventListener("keydown", (event) =>
            event.stopPropagation(),
          );
          cell.prepend(button);
          buttons.add(button);
        }
        if (trigger === button && button.dataset.ticker !== ticker) close();
        button.dataset.ticker = ticker;
        const color = state.get()[ticker];
        button.style.setProperty(
          "--flag-color",
          color ? colors[color][1] : "transparent",
        );
        button.style.setProperty(
          "--flag-stroke",
          color ? colors[color][1] : "currentColor",
        );
        button.setAttribute(
          "aria-label",
          `${ticker} · ${color ? colors[color][0] + "收藏" : "添加颜色收藏"}${readonly ? "（只读）" : ""}`,
        );
        button.title = color ? colors[color][0] + "收藏" : "添加颜色收藏";
      }
    };
    const schedule = () => {
      if (!scheduled && !disposed) {
        scheduled = true;
        doc.defaultView.requestAnimationFrame(paint);
      }
    };
    function open(button) {
      if (popup && trigger === button) {
        close(true);
        return;
      }
      close();
      if (writing) return;
      trigger = button;
      const ticker = button.dataset.ticker,
        current = state.get()[ticker];
      popup = doc.createElement("section");
      popup.className = "mw-flag-palette";
      popup.setAttribute("role", "dialog");
      popup.setAttribute("aria-label", `${ticker} 收藏颜色`);
      const heading = doc.createElement("strong");
      heading.textContent = readonly ? "收藏颜色 · 手机只读" : "收藏颜色";
      const group = doc.createElement("div");
      group.className = "mw-flag-colors";
      group.setAttribute("role", "radiogroup");
      group.setAttribute("aria-label", "七色收藏");
      const status = doc.createElement("p");
      status.className = "mw-flag-status";
      status.setAttribute("role", "status");
      const retry = doc.createElement("button");
      retry.textContent = "重试保存";
      retry.hidden = true;
      async function choose(color) {
        if (readonly || writing) return;
        const palette = popup;
        pendingEdit = color;
        writing = true;
        status.textContent = "正在保存…";
        retry.hidden = true;
        for (const b of popup.querySelectorAll("button")) b.disabled = true;
        try {
          await state.set(ticker, color);
          if (disposed || popup !== palette) return;
          writing = false;
          paint();
          close(true);
        } catch (error) {
          if (disposed || popup !== palette) return;
          writing = false;
          status.textContent = "保存失败，修改尚未保存：" + String(error);
          retry.hidden = false;
          for (const b of palette.querySelectorAll("button"))
            b.disabled = false;
          report(error);
        }
      }
      for (const [color, [label, hex]] of Object.entries(colors)) {
        const option = doc.createElement("button");
        option.type = "button";
        option.setAttribute("role", "radio");
        option.setAttribute("aria-label", label);
        option.setAttribute("aria-checked", String(current === color));
        option.disabled = readonly;
        option.innerHTML = icon;
        option.style.setProperty("--flag-color", hex);
        option.style.color = hex;
        option.title = label;
        option.querySelector("svg").style.cssText =
          "width:18px;height:18px;fill:currentColor;stroke:currentColor";
        option.onclick = () => choose(color);
        group.append(option);
      }
      const dismiss = doc.createElement("button");
      dismiss.type = "button";
      dismiss.textContent = "关闭";
      dismiss.onclick = () => close(true);
      const clear = doc.createElement("button");
      clear.className = "mw-flag-clear";
      clear.type = "button";
      clear.textContent = "取消收藏";
      clear.disabled = readonly;
      clear.onclick = () => choose(null);
      retry.onclick = () => choose(pendingEdit);
      popup.append(heading, group, clear, status, retry, dismiss);
      doc.body.append(popup);
      const bounds = button.getBoundingClientRect();
      popup.style.left =
        Math.max(8, Math.min(bounds.left, doc.defaultView.innerWidth - 256)) +
        "px";
      popup.style.top =
        Math.max(
          8,
          Math.min(
            bounds.bottom + 4,
            doc.defaultView.innerHeight - popup.offsetHeight - 8,
          ),
        ) + "px";
      button.setAttribute("aria-expanded", "true");
      (readonly
        ? dismiss
        : group.querySelector("[aria-checked=true]") || group.firstElementChild
      ).focus();
    }
    const outside = (e) => {
      if (popup && !popup.contains(e.target) && !trigger?.contains(e.target))
        close();
    };
    const keys = (e) => {
      if (!popup) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(true);
        return;
      }
      const options = [
        ...popup.querySelectorAll("button:not([hidden]):not(:disabled)"),
      ];
      if (
        [
          "ArrowRight",
          "ArrowLeft",
          "ArrowDown",
          "ArrowUp",
          "Home",
          "End",
          "Tab",
        ].includes(e.key)
      ) {
        e.preventDefault();
        e.stopPropagation();
        const i = options.indexOf(doc.activeElement),
          delta =
            e.key === "ArrowLeft" ||
            e.key === "ArrowUp" ||
            (e.key === "Tab" && e.shiftKey)
              ? -1
              : 1;
        options[
          e.key === "Home"
            ? 0
            : e.key === "End"
              ? options.length - 1
              : (i + delta + options.length) % options.length
        ]?.focus();
      }
    };
    const observer = new MutationObserver(schedule);
    observer.observe(doc.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-symbol-full"],
    });
    doc.addEventListener("pointerdown", outside, true);
    doc.addEventListener("keydown", keys, true);
    paint();
    return {
      dispose() {
        disposed = true;
        writing = false;
        close();
        observer.disconnect();
        doc.removeEventListener("pointerdown", outside, true);
        doc.removeEventListener("keydown", keys, true);
        for (const b of buttons) b.remove();
        buttons.clear();
        style.remove();
      },
    };
  }
  return { name, colors, identity, parse, store, attach };
})();
