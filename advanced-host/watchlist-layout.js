/* Small, version-pinned adaptations for the native TradingView watchlist.
 * The adapter only moves existing nodes and adds presentation wrappers. If
 * the private DOM changes, it reports and leaves the native widget untouched.
 */
(() => {
  const versionHash = "6b804c486857f27920cf761aa7eb6e29d9bb6362";
  const moreLabel = /(更多|菜单|列|more|menu|options)/i;
  const addLabel = /(添加|加入|add|plus|\+)/i;
  const internalName = /^(?:MW[CPH]:|(?:DUKA|YAHOO|NATIVE|MD|OANDA|BINANCE):)|^[a-f0-9]{32,64}$|^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

  function versionSupported() {
    try {
      return String(globalThis.TradingView?.version?.()).includes(versionHash);
    } catch (_) {
      return false;
    }
  }

  function text(button) {
    return `${button.getAttribute("aria-label") || ""} ${button.title || ""} ${button.textContent || ""}`;
  }

  function watchlistRoot(doc) {
    return doc.querySelector('[data-test-id-widget-type="watchlist"]') ||
      doc.querySelector('[data-name="watchlist"]') ||
      [...doc.querySelectorAll('[data-test-id-widget-type]')].find(node =>
        /watchlist/i.test(node.getAttribute("data-test-id-widget-type") || "")) ||
      [...doc.querySelectorAll('.widgetbar-widgetbody')].find(node =>
        node.querySelector('[data-symbol-full],button[data-column-type="short_name"]'));
  }

  function rowForHeader(header) {
    return header?.closest('[role="row"],tr,[class*="header"], [class*="Header"]') || header?.parentElement;
  }

  function latestColumn(root) {
    const headers = [...root.querySelectorAll('button[data-column-type], [role="columnheader"]')];
    return headers.find(header => /最新价|最新价格|last|close|price/i.test(text(header)) ||
      /^(last|close|lp)$/i.test(header.dataset.columnType || ""));
  }

  function rowCells(root) {
    return [...root.querySelectorAll('[data-symbol-full]')];
  }

  function releaseHumanName(row, getName) {
    const name = row.querySelector('[class*="symbolNameText-"]');
    if (!name) return;
    const value = (name.textContent || "").trim();
    // Every source/type shares this guard. These are routing identities, never
    // display codes, even after native marks a row "resolved" or shows a price.
    const ready = !!value && !internalName.test(value);
    const known = String(getName(row.dataset.symbolFull) || "").trim();
    // Metadata belongs to this exact routing identity, and is already present
    // at startup. Paint its real name without waiting for the first quote or
    // replacing native React text. Reused rows must discard the old overlay.
    if (!ready && known && !internalName.test(known)) {
      if (name.dataset.mwDisplayName !== known) name.dataset.mwDisplayName = known;
    } else if (name.hasAttribute("data-mw-display-name")) delete name.dataset.mwDisplayName;
    if (ready !== (row.dataset.mwNameReady === "true")) {
      if (ready) row.dataset.mwNameReady = "true";
      else delete row.dataset.mwNameReady;
    }
  }

  function latestCell(row, header) {
    const type = header?.dataset.columnType;
    if (type) {
      const exact = [...row.querySelectorAll("[data-column-type]")]
        .find(node => node.dataset.columnType === type);
      if (exact) return exact;

      // TradingView's current rows identify value columns with private,
      // version-pinned class tokens rather than data attributes. Prefer the
      // semantic token so the first indicator cell is never mistaken for the
      // latest-price cell when the header and row structures differ.
      const cells = [...row.querySelectorAll('[class*="cell"]')]
        .filter(node => node.closest("[data-symbol-full]") === row);
      const classFor = {
        last_price: /(?:^|\s)last-[^\s]*(?:\s|$)/,
        change: /(?:^|\s)change-[^\s]*(?:\s|$)/,
        change_percent: /(?:^|\s)changeInPercent[^\s]*(?:\s|$)/,
      }[type];
      if (classFor) {
        const semantic = cells.find(node => {
          const classes = ` ${node.className || ""} `;
          if (!classFor.test(classes)) return false;
          if (type === "last_price" && /changeInPercent/.test(classes)) return false;
          if (type === "change" && /changeInPercent/.test(classes)) return false;
          return true;
        });
        if (semantic) return semantic;
      }
    }
    const headers = header ? [...header.parentElement.querySelectorAll('button[data-column-type], [role="columnheader"]')] : [];
    const index = headers.indexOf(header);
    const cells = [...row.children];
    return index >= 0 ? cells[index] : null;
  }

  function wrapLastDigit(cell) {
    if (!cell) return false;
    // Keep every native Text node intact: React may retain and update it.
    // A CSS glyph overlay raises the last digit without splitting/replacing
    // native text or adding duplicated characters to copy/sort/reader text.
    const raw = cell.textContent || "";
    let node, index = -1, lastNode;
    const walker = cell.ownerDocument.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    while ((node = walker.nextNode())) {
      const matches = [...node.data.matchAll(/[0-9]/g)];
      if (matches.length) { index = matches.at(-1).index; lastNode = node; }
    }
    if (index < 0) {
      if (cell.hasAttribute("data-mw-price-digit")) {
        delete cell.dataset.mwPriceDigit;
        delete cell.dataset.mwRawPrice;
        cell.removeAttribute("aria-label");
      }
      return false;
    }
    const range = cell.ownerDocument.createRange();
    range.setStart(lastNode, index); range.setEnd(lastNode, index + 1);
    const glyph = range.getBoundingClientRect(), bounds = cell.getBoundingClientRect();
    if (!glyph.width || !glyph.height) return false;
    const view = cell.ownerDocument.defaultView;
    const style = view.getComputedStyle(lastNode.parentElement);
    // Composite translucent native row/flash backgrounds over their ancestors
    // so the overlay fully covers the baseline glyph, including selected rows.
    let alpha = 0, rgb = [0, 0, 0];
    for (let at = lastNode.parentElement; at && alpha < 1; at = at.parentElement) {
      const color = view.getComputedStyle(at).backgroundColor.match(/[\d.]+/g)?.map(Number);
      if (!color || color.length < 3) continue;
      const layer = (1 - alpha) * (color[3] ?? 1);
      rgb = rgb.map((value, i) => value + color[i] * layer);
      alpha += layer;
    }
    rgb = rgb.map(value => Math.round(value + 255 * (1 - alpha)));
    const values = {
      "--mw-digit-left": `${glyph.left - bounds.left - cell.clientLeft}px`,
      "--mw-digit-top": `${glyph.top - bounds.top - cell.clientTop}px`,
      "--mw-digit-width": `${glyph.width}px`,
      "--mw-digit-height": `${glyph.height}px`,
      "--mw-digit-color": style.color,
      "--mw-digit-background": `rgb(${rgb.join(",")})`,
      "--mw-digit-size": `${parseFloat(style.fontSize) * 0.7}px`,
    };
    for (const [key, value] of Object.entries(values))
      if (cell.style.getPropertyValue(key) !== value) cell.style.setProperty(key, value);
    if (cell.dataset.mwPriceDigit !== lastNode.data[index]) cell.dataset.mwPriceDigit = lastNode.data[index];
    if (cell.dataset.mwRawPrice !== raw) cell.dataset.mwRawPrice = raw;
    if (cell.getAttribute("aria-label") !== raw) cell.setAttribute("aria-label", raw);
    return true;
  }

  function moveMenu(root) {
    const plus = [...root.querySelectorAll("button")].find(button => {
      const value = text(button);
      return !button.disabled && addLabel.test(value) && !moreLabel.test(value);
    });
    if (!plus) return false;
    const header = root.querySelector('button[data-column-type="short_name"]');
    const headerRow = rowForHeader(header);
    const menu = [...(headerRow?.querySelectorAll("button") || []),
      ...root.querySelectorAll('button[class*="columnsMenu"],[data-name*="watchlist"][data-name*="menu"],button[aria-label*="更多"]')].find(button => {
      if (button.matches('button[class*="columnsMenu"],button[data-name*="columns-menu"]')) return true;
      if (button === header || button === plus || button.disabled) return false;
      const value = text(button);
      return moreLabel.test(value) || button.querySelector('svg path[d*="M"]');
    });
    if (!menu || menu === plus) return false;
    // The column header and list toolbar have separate native React roots.
    // Reparenting this button breaks React's delegated menu handler. Keep the
    // native tree intact and move only its visual box beside the + control.
    const body = menu.closest(".widgetbar-widgetbody");
    if (body) {
      // The native body uses strict containment, making fixed coordinates
      // relative to the list and clipping anything above its column header.
      // Retain size/style isolation while allowing this native control to
      // paint in the widget toolbar.
      body.style.contain = "size style";
      body.style.overflow = "visible";
    }
    const anchor = plus.getBoundingClientRect();
    Object.assign(menu.style, {
      position: "fixed", left: `${anchor.left - 32}px`, top: `${anchor.top}px`,
      width: "28px", height: `${anchor.height}px`, margin: "0", zIndex: "10",
    });
    menu.dataset.mwWatchlistMoved = "true";
    if (!menu.getAttribute("aria-label")) menu.setAttribute("aria-label", "自选列表列设置");
    const svg = menu.querySelector("svg");
    if (svg) svg.style.transform = "rotate(90deg)";
    return true;
  }

  function attach(widget, report = () => {}, getName = () => undefined) {
    const probe = widget?.createButton?.({align: "left", useTradingViewStyle: false});
    const doc = probe?.ownerDocument;
    if (probe) widget.removeButton(probe);
    if (!doc || !versionSupported()) {
      // The startup CSS gate applies before attach. Release it explicitly on
      // an unsupported library rather than leaving genuine names loading.
      if (doc) doc.documentElement.dataset.mwWatchlistFallback = "true";
      report(Error("watchlist DOM 版本未适配，已安全回退"));
      return {refresh() {}, dispose() {}};
    }
    delete doc.documentElement.dataset.mwWatchlistFallback;
    let disposed = false, applying = false, pending = false;
    const refresh = () => {
      if (disposed || applying) return;
      const root = watchlistRoot(doc);
      if (!root) return;
      applying = true;
      try {
        moveMenu(root);
        const header = latestColumn(root);
        for (const row of rowCells(root)) {
          releaseHumanName(row, getName);
          wrapLastDigit(latestCell(row, header));
        }
      } catch (error) { report(error); }
      finally { applying = false; }
    };
    const observer = new MutationObserver(() => {
      if (pending || applying) return;
      pending = true;
      queueMicrotask(() => { pending = false; refresh(); });
    });
    observer.observe(doc.documentElement, {childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ["data-symbol-full", "data-symbol-short", "data-active", "class"]});
    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(refresh) : null;
    resizeObserver?.observe(doc.documentElement);
    const root = watchlistRoot(doc);
    if (root) resizeObserver?.observe(root);
    doc.defaultView?.addEventListener("resize", refresh);
    // Native hover backgrounds change without a DOM mutation.
    doc.addEventListener("pointerover", refresh, true);
    doc.addEventListener("pointerout", refresh, true);
    refresh();
    return {refresh, dispose() {
      disposed = true; observer.disconnect(); resizeObserver?.disconnect();
      doc.documentElement.dataset.mwWatchlistFallback = "true";
      for (const cell of doc.querySelectorAll("[data-mw-price-digit]")) delete cell.dataset.mwPriceDigit;
      doc.defaultView?.removeEventListener("resize", refresh);
      doc.removeEventListener("pointerover", refresh, true);
      doc.removeEventListener("pointerout", refresh, true);
    }};
  }

  globalThis.MWWatchlistLayout = {attach, wrapLastDigit};
})();
