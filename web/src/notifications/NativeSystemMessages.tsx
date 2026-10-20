/** Reusable notification-center presentation. Real transport or fixture is injected.
 * No notification runtime, persistence, reception or alert scheduler lives here.
 */
import { createRoot } from "react-dom/client";
import { createPortal, flushSync } from "react-dom";
import { useState, useLayoutEffect } from "react";
import {
  NativeControls,
  NativeScrollClass,
  type NativeControlFactory,
} from "../advanced/NativeAlertControls";
import { NoticePanel } from "./Panel";
import type { Notice, NoticeState, NoticeTransport } from "./types";
import { messageIcons } from "./icons";
import "./native-system-messages.css";

type Geometry = { width: number; height: number; top: number; right: number };
export type Surface = {
  document: Document;
  scrollClass: string;
  prepareEntry: (entry: HTMLElement) => void;
  control: NativeControlFactory;
  overlayBounds: (anchor?: HTMLElement) => {
    top: number;
    width: number;
    height: number;
    panelLeft: number;
  };
  mount: (
    target: HTMLElement,
    content: (node: HTMLElement | null) => void,
    instant?: boolean,
  ) => { update: (p: Geometry) => void; destroy: () => void };
  destroy: () => void;
};
declare global {
  var nativeNotificationSurface: (
    widget: any,
    report: (error: unknown) => void,
  ) => Promise<Surface>;
}

