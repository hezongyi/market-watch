import type { ReactNode } from "react";
import { Inbox, WifiOff } from "lucide-react";

/** Shared A06 states; real request/cache state decides which one is shown. */
export function MobileLoading({ label = "正在读取…", rows = 5 }: { label?: string; rows?: number }) {
  return <div className="mobile-loading" role="status" aria-label={label}>
    <p className="mobile-rows-note">{label}</p>
    <div aria-hidden="true">{Array.from({ length: rows }, (_, i) =>
      <div className="mobile-skeleton" key={i}><i /><i /></div>)}</div>
  </div>;
}

export function MobileEmpty({ title, children, offline = false, action }: {
  title: string; children?: ReactNode; offline?: boolean; action?: ReactNode;
}) {
  const Icon = offline ? WifiOff : Inbox;
  return <div className="mobile-state-panel" role="status">
    <span className="mobile-state-icon"><Icon aria-hidden="true" /></span>
    <h3>{title}</h3><p>{children}</p>{action}
  </div>;
}
