import { useEffect, useRef, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { PULL_THRESHOLD, usePullRefresh } from "./usePullRefresh";
import { MOBILE_OVERLAYS } from "./WatchOverlays";
import { logFailure } from "./logs";

/** Alert lists share the Data page gesture while retaining their own reads. */
export default function AlertListRefresh({
  active,
  online,
  loading,
  resetKey,
  refresh,
  children,
}: {
  active: boolean;
  online: boolean;
  loading: boolean;
  resetKey: string;
  refresh(): Promise<void>;
  children: ReactNode;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const [foreground, setForeground] = useState(!document.hidden && navigator.onLine);
  const [refreshing, setRefreshing] = useState(false);
  const generation = useRef(0), pending = useRef(false);
  useEffect(() => {
    const change = () => setForeground(!document.hidden && navigator.onLine);
    document.addEventListener("visibilitychange", change);
    addEventListener("online", change);
    addEventListener("offline", change);
    return () => {
      document.removeEventListener("visibilitychange", change);
      removeEventListener("online", change);
      removeEventListener("offline", change);
    };
  }, []);
  const enabled = active && online && foreground;
  useEffect(() => {
    generation.current++;
    pending.current = false;
    setRefreshing(false);
    return () => { generation.current++; };
  }, [enabled, resetKey]);
  const distance = usePullRefresh(scroll, enabled, refreshing || loading, () => {
    if (!enabled || pending.current || document.querySelector(MOBILE_OVERLAYS)) return;
    const current = ++generation.current;
    pending.current = true;
    setRefreshing(true);
    void refresh().catch(error => logFailure("告警", "下拉刷新", error)).finally(() => {
      if (current !== generation.current) return;
      pending.current = false;
      setRefreshing(false);
    });
  });
  return (
    <div ref={scroll} className="alert-list-scroll">
      <div
        className="mobile-pull-refresh"
        style={{ height: refreshing ? PULL_THRESHOLD : distance }}
        role="status"
        data-refreshing={refreshing || undefined}
      >
        {(refreshing || distance > 8) && <>
          <RefreshCw aria-hidden="true" style={refreshing ? undefined : { transform: `rotate(${distance * 3}deg)` }} />
          <span>{refreshing ? "正在刷新…" : distance >= PULL_THRESHOLD ? "松开刷新" : "下拉刷新"}</span>
        </>}
      </div>
      {children}
    </div>
  );
}