export async function attachNativeSystemMessages({
  widget,
  state: initial,
  request,
  onLocate,
  report,
  onOpenChanged,
}: {
  widget: any;
  state: NoticeState;
  request: NoticeTransport;
  onLocate?: (notice: Notice) => void | Promise<void>;
  report: (error: unknown) => void;
  onOpenChanged?: (opened: boolean, eventId?: string) => void;
}) {
  const native = await globalThis.nativeNotificationSurface(widget, report),
    doc = native.document;
  const entry: HTMLElement = widget.createButton({
    align: "right",
    useTradingViewStyle: false,
  });
  native.prepareEntry(entry);
  entry.classList.add("nc-system-entry");
  // Pinned v31.1.0: hide only the line immediately before this entry's group.
  // Keep its wrapper and dimensions so the native button spacing stays intact.
  const entrySeparatorStyle = doc.createElement("style");
  entrySeparatorStyle.textContent = `
    .separatorWrap-MBOVGQRI:has(+ .group-MBOVGQRI .nc-system-entry) > .separator-MBOVGQRI {
      visibility: hidden;
    }
  `;
  doc.head.append(entrySeparatorStyle);
  entry.setAttribute("role", "button");
  entry.tabIndex = 0;
  entry.innerHTML = `<span class="nc-entry-symbol" aria-hidden="true">${messageIcons.bell}<span class="nc-entry-count"></span></span>`;
  let current = initial,
    opened = false,
    disposed = false,
    keyboardOpen = false;
  let surface: ReturnType<Surface["mount"]> | null = null;
  const nativeHost = doc.createElement("div");
  doc.body.append(nativeHost);
  const reactHost = document.createElement("div");
  document.body.append(reactHost);
  const root = createRoot(reactHost);
  let render: (patch: any) => void = () => {};
  let eventId: string | undefined;
  function close(restore = false) {
    if (!opened) return;
    opened = false;
    entry.setAttribute("aria-expanded", "false");
    // Remove React content before unmounting its native parent.
    render({ opened: false });
    onOpenChanged?.(false);
    if (restore) entry.focus({ preventScroll: true });
  }
  const position = () => {
    if (!surface) return;
    const bounds = native.overlayBounds(entry),
      r = entry.getBoundingClientRect();
    surface.update({
      width: Math.min(400, bounds.width - 24),
      height: Math.max(160, Math.min(590, bounds.height - bounds.top - 12)),
      top: bounds.top,
      right: Math.max(12, bounds.width - r.right),
    });
  };
  function open(id?: string, keyboard = false) {
    if (disposed) return;
    eventId = id;
    keyboardOpen = keyboard;
    opened = true;
    entry.setAttribute("aria-expanded", "true");
    render({ opened: true, eventId: id });
    onOpenChanged?.(true, id);
  }
  function View() {
    const [view, setView] = useState({
      state: current,
      opened: false,
      eventId,
    });
    const [target, setTarget] = useState<HTMLElement | null>(null);
    render = (patch) => {
      if (!disposed) setView((old) => ({ ...old, ...patch }));
    };
    // Native Dialog owns its surface; only the existing NoticePanel is portaled.
    // Layout effect keeps mount/unmount in the same component lifecycle.
    useLayoutEffect(() => {
      if (!view.opened) return;
      surface = native.mount(nativeHost, setTarget);
      position();
      return () => {
        surface?.destroy();
        surface = null;
      };
    }, [view.opened]);
    useLayoutEffect(() => {
      if (target && view.opened && keyboardOpen) {
        // Native controls mount in a separate React root. A single animation
        // frame can run before their buttons exist; observe actual readiness.
        const focusReady = () => {
          const control =
            target.querySelector<HTMLElement>(".nc-heading button");
          if (!control) return;
          observer.disconnect();
          if (doc.activeElement === entry || doc.activeElement === doc.body)
            control.focus({ preventScroll: true });
        };
        const observer = new MutationObserver(focusReady);
        observer.observe(target, { childList: true, subtree: true });
        focusReady();
        return () => observer.disconnect();
      }
    }, [target, view.opened]);
    return target && view.opened
      ? createPortal(
          <NativeControls.Provider value={native.control}>
            <NativeScrollClass.Provider value={native.scrollClass}>
              <NoticePanel
                state={view.state}
                request={request}
                eventId={view.eventId}
                onClose={() => close(true)}
                onLocate={onLocate}
              />
            </NativeScrollClass.Provider>
          </NativeControls.Provider>,
          target,
        )
      : null;
  }
  // Keep root setup synchronous for calls made immediately after attach resolves.
  flushSync(() => root.render(<View />));
  const sync = (state: NoticeState) => {
    if (disposed) return;
    current = state;
    const count = entry.querySelector<HTMLElement>(".nc-entry-count")!;
    count.textContent = state.unread > 99 ? "99+" : String(state.unread);
    count.hidden = state.unread === 0;
    entry.setAttribute("aria-label", `系统消息，${state.unread} 条未读`);
    entry.setAttribute("aria-haspopup", "dialog");
    entry.setAttribute("title", `系统消息，${state.unread} 条未读`);
    render({ state });
  };
  const click = (event: MouseEvent) =>
    opened ? close(false) : open(undefined, event.detail === 0);
  const keys = (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      opened ? close(true) : open(undefined, true);
    }
  };
  const outside = (event: PointerEvent) => {
    const node = event.target as Element;
    if (
      !opened ||
      entry.contains(node) ||
      nativeHost.contains(node) ||
      node.closest(
        '[data-name="mw-native-alert-menu"],[role="listbox"],[class*="popup-"]',
      )
    )
      return;
    close(false);
  };
  const escape = (event: KeyboardEvent) => {
    if (opened && event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      close(true);
    }
  };
  entry.setAttribute("aria-expanded", "false");
  entry.addEventListener("click", click);
  entry.addEventListener("keydown", keys);
  doc.addEventListener("pointerdown", outside);
  doc.addEventListener("keydown", escape);
  doc.defaultView!.addEventListener("resize", position);
  sync(initial);
  return {
    open,
    close,
    update: sync,
    isOpen: () => opened,
    destroy() {
      if (disposed) return;
      disposed = true;
      const wasOpened = opened;
      opened = false;
      doc.removeEventListener("pointerdown", outside);
      doc.removeEventListener("keydown", escape);
      doc.defaultView!.removeEventListener("resize", position);
      entry.removeEventListener("click", click);
      entry.removeEventListener("keydown", keys);
      root.unmount();
      native.destroy();
      entrySeparatorStyle.remove();
      widget.removeButton(entry);
      nativeHost.remove();
      reactHost.remove();
      if (wasOpened) onOpenChanged?.(false);
    },
  };
}
