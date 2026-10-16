/* Small, version-pinned adaptations for the native TradingView watchlist.
 * The adapter only moves existing nodes and adds presentation wrappers. If
 * the private DOM changes, it reports and leaves the native widget untouched.
 */
(() => {
  const versionHash = "6b804c486857f27920cf761aa7eb6e29d9bb6362";
  const number = /[0-9]/;
  const moreLabel = /(更多|菜单|列|more|menu|options)/i;
  const addLabel = /(添加|加入|add|plus|\+)/i;

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
    // Native uptick/downtick markup nests the changing digits in spans.
    const existing = cell.querySelector('[data-mw-price-sup="true"]');
    const raw = cell.textContent || "";
    if (existing) {
      // Observer callbacks include our own DOM writes. Leave an unchanged
      // quote untouched so those callbacks settle instead of rewriting the
      // superscript forever and starving native rendering/subscriptions.
      if (cell.dataset.mwRawPrice === raw) return true;
      // A native text update may leave our wrapper in place. Preserve the
      // current visible quote, including its last digit, rather than restoring
      // the previous snapshot over the newly received price.
      existing.replaceWith(cell.ownerDocument.createTextNode(existing.textContent || ""));
    }
    let node, index = -1, lastNode;
    const walker = cell.ownerDocument.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    while ((node = walker.nextNode())) {
      const match = [...node.data].reduce((found, char, i) => number.test(char) ? i : found, -1);
      if (match >= 0) { index = match; lastNode = node; }
    }
    // The row is native markup; only wrap a known numeric tail. A missing or
    // malformed quote remains ordinary text and never blocks the watchlist.
    if (index < 0) return false;
    const target = lastNode;
    const digit = target.data[index];
    const before = target.data.slice(0, index);
    const after = target.data.slice(index + 1);
    const sup = cell.ownerDocument.createElement("sup");
    sup.dataset.mwPriceSup = "true";
    sup.setAttribute("aria-hidden", "true");
    sup.textContent = digit;
    target.replaceWith(...[
      before && cell.ownerDocument.createTextNode(before),
      sup,
      after && cell.ownerDocument.createTextNode(after),
    ].filter(Boolean));
    cell.dataset.mwRawPrice = raw;
    cell.setAttribute("aria-label", raw);
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
    if (menu.parentElement === plus.parentElement && menu.nextElementSibling === plus) return true;
    plus.parentElement?.insertBefore(menu, plus);
    menu.dataset.mwWatchlistMoved = "true";
    const svg = menu.querySelector("svg");
    if (svg) svg.style.transform = "rotate(90deg)";
    return true;
  }

  function attach(widget, report = () => {}) {
    const probe = widget?.createButton?.({align: "left", useTradingViewStyle: false});
    const doc = probe?.ownerDocument;
    if (probe) widget.removeButton(probe);
    if (!doc || !versionSupported()) {
      report(Error("watchlist DOM 版本未适配，已安全回退"));
      return {refresh() {}, dispose() {}};
    }
    let disposed = false, applying = false, pending = false;
    const refresh = () => {
      if (disposed || applying) return;
      const root = watchlistRoot(doc);
      if (!root) return;
      applying = true;
      try {
        moveMenu(root);
        const header = latestColumn(root);
        for (const row of rowCells(root)) wrapLastDigit(latestCell(row, header));
      } catch (error) { report(error); }
      finally { applying = false; }
    };
    const observer = new MutationObserver(() => {
      if (pending || applying) return;
      pending = true;
      queueMicrotask(() => { pending = false; refresh(); });
    });
    observer.observe(doc.body, {childList: true, subtree: true, characterData: true});
    refresh();
    return {refresh, dispose() {disposed = true; observer.disconnect();}};
  }

  globalThis.MWWatchlistLayout = {attach, wrapLastDigit};
})();
