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
      writing = false,
      activeWrite,
      hoveredRow = null,
      hoveredPopup = false,
      closeTimer;
    const buttons = new Set(),
      positionedCells = new Map(),
      rowBindings = new Map(),
      optimistic = new Map(),
      defaultWrites = new Map();
    const style = doc.createElement("style");
    style.textContent = `
      .mw-symbol-flag{position:absolute;z-index:3;left:0;top:50%;display:grid;place-items:center;width:16px;height:24px;min-width:16px;padding:0!important;margin:0;border:0;border-radius:2px;background:transparent;color:var(--flag-color,#787b86);cursor:pointer;touch-action:manipulation;transform:translateY(-50%);transition:background .12s ease,opacity .12s ease}
      .mw-symbol-flag svg{width:16px;height:24px;fill:currentColor;stroke:none;pointer-events:none}
      .mw-symbol-flag{opacity:0}
      [data-symbol-full]:hover .mw-symbol-flag,.mw-symbol-flag[data-empty=false],.mw-symbol-flag:focus-visible,.mw-symbol-flag[data-active=true]{opacity:1}
      .mw-symbol-flag[data-empty=true][data-active=true]{color:#f23645}
      .mw-symbol-flag:hover{background:#787b861c}
      .mw-symbol-flag:active{background:#787b8630}
      .mw-symbol-flag:focus-visible,.mw-flag-palette button:focus-visible{outline:2px solid #2962ff;outline-offset:2px}
      .mw-flag-palette{position:fixed;z-index:10000;display:flex;align-items:center;gap:3px;width:max-content;max-width:calc(100vw - 16px);min-height:32px;box-sizing:border-box;padding:4px 6px;background:#fff;color:#131722;border:1px solid #d1d4dc;border-radius:3px;box-shadow:0 4px 14px #0003;font:13px -apple-system,BlinkMacSystemFont,sans-serif}
      .theme-dark .mw-flag-palette{background:#242424;color:#eee;border-color:#4c4c4c;box-shadow:0 4px 14px #0008}
      .mw-flag-colors{display:flex;align-items:center;gap:5px}
      .mw-flag-palette button{box-sizing:border-box;display:grid;place-items:center;width:22px;height:24px;min-width:22px;min-height:24px;padding:0;border:0;border-radius:3px;background:transparent;color:inherit;cursor:pointer;touch-action:manipulation}
      .mw-flag-palette button[hidden]{display:none!important}
      .mw-flag-palette button:hover{background:#787b861c}
      .mw-flag-palette button:disabled{opacity:.5;cursor:default}
      .mw-flag-swatch-dot{width:15px;height:15px;border-radius:50%;background:var(--swatch-color);box-shadow:inset 0 0 0 1px #0002}
      .mw-flag-palette button[aria-checked=true] .mw-flag-swatch-dot{box-shadow:0 0 0 2px var(--mw-flag-palette-bg,#fff),0 0 0 3px var(--swatch-color),inset 0 0 0 1px #0002}
      .theme-dark .mw-flag-palette button[aria-checked=true] .mw-flag-swatch-dot{--mw-flag-palette-bg:#242424}
      .mw-flag-clear{font-size:0!important}
      .mw-flag-clear svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round}
      .mw-flag-status,.mw-flag-retry{display:none}
      .mw-flag-palette[data-error=true] .mw-flag-status,.mw-flag-palette[data-error=true] .mw-flag-retry{display:block}
      .mw-flag-status{max-width:240px;margin:0 4px;line-height:1.4;overflow-wrap:anywhere}
      .mw-flag-palette[data-error=true]{width:min(360px,calc(100vw - 16px));min-width:min(240px,calc(100vw - 16px));flex-wrap:wrap}
      .mw-flag-visually-hidden{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
      .mw-flag-palette>.mw-flag-visually-hidden{left:-8px;top:0;margin:0;z-index:20}
    `;
    doc.head.append(style);
    const cancelClose = () => {
      if (closeTimer) {
        doc.defaultView.clearTimeout(closeTimer);
        closeTimer = undefined;
      }
    };
    const scheduleClose = () => {
      cancelClose();
      closeTimer = doc.defaultView.setTimeout(() => {
        closeTimer = undefined;
        if (!hoveredRow && !hoveredPopup) close();
      }, 0);
    };
    const bindRow = (row) => {
      if (rowBindings.has(row)) return;
      const enter = () => {
        hoveredRow = row;
        cancelClose();
      };
      const leave = () => {
        if (hoveredRow === row) hoveredRow = null;
        scheduleClose();
      };
      row.addEventListener("pointerenter", enter);
      row.addEventListener("pointerleave", leave);
      rowBindings.set(row, { enter, leave });
    };
    const close = (focus = false) => {
      if (writing) return;
      cancelClose();
      popup?.remove();
      popup = null;
      hoveredPopup = false;
      pendingEdit = null;
      if (trigger?.isConnected) {
        trigger.dataset.active = "false";
        trigger.setAttribute("aria-expanded", "false");
        if (focus) trigger.focus();
      }
      trigger = null;
    };
    const icon =
      '<svg viewBox="0 0 16 24" aria-hidden="true"><path d="M2.5 17.5v-11h11l-3.67 5.5 3.67 5.5z"/></svg>';
    const clearIcon =
      '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>';
    const paint = () => {
      if (disposed) return;
      scheduled = false;
      for (const button of buttons)
        if (!button.isConnected) buttons.delete(button);
      for (const [row, listeners] of rowBindings)
        if (!row.isConnected) {
          row.removeEventListener("pointerenter", listeners.enter);
          row.removeEventListener("pointerleave", listeners.leave);
          rowBindings.delete(row);
          if (hoveredRow === row) hoveredRow = null;
        }
      for (const row of doc.querySelectorAll("[data-symbol-full]")) {
        bindRow(row);
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
        if (!positionedCells.has(row)) {
          positionedCells.set(row, row.style.position);
          if (doc.defaultView.getComputedStyle(row).position === "static")
            row.style.position = "relative";
        }
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
          buttons.add(button);
        }
        if (button.parentElement !== row) row.append(button);
        if (trigger === button && button.dataset.ticker !== ticker) close();
        button.dataset.ticker = ticker;
        const stored = state.get();
        const color = optimistic.has(ticker) ? optimistic.get(ticker) : stored[ticker];
        const visualColor = color || ((trigger === button && popup) && !readonly ? "red" : null);
        button.dataset.empty = String(!visualColor);
        button.dataset.active = String(trigger === button && Boolean(popup));
        button.setAttribute("aria-pressed", String(Boolean(visualColor)));
        button.style.setProperty(
          "--flag-color",
          visualColor ? colors[visualColor][1] : "#787b86",
        );
        button.style.setProperty(
          "--flag-stroke",
          visualColor ? colors[visualColor][1] : "currentColor",
        );
        button.setAttribute(
          "aria-label",
          `${ticker} · ${visualColor ? colors[visualColor][0] + "收藏" : "添加颜色收藏"}${readonly ? "（只读）" : ""}`,
        );
        button.title = visualColor ? colors[visualColor][0] + "收藏" : "添加颜色收藏";
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
      if (writing) {
        const wait = activeWrite;
        popup?.remove();
        popup = null;
        hoveredPopup = false;
        trigger = null;
        if (wait)
          wait.then(() => {
            if (!disposed && !writing) open(button);
          });
        return;
      }
      trigger = button;
      button.dataset.active = "true";
      const ticker = button.dataset.ticker,
        current = state.get()[ticker],
        selected = current || (!readonly ? "red" : null);
      popup = doc.createElement("section");
      popup.className = "mw-flag-palette";
      popup.setAttribute("role", "dialog");
      popup.setAttribute("aria-label", `${ticker} 收藏颜色`);
      const heading = doc.createElement("strong");
      heading.textContent = readonly ? "收藏颜色 · 手机只读" : "收藏颜色";
      heading.className = "mw-flag-visually-hidden";
      const group = doc.createElement("div");
      group.className = "mw-flag-colors";
      group.setAttribute("role", "radiogroup");
      group.setAttribute("aria-label", "七色收藏");
      const status = doc.createElement("p");
      status.className = "mw-flag-status";
      status.setAttribute("role", "status");
      const retry = doc.createElement("button");
      retry.className = "mw-flag-retry";
      retry.textContent = "重试保存";
      retry.hidden = true;
      async function choose(color) {
        if (readonly || writing) return;
        const palette = popup;
        const defaultWrite = defaultWrites.get(ticker);
        pendingEdit = color;
        if (color === "red" && defaultWrite) {
          // The first click already started the red write. Reuse it and release
          // the palette immediately so the next interaction is not blocked.
          optimistic.set(ticker, color);
          defaultWrite.catch(report);
          close(true);
          return;
        }
        writing = true;
        status.textContent = "正在保存…";
        retry.hidden = true;
        for (const b of popup.querySelectorAll("button")) b.disabled = true;
        try {
          let saved;
          if (color === "red" && defaultWrite) saved = await defaultWrite;
          else {
            if (defaultWrite) await defaultWrite.catch(() => null);
            activeWrite = state.set(ticker, color);
            saved = await activeWrite;
          }
          if (disposed || popup !== palette) {
            writing = false;
            if (popup !== palette) palette.remove();
            return;
          }
          if ((color === null && !saved?.[ticker]) || saved?.[ticker] === color)
            optimistic.delete(ticker);
          writing = false;
          paint();
          close(true);
        } catch (error) {
          if (disposed || popup !== palette) {
            writing = false;
            if (popup !== palette) palette.remove();
            return;
          }
          writing = false;
          status.textContent = "保存失败，修改尚未保存：" + String(error);
          palette.dataset.error = "true";
          retry.hidden = false;
          for (const b of palette.querySelectorAll("button"))
            b.disabled = false;
          report(error);
        } finally {
          // A native row refresh can replace the trigger while the request is in flight.
          // Never leave a detached palette holding the write lock.
          writing = false;
          activeWrite = undefined;
        }
      }
      for (const [color, [label, hex]] of Object.entries(colors)) {
        const option = doc.createElement("button");
        option.className = "mw-flag-swatch";
        option.type = "button";
        option.setAttribute("role", "radio");
        option.setAttribute("aria-label", label);
        option.setAttribute("aria-checked", String(selected === color));
        option.disabled = readonly;
        option.innerHTML = '<span class="mw-flag-swatch-dot" aria-hidden="true"></span>';
        option.style.setProperty("--swatch-color", hex);
        option.title = label;
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
      clear.innerHTML = clearIcon;
      clear.setAttribute("aria-label", "取消收藏");
      clear.title = "取消收藏";
      clear.disabled = readonly;
      clear.onclick = () => choose(null);
      retry.onclick = () => choose(pendingEdit);
      popup.append(heading, group, clear, status, retry, dismiss);
      dismiss.className = "mw-flag-visually-hidden";
      popup.addEventListener("pointerenter", () => {
        hoveredPopup = true;
        cancelClose();
      });
      popup.addEventListener("pointerleave", () => {
        hoveredPopup = false;
        scheduleClose();
      });
      doc.body.append(popup);
      const bounds = button.getBoundingClientRect();
      const width = popup.offsetWidth;
      const height = popup.offsetHeight;
      const gap = 4;
      popup.style.left =
        Math.max(8, Math.min(bounds.left - 4, doc.defaultView.innerWidth - width - 8)) +
        "px";
      popup.style.top =
        Math.max(
          8,
          Math.min(
            bounds.bottom + gap,
            doc.defaultView.innerHeight - height - 8,
          ),
        ) + "px";
      button.setAttribute("aria-expanded", "true");
      (readonly
        ? dismiss
        : group.querySelector("[aria-checked=true]") || group.firstElementChild
      ).focus();
      if (!current && !readonly && !optimistic.has(ticker)) {
        // Give the first click an immediate red visual state while persistence runs.
        optimistic.set(ticker, "red");
        button.dataset.empty = "false";
        button.setAttribute("aria-pressed", "true");
        button.style.setProperty("--flag-color", colors.red[1]);
        button.setAttribute("aria-label", `${ticker} · 红色收藏`);
        button.title = "红色收藏";
        const defaultWrite = state
          .set(ticker, "red");
        defaultWrites.set(ticker, defaultWrite);
        defaultWrite
          .then((saved) => {
            if (saved?.[ticker] === "red") optimistic.delete(ticker);
            if (defaultWrites.get(ticker) === defaultWrite)
              defaultWrites.delete(ticker);
            if (disposed) return;
            paint();
            if (popup && trigger === button)
              group.querySelector('[aria-label="红色"]')?.setAttribute(
                "aria-checked",
                "true",
              );
          })
          .catch((error) => {
            if (defaultWrites.get(ticker) === defaultWrite)
              defaultWrites.delete(ticker);
            report(error);
            if (!disposed && popup && trigger === button) {
              status.textContent = "保存失败，修改尚未保存：" + String(error);
              popup.dataset.error = "true";
            }
          });
      }
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
      colorFor(ticker) {
        try {
          ticker = identity(ticker);
          return optimistic.has(ticker) ? optimistic.get(ticker) : state.get()[ticker];
        } catch {
          return undefined;
        }
      },
      dispose() {
        disposed = true;
        writing = false;
        close();
        observer.disconnect();
        doc.removeEventListener("pointerdown", outside, true);
        doc.removeEventListener("keydown", keys, true);
        for (const b of buttons) b.remove();
        cancelClose();
        for (const [row, listeners] of rowBindings) {
          row.removeEventListener("pointerenter", listeners.enter);
          row.removeEventListener("pointerleave", listeners.leave);
        }
        rowBindings.clear();
        for (const [row, position] of positionedCells)
          row.style.position = position;
        positionedCells.clear();
        buttons.clear();
        style.remove();
      },
    };
  }
  return { name, colors, identity, parse, store, attach };
})();
