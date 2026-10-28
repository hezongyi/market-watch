/* Native surface adapter for the pinned v31.1.0 build. No vendor modification.
 * Used unchanged by the preview and the eventual notification data binding.
 */
async function nativeNotificationSurface(widget, report) {
  const version = globalThis.TradingView?.version?.();
  if (!version?.includes("6b804c486857f27920cf761aa7eb6e29d9bb6362"))
    throw Error("系统消息原生外壳版本尚未适配");
  // onChartReady does not guarantee that the custom header is mounted.
  await widget.headerReady();
  const common = await nativeAlertShell(widget, {
    page: null,
    mount: () => {},
    unmount: () => {},
    report,
  });
  try {
    const slot = widget.createButton({
      align: "right",
      useTradingViewStyle: false,
    });
    const doc = slot.ownerDocument;
    widget.removeButton(slot);
    let req;
    doc.defaultView.webpackChunktradingview.push([
      [`mw-native-messages-${crypto.randomUUID()}`],
      {},
      (r) => {
        req = r;
      },
    ]);
    // DialogSearch's own shared chunk. Do not load the symbol-search application.
    await nativeAlertChunks(req, [3854]);
    const R = req(779474),
      createRoot = req(590263).createReactRoot;
    const Dialog = req(491617).Dialog,
      NavButton = req(569716).NavButton,
      Search = req(357723).DialogSearch,
      ToolbarIconButton = req(51061).ToolbarIconButton;
    if (!Dialog || !NavButton || !Search || !ToolbarIconButton)
      throw Error("系统消息原生组件契约不匹配");
    function Icon(props) {
      const ref = R.useRef(null);
      R.useLayoutEffect(() => {
        props.reference?.(ref.current?.querySelector("button"));
        return () => props.reference?.(null);
      }, [props.reference]);
      const { reference, ...rest } = props;
      return R.createElement(
        "span",
        { ref, className: "nc-native-icon-holder" },
        R.createElement(NavButton, rest),
      );
    }
    const noticeCSS = req(412377);
    const style = doc.createElement("link");
    style.rel = "stylesheet";
    style.href = `${globalThis.MW_CHART_LIBRARY_PATH || "/charting_library/"}bundles/2371.3fc94a1aa7a1e03d91e4.css`;
    doc.head.append(style);
    const roots = new Set();
    const entryCleanups = new Set();
    function alignEntry(node) {
      const win = doc.defaultView;
      let frame = 0, watchlist = null, offset = 0;
      const resize = new win.ResizeObserver(schedule);
      const mutations = new win.MutationObserver(schedule);
      function schedule() {
        if (!frame) frame = win.requestAnimationFrame(update);
      }
      function update() {
        frame = 0;
        // The sidebar's bookmark icon is `base`; watchlists-button is the
        // text/dropdown inside the open panel and is not the alignment target.
        const target = doc.querySelector('button[data-name="base"][aria-pressed]');
        if (target !== watchlist) {
          if (watchlist) resize.unobserve(watchlist);
          watchlist = target;
          if (watchlist) resize.observe(watchlist);
        }
        const icon = watchlist?.getBoundingClientRect();
        const visible = icon?.width > 0 && icon.height > 0 &&
          icon.right > 0 && icon.left < win.innerWidth;
        // Reserve real toolbar space on both sides of the 38px native button.
        // The right edge stays anchored; no translated hit area overlaps peers.
        const rect = node.getBoundingClientRect();
        const delta = visible
          ? offset + icon.left + icon.width / 2 - (rect.left + rect.width / 2)
          : 0;
        offset = delta;
        node.style.transform = visible ? `translateX(${delta}px)` : "";
      }
      node.style.justifyContent = "center";
      resize.observe(doc.documentElement);
      resize.observe(node);
      mutations.observe(doc.body, { childList: true, subtree: true });
      win.addEventListener("resize", schedule);
      schedule();
      const cleanup = () => {
        resize.disconnect();
        mutations.disconnect();
        win.removeEventListener("resize", schedule);
        if (frame) win.cancelAnimationFrame(frame);
        entryCleanups.delete(cleanup);
      };
      entryCleanups.add(cleanup);
    }
    function managed(element, target) {
      const root = createRoot(element, target, "modern");
      roots.add(root);
      return {
        update: (props) => root.render(props),
        destroy() {
          roots.delete(root);
          root.unmount();
        },
      };
    }
    return {
      document: doc,
      scrollClass: req(421859).scrollContainer,
      async createEntry(node, icon) {
        // v31's custom-header observer otherwise disables keyboard navigation
        // for custom HTML and its descendants after every badge text update.
        node.dataset.internalAllowKeyboardNavigation = "true";
        node.classList.add("nc-system-entry-slot");
        return new Promise((resolve) => {
          managed(R.createElement(ToolbarIconButton, {
            icon,
            tooltip: "系统消息",
            "aria-label": "系统消息",
            className: "nc-system-entry",
            // Native ToolWidgetButton enables its interactive state from this
            // prop; the owning controller installs the business click handler.
            onClick: () => {},
            ref: (button) => {
              if (button) {
                alignEntry(node);
                resolve(button);
              }
            },
          }), node);
        });
      },
      overlayBounds: common.overlayBounds,
      control(kind, target, props) {
        if (kind !== "search" && kind !== "icon")
          return common.control(kind, target, props);
        const component = kind === "search" ? Search : Icon;
        const handle = managed(R.createElement(component, props), target);
        return {
          update: (next) => handle.update(R.createElement(component, next)),
          destroy: () => handle.destroy(),
        };
      },
      mount(target, content, instant = false) {
        const tree = (props) =>
          R.createElement(
            Dialog,
            {
              className: instant
                ? `${noticeCSS.popupDialog} nc-native-instant`
                : "nc-native-surface",
              containerTabIndex: -1,
              containerAriaLabel: instant ? "即时通知" : "系统消息",
              "data-name": instant
                ? "mw-native-instant-notice"
                : "mw-native-system-message-center",
              backdrop: false,
              reference: (node) => {
                if (node) {
                  node.setAttribute("role", "dialog");
                  node.setAttribute("aria-modal", "false");
                }
              },
              style: {
                position: "fixed",
                width: props.width,
                height: instant ? undefined : props.height,
                maxHeight: props.maxHeight,
                top: props.top,
                bottom: props.bottom,
                right: props.right,
                left: undefined,
                transform: undefined,
                zIndex: instant ? 151 : 140,
              },
            },
            R.createElement("div", {
              className: instant
                ? "nc-native-instant-content"
                : "nc-native-content",
              ref: content,
            }),
          );
        const root = managed(
          tree({ width: 400, height: 590, top: 46, right: 12 }),
          target,
        );
        return {
          update: (props) => root.update(tree(props)),
          destroy: () => root.destroy(),
        };
      },
      destroy() {
        for (const cleanup of entryCleanups) cleanup();
        style.remove();
        for (const root of roots) root.unmount();
        roots.clear();
        common.destroy();
      },
    };
  } catch (error) {
    common.destroy();
    throw error;
  }
}
globalThis.nativeNotificationSurface = nativeNotificationSurface;
