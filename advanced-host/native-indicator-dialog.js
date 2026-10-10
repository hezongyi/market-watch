/* Version-pinned extension of the installed native indicator controller.
 * Licensed factories and native study/favorite identities remain untouched. */
function chartNativeIndicators(widget, doc, req, ui) {
  const R = ui.react,
    moduleId = 217583,
    events = new EventTarget();
  const state = {
    category: "all",
    query: "",
    entries: [],
    names: new Map(),
    pending: new Set(),
    latest: null,
    controller: null,
    notice: "",
    report: () => {},
    lastFocus: null,
  };
  const Context = R.createContext(null);
  const propertyObservers = new Set();
  const categories = [
    ["all", "全部指标"],
    ["favorites", "收藏"],
    ["native", "内置指标"],
    ["python", "我的 Python"],
    ["added", "当前图表已添加"],
  ];
  const notify = () => events.dispatchEvent(new Event("change"));
  function entryFor(row) {
    const name = state.names.get(row.studyData?.id || row.id);
    return (
      state.entries.find(
        (entry) =>
          entry.name === name ||
          entry.label === name ||
          entry.name === row.title ||
          entry.label === row.title ||
          (row.title.startsWith("守望 Python ") &&
            entry.id === row.title.slice("守望 Python ".length)),
      ) || null
    );
  }
  function annotate(row) {
    const entry = entryFor(row);
    return {
      ...row,
      tags: [
        ...(row.tags || []),
        ...(entry ? [entry.name, entry.label, entry.id, ...entry.aliases] : []),
      ],
    };
  }
  function Row({ Native, ...props }) {
    const ctx = R.useContext(Context),
      entry = entryFor(props.item),
      pending = state.pending.has(props.item.id);
    return R.createElement(
      "div",
      {
        className: "mw-native-study-row",
        "data-study-name": entry?.name,
        "data-native-study-id": props.item.id,
        "aria-busy": pending,
        "data-selected-detail": ctx.detail?.id === props.item.id || undefined,
      },
      R.createElement(
        "div",
        { className: "mw-native-study-main" },
        R.createElement(Native, {
          ...props,
          onClick: pending ? () => {} : props.onClick,
        }),
      ),
      R.createElement(
        "small",
        { className: "mw-native-study-meta" },
        `${entry?.source || "内置"}${entry?.pane ? " · " + (entry.pane === "main" ? "主图" : "副图") : ""}${pending ? " · 正在添加…" : ""}`,
      ),
      R.createElement(
        "button",
        {
          type: "button",
          className: "mw-native-study-details",
          onClick: (event) => {
            event.stopPropagation();
            ctx.showDetail(props.item, event.currentTarget);
          },
          "aria-label": `查看 ${entry?.label || props.item.title}详情`,
        },
        "详情",
      ),
    );
  }
  function View({ Native, ...props }) {
    const [, refresh] = R.useReducer((n) => n + 1, 0),
      [detail, setDetail] = R.useState(null);
    const trigger = R.useRef(null),
      [revision, update] = R.useReducer((n) => n + 1, 0);
    R.useEffect(() => {
      const handler = () => refresh();
      events.addEventListener("change", handler);
      return () => events.removeEventListener("change", handler);
    }, []);
    const closeDetail = () => {
      setDetail(null);
      requestAnimationFrame(() => {
        if (trigger.current?.isConnected)
          trigger.current.focus({ preventScroll: true });
      });
    };
    const ctx = {
      empty:
        state.ready &&
        !props.data.filter((row) =>
          state.category === "favorites"
            ? row.isFavorite
            : state.category === "python"
              ? entryFor(row)?.source === "Python"
              : state.category === "native"
                ? entryFor(row)?.source !== "Python"
                : true,
        ).length,
      detail,
      closeDetail,
      revision,
      update,
      showDetail: (row, node) => {
        trigger.current = node;
        setDetail(row);
      },
      select: (category) => {
        state.category = category;
        setDetail(null);
        notify();
      },
    };
    const data = props.data
      .filter((row) =>
        state.category === "favorites"
          ? row.isFavorite
          : state.category === "python"
            ? entryFor(row)?.source === "Python"
            : state.category === "native"
              ? entryFor(row)?.source !== "Python"
              : state.category !== "added",
      )
      .map(annotate);
    return R.createElement(
      Context.Provider,
      { value: ctx },
      R.createElement(Native, { ...props, data }),
    );
  }
  function Added() {
    const ctx = R.useContext(Context),
      chart = widget.activeChart();
    const [busy, setBusy] = R.useState(null);
    const studies = chart.getAllStudies().filter((study) => {
      const entry = state.entries.find((entry) => entry.name === study.name);
      return indicatorMatches(
        [
          entry || {
            name: study.name,
            label: study.name,
            id: String(study.id),
            aliases: [],
          },
        ],
        state.query,
      ).length;
    });
    async function act(id, label, run) {
      if (busy) return;
      setBusy(id + label);
      try {
        await run();
        state.notice = "";
      } catch (error) {
        state.notice = String(error);
        state.report(error);
      } finally {
        setBusy(null);
        notify();
      }
    }
    return R.createElement(
      "div",
      { className: "mw-native-added" },
      studies.length
        ? studies.map((study) => {
            const entry = state.entries.find(
                (entry) => entry.name === study.name,
              ),
              api = chart.getStudyById(study.id);
            const summary = api
              .getInputValues()
              .filter((input) => typeof input.value === "number")
              .map((input) => `${input.id}=${input.value}`)
              .join(" · ");
            return R.createElement(
              "div",
              {
                key: study.id,
                className: "mw-native-added-row",
                "data-instance-id": study.id,
              },
              R.createElement(
                "div",
                null,
                R.createElement("strong", null, entry?.label || study.name),
                R.createElement(
                  "small",
                  null,
                  `${entry?.source || "内置"} · ${summary || "默认参数"}`,
                ),
              ),
              R.createElement(
                "div",
                { className: "mw-native-added-actions" },
                [
                  ["设置", () => properties(chart, study.id)],
                  [
                    api.isVisible() ? "隐藏" : "显示",
                    () => api.setVisible(!api.isVisible()),
                  ],
                  ["移除", () => chart.removeEntity(study.id)],
                ].map(([label, run]) =>
                  R.createElement(
                    "button",
                    {
                      key: label,
                      type: "button",
                      disabled: !!busy,
                      "aria-label": `${label} ${entry?.label || study.name}`,
                      onClick: (event) => {
                        const node = event.currentTarget;
                        void act(study.id, label, run).then(() =>
                          requestAnimationFrame(() => {
                            if (node.isConnected) node.focus();
                            else
                              doc
                                .querySelector(
                                  `[data-instance-id="${study.id}"] button`,
                                )
                                ?.focus();
                          }),
                        );
                      },
                    },
                    label,
                  ),
                ),
              ),
            );
          })
        : R.createElement(
            "p",
            { className: "mw-native-indicator-empty" },
            state.query ? "没有匹配的指标" : "当前图表尚未添加指标",
          ),
    );
  }
  function Detail() {
    const ctx = R.useContext(Context),
      row = ctx.detail,
      entry = entryFor(row),
      ref = R.useRef(null);
    R.useLayoutEffect(() => {
      ref.current?.focus({ preventScroll: true });
    }, [row.id]);
    let inputs = [];
    if (entry)
      try {
        inputs = widget.getStudyInputs(entry.name);
      } catch {}
    return R.createElement(
      "aside",
      {
        className: "mw-native-indicator-detail",
        tabIndex: -1,
        ref,
        "aria-label": "指标详情",
      },
      R.createElement(
        "div",
        { className: "mw-native-detail-header" },
        R.createElement("h3", null, entry?.label || row.title),
        R.createElement(
          "button",
          {
            type: "button",
            onClick: ctx.closeDetail,
            "aria-label": "关闭指标详情",
          },
          "返回列表",
        ),
      ),
      R.createElement(
        "div",
        { className: "mw-native-detail-body" },
        R.createElement(
          "p",
          null,
          `${entry?.source || "内置"}${entry?.pane ? " · " + (entry.pane === "main" ? "主图" : "副图") : ""}`,
        ),
        entry?.meta?.description &&
          R.createElement("p", null, `用途：${entry.meta.description}`),
        entry?.meta?.calculation &&
          R.createElement("p", null, `计算：${entry.meta.calculation}`),
        R.createElement("h4", null, entry?.meta ? "默认输入" : "输入参数"),
        inputs.length
          ? R.createElement(
              "dl",
              null,
              inputs.map((input) =>
                R.createElement(
                  "div",
                  { key: input.id },
                  R.createElement(
                    "dt",
                    null,
                    input.localizedName || input.name || input.id,
                  ),
                  R.createElement(
                    "dd",
                    null,
                    String(
                      input.defval ??
                        input.defaultValue ??
                        entry?.meta?.params?.[input.id] ??
                        "添加后设置",
                    ),
                  ),
                ),
              ),
            )
          : R.createElement(
              "p",
              null,
              entry
                ? "此指标没有可配置输入。"
                : "添加后可通过原生参数窗口查看和设置。",
            ),
        entry?.meta &&
          R.createElement("p", null, `版本 ${entry.meta.version || "1"}`),
        R.createElement(
          "button",
          {
            type: "button",
            disabled: state.pending.has(row.id) || row.isGrayed,
            onClick: () => state.controller?._applyStudy(row),
          },
          state.pending.has(row.id) ? "正在添加…" : "添加",
        ),
      ),
    );
  }
  const Frame = R.forwardRef(function Frame({ Native, ...props }, ref) {
    const ctx = R.useContext(Context),
      [narrow, setNarrow] = R.useState(false),
      region = R.useRef(null),
      opened = R.useRef(false);
    const original = props.render(),
      children = R.Children.toArray(original.props.children),
      search = children[0],
      body = children[1];
    R.useLayoutEffect(() => {
      if (props.isOpened && !opened.current) {
        search.props.onChange({ target: { value: state.query } });
        if (state.restoreScroll !== undefined)
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const list = doc.querySelector(
                '.mw-native-indicator-list [data-role="dialog-content"]',
              );
              if (list) list.scrollTop = state.restoreScroll;
              delete state.restoreScroll;
            }),
          );
      }
      opened.current = props.isOpened;
    }, [props.isOpened]);
    R.useLayoutEffect(() => {
      const observer = new ResizeObserver(() =>
        setNarrow(region.current?.clientWidth < 850),
      );
      if (region.current) observer.observe(region.current);
      return () => observer.disconnect();
    }, [props.isOpened]);
    R.useLayoutEffect(() => {
      if (
        narrow &&
        ctx.detail &&
        !doc.activeElement.closest(".mw-native-indicator-detail")
      )
        region.current?.querySelector("aside")?.focus({ preventScroll: true });
    }, [narrow, ctx.detail]);
    const close = () => {
      ctx.closeDetail();
      props.onClose();
      requestAnimationFrame(() => state.lastFocus?.focus());
    };
    function keyboard(event) {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        ctx.detail ? ctx.closeDetail() : close();
        return;
      }
      if (event.key === "Tab") {
        const scope =
          narrow && ctx.detail
            ? region.current?.querySelector("aside")
            : doc.querySelector('[data-name="indicators-dialog"]');
        const targets = [
          ...(scope?.querySelectorAll(
            'button,input,[tabindex="0"],select,[role="button"]',
          ) || []),
        ].filter(
          (node) =>
            !node.disabled &&
            !node.closest("[inert]") &&
            node.getClientRects().length &&
            node.tabIndex >= 0,
        );
        const index = targets.indexOf(doc.activeElement),
          next = index + (event.shiftKey ? -1 : 1);
        if (
          targets.length &&
          (index < 0 || next < 0 || next >= targets.length)
        ) {
          event.preventDefault();
          targets[event.shiftKey ? targets.length - 1 : 0].focus();
        }
        return;
      }
      if (
        event.target.matches("input") ||
        event.target.closest('[data-role="list-item"]')
      )
        props.onKeyDown?.(event);
    }
    const nav = R.createElement(
      "nav",
      { className: "mw-native-indicator-categories", "aria-label": "指标分类" },
      categories.map(([key, label]) =>
        R.createElement(ui.components.sidebarItem, {
          key,
          tag: "button",
          type: "button",
          mode: "normal",
          title: label,
          isActive: state.category === key,
          "aria-pressed": state.category === key,
          onClick: () => ctx.select(key),
          className: "mw-native-indicator-category",
        }),
      ),
    );
    const selector = R.createElement(
      "div",
      {
        className: "mw-native-indicator-category-select",
        "data-native-component": "select",
      },
      R.createElement(ui.components.select, {
        "aria-label": "指标分类",
        size: "small",
        value: state.category,
        items: categories.map(([value, content]) => ({ value, content })),
        onChange: ctx.select,
      }),
    );
    return R.createElement(Native, {
      ...props,
      ref,
      title: R.createElement(
        "span",
        { className: "mw-indicator-dialog-title" },
        R.createElement("span", {
          dangerouslySetInnerHTML: { __html: state.icon },
        }),
        "指标",
      ),
      closeAriaLabel: "关闭指标窗口",
      className: "mw-native-indicators",
      wrapperClassName: "mw-native-indicators-wrapper",
      onKeyDown: keyboard,
      onClose: close,
      backdrop: true,
      render: () =>
        R.createElement(
          "div",
          {
            className: `mw-native-indicator-content${ctx.detail ? " has-detail" : ""}${narrow ? " narrow" : ""}`,
            ref: region,
            "data-theme": widget.getTheme().toLowerCase(),
            "data-native-indicator-view": state.category,
          },
          R.cloneElement(search, {
            containerClassName: `${search.props.containerClassName || ""} mw-native-indicator-search`,
            "aria-label": "搜索指标",
            value: state.query,
            onChange: (event) => {
              state.query = event.target.value;
              search.props.onChange(event);
              ctx.closeDetail();
              notify();
            },
          }),
          selector,
          R.cloneElement(
            body,
            { className: "mw-native-indicator-body" },
            nav,
            R.createElement(
              "div",
              {
                className: "mw-native-indicator-list",
                ref: (node) => {
                  if (node) node.inert = !!ctx.detail && narrow;
                },
              },
              state.category === "added"
                ? R.createElement(Added)
                : ctx.empty
                  ? R.createElement(
                      "p",
                      { className: "mw-native-indicator-empty" },
                      state.category === "favorites"
                        ? "尚未收藏指标，点击列表中的星标即可收藏。"
                        : "没有符合分类的指标",
                    )
                  : body.props.children,
            ),
            ctx.detail && R.createElement(Detail),
          ),
          R.createElement(
            "footer",
            null,
            R.createElement(
              "span",
              { role: "status", "aria-live": "polite" },
              state.notice || "点击指标名称添加，星标用于收藏。",
            ),
            state.latest &&
              R.createElement(
                "button",
                {
                  type: "button",
                  onClick: () =>
                    properties(state.latest.chart, state.latest.id),
                },
                "设置刚添加的指标",
              ),
            R.createElement(
              "button",
              { type: "button", onClick: close },
              "完成",
            ),
          ),
        ),
    });
  });
  function properties(chart, id) {
    if (!chart.getAllStudies().some((study) => study.id === id)) {
      state.notice = "该指标已移除";
      notify();
      return;
    }
    state.restoreScroll =
      doc.querySelector(
        '.mw-native-indicator-list [data-role="dialog-content"]',
      )?.scrollTop || 0;
    state.controller?.hide();
    let saw = false;
    const observer = new MutationObserver(() => {
      const visible = [...doc.querySelectorAll('[role="dialog"]')].some(
        (node) => node.getClientRects().length,
      );
      if (visible) saw = true;
      else if (saw) {
        observer.disconnect();
        propertyObservers.delete(observer);
        widget.activeChart().executeActionById("insertIndicator");
      }
    });
    propertyObservers.add(observer);
    observer.observe(doc.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    try {
      chart.showPropertiesDialog(id);
    } catch (error) {
      observer.disconnect();
      propertyObservers.delete(observer);
      widget.activeChart().executeActionById("insertIndicator");
      throw error;
    }
  }
  const originalFactory = req.m[moduleId];
  if (!originalFactory || originalFactory.mwNativeIndicators)
    throw Error("原生指标适配器不可用或已加载");
  function factory(module, exports, nativeRequire) {
    const reactProxy = {
      ...R,
      createElement(type, props, ...children) {
        if (props?.dataName === "indicators-dialog")
          return R.createElement(
            Frame,
            { ...props, Native: type },
            ...children,
          );
        if (props?.data && props.applyStudy && "isOpened" in props)
          return R.createElement(View, { ...props, Native: type }, ...children);
        if (
          props?.item &&
          props.favoriteClickHandler &&
          props.role === "option"
        )
          return R.createElement(Row, { ...props, Native: type }, ...children);
        return R.createElement(type, props, ...children);
      },
    };
    const scopedRequire = Object.assign(
      (id) => (id === 779474 ? reactProxy : nativeRequire(id)),
      nativeRequire,
    );
    originalFactory(module, exports, scopedRequire);
    const NativeController = module.exports.IndicatorsLibraryContainer;
    class Controller extends NativeController {
      constructor(...args) {
        super(...args);
        state.controller = this;
      }
      async _init() {
        await super._init();
        const present = new Set(this._indicatorData.map((row) => row.id));
        for (const meta of this.mwCustomStudies || []) {
          if (present.has(meta.id)) continue;
          this._indicatorData.push({
            id: meta.id,
            title: meta.description,
            shortDescription: meta.shortDescription,
            shortTitle: meta.shortDescription,
            isStrategy: false,
            isHidden: false,
            isOverlay: meta.is_price_study,
            studyData: {
              id: meta.id,
              version: meta.version,
              descriptor: { type: "java", studyId: meta.id },
              packageName: "market-watch-1",
            },
          });
        }
        this._refreshFavorites();
        state.ready = true;
        notify();
      }
      async _requestBuiltInJavaStudies() {
        const rows = await super._requestBuiltInJavaStudies();
        for (const row of rows) state.names.set(row.id, row.description);
        this.mwCustomStudies = rows.filter(
          (row) =>
            row.isCustomIndicator && row.description.startsWith("守望 Python "),
        );
        return rows;
      }
      async _insertStudyImpl(row, ...args) {
        if (state.pending.has(row.id)) return null;
        const chart = widget.activeChart(),
          before = new Set(chart.getAllStudies().map((study) => study.id));
        state.pending.add(row.id);
        notify();
        try {
          const value = await super._insertStudyImpl(row, ...args);
          if (value) {
            const name = entryFor(row)?.name || value.description;
            const added = chart
              .getAllStudies()
              .filter((study) => !before.has(study.id) && study.name === name)
              .at(-1);
            if (added) state.latest = { chart, id: added.id };
            state.notice = `已添加 ${entryFor(row)?.label || row.title}`;
          }
          return value;
        } catch (error) {
          state.notice = String(error);
          state.report(error);
          return null;
        } finally {
          state.pending.delete(row.id);
          notify();
        }
      }
    }
    Object.defineProperty(Controller, "mwNativeIndicators", { value: true });
    module.exports = {
      ...module.exports,
      IndicatorsLibraryContainer: Controller,
    };
  }
  factory.mwNativeIndicators = true;
  req.m[moduleId] = factory;

  const refresh = () => notify();
  for (const event of [
    "activeChartChanged",
    "study_event",
    "chart_loaded",
    "chart_theme_changed",
  ])
    widget.subscribe(event, refresh);
  return {
    open(options) {
      if (options.isCurrent && !options.isCurrent()) return;
      Object.assign(state, options);
      state.lastFocus = doc.activeElement;
      widget.activeChart().executeActionById("insertIndicator");
    },
    close() {
      state.controller?.hide();
    },
    dispose() {
      for (const observer of propertyObservers) observer.disconnect();
      propertyObservers.clear();
      state.controller?.hide();
      for (const event of [
        "activeChartChanged",
        "study_event",
        "chart_loaded",
        "chart_theme_changed",
      ])
        widget.unsubscribe(event, refresh);
    },
  };
}
