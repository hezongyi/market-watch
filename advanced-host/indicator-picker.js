/* Host-owned selector. Study names/IDs remain the library's persisted identities. */
function indicatorEntries(chartWidget, catalog) {
  const labels = {
    "Moving Average": ["简单移动平均线", "SMA", "均线"],
    "Moving Average Exponential": ["指数移动平均线", "EMA", "均线"],
    "Moving Average Weighted": ["加权移动平均线", "WMA", "LWMA", "均线"],
    "Bollinger Bands": ["布林带", "BB", "BBANDS"],
    "Relative Strength Index": ["相对强弱指数", "RSI"],
    MACD: ["指数平滑异同均线", "MACD"],
    "Average True Range": ["平均真实波幅", "ATR"],
    Stochastic: ["随机指标", "STOCH"],
  };
  return chartWidget.getStudiesList().map((name) => {
    const id = name.startsWith("守望 Python ")
      ? name.slice("守望 Python ".length)
      : null;
    const meta = id && catalog[id];
    const aliases = meta?.aliases || labels[name] || [];
    return {
      name,
      id: id || name,
      label: meta?.label || aliases[0] || name,
      aliases,
      source: meta ? "Python" : "内置",
      pane: meta?.pane,
      meta,
    };
  });
}

function indicatorMatches(entries, query) {
  const q = query.trim().toLocaleLowerCase();
  const rank = (entry) => {
    const fields = [entry.label, entry.name, entry.id, ...entry.aliases].map(
      (s) => s.toLocaleLowerCase(),
    );
    return !q || fields.includes(q)
      ? 0
      : fields.some((s) => s.startsWith(q))
        ? 1
        : fields.some((s) => s.includes(q))
          ? 2
          : 3;
  };
  return entries
    .map((entry) => ({ entry, rank: rank(entry) }))
    .filter((row) => row.rank < 3)
    .sort(
      (a, b) =>
        a.rank - b.rank || a.entry.label.localeCompare(b.entry.label, "zh-CN"),
    )
    .map((row) => row.entry);
}

