/** Presentation adapter. Reception, persistence and sound remain in the parent. */
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { useState } from "react";
import { NativeControls } from "../advanced/NativeAlertControls";
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
  alert: (signalId: string) => void;
};
async function attach({
  widget,
  scope,
  request,
  state: initial,
  panelChanged,
  report,
  locate,
  alert,
}: Options) {
  // Load the existing chart control factory without registering a sidebar page.
  const shell = await globalThis.nativeAlertShell(widget, {
    page: null,
    mount: () => {},
    unmount: () => {},
    report,
  });
  await widget.headerReady();
  const slot = widget.createButton({
    align: "right",
    useTradingViewStyle: false,
  });
  const doc: Document = slot.ownerDocument;
  widget.removeButton(slot);
  let disposed = false,
    opened = false,
    selected: string | undefined,
    current = initial,
    entry: string | undefined,
    count = -1;
  let render: (patch: any) => void = () => {};
  const host = document.createElement("div");
  host.dataset.name = "mw-notification-view";
  document.body.append(host);
  const root = createRoot(host);
  const entryText = () => `系统消息 · ${current.unread}`;
  const findEntry = () =>
    [...doc.querySelectorAll<HTMLElement>('button,[role="button"]')].find(
      (node) =>
        node.textContent?.trim() === entryText() &&
        node.getClientRects().length > 0 &&
        doc.defaultView!.getComputedStyle(node).visibility !== "hidden" &&
        !node.closest('[aria-hidden="true"],[inert]'),
    );
  function close(restoreFocus = true) {
    opened = false;
    selected = undefined;
    render({ opened: false, eventId: undefined });
    panelChanged(false);
    if (restoreFocus) findEntry()?.focus();
  }
  async function open(eventId?: string) {
    if (eventId) {
      try {
        const row: Notice = await request({
          action: "detail",
          event_id: eventId,
        });
        if (disposed) return;
        if (row.source_kind === "chart_alert") {
          close(false);
          alert(row.source_id);
          return;
        }
      } catch (error) {
        if (disposed) return; /* Panel exposes the readable failure. */
      }
    }
    if (disposed) return;
    selected = eventId;
    opened = true;
    render({ eventId, opened: true });
    panelChanged(true, eventId);
  }
  async function locateSource(notice: Notice) {
    if (
      notice.workspace !== scope.workspace_id ||
      notice.source_kind === "chart_alert"
    ) {
      await locate(notice);
      return;
    }
    const context = notice.context;
    const closeSource = () => {
      close(false);
    };
    if (
      ["workspace", "preferences", "chart_shell"].includes(notice.source_kind)
    ) {
      closeSource();
      return;
    }
    if (
      ["data_center", "capacity"].includes(notice.source_kind) ||
      context.consumer === "quotes" ||
      context.timeframe === "quotes"
    ) {
      await locate(notice);
      closeSource();
      return;
    }
    let index = context.chart_index;
    const frameNames: Record<string, string> = {
      "1": "M1",
      "5": "M5",
      "15": "M15",
      "30": "M30",
      "60": "H1",
      "240": "H4",
      "1D": "D1",
      "1W": "W1",
      "1M": "MN",
    };
    const matches = (chart: any) => {
      const symbol = chart.symbol(),
        identity = (globalThis as any).MWSeries?.decode(symbol),
        resolution = String(chart.resolution());
      return (
        context.instrument &&
        context.timeframe &&
        (context.instrument === symbol ||
          context.instrument === identity?.symbol) &&
        (context.timeframe === resolution ||
          context.timeframe === frameNames[resolution])
      );
    };
    const serverHistory =
      notice.id.startsWith("t:") &&
      notice.source_kind === "history" &&
      context.epoch == null;
    if (
      serverHistory ||
      (context.epoch === scope.epoch && !Number.isSafeInteger(index))
    ) {
      const candidates = Array.from(
        { length: widget.chartsCount() },
        (_, i) => i,
      ).filter((i) => matches(widget.chart(i)));
      if (candidates.length !== 1)
        throw Error("无法唯一确认来源图格，请核查当前品种和周期");
      index = candidates[0];
    }
    if (
      (!serverHistory && context.epoch !== scope.epoch) ||
      !Number.isSafeInteger(index) ||
      Number(index) < 0 ||
      Number(index) >= widget.chartsCount()
    )
      throw Error("来源图格上下文已改变，请在当前工作区核查后操作");
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
    close(false);
  }
  const openBubble = async () => {
    if (!current.bubble) return;
    if (current.bubble.source_kind === "chart_alert") {
      close(false);
      alert(current.bubble.source_id);
    } else
      await open(current.bubble.local_status ? undefined : current.bubble.id);
  };
  function View() {
    const [view, setView] = useState({
      state: current,
      eventId: selected,
      opened,
    });
    render = (patch) => {
      if (!disposed) setView((old) => ({ ...old, ...patch }));
    };
    const theme = String(widget.getTheme()).toLowerCase();
    return (
      <NativeControls.Provider value={shell.control}>
        {view.opened &&
          createPortal(
            <div
              className="nc-popup"
              data-theme={theme}
              role="dialog"
              aria-modal="false"
              aria-label="通知中心"
            >
              <NoticePanel
                state={view.state}
                request={request}
                eventId={view.eventId}
                onClose={() => close()}
                onLocate={locateSource}
              />
            </div>,
            doc.body,
          )}
        {view.state.bubble &&
          createPortal(
            <div className="mw-notice-anchor" data-theme={theme}>
              <NoticeBubble
                notice={view.state.bubble}
                request={request}
                onOpen={openBubble}
                onLocate={
                  view.state.bubble.workspace
                    ? () => locateSource(view.state.bubble!)
                    : undefined
                }
              />
            </div>,
            doc.body,
          )}
      </NativeControls.Provider>
    );
  }
  root.render(<View />);
  let scheduled = 0;
  function position() {
    scheduled = 0;
    const bounds = shell.overlayBounds(findEntry());
    const popup = doc.querySelector<HTMLElement>(".nc-popup"),
      bubble = doc.querySelector<HTMLElement>(".mw-notice-anchor .nc-bubble");
    if (popup) {
      popup.style.top = bounds.top + "px";
      popup.style.right =
        Math.max(
          12,
          bounds.width -
            (findEntry()?.getBoundingClientRect().right || bounds.width - 12),
        ) + "px";
      popup.style.height =
        Math.min(590, bounds.height - bounds.top - 12) + "px";
    }
    if (bubble) {
      bubble.style.top = bounds.top + "px";
      const clear =
        bounds.panelLeft > bounds.width / 2
          ? 2 * (bounds.panelLeft - bounds.width / 2 - 8)
          : bounds.width - 24;
      bubble.style.width =
        Math.min(355, bounds.width - 24, clear) + "px";
    }
  }
  const schedulePosition = () => {
    if (!scheduled)
      scheduled = doc.defaultView!.requestAnimationFrame(position);
  };
  const observer = new MutationObserver(schedulePosition);
  observer.observe(doc.body, { childList: true, subtree: true });
  doc.defaultView!.addEventListener("resize", schedulePosition);
  const outside = (event: PointerEvent) => {
    const target = event.target as HTMLElement;
    if (
      !opened ||
      target.closest(
        '.nc-popup,.mw-notice-anchor,[role="menu"],[role="listbox"],[role="option"],[class*="popup-"]',
      ) ||
      findEntry()?.contains(target)
    )
      return;
    close(false);
  };
  doc.addEventListener("pointerdown", outside);
  const sync = (state: NoticeState) => {
    // Locate the existing entry using its old label before the unread count changes.
    const focused = findEntry() === doc.activeElement;
    current = state;
    if (count !== state.unread) {
      count = state.unread;
      if (entry) widget.removeButton(entry);
      entry = widget.createButton({
        align: "right",
        useTradingViewStyle: true,
        text: entryText(),
        title: `系统消息，${state.unread} 条未读`,
        onClick: () => {
          if (opened) close();
          else void open();
        },
      });
      if (focused)
        doc.defaultView!.requestAnimationFrame(() => findEntry()?.focus());
    }
    render({ state });
    schedulePosition();
  };
  sync(initial);
  return {
    scope,
    open,
    update: sync,
    destroy() {
      disposed = true;
      observer.disconnect();
      doc.removeEventListener("pointerdown", outside);
      doc.defaultView!.removeEventListener("resize", schedulePosition);
      if (scheduled) doc.defaultView!.cancelAnimationFrame(scheduled);
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
