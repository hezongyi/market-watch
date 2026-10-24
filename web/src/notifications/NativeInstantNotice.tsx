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
  let geometry = "";
  const position = () => {
    if (!surface) return;
    const b = native.overlayBounds();
    const narrow = b.width < 480, inset = narrow ? 12 : 16;
    const area = narrow
      ? { left: 0, top: 0, right: b.width, bottom: b.height }
      : b.chartBounds;
    const next = {
      width: Math.max(0, Math.min(355, area.right - area.left - 2 * inset)),
      height: 0,
      bottom: b.height - area.bottom + inset,
      right: b.width - area.right + inset,
      maxHeight: Math.max(0, area.bottom - area.top - 2 * inset),
    };
    const signature = JSON.stringify(next);
    if (signature !== geometry) {
      geometry = signature;
      surface.update(next);
    }
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
      geometry = "";
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
  let frame = 0;
  const schedule = () => {
    if (!frame) frame = doc.defaultView!.requestAnimationFrame(() => {
      frame = 0;
      position();
    });
  };
  const observer = new MutationObserver(schedule);
  observer.observe(doc.body, { childList: true, subtree: true,
    attributes: true, attributeFilter: ["class", "style"] });
  const resize = new doc.defaultView!.ResizeObserver(schedule);
  resize.observe(doc.documentElement);
  doc.defaultView!.addEventListener("resize", schedule);
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
      resize.disconnect();
      if (frame) doc.defaultView!.cancelAnimationFrame(frame);
      doc.defaultView!.removeEventListener("resize", schedule);
      root.unmount();
      native.destroy();
      host.remove();
      reactHost.remove();
    },
  };
}
