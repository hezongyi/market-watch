import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { formatTimestamp } from "../time/chartTime";
import {
  healthNames,
  statuses,
  type AlertEvent,
  type AlertRow,
  type DisplayIdentity,
} from "./chartAlerts";

export function alertCode(
  value: { display_identity?: DisplayIdentity; display_label?: string },
  fallback: string,
) {
  return value.display_identity?.code || value.display_label || fallback;
}
export function alertState(row: AlertRow) {
  if (row.status === "active" && row.health !== "ready")
    return healthNames[row.health] || row.health;
  return row.status === "completed"
    ? "停止 — 已触发"
    : statuses[row.status] || row.status;
}
/** Local vector identity: no remote symbol service, no platform-dependent emoji. */
export function AlertSymbolIcon({ code }: { code: string }) {
  const euroDollar = code === "EURUSD";
  return (
    <svg
      className="alert-symbol-icon"
      width="18"
      height="18"
      viewBox="0 0 18 18"
      aria-hidden="true"
    >
      <circle
        cx="11.5"
        cy="6.5"
        r="5.5"
        fill={euroDollar ? "#f1f1f1" : "#64748b"}
      />
      {euroDollar && (
        <path
          d="M7 3h8M6 5h11M7 7h9M8 9h7"
          stroke="#d64653"
          strokeWidth="1.2"
        />
      )}
      <circle
        cx="6.5"
        cy="11.5"
        r="6"
        fill="#1978c8"
        stroke="var(--alert-bg)"
      />
      {euroDollar ? (
        <path
          d="m6.5 7 .5 1.4h1.5l-1.2.9.5 1.4-1.3-.9-1.3.9.5-1.4-1.2-.9H6zM3 12h7M6.5 13v2"
          fill="#f3d65e"
          stroke="#f3d65e"
          strokeWidth=".6"
        />
      ) : (
        <path d="m3 13 2-3 2 2 3-4" stroke="white" fill="none" />
      )}
    </svg>
  );
}

/** Lives in the anchor's document, including inside the native chart iframe. */
export function AlertSummary({
  row,
  event,
  zone,
  theme,
  children,
}: {
  row?: AlertRow;
  event?: AlertEvent;
  zone: string;
  theme: string;
  children: ReactNode;
}) {
  const anchor = useRef<HTMLDivElement>(null),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const id = useId();
  const tooltip = useRef<HTMLDivElement>(null);
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setPosition(null);
  };
  const show = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const el = anchor.current;
      if (!el) return;
      const box = el.getBoundingClientRect(),
        view = el.ownerDocument.defaultView!;
      const width = Math.min(250, view.innerWidth - 16);
      setPosition({
        left: Math.max(
          8,
          Math.min(
            box.left >= width + 16 ? box.left - width - 8 : box.right + 8,
            view.innerWidth - width - 8,
          ),
        ),
        top: Math.max(8, Math.min(box.top, view.innerHeight - 180)),
      });
    }, 300);
  };
  useEffect(() => {
    const doc = anchor.current?.ownerDocument,
      view = doc?.defaultView;
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    doc?.addEventListener("keydown", escape);
    doc?.addEventListener("scroll", hide, true);
    view?.addEventListener("resize", hide);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      doc?.removeEventListener("keydown", escape);
      doc?.removeEventListener("scroll", hide, true);
      view?.removeEventListener("resize", hide);
    };
  }, []);
  useLayoutEffect(() => {
    const el = tooltip.current,
      view = el?.ownerDocument.defaultView;
    if (!el || !view || !position) return;
    const bounds = el.getBoundingClientRect();
    const top = Math.max(
      8,
      Math.min(position.top, view.innerHeight - bounds.height - 8),
    );
    if (top !== position.top) setPosition({ ...position, top });
    const button = anchor.current?.querySelector("button");
    const previous = button?.getAttribute("aria-describedby");
    button?.setAttribute(
      "aria-describedby",
      [previous, id].filter(Boolean).join(" "),
    );
    return () => {
      if (button) {
        if (previous) button.setAttribute("aria-describedby", previous);
        else button.removeAttribute("aria-describedby");
      }
    };
  }, [position, id]);
  const config = event?.evidence.config || row!.config;
  return (
    <div
      ref={anchor}
      className="alert-summary-anchor"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) hide();
      }}
      aria-describedby={position ? id : undefined}
    >
      {children}
      {position &&
        createPortal(
          <div
            ref={tooltip}
            id={id}
            role="tooltip"
            className="alert-summary-tooltip"
            data-theme={theme}
            style={position}
          >
            <strong>{config.name}</strong>
            <p>
              {event ? event.display_label : row?.display_label} ·{" "}
              {row
                ? alertState(row)
                : event!.evidence.ordinal >= config.max_triggers
                  ? "停止 — 已触发"
                  : "已触发"}
            </p>
            {row && <p>{row.condition_summary}</p>}
            {row?.health_reason && <p>{row.health_reason}</p>}
            {(row || event?.evidence.alert_created_at) && (
              <p>
                创建：
                {formatTimestamp(
                  row?.created_at ?? event!.evidence.alert_created_at!,
                  zone,
                )}
              </p>
            )}
            {(event?.occurred_at || row?.last_triggered_at) && (
              <p>
                上次触发：
                {formatTimestamp(
                  event?.occurred_at || row!.last_triggered_at!,
                  zone,
                )}
              </p>
            )}
            {!row && (
              <p>
                事件身份：{config.source} · {config.timeframe}
              </p>
            )}
          </div>,
          anchor.current!.ownerDocument.body,
        )}
    </div>
  );
}
