/** Presentation only. Auth, reception, persistence and audio stay in the parent. */
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { useState } from "react";
import { NoticePanel, NoticeBubble } from "./Panel";
import type { Notice, NoticeState, NoticeTransport } from "./types";

type Scope = { workspace_id: string; session: string; epoch: number };
type Options = {
  widget: any;
  scope: Scope;
  request: NoticeTransport;
  state: NoticeState;
  panelChanged: (open: boolean, event?: string) => void;
  report: (error: unknown) => void;
  locate: (notice: Notice) => void | Promise<void>;
};
async function attach({
  widget,
  scope,
  request,
  state: initial,
  panelChanged,
  report,
  locate,
}: Options) {
  let target: HTMLElement | null = null,
    sidebarTarget: HTMLElement | null = null,
    disposed = false,
    selected: string | undefined;
  let render: (patch: any) => void = () => {};
  let opened = false;
  let compactDialog: any = null,
    openingCompact = false;
  const shell = await globalThis.nativeAlertShell(widget, {
    page: "mw-notifications",
    title: "通知中心",
    icon: '<svg width="44" height="44" viewBox="0 0 44 44" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 28h16l-2-4v-6a6 6 0 0 0-12 0v6l-2 4ZM20 32h4"/></svg>',
    mount(node) {
      sidebarTarget = node;
      if (!compactDialog && !openingCompact) {
        target = node;
        render({ target });
      }
    },
    unmount(node) {
      if (sidebarTarget === node) sidebarTarget = null;
      if (target === node) {
        target = null;
        render({ target: null });
      }
    },
    report,
  });
  await widget.headerReady();
  const slot = widget.createButton({
      align: "right",
      useTradingViewStyle: false,
    }),
    doc: Document = slot.ownerDocument;
  // HTML slots are cloned by the toolbar's overflow measurement. Use its
  // public styled-button callback so every visible representation activates.
  widget.removeButton(slot);
  let entry: string | undefined;
  const host = document.createElement("div");
  host.dataset.name = "mw-notification-view";
  document.body.append(host);
  const root = createRoot(host);
  function open(eventId?: string) {
    selected = eventId;
    opened = true;
    render({ eventId, opened: true });
    if (doc.defaultView!.innerWidth < 1000) {
      if (!compactDialog && !openingCompact) {
        openingCompact = true;
        void shell
          .openDialog({
            title: "通知中心",
            onClose: () => {
              compactDialog = null;
              target = sidebarTarget;
              opened = false;
              render({ target, opened: false });
              panelChanged(false);
            },
          })
          .then((dialog: any) => {
            if (disposed) {
              dialog.close();
              return;
            }
            compactDialog = dialog;
            dialog.body.style.cssText =
              "width:min(420px,calc(100vw - 48px));height:min(720px,calc(100vh - 140px));padding:0;overflow:hidden";
            target = dialog.body;
            render({ target, opened: true });
            dialog.recenter();
          })
          .catch(report)
          .finally(() => {
            openingCompact = false;
          });
      }
    } else shell.open();
    panelChanged(true, eventId);
  }
  const openBubble = () => open(current.bubble?.id);
  let current = initial;
  function View() {
    const [view, setView] = useState({
      target,
      state: current,
      eventId: selected,
      opened,
    });
    render = (patch) => {
      if (!disposed) setView((old) => ({ ...old, ...patch }));
    };
    const theme = String(widget.getTheme()).toLowerCase();
    return (
      <>
        {view.target &&
          createPortal(
            <div data-theme={theme} style={{ height: "100%", minHeight: 0 }}>
              <NoticePanel
                active={view.opened}
                state={view.state}
                request={request}
                eventId={view.eventId}
                onClose={() => {
                  if (compactDialog) compactDialog.close();
                  else shell.close();
                  opened = false;
                  render({ opened: false });
                  panelChanged(false);
                  findEntry()?.focus();
                }}
                onLocate={async (notice) => {
                  if (
                    notice.workspace !== scope.workspace_id ||
                    notice.source_kind === "chart_alert"
                  ) {
                    await locate(notice);
                    return;
                  }
                  const context = notice.context;
                  const closeSource = () => {
                    if (compactDialog) compactDialog.close(); else shell.close();
                    opened = false; render({ opened: false }); panelChanged(false);
                  };
                  if (['workspace', 'preferences', 'chart_shell'].includes(notice.source_kind)) {
                    closeSource(); return;
                  }
                  if (['data_center', 'capacity'].includes(notice.source_kind) || context.consumer === 'quotes' || context.timeframe === 'quotes') {
                    await locate(notice); closeSource(); return;
                  }
                  let index = context.chart_index;
                  const frameNames: Record<string, string> = {"1":"M1","5":"M5","15":"M15","30":"M30","60":"H1","240":"H4","1D":"D1","1W":"W1","1M":"MN"};
                  const matches = (chart: any) => {
                    const symbol = chart.symbol(), identity = (globalThis as any).MWSeries?.decode(symbol), resolution = String(chart.resolution());
                    return context.instrument && context.timeframe &&
                      (context.instrument === symbol || context.instrument === identity?.symbol) &&
                      (context.timeframe === resolution || context.timeframe === frameNames[resolution]);
                  };
                  const serverHistory = notice.id.startsWith('t:') && notice.source_kind === 'history' && context.epoch == null;
                  if (serverHistory || (context.epoch === scope.epoch && !Number.isSafeInteger(index))) {
                    const candidates = Array.from({length:widget.chartsCount()}, (_, i) => i).filter(i => matches(widget.chart(i)));
                    if (candidates.length !== 1) throw Error('无法唯一确认来源图格，请核查当前品种和周期');
                    index = candidates[0];
                  }
                  if (
                    (!serverHistory && context.epoch !== scope.epoch) ||
                    !Number.isSafeInteger(index) ||
                    Number(index) < 0 ||
                    Number(index) >= widget.chartsCount()
                  )
                    throw Error(
                      "来源图格上下文已改变，请在当前工作区核查后操作",
                    );
                  const chart = widget.chart(index);
                  const symbol = chart.symbol();
                  const identity = (globalThis as any).MWSeries?.decode(symbol);
                  const resolution = String(chart.resolution());
                  if (
                    (context.instrument &&
                      context.instrument !== symbol &&
                      context.instrument !== identity?.symbol) ||
                    (context.timeframe &&
                      context.timeframe !== resolution &&
                      context.timeframe !== frameNames[resolution])
                  )
                    throw Error("来源图格的品种或周期已改变，未操作当前图表");
                  widget.setActiveChart(index);
                  if (compactDialog) compactDialog.close();
                  else shell.close();
                  opened = false;
                  render({ opened: false });
                  panelChanged(false);
                }}
              />
            </div>,
            view.target,
          )}
        {view.state.bubble &&
          createPortal(
            <div className="mw-notice-anchor" data-theme={theme}>
              <NoticeBubble
                notice={view.state.bubble}
                request={request}
                onOpen={openBubble}
              />
            </div>,
            doc.body,
          )}
      </>
    );
  }
  root.render(<View />);
  function position() {
    const bubble = doc.querySelector<HTMLElement>(
      ".mw-notice-anchor .nc-bubble",
    );
    if (!bubble) return;
    const box = findEntry()?.getBoundingClientRect();
    if (!box) return;
    bubble.style.top = box.bottom + 8 + "px";
    bubble.style.left =
      Math.max(
        8,
        Math.min(
          doc.defaultView!.innerWidth - bubble.offsetWidth - 8,
          box.right - bubble.offsetWidth,
        ),
      ) + "px";
  }
  const observer = new MutationObserver(position);
  observer.observe(doc.body, { childList: true, subtree: true });
  doc.defaultView!.addEventListener("resize", position);
  const timer = setInterval(() => {
    if (openingCompact || compactDialog) return;
    const opened = shell.isOpen?.();
    if (opened !== lastOpen) {
      lastOpen = !!opened;
      render({ opened: !!opened });
      panelChanged(!!opened, selected);
    }
  }, 250);
  let lastOpen = false;
  let count = -1;
  const entryText = () => `通知中心 · ${current.unread} 未读`;
  const findEntry = () =>
    [...doc.querySelectorAll<HTMLElement>('button,[role="button"]')].find(
      (node) =>
        node.textContent?.trim() === entryText() &&
        node.getClientRects().length > 0 &&
        doc.defaultView!.getComputedStyle(node).visibility === "visible" &&
        !node.closest('[aria-hidden="true"],[inert]'),
    );
  const sync = (state: NoticeState) => {
    current = state;
    if (count !== state.unread) {
      const focused = findEntry() === doc.activeElement;
      count = state.unread;
      if (entry) widget.removeButton(entry);
      entry = widget.createButton({
        align: "right",
        useTradingViewStyle: true,
        text: entryText(),
        title: `通知中心，${state.unread} 条未读`,
        onClick: () => open(),
      });
      if (focused) requestAnimationFrame(() => findEntry()?.focus());
    }
    render({ state });
  };
  sync(initial);
  return {
    scope,
    open,
    update: sync,
    destroy() {
      disposed = true;
      clearInterval(timer);
      observer.disconnect();
      doc.defaultView!.removeEventListener("resize", position);
      root.unmount();
      host.remove();
      if (entry) widget.removeButton(entry);
      shell.destroy();
    },
  };
}
declare global {
  var MWNativeNotifications: { attach: typeof attach };
}
globalThis.MWNativeNotifications = { attach };
