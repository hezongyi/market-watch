import { createRoot } from "react-dom/client";
import { createPortal, flushSync } from "react-dom";
import { useLayoutEffect, useState } from "react";
import { NativeControls } from "../advanced/NativeAlertControls";
import { NoticeBubble } from "./Panel";
import type { Notice, NoticeState, NoticeTransport } from "./types";
import type { Surface } from "./NativeSystemMessages";
import "./native-instant-notice.css";

export async function attachNativeInstantNotice({
  widget,
  state: initial,
  request,
  report,
  onOpen,
  onLocate,
}: {
  widget: any;
  state: NoticeState;
  request: NoticeTransport;
  report: (error: unknown) => void;
  onOpen: (notice: Notice) => void | Promise<void>;
  onLocate: (notice: Notice) => void | Promise<void>;
}) {
  const native = await globalThis.nativeNotificationSurface(widget, report),
    doc = native.document;
  const host = doc.createElement("div"),
    reactHost = document.createElement("div");
  doc.body.append(host);
  document.body.append(reactHost);
  const root = createRoot(reactHost);
  let disposed = false,
    surface: ReturnType<Surface["mount"]> | null = null;
  let render: (state: NoticeState) => void = () => {};
  const position = () => {
    if (!surface) return;
    const b = native.overlayBounds();
    const clear =
      b.panelLeft > b.width / 2
        ? 2 * (b.panelLeft - b.width / 2 - 8)
        : b.width - 24;
    surface.update({
      width: Math.max(120, Math.min(355, b.width - 24, clear)),
      height: 0,
      top: b.top,
      right: 0,
    });
  };
  function View() {
    const [state, setState] = useState(initial),
      [target, setTarget] = useState<HTMLElement | null>(null);
    render = setState;
    const showing = !!state.bubble;
    useLayoutEffect(() => {
      if (!showing) return;
      surface = native.mount(host, setTarget, true);
      position();
      return () => {
        surface?.destroy();
        surface = null;
      };
    }, [showing]);
    return showing && target
      ? createPortal(
          <NativeControls.Provider value={native.control}>
            <NoticeBubble
              key={state.bubble!.id}
              notice={state.bubble!}
              pending={Math.max(0, (state.alertPending || 0) - 1)}
              request={request}
              onOpen={() => onOpen(state.bubble!)}
              onLocate={
                state.bubble!.workspace
                  ? () => onLocate(state.bubble!)
                  : undefined
              }
            />
          </NativeControls.Provider>,
          target,
        )
      : null;
  }
  flushSync(() => root.render(<View />));
  const observer = new MutationObserver(position);
  observer.observe(doc.body, { childList: true, subtree: true });
  doc.defaultView!.addEventListener("resize", position);
  return {
    update(state: NoticeState) {
      if (!disposed) {
        render(state);
        position();
      }
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      doc.defaultView!.removeEventListener("resize", position);
      root.unmount();
      native.destroy();
      host.remove();
      reactHost.remove();
    },
  };
}