function chartIndicatorPicker(chartWidget, catalog, report, getNativeUi) {
  const probe = chartWidget.createButton({
    align: "left",
    useTradingViewStyle: false,
  });
  const doc = probe.ownerDocument;
  chartWidget.removeButton(probe);
  const icon =
    '<svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6.5 11.5 5-5 4 4 7-5"/><path d="M6.5 22.5v-4h4v-3h4v2h4v-5h4v10h-16Zm4 0v-4m4 4v-5m4 5v-5"/></svg>';
  const buttonId = chartWidget.createButton({
    align: "left",
    useTradingViewStyle: true,
    text: "指标",
    title: "指标",
    onClick: () => {
      if (suspended) {
        suspended = false;
        chartWidget.closePopupsAndDialogs();
      }
      void open();
    },
  });
  const toolbarStyle = doc.createElement("style");
  toolbarStyle.textContent =
    ".mw-indicator-button .js-button-text{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:100%}.mw-indicator-button svg{width:28px;height:28px;display:block;flex-shrink:0}";
  doc.head.append(toolbarStyle);
  function decorateButton() {
    for (const button of doc.querySelectorAll(
      'button[data-name="custom-tradingview-styled-button"][aria-label="指标"]',
    )) {
      if (button.classList.contains("mw-indicator-button")) continue;
      button.classList.add("mw-indicator-button");
      (button.querySelector(".js-button-text") || button).insertAdjacentHTML(
        "afterbegin",
        icon,
      );
    }
  }
  const toolbarObserver = new MutationObserver(decorateButton);
  toolbarObserver.observe(doc.body, { childList: true, subtree: true });
  decorateButton();
  const entries = indicatorEntries(chartWidget, catalog),
    pendingAdds = new Set();
  const dialog = doc.createElement("div");
  dialog.className = "mw-indicator-picker";
  dialog.hidden = true;
  dialog.innerHTML = `<header class="mw-indicator-fallback-header"><h2>${icon}指标</h2><button type="button" data-close aria-label="关闭指标窗口">关闭</button></header>
    <div class="mw-indicator-search"><input type="search" aria-label="搜索指标" placeholder="搜索名称或缩写，如 均线 / SMA / RSI" autocomplete="off"></div>
    <nav class="mw-indicator-tabs" aria-label="指标分类"></nav>
    <div class="mw-indicator-heading"><span>指标名称</span><span data-heading-actions>操作</span></div>
    <div class="mw-indicator-body"><div class="mw-indicator-results" tabindex="-1"></div><aside class="mw-indicator-detail" aria-labelledby="mw-indicator-detail-title" tabindex="-1" hidden></aside></div>
    <footer><span role="status" aria-live="polite" aria-atomic="true">选择指标添加到当前图表。</span><button type="button" data-close>完成</button></footer>`;
  doc.body.append(dialog);
  const search = dialog.querySelector(".mw-indicator-search"),
    results = dialog.querySelector(".mw-indicator-results"),
    status = dialog.querySelector("[role=status]"),
    nav = dialog.querySelector("nav"),
    detailPanel = dialog.querySelector("aside");
  const fallbackInput = search.querySelector("input");
  let query = fallbackInput,
    searchText = "";
  let category = "all",
    disposed = false,
    lastFocus,
    pointerButton,
    latestAdded,
    detail,
    detailFocus;
  let suspended = false,
    sawNativeDialog = false,
    opening = false,
    generation = 0,
    ui,
    nativeExtension,
    nativeRoot,
    nativeMount,
    searchControl,
    fallback;
  const categories = [
    ["all", "全部"],
    ["native", "内置指标"],
    ["python", "我的 Python"],
    ["favorites", "收藏"],
    ["added", "当前图表已添加"],
  ];
  const el = (tag, text, className) => {
    const node = doc.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const action = (text, run, label) => {
    const node = el("button", text);
    node.type = "button";
    if (label) node.setAttribute("aria-label", label);
    node.onclick = async () => {
      if (node.disabled) return;
      node.disabled = true;
      try {
        await run();
      } catch (error) {
        status.textContent = String(error);
        report(error);
      } finally {
        node.disabled = false;
      }
    };
    return node;
  };
  const latestSettings = action("设置刚添加的指标", () => {
    if (!latestAdded) return;
    const { chart, id } = latestAdded;
    if (!chart.getAllStudies().some((study) => study.id === id)) {
      latestAdded = undefined;
      latestSettings.hidden = true;
      status.textContent = "该指标已移除";
      return;
    }
    nativeDialog(() => chart.showPropertiesDialog(id));
  });
  latestSettings.hidden = true;
  dialog.querySelector("footer [data-close]").before(latestSettings);
  function theme() {
    dialog.dataset.theme = chartWidget.getTheme().toLowerCase();
    if (fallback) fallback.dataset.theme = dialog.dataset.theme;
  }
  const rememberPointer = (event) => {
    if (!dialog.open && !suspended)
      pointerButton = event.target.closest("button,[role=button]");
  };
  doc.addEventListener("pointerdown", rememberPointer, true);
  function close(restore = true) {
    nativeExtension?.close();
    ++generation;
    opening = false;
    dialog.open = false;
    dialog.hidden = true;
    dialog.remove();
    nativeRoot?.unmount();
    nativeRoot = null;
    nativeMount?.remove();
    nativeMount = null;
    fallback?.close();
    fallback?.remove();
    fallback = null;
    doc.body.append(dialog);
    if (restore)
      doc.defaultView.requestAnimationFrame(() => {
        if (!dialog.open && !opening) lastFocus?.focus();
      });
  }
  function searchProps() {
    return {
      value: searchText,
      placeholder: "搜索名称或缩写，如 均线 / SMA / RSI",
      "aria-label": "搜索指标",
      reference: (node) => {
        query = node || fallbackInput;
      },
      onChange: (event) => {
        searchText = event.target.value;
        searchControl?.update(searchProps());
        results.scrollTop = 0;
        hideDetail(false);
        render();
      },
    };
  }
  async function open(preserveFocus = false) {
    if (disposed) return;
    if (dialog.open) {
      query.focus();
      return;
    }
    if (opening) return;
    if (!preserveFocus)
      lastFocus = doc.activeElement?.matches("button,[role=button]")
        ? doc.activeElement
        : pointerButton || doc.activeElement;
    const activeGeneration = ++generation;
    opening = true;
    theme();
    try {
      const adapter =
        getNativeUi?.() ||
        (typeof chartNativeUi === "function"
          ? chartNativeUi(chartWidget, doc)
          : null);
      if (!adapter) throw Error("原生界面加载器不可用");
      ui = await adapter.load();
      if (disposed || activeGeneration !== generation) return;
      if (ui.openIndicators) {
        nativeExtension = await ui.openIndicators({entries,icon,report,isCurrent:()=>!disposed && activeGeneration === generation});
        opening = false;
        return;
      }
      if (!searchControl) {
        fallbackInput.remove();
        searchControl = ui.mount("search", search, searchProps());
      }
      const R = ui.react;
      nativeMount = doc.createElement("div");
      doc.body.append(nativeMount);
      dialog.classList.add("is-native");
      dialog.open = true;
      dialog.hidden = false;
      opening = false;
      render();
      nativeRoot = ui.createRoot(
        R.createElement(ui.components.dialog, {
          isOpened: true,
          title: R.createElement(
            "span",
            { className: "mw-indicator-dialog-title" },
            R.createElement("span", {
              dangerouslySetInnerHTML: { __html: icon },
            }),
            "指标",
          ),
          dataName: "mw-indicator-dialog",
          dataDialogName: "指标",
          containerAriaLabel: "指标",
          closeAriaLabel: "关闭指标窗口",
          className: "mw-indicator-native",
          wrapperClassName: "mw-indicator-wrapper",
          draggable: true,
          showSeparator: true,
          shouldReturnFocus: false,
          onClose: () => close(),
          onKeyDown: (event) => {
            if (event.key === "Escape" && !event.defaultPrevented) {
              event.preventDefault();
              detail ? hideDetail() : close();
            }
          },
          render: () =>
            R.createElement("div", {
              className: "mw-indicator-content",
              ref: (node) => {
                if (node) {
                  node.append(dialog);
                  doc.defaultView.requestAnimationFrame(() => query.focus());
                }
              },
            }),
        }),
        nativeMount,
      );
    } catch (error) {
      if (disposed || activeGeneration !== generation) return;
      if (nativeRoot) {
        close(false);
        return;
      }
      // A resource/version mismatch keeps the complete picker usable.
      searchControl?.dispose();
      searchControl = null;
      query = fallbackInput;
      search.replaceChildren(fallbackInput);
      fallbackInput.value = searchText;
      dialog.classList.remove("is-native");
      fallback = doc.createElement("dialog");
      fallback.className = "mw-indicator-fallback";
      fallback.setAttribute("aria-label", "指标");
      fallback.dataset.theme = dialog.dataset.theme;
      fallback.addEventListener("cancel", (event) => {
        event.preventDefault();
        detail ? hideDetail() : close();
      });
      doc.body.append(fallback);
      fallback.append(dialog);
      dialog.open = true;
      dialog.hidden = false;
      opening = false;
      render();
      fallback.showModal();
      query.focus();
    }
  }
  const observer = new MutationObserver(() => {
    if (!suspended || disposed) return;
    const visible = [...doc.querySelectorAll('[role="dialog"]')].some(
      (node) => node.getClientRects().length,
    );
    if (visible) sawNativeDialog = true;
    else if (sawNativeDialog) {
      suspended = false;
      void open(true);
    }
  });
  observer.observe(doc.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden"],
  });
  function nativeDialog(run) {
    suspended = true;
    sawNativeDialog = false;
    close(false);
    try {
      run();
    } catch (error) {
      suspended = false;
      void open(true);
      throw error;
    }
  }
  function hideDetail(restore = true) {
    detail = null;
    detailPanel.hidden = true;
    for (const row of results.children) row.removeAttribute("data-selected-detail");
    dialog.classList.remove("has-detail");
    results.inert = false;
    if (restore) {
      const key = detailFocus?.dataset.focusKey;
      const trigger = detailFocus?.isConnected
        ? detailFocus
        : [...results.querySelectorAll("[data-focus-key]")].find(
            (node) => node.dataset.focusKey === key,
          );
      trigger?.focus({ preventScroll: true });
    }
  }
  function select(value) {
    category = value;
    results.scrollTop = 0;
    hideDetail(false);
    render();
  }
  for (const [value, label] of categories) {
    const node = action(label, () => select(value));
    node.dataset.category = value;
    nav.append(node);
  }
  async function addEntry(entry) {
    if (pendingAdds.has(entry.name)) return;
    const chart = chartWidget.activeChart();
    pendingAdds.add(entry.name);
    render();
    if (detail?.entry.name === entry.name) renderDetail();
    try {
      const id = await chart.createStudy(entry.name, false, false);
      if (disposed) return;
      if (id === null) throw Error("指标未添加，请检查图表提示");
      latestAdded = { chart, id };
      latestSettings.hidden = false;
      status.textContent = `已添加 ${entry.label}（${entry.source}）`;
    } finally {
      pendingAdds.delete(entry.name);
      if (!disposed) {
        render();
        if (detail?.entry.name === entry.name) renderDetail();
      }
    }
  }
  function addButton(entry) {
    const adding = pendingAdds.has(entry.name),
      node = action(
        adding ? "正在添加…" : "添加",
        () => addEntry(entry),
        `添加 ${entry.label}（${entry.source}）`,
      );
    node.disabled = adding;
    node.setAttribute("aria-busy", String(adding));
    node.dataset.focusKey = entry.name + ":add";
    return node;
  }
  function showDetail(entry, trigger) {
    detail = { entry };
    for (const row of results.children) row.toggleAttribute("data-selected-detail", row.dataset.studyName === entry.name);
    detailFocus = trigger;
    dialog.classList.add("has-detail");
    renderDetail();
    fitDetail();
    detailPanel.focus({ preventScroll: true });
  }
  function fitDetail() {
    const active = doc.activeElement;
    results.inert = !!detail && dialog.clientWidth < 850;
    dialog.classList.toggle("detail-full", results.inert);
    if (results.inert && results.contains(active))
      detailPanel.focus({ preventScroll: true });
  }
  const resize = new ResizeObserver(fitDetail);
  resize.observe(dialog);
  function renderDetail() {
    if (!detail) return;
    const focused = detailPanel.contains(doc.activeElement),
      key = doc.activeElement?.dataset.focusKey;
    const { entry } = detail;
    detailPanel.hidden = false;
    detailPanel.replaceChildren();
    const heading = el("div", "", "mw-indicator-detail-header"),
      title = el("h3", entry.label);
    title.id = "mw-indicator-detail-title";
    heading.append(
      title,
      action("返回列表", () => hideDetail(), "关闭指标详情"),
    );
    detailPanel.append(heading);
    const body = el("div", "", "mw-indicator-detail-body");
    body.append(
      el(
        "p",
        `${entry.source}${entry.pane ? " · " + (entry.pane === "main" ? "主图" : "副图") : ""} · ${entry.source === "Python" ? entry.id : entry.name}`,
      ),
    );
    if (entry.meta?.description)
      body.append(el("p", `用途：${entry.meta.description}`));
    if (entry.meta?.calculation)
      body.append(el("p", `计算：${entry.meta.calculation}`));
    let inputs = [];
    try {
      inputs = chartWidget.getStudyInputs(entry.name);
    } catch {}
    const table = el("dl", "", "mw-indicator-inputs");
    for (const input of inputs) {
      const item = el("div");
      item.append(
        el("dt", input.localizedName || input.name || input.id),
        el(
          "dd",
          String(
            input.defval ??
              input.defaultValue ??
              entry.meta?.params?.[input.id] ??
              "添加后设置",
          ),
        ),
      );
      table.append(item);
    }
    body.append(
      el("h4", entry.meta ? "默认输入" : "输入参数"),
      inputs.length ? table : el("p", "此指标没有可配置输入。"),
    );
    if (entry.meta) body.append(el("p", `版本 ${entry.meta.version || "1"}`));
    body.append(addButton(entry));
    detailPanel.append(body);
    if (focused) {
      const target = [...detailPanel.querySelectorAll("[data-focus-key]")].find(
        (node) => node.dataset.focusKey === key && !node.disabled,
      );
      (target || detailPanel).focus({ preventScroll: true });
    }
  }
  function render() {
    if (disposed) return;
    const focused = doc.activeElement?.dataset.focusKey,
      scroll = results.scrollTop;
    for (const node of nav.children) {
      const active = node.dataset.category === category;
      node.setAttribute("aria-current", String(active));
      node.setAttribute("aria-pressed", String(active));
    }
    dialog.querySelector("[data-heading-actions]").textContent =
      category === "added" ? "设置与管理" : "操作";
    const nodes = [];
    if (category === "favorites") {
      const box = el("div", "", "mw-indicator-empty");
      box.append(
        el("p", "收藏与原生指标窗口共用，刷新及切换工作区后保留。"),
        action("打开原生收藏", () =>
          nativeDialog(() =>
            chartWidget.activeChart().executeActionById("insertIndicator"),
          ),
        ),
      );
      nodes.push(box);
    } else if (category === "added") {
      const chart = chartWidget.activeChart();
      for (const study of chart.getAllStudies()) {
        const api = chart.getStudyById(study.id),
          entry = entries.find((row) => row.name === study.name),
          label = entry?.label || study.name;
        if (
          !indicatorMatches(
            [
              {
                label,
                name: study.name,
                id: String(study.id),
                aliases: entry?.aliases || [],
              },
            ],
            searchText,
          ).length
        )
          continue;
        const row = el("div", "", "mw-indicator-row");
        row.dataset.instanceId = study.id;
        const summary = api
          .getInputValues()
          .filter((item) => typeof item.value === "number")
          .map((item) => `${item.id}=${item.value}`)
          .join(" · ");
        const info = el("div", "", "mw-indicator-info");
        const title = el("div", "", "mw-indicator-title-row");
        title.append(el("strong", label));
        if (entry) title.append(el("span", entry.source, "mw-indicator-badge"));
        info.append(title, el("small", summary || "默认参数"));
        const controls = el("div", "", "mw-indicator-actions");
        for (const [name, run] of [
          [
            "设置",
            () => nativeDialog(() => chart.showPropertiesDialog(study.id)),
          ],
          [
            api.isVisible() ? "隐藏" : "显示",
            () => {
              api.setVisible(!api.isVisible());
              render();
            },
          ],
          [
            "移除",
            () => {
              chart.removeEntity(study.id);
              render();
            },
          ],
        ]) {
          const control = action(name, run, `${name} ${label}`);
          control.dataset.focusKey = `${study.id}:${name}`;
          controls.append(control);
        }
        row.append(info, controls);
        nodes.push(row);
      }
    } else {
      const list = entries.filter(
        (row) =>
          category === "all" ||
          (category === "python"
            ? row.source === "Python"
            : row.source === "内置"),
      );
      for (const entry of indicatorMatches(list, searchText)) {
        const row = el("div", "", "mw-indicator-row");
        row.dataset.studyName = entry.name;
        row.toggleAttribute("data-selected-detail", detail?.entry.name === entry.name);
        const info = el("div", "", "mw-indicator-info"),
          title = el("div", "", "mw-indicator-title-row"),
          name = action(entry.label, () => showDetail(entry, name));
        name.className = "mw-indicator-name";
        name.dataset.focusKey = entry.name + ":detail";
        title.append(name, el("span", entry.source, "mw-indicator-badge"));
        if (entry.pane)
          title.append(
            el(
              "span",
              entry.pane === "main" ? "主图" : "副图",
              "mw-indicator-badge",
            ),
          );
        info.append(
          title,
          el("small", entry.source === "Python" ? entry.id : entry.name),
        );
        const controls = el("div", "", "mw-indicator-actions"),
          details = action(
            "详情",
            () => showDetail(entry, details),
            `查看 ${entry.label}（${entry.source}）详情`,
          );
        details.dataset.focusKey = entry.name + ":details";
        controls.append(details, addButton(entry));
        row.append(info, controls);
        nodes.push(row);
      }
    }
    if (!nodes.length) {
      const box = el("div", "", "mw-indicator-empty");
      box.append(
        el(
          "p",
          category === "added" && !searchText
            ? "当前图表尚未添加指标"
            : "没有匹配的指标",
        ),
      );
      if (category !== "all")
        box.append(action("在全部指标中搜索", () => select("all")));
      box.append(
        action("清除筛选", () => {
          searchText = "";
          fallbackInput.value = "";
          searchControl?.update(searchProps());
          select("all");
          query.focus();
        }),
      );
      nodes.push(box);
    }
    results.replaceChildren(...nodes);
    results.scrollTop = scroll;
    if (focused) {
      const replacement = [
        ...results.querySelectorAll("[data-focus-key]"),
      ].find((node) => node.dataset.focusKey === focused);
      (replacement || results).focus({ preventScroll: true });
    }
  }
  fallbackInput.oninput = () => {
    searchText = fallbackInput.value;
    results.scrollTop = 0;
    hideDetail(false);
    render();
  };
  dialog
    .querySelectorAll("[data-close]")
    .forEach((node) => (node.onclick = () => close()));
  const keyboard = (event) => {
    if (!dialog.open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      detail ? hideDetail() : close();
    } else if (event.key === "Tab") {
      const scope =
        detail && results.inert
          ? detailPanel
          : doc.querySelector('[data-name="mw-indicator-dialog"]') ||
            fallback ||
            dialog;
      const targets = [
        ...scope.querySelectorAll('button,input,[tabindex="0"]'),
      ].filter(
        (node) =>
          !node.disabled &&
          !node.closest("[inert]") &&
          node.getClientRects().length,
      );
      const first = targets[0],
        last = targets.at(-1),
        focused = doc.activeElement;
      if (
        event.shiftKey &&
        (focused === first || !scope.contains(focused) || focused === scope)
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (focused === last || !scope.contains(focused) || focused === scope)
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        first?.focus();
      }
    }
  };
  doc.addEventListener("keydown", keyboard, true);
  const refresh = () => {
    if (dialog.open && category === "added") render();
  };
  const bindings = [
    [
      "activeChartChanged",
      () => {
        hideDetail(false);
        refresh();
      },
    ],
    ["layout_changed", refresh],
    ["chart_loaded", refresh],
    ["study_event", refresh],
    ["study_properties_changed", refresh],
    ["chart_theme_changed", theme],
  ];
  for (const [event, callback] of bindings)
    chartWidget.subscribe(event, callback);
  return {
    open,
    close: () => {
      suspended = false;
      sawNativeDialog = false;
      close();
    },
    dispose() {
      disposed = true;
      close(false);
      observer.disconnect();
      toolbarObserver.disconnect();
      resize.disconnect();
      searchControl?.dispose();
      nativeExtension?.dispose();
      toolbarStyle.remove();
      dialog.remove();
      doc.removeEventListener("keydown", keyboard, true);
      doc.removeEventListener("pointerdown", rememberPointer, true);
      chartWidget.removeButton(buttonId);
      for (const [event, callback] of bindings)
        chartWidget.unsubscribe(event, callback);
    },
  };
}
