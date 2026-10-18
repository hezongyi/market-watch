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
  locate: (notice: Notice) => void;
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
    disposed = false,
    selected: string | undefined;
  let render: (patch: any) => void = () => {};
  let opened = false;
  const shell = await globalThis.nativeAlertShell(widget, {
    page: "mw-notifications",
    title: "通知中心",
    icon: '<svg width="44" height="44" viewBox="0 0 44 44" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 28h16l-2-4v-6a6 6 0 0 0-12 0v6l-2 4ZM20 32h4"/></svg>',
    mount(node) {
      target = node;
      render({ target });
    },
    unmount(node) {
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
  const button = doc.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", "通知中心");
  button.title = "专业图表通知中心";
  button.dataset.name = "mw-notification-entry";
  button.style.cssText =
    "height:28px;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;padding:0 8px;white-space:nowrap";
  slot.appendChild(button);
  const host = document.createElement("div");
  host.dataset.name = "mw-notification-view";
  document.body.append(host);
  const root = createRoot(host);
  function open(eventId?: string) {
    selected = eventId;
    opened = true;
    render({ eventId, opened: true });
    shell.open();
    panelChanged(true, eventId);
  }
  button.onclick = () => open();
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
                  shell.close();
                  opened = false;
                  render({ opened: false });
                  panelChanged(false);
                  button.focus();
                }}
                onLocate={locate}
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
    const box = button.getBoundingClientRect();
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
    const opened = shell.isOpen?.();
    if (opened !== lastOpen) {
      lastOpen = !!opened;
      render({ opened: !!opened });
      panelChanged(!!opened, selected);
    }
  }, 250);
  let lastOpen = false;
  const sync = (state: NoticeState) => {
    current = state;
    button.textContent = `通知${state.unread ? ` ${state.unread}` : ""}`;
    button.setAttribute("aria-label", `通知中心，${state.unread} 条未读`);
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
      widget.removeButton(slot);
      shell.destroy();
    },
  };
}
declare global {
  var MWNativeNotifications: { attach: typeof attach };
}
globalThis.MWNativeNotifications = { attach };
