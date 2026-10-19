/* Fixed v31.1.0 adapter. All private widgetbar/notice DOM access lives here.
 * Vendor bytes are untouched. Business state outlives native page recreation. */
const nativeAlertRuntimes = new WeakMap();
const nativePageRegistries = new WeakMap();
async function nativeAlertShell(
  widget,
  { mount, unmount, report, page = "alerts", title = "警报", icon },
) {
  const version = globalThis.TradingView?.version?.();
  if (
    !version ||
    !/\bv31\.1\.0\b/.test(version) ||
    !version.includes("6b804c486857f27920cf761aa7eb6e29d9bb6362")
  )
    throw Error(`告警原生适配不支持图表库 ${version}`);
  const api = await widget.widgetbar(),
    bar = api?._widgetbar;
  if (
    !bar?.layout ||
    !bar.widgetConfig?.alerts ||
    ![
      "loadWidgets",
      "getLayoutState",
      "refreshFromTVSettings",
      "setPage",
    ].every((key) => typeof bar[key] === "function")
  )
    throw Error("v31.1.0 原生告警侧栏契约不匹配");
  bar.loadWidgets();
  await bar._configuration;
  const doc = bar._wrap?.ownerDocument;
  if (!doc?.defaultView?.webpackChunktradingview)
    throw Error("原生侧栏文档契约不匹配");
  // Finish async dependencies before mutating the bar. Failed initialization
  // leaves its original page factory and configuration intact.
  let vendor = nativeAlertRuntimes.get(doc);
  if (!vendor)
    doc.defaultView.webpackChunktradingview.push([
      ["mw-native-alert-controls-v31.1.0"],
      {},
      (require) => {
        vendor = require;
        nativeAlertRuntimes.set(doc, require);
      },
    ]);
  if (!vendor?.e) throw Error("v31.1.0 原生控件运行时契约不匹配");
  await Promise.all([
    // Select imports DOM IDs (210754) and keyboard navigation (409286)
    // from shared chunks. Other lazy UI may not have finished loading them.
    vendor.e(32171),
    vendor.e(36145),
    vendor.e(21981),
    vendor.e(42706),
    vendor.e(34540),
    vendor.e(56595),
    vendor.e(91676),
    vendor.e(39218),
  ]);
  const nativeReact = vendor(779474),
    createNativeRoot = vendor(590263).createReactRoot;
  const PopupMenu = vendor(986418).PopupMenu,
    PopupMenuItem = vendor(18392).PopupMenuItem;
  const PopupMenuSeparator = vendor(658778).PopupMenuSeparator;
  const nativeComponents = {
    select: vendor(221339).Select,
    checkbox: vendor(343577).Checkbox,
    button: vendor(536605).Button,
    input: vendor(909536).InputControl,
    textarea: vendor(165770).Textarea,
    menu: NativeMenu,
  };
  if (
    !nativeReact?.createElement ||
    typeof createNativeRoot !== "function" ||
    ![
      ...Object.values(nativeComponents),
      PopupMenu,
      PopupMenuItem,
      PopupMenuSeparator,
    ].every(Boolean)
  )
    throw Error("v31.1.0 原生告警控件契约不匹配");
  let releasePage = () => {};
  let disposed = false,
    dialog = null,
    cancelOpening = null;
  const nodes = new Set();
  // Controls-only clients must never register or resize a widgetbar page.
  if (page !== null) {
    let registry = nativePageRegistries.get(bar);
    if (!registry) {
      registry = { originalState: bar.getLayoutState, entries: new Map() };
      nativePageRegistries.set(bar, registry);
      bar.getLayoutState = function () {
        const state = registry.originalState.call(this);
        for (const [name, entry] of registry.entries) {
          if (!state.pages.some((item) => item.name === name))
            state.pages.splice(1, 0, {
              name,
              title: entry.title,
              icon: entry.icon,
              widgets: [{ type: name }],
            });
        }
        return state;
      };
    }
    if (registry.entries.has(page))
      throw Error("原生侧栏页面重复接入：" + page);
    const originalConfig = bar.widgetConfig[page];
    releasePage = () => {
      registry.entries.delete(page);
      if (originalConfig) bar.widgetConfig[page] = originalConfig;
      else delete bar.widgetConfig[page];
      if (!registry.entries.size) {
        bar.getLayoutState = registry.originalState;
        nativePageRegistries.delete(bar);
      }
    };
    class AlertContent {
      constructor(props) {
        this.node = props.container.ownerDocument.createElement("div");
        this.node.dataset.name = "mw-native-alert-content";
        this.node.style.cssText =
          "height:100%;min-height:0;display:flex;flex-direction:column";
        props.container.appendChild(this.node);
        nodes.add(this.node);
        if (!disposed) mount(this.node);
      }
      destroy() {
        nodes.delete(this.node);
        unmount(this.node);
        this.node.remove();
      }
    }
    bar.widgetConfig[page] = {
      ...bar.widgetConfig.alerts,
      noHeader: true,
      ctor: AlertContent,
    };
    registry.entries.set(page, {
      title,
      icon:
        icon ||
        '<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44" fill="none" stroke="currentColor" stroke-width="1.5"><g transform="translate(8 8)"><circle cx="14" cy="15" r="8"/><path d="M14 10v5h4M5 6l3-3M20 3l3 3M9 23l-2 2M19 23l2 2"/></g></svg>',
    });
    // Rebuild only once. Native refreshes use the wrapped state factory thereafter.
    try {
      bar.refreshFromTVSettings();
    } catch (error) {
      disposed = true;
      releasePage();
      for (const node of nodes) {
        unmount(node);
        node.remove();
      }
      nodes.clear();
      try {
        bar.refreshFromTVSettings();
      } catch (rollbackError) {
        report(rollbackError);
      }
      throw error;
    }
  }
  const style = doc.createElement("link");
  style.rel = "stylesheet";
  style.href = "/alert-ui.css";
  doc.head.appendChild(style);

  function NativeMenu({ anchor, label, items, opened, onClose }) {
    const reference = nativeReact.useRef(null);
    nativeReact.useEffect(() => {
      if (!opened) return;
      const frame = doc.defaultView.requestAnimationFrame(() => {
        reference.current?.querySelector("button:not(:disabled)")?.focus();
      });
      return () => doc.defaultView.cancelAnimationFrame(frame);
    }, [opened]);
    nativeReact.useLayoutEffect(() => {
      const buttons = reference.current?.querySelectorAll("button") || [];
      buttons.forEach((button, index) => {
        const item = items[index];
        button.setAttribute(
          "role",
          item.checked === undefined ? "menuitem" : "menuitemcheckbox",
        );
        button.setAttribute("tabindex", "-1");
        if (item.checked !== undefined)
          button.setAttribute("aria-checked", String(item.checked));
      });
    });
    const close = () => {
      onClose();
      if (anchor?.isConnected) anchor.focus();
    };
    return nativeReact.createElement(
      PopupMenu,
      {
        isOpened: opened,
        role: "menu",
        "aria-label": label,
        "data-name": "mw-native-alert-menu",
        reference,
        minWidth: 180,
        doNotCloseOn: anchor,
        repositionOnScroll: true,
        position: () => {
          const box = anchor.getBoundingClientRect();
          return {
            x: box.left,
            y: box.bottom + 4,
            indentFromWindow: { top: 8, bottom: 8, left: 8, right: 8 },
          };
        },
        onClose: close,
        onKeyboardClose: close,
      },
      nativeReact.createElement(
        "div",
        {
          ref: reference,
          role: "menu",
          "aria-label": label,
          "data-name": "mw-native-alert-menu",
          onKeyDown: (event) => {
            const buttons = [
              ...reference.current.querySelectorAll(
                '[role^="menuitem"]:not(:disabled)',
              ),
            ];
            const index = buttons.indexOf(event.target);
            if (event.key === "Escape" || event.key === "Tab") {
              event.preventDefault();
              event.stopPropagation();
              close();
              return;
            }
            let next;
            if (event.key === "ArrowDown") next = (index + 1) % buttons.length;
            else if (event.key === "ArrowUp")
              next = (index - 1 + buttons.length) % buttons.length;
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = buttons.length - 1;
            else return;
            event.preventDefault();
            event.stopPropagation();
            buttons[next]?.focus();
          },
        },
        items.flatMap((item, index) =>
          [
            item.divider &&
              nativeReact.createElement(PopupMenuSeparator, {
                key: "separator-" + index,
              }),
            nativeReact.createElement(PopupMenuItem, {
              key: index,
              label: item.label,
              tagName: "button",
              type: "button",
              tabIndex: -1,
              role:
                item.checked === undefined ? "menuitem" : "menuitemcheckbox",
              "aria-checked": item.checked,
              "aria-disabled": Boolean(item.disabled),
              disabled: item.disabled,
              isDisabled: item.disabled,
              toolbox: item.checked
                ? nativeReact.createElement(
                    "svg",
                    {
                      width: 16,
                      height: 16,
                      viewBox: "0 0 16 16",
                      "aria-hidden": true,
                    },
                    nativeReact.createElement("path", {
                      d: "m3 8 3 3 7-7",
                      fill: "none",
                      stroke: "currentColor",
                      strokeWidth: 1.5,
                    }),
                  )
                : null,
              onClick: () => {
                close();
                item.run();
              },
            }),
          ].filter(Boolean),
        ),
      ),
    );
  }
  function closeDialog() {
    cancelOpening?.();
    dialog?.close();
  }
  function openDialog({ title, onClose }) {
    if (disposed) return Promise.reject(Error("图表已销毁"));
    closeDialog();
    const focus = doc.activeElement;
    return new Promise((resolve, reject) => {
      let handle,
        observer,
        timer,
        resizeObserver,
        resize,
        finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        observer?.disconnect();
        resizeObserver?.disconnect();
        if (resize) doc.defaultView.removeEventListener("resize", resize);
        doc.removeEventListener("keydown", keys, true);
        if (dialog === handle) dialog = null;
        if (cancelOpening === cancel) cancelOpening = null;
        onClose();
        if (focus?.isConnected) focus.focus();
      };
      const cancel = () => {
        reject(Error("告警窗口打开已取消"));
        done();
      };
      cancelOpening = cancel;
      const keys = (event) => {
        if (!handle) return;
        if (event.key === "Escape") {
          if (
            doc.querySelector(
              '[popover]:popover-open,[data-name="mw-native-alert-menu"]',
            ) ||
            [...doc.querySelectorAll('[role="listbox"]')].some(
              (node) => node.getClientRects().length,
            )
          )
            return;
          event.preventDefault();
          event.stopImmediatePropagation();
          if (!handle.busy)
            handle.onEscape ? handle.onEscape() : handle.close();
        } else if (handle.shell.contains(event.target)) {
          // Let content handle Tab/Enter, without letting chart shortcuts consume input.
          if (event.key === "Tab") {
            const controls = [
              ...handle.shell.querySelectorAll(
                'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
              ),
            ].filter((node) => node.getClientRects().length);
            const first = controls[0],
              last = controls.at(-1);
            if (event.shiftKey && event.target === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && event.target === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }
      };
      function find() {
        const shell = [
          ...doc.querySelectorAll('[data-name="warning-dialog"]'),
        ].find(
          (node) =>
            node.querySelector('[class*="title-"]')?.textContent === title,
        );
        if (!shell) return;
        if (finished || disposed) {
          shell.querySelector('[data-name="close"]')?.click();
          observer?.disconnect();
          return;
        }
        const body = shell.querySelector('[class*="content-"]'),
          footer = shell.querySelector('[class*="footer-"]'),
          close = shell.querySelector('[data-name="close"]');
        if (!body || !footer || !close) {
          reject(Error("原生告警窗口契约不匹配"));
          done();
          return;
        }
        clearTimeout(timer);
        observer.disconnect();
        shell.dataset.name = "mw-native-alert-dialog";
        shell.classList.add("mw-native-alert-shell");
        shell.setAttribute("role", "dialog");
        shell.setAttribute("aria-modal", "true");
        shell.setAttribute("aria-label", title);
        body.replaceChildren();
        footer.hidden = true;
        const titleNode = shell.querySelector('[class*="title-"]');
        resize = () => handle?.recenter();
        handle = {
          shell,
          body,
          busy: false,
          onEscape: null,
          close: () => {
            handle.busy = false;
            close.disabled = false;
            close.click();
            done();
          },
          setBusy: (value) => {
            handle.busy = value;
            close.disabled = value;
          },
          setTitle: (value) => {
            titleNode.textContent = value;
            shell.setAttribute("aria-label", value);
          },
          recenter: () => {
            const outer = shell.parentElement;
            outer.style.transform = `translate(${Math.max(8, (doc.defaultView.innerWidth - outer.offsetWidth) / 2)}px, ${Math.max(8, (doc.defaultView.innerHeight - outer.offsetHeight) / 2)}px)`;
          },
        };
        resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(shell);
        const originalClose = handle.close;
        handle.close = () => {
          resizeObserver.disconnect();
          doc.defaultView.removeEventListener("resize", resize);
          originalClose();
        };
        doc.defaultView.addEventListener("resize", resize);
        dialog = handle;
        cancelOpening = null;
        close.addEventListener(
          "click",
          (event) => {
            if (handle.busy) {
              event.preventDefault();
              event.stopImmediatePropagation();
            } else done();
          },
          true,
        );
        doc.addEventListener("keydown", keys, true);
        resolve(handle);
      }
      // Public notice closes on outside click, including its portaled Select menu.
      // The same native warning factory accepts that behavior as an explicit option.
      vendor(894450)
        .showWarning({
          title,
          text: " ",
          onClose: done,
          closeOnOutsideClick: false,
        })
        .then((close) => {
          if (finished || disposed) close?.();
        })
        .catch((error) => {
          reject(error);
          done();
        });
      observer = new MutationObserver(find);
      observer.observe(doc.body, { childList: true, subtree: true });
      timer = setTimeout(() => {
        observer.disconnect();
        reject(Error("原生告警窗口打开超时"));
        done();
      }, 5000);
      find();
    });
  }
  return {
    isOpen: () =>
      page !== null &&
      !disposed &&
      bar.layout.getActivePage()?.name === page &&
      !bar.layout.minimized,
    open: () => {
      if (page !== null && !disposed) bar.setPage(page);
    },
    close: () => {
      if (
        page !== null &&
        !disposed &&
        bar.layout.getActivePage()?.name === page &&
        !bar.layout.minimized
      )
        bar.layout.onTabClick(bar.layout.getActivePage());
    },
    openDialog,
    overlayBounds: (anchor) => {
      const width = doc.defaultView.innerWidth,
        height = doc.defaultView.innerHeight;
      const panel = bar._wrap?.getBoundingClientRect();
      const toolbar = doc
        .querySelector(".innerWrap-OhqNVIYA")
        ?.getBoundingClientRect();
      return {
        width,
        height,
        top:
          (toolbar?.bottom || anchor?.getBoundingClientRect().bottom || 40) + 8,
        panelLeft:
          !bar.layout.minimized && panel?.width > 60 ? panel.left : width,
      };
    },
    control: (kind, container, props) => {
      const component = nativeComponents[kind];
      if (!component) throw Error("未知原生告警控件");
      const nativeRoot = createNativeRoot(
        nativeReact.createElement(component, props),
        container,
        "modern",
      );
      return {
        update: (next) =>
          nativeRoot.render(nativeReact.createElement(component, next)),
        destroy: () => nativeRoot.unmount(),
      };
    },
    destroy: () => {
      if (disposed) return;
      disposed = true;
      closeDialog();
      for (const node of nodes) {
        unmount(node);
        node.remove();
      }
      nodes.clear();
      style.remove();
      releasePage();
      try {
        if (page !== null) bar.refreshFromTVSettings();
      } catch (error) {
        report(error);
      }
    },
    diagnostics: () => ({
      version,
      pages: bar.layout.pages.map((page) => page.name),
      mounts: nodes.size,
    }),
  };
}
