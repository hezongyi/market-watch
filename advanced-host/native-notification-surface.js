/* Native surface adapter for the pinned v31.1.0 build. No vendor modification.
 * Used unchanged by the preview and the eventual notification data binding.
 */
async function nativeNotificationSurface(widget, report) {
  const version = globalThis.TradingView?.version?.();
  if (!version?.includes("6b804c486857f27920cf761aa7eb6e29d9bb6362"))
    throw Error("系统消息原生外壳版本尚未适配");
  const common = await nativeAlertShell(widget, {
    page: null,
    mount: () => {},
    unmount: () => {},
    report,
  });
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
  try {
    // DialogSearch's own shared chunk. Do not load the symbol-search application.
    await req.e(3854);
    const R = req(779474),
      createRoot = req(590263).createReactRoot;
    const Dialog = req(491617).Dialog,
      NavButton = req(569716).NavButton,
      Search = req(357723).DialogSearch;
    if (!Dialog || !NavButton || !Search)
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
      prepareEntry(node) {
        // v31's custom-header observer otherwise disables keyboard navigation
        // for custom HTML and its descendants after every badge text update.
        node.dataset.internalAllowKeyboardNavigation = "true";
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
              className: instant ? `${noticeCSS.popupDialog} nc-native-instant` : "nc-native-surface",
              containerTabIndex: -1,
              containerAriaLabel: instant ? "即时通知" : "系统消息",
              "data-name": instant ? "mw-native-instant-notice" : "mw-native-system-message-center",
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
                top: props.top,
                right: instant ? undefined : props.right,
                left: instant ? "50%" : undefined,
                transform: instant ? "translateX(-50%)" : undefined,
                zIndex: instant ? 151 : 140,
              },
            },
            R.createElement("div", {
              className: instant ? "nc-native-instant-content" : "nc-native-content",
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
