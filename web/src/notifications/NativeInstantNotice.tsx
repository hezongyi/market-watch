import { createRoot } from "react-dom/client";
import { createPortal, flushSync } from "react-dom";
import { useLayoutEffect, useRef, useState } from "react";
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
      [target, setTarget] = useState<HTMLElement | null>(null),
      [presented, setPresented] = useState(initial.bubble),
      [phase, setPhase] = useState("enter");
    const latest = useRef(state),
      displayed = useRef(presented);
    latest.current = state;
    displayed.current = presented;
    render = setState;
    const showing = !!presented;
    const reduced = () =>
      doc.defaultView!.matchMedia("(prefers-reduced-motion: reduce)").matches;
    useLayoutEffect(() => {
      if (displayed.current?.id === state.bubble?.id) {
        setPhase((value) => (value === "exit" ? "enter" : value));
        return;
      }
      if (!displayed.current) {
        setPresented(state.bubble);
        setPhase("enter");
        return;
      }
      // Business state advances immediately. This inert snapshot exists only
      // long enough to show that one event left before another takes its place.
      setPhase("exit");
      const timer = setTimeout(
        () => {
          setPresented(latest.current.bubble);
          setPhase("enter");
        },
        reduced() ? 0 : 160,
      );
      return () => clearTimeout(timer);
    }, [state.bubble?.id]);
    useLayoutEffect(() => {
      if (!target || !presented || phase !== "enter") return;
      const timer = setTimeout(() => setPhase("shown"), reduced() ? 0 : 220);
      return () => clearTimeout(timer);
    }, [target, presented?.id, phase]);
    useLayoutEffect(() => {
      if (!showing) return;
      surface = native.mount(host, setTarget, true);
      position();
      return () => {
        surface?.destroy();
        surface = null;
      };
    }, [showing]);
    const current = state.bubble?.id === presented?.id;
    const notice = current ? state.bubble : presented;
    return notice && target
      ? createPortal(
          <NativeControls.Provider value={native.control}>
            <div
              data-notice-phase={phase}
              inert={!current || phase !== "shown"}
            >
              <NoticeBubble
                key={notice.id}
                notice={notice}
                active={current && phase === "shown"}
                popupSeconds={state.systemPopupSeconds}
                pending={Math.max(0, (state.alertPending || 0) - 1)}
                request={request}
                onOpen={() => onOpen(notice)}
                onLocate={notice.workspace ? () => onLocate(notice) : undefined}
              />
            </div>
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
