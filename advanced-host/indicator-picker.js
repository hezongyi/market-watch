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

function chartIndicatorPicker(chartWidget, catalog, report) {
  const slot = chartWidget.createButton({
    align: "left",
    useTradingViewStyle: false,
  });
  const doc = slot.ownerDocument;
  chartWidget.removeButton(slot);
  // Native styled button owns keyboard/overflow behavior. Never bind to a
  // placeholder's child: the header uses disabled sizing clones of that HTML.
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
      open();
    },
  });
  // Restore the four-column/rising-line silhouette from chart-menu.css on the
  // public custom button, since the built-in indicator entry is now disabled.
  const toolbarStyle = doc.createElement("style");
  toolbarStyle.textContent = ".mw-indicator-button .js-button-text{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:100%}.mw-indicator-button svg{width:28px;height:28px;display:block;flex-shrink:0}";
  doc.head.append(toolbarStyle);
  function decorateButton() {
    for (const button of doc.querySelectorAll('button[data-name="custom-tradingview-styled-button"][aria-label="指标"]')) {
      if (button.classList.contains("mw-indicator-button")) continue;
      button.classList.add("mw-indicator-button");
      (button.querySelector(".js-button-text") || button).insertAdjacentHTML("afterbegin",
        '<svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6.5 11.5 5-5 4 4 7-5"/><path d="M6.5 22.5v-4h4v-3h4v2h4v-5h4v10h-16Zm4 0v-4m4 4v-5m4 5v-5"/></svg>');
    }
  }
  const toolbarObserver = new MutationObserver(decorateButton);
  toolbarObserver.observe(doc.body, { childList: true, subtree: true });
  decorateButton();
  const entries = indicatorEntries(chartWidget, catalog);
  const dialog = doc.createElement("dialog");
  dialog.className = "mw-indicator-picker";
  dialog.setAttribute("aria-labelledby", "mw-indicator-title");
  dialog.innerHTML = `<header><h2 id="mw-indicator-title">指标</h2><button type="button" data-close aria-label="关闭指标窗口">关闭</button></header>
    <div class="mw-indicator-search"><label for="mw-indicator-query">搜索指标</label><input id="mw-indicator-query" type="search" placeholder="搜索名称或缩写，如 均线 / SMA / RSI" autocomplete="off"></div>
    <select class="mw-indicator-category" aria-label="指标分类"></select>
    <div class="mw-indicator-body"><nav aria-label="指标分类"></nav><div class="mw-indicator-results" tabindex="-1"></div></div>
    <footer><span role="status" aria-live="polite" aria-atomic="true"></span><button type="button" data-close>完成</button></footer>`;
  doc.body.append(dialog);
  const query = dialog.querySelector("input");
  const results = dialog.querySelector(".mw-indicator-results");
  const status = dialog.querySelector("[role=status]");
  const nav = dialog.querySelector("nav");
  const categorySelect = dialog.querySelector("select");
  let category = "all",
    disposed = false,
    lastFocus,
    pointerButton,
    latestAdded;
  const rememberPointer = (event) => {
    if (!dialog.open && !suspended)
      pointerButton = event.target.closest("button, [role=button]");
  };
  doc.addEventListener("pointerdown", rememberPointer, true);
  let suspended = false,
    sawNativeDialog = false;
  const categories = [
    ["all", "全部"],
    ["favorites", "收藏"],
    ["native", "内置指标"],
    ["python", "我的 Python"],
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
  }
  function close() {
    dialog.close();
    lastFocus?.focus();
  }
  function open(preserveFocus = false) {
    if (disposed) return;
    if (!preserveFocus)
      lastFocus = doc.activeElement?.matches("button, [role=button]")
        ? doc.activeElement
        : pointerButton || doc.activeElement;
    theme();
    render();
    if (!dialog.open) dialog.showModal();
    query.focus();
  }
  // Read-only observation of dialog closure; never move or modify vendor DOM.
  // The public API exposes an open event, but no corresponding close event.
  const observer = new MutationObserver(() => {
    if (!suspended || disposed) return;
    const visible = [...doc.querySelectorAll('[role="dialog"]')].some(
      (node) => node !== dialog && node.getClientRects().length,
    );
    if (visible) sawNativeDialog = true;
    else if (sawNativeDialog) {
      suspended = false;
      open(true);
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
    close();
    try {
      run();
    } catch (error) {
      suspended = false;
      open(true);
      throw error;
    }
  }
  function select(value) {
    category = value;
    results.scrollTop = 0;
    render();
  }
  for (const [value, label] of categories) {
    const node = action(label, () => select(value));
    node.dataset.category = value;
    nav.append(node);
    const option = el("option", label);
    option.value = value;
    categorySelect.append(option);
  }
  function render() {
    if (disposed) return;
    const focused = doc.activeElement?.dataset.focusKey;
    const scroll = results.scrollTop;
    for (const node of nav.children)
      node.setAttribute(
        "aria-current",
        String(node.dataset.category === category),
      );
    categorySelect.value = category;
    const nodes = [];
    if (category === "favorites") {
      const box = el("div", "", "mw-indicator-empty");
      box.append(el("p", "收藏与原生指标窗口共用，刷新及切换工作区后保留。"));
      box.append(
        action("打开原生收藏", () =>
          nativeDialog(() =>
            chartWidget.activeChart().executeActionById("insertIndicator"),
          ),
        ),
      );
      nodes.push(box);
    } else if (category === "added") {
      const chart = chartWidget.activeChart();
      const studies = chart
        .getAllStudies()
        .map((study) => {
          const api = chart.getStudyById(study.id);
          const entry = entries.find((row) => row.name === study.name);
          return {
            study,
            api,
            entry,
            label: entry?.label || study.name,
            summary: api
              .getInputValues()
              .filter((item) => typeof item.value === "number")
              .map((item) => `${item.id}=${item.value}`)
              .join(" · "),
          };
        })
        .filter(
          (row) =>
            indicatorMatches(
              [
                {
                  label: row.label,
                  name: row.study.name,
                  id: String(row.study.id),
                  aliases: row.entry?.aliases || [],
                },
              ],
              query.value,
            ).length,
        );
      for (const { study, api, label, summary } of studies) {
        const row = el("div", "", "mw-indicator-row");
        row.dataset.instanceId = study.id;
        const info = el("div", "", "mw-indicator-info");
        info.append(el("strong", label), el("small", summary || "默认参数"));
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
      for (const entry of indicatorMatches(list, query.value)) {
        const row = el("div", "", "mw-indicator-row");
        row.dataset.studyName = entry.name;
        const info = el("div", "", "mw-indicator-info");
        const title = el("div", "", "mw-indicator-title-row");
        title.append(
          el("strong", entry.label),
          el("span", entry.source, "mw-indicator-badge"),
        );
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
        const details = el("details");
        details.append(el("summary", "详情"));
        if (entry.meta?.description)
          details.append(el("p", `用途：${entry.meta.description}`));
        if (entry.meta?.calculation)
          details.append(el("p", `计算：${entry.meta.calculation}`));
        details.ontoggle = () => {
          if (!details.open || details.dataset.loaded) return;
          details.dataset.loaded = "true";
          let inputs;
          try {
            inputs = chartWidget.getStudyInputs(entry.name);
          } catch {
            inputs = [];
          }
          details.append(
            el(
              "p",
              "输入：" +
                (inputs.map((item) => item.name || item.id).join("、") || "无"),
            ),
          );
        };
        if (entry.meta)
          details.append(
            el(
              "p",
              `版本 ${entry.meta.version || "1"} · Python 计算，图表显示；遇到行情缺口重新预热。`,
            ),
          );
        info.append(details);
        const add = action(
          "添加",
          async () => {
            // Capture this chart before awaiting: never route completion to another chart.
            const chart = chartWidget.activeChart();
            const id = await chart.createStudy(entry.name, false, false);
            if (disposed) return;
            if (id === null) throw Error("指标未添加，请检查图表提示");
            latestAdded = { chart, id };
            latestSettings.hidden = false;
            status.textContent = `已添加 ${entry.label}（${entry.source}）`;
          },
          `添加 ${entry.label}（${entry.source}）`,
        );
        add.dataset.focusKey = entry.name;
        row.append(info, add);
        nodes.push(row);
      }
    }
    if (!nodes.length) {
      const box = el("div", "", "mw-indicator-empty");
      box.append(
        el(
          "p",
          category === "added" && !query.value
            ? "当前图表尚未添加指标"
            : "没有匹配的指标",
        ),
      );
      if (category !== "all")
        box.append(action("在全部指标中搜索", () => select("all")));
      box.append(
        action("清除筛选", () => {
          query.value = "";
          select("all");
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
      (replacement || results).focus();
    }
  }
  categorySelect.onchange = () => select(categorySelect.value);
  query.oninput = () => {
    results.scrollTop = 0;
    render();
  };
  dialog.querySelectorAll("[data-close]").forEach((node) => {
    node.onclick = close;
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  // Tab can otherwise leave an iframe's native dialog through browser chrome.
  const keyboard = (event) => {
    if (!dialog.open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    } else if (event.key === "Tab") {
      const targets = [
        ...dialog.querySelectorAll(
          'button, input, select, summary, [tabindex="0"]',
        ),
      ].filter((node) => !node.disabled && node.getClientRects().length);
      const first = targets[0],
        last = targets[targets.length - 1];
      const focused = doc.activeElement;
      if (event.shiftKey && (focused === first || !dialog.contains(focused))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (focused === last || !dialog.contains(focused))
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
    ["activeChartChanged", refresh],
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
    close: () => { suspended = false; sawNativeDialog = false; close(); },
    dispose() {
      disposed = true;
      observer.disconnect();
      toolbarObserver.disconnect();
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
