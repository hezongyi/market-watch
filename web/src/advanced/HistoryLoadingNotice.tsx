import { useEffect, useState } from "react";
import type { HistoryProgress } from "./nativeHistoryLoads";

export const HISTORY_NOTICE_DELAY_MS = 5000;

export type NativeLoad = HistoryProgress & {
  instrument: string;
  timeframe: string;
  count: number;
  from: number;
  to: number;
  started: number;
  ended?: boolean;
  epoch: number;
};
export type CapacityNotice = {
  id?: number;
  instrument: string;
  timeframe: string;
  phase: "filling" | "limited" | "failed";
  message: string;
  requested?: number;
  actual?: number;
  limit?: number;
  scope?: string;
  resident?: number;
};
const phases = {
  queued: "正在排队",
  checking: "正在检查历史缓存",
  waiting: "正在等待历史补数",
  filling: "正在补齐历史行情",
  delivering: "正在读取并传送历史数据",
  applying: "图表正在处理 K 线",
};
const date = (value: number) =>
  new Date(value).toISOString().slice(0, 16).replace("T", " ");
export function HistoryLoadingNotice({
  loads,
  onCancel,
  capacities,
  onDismiss,
  onSettings,
}: {
  loads: Record<string, NativeLoad>;
  onCancel: () => void;
  capacities: Record<string, CapacityNotice>;
  onDismiss: () => void;
  onSettings: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  const hasLoads = Object.keys(loads).length > 0;
  useEffect(() => {
    if (!hasLoads) return;
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, [hasLoads]);
  const groups = new Map<string, NativeLoad[]>();
  for (const load of Object.values(loads)) {
    const capacity = Object.values(capacities).some((notice) =>
      notice.instrument === load.instrument && notice.timeframe === load.timeframe);
    if (now - load.started < HISTORY_NOTICE_DELAY_MS && !capacity) continue;
    const key = load.instrument + "|" + load.timeframe;
    groups.set(key, [...(groups.get(key) || []), load]);
  }
  const results = Object.entries(capacities);
  if (!groups.size && !results.length) return null;
  const busy =
    Object.values(loads).some((load) => !load.ended) ||
    results.some(([, notice]) => notice.phase === "filling");
  return (
    <aside className="advanced-loading-notice" aria-label="历史数据加载">
      <strong>
        {busy ? "正在加载历史数据" : "历史数据定位结果"}
        {groups.size > 1 ? ` · ${groups.size} 个品种周期` : ""}
      </strong>
      <div role="status" aria-live="polite">
        {results.map(([key, notice]) => (
          <div
            className="history-loading-row history-capacity-result"
            key={key}
          >
            <b>
              {notice.instrument}
              {notice.timeframe ? ` · ${notice.timeframe}` : ""}
            </b>
            <span>{notice.message}</span>
            {Number.isFinite(notice.requested) && (
              <span>请求日期 {date(notice.requested! * 1000)} UTC</span>
            )}
            {Number.isFinite(notice.actual) && (
              <span>实际已定位至 {date(notice.actual! * 1000)} UTC</span>
            )}
            {notice.limit !== undefined && (
              <span>
                {notice.scope === "workspace"
                  ? "工作区加权上限"
                  : "单源容量上限"}{" "}
                {notice.limit.toLocaleString()} 根
                {notice.resident !== undefined
                  ? ` · 本源已加载 ${notice.resident.toLocaleString()} 根`
                  : ""}
              </span>
            )}
          </div>
        ))}
        {[...groups].map(([key, rows]) => {
          const active = rows.filter((row) => !row.ended);
          const candidates = active.length ? active : rows;
          const load = candidates.reduce((a, b) =>
            a.started >= b.started ? a : b,
          );
          const count = load.count;
          const pages = load.pages || 0;
          return (
            <div className="history-loading-row" key={key}>
              <b>
                {load.instrument} · {load.timeframe}
              </b>
              <span>
                {rows.every((row) => row.ended)
                  ? "本次历史处理已结束"
                  : phases[load.phase]}
                {rows.length > 1 ? ` · ${rows.length} 个请求` : ""}
                {rows.length > 1 ? "（下列为最近活动请求）" : ""}
              </span>
              <span>
                请求 {count.toLocaleString()} 根
                {load.phase === "waiting" || load.phase === "filling"
                  ? ` · 本次新增缓存 ${pages} 页 / 预计总共约 ${Math.max(pages, load.estimatedPages || 1)} 页`
                  : pages ? ` · 本次新增缓存共 ${pages} 页`
                    : ["queued", "checking"].includes(load.phase) && load.estimatedPages
                      ? ` · 预计缓存总共约 ${load.estimatedPages} 页` : ""}
                {load.received !== undefined
                  ? ` · 已收到 ${load.received.toLocaleString()} 根`
                  : ""}
              </span>
              <span>
                请求范围 {date(load.from)} — {date(load.to)} UTC
              </span>
            </div>
          );
        })}
      </div>
      {Object.keys(loads).length > 0 && (
        <p className="history-loading-elapsed">
          已等待{" "}
          {Math.max(
            0,
            Math.floor(
              (now -
                Math.min(...Object.values(loads).map((load) => load.started))) /
                1000,
            ),
          )}{" "}
          秒
        </p>
      )}
      {busy && <p>补齐的历史会保存在缓存中，后续访问通常更快。</p>}
      <div className="history-notice-actions">
        {busy && <button onClick={onCancel}>取消历史加载</button>}
        {!!results.length && <button onClick={onSettings}>调整历史容量</button>}
        {results.some(([, notice]) => notice.phase !== "filling") && (
          <button onClick={onDismiss}>关闭提示</button>
        )}
      </div>
    </aside>
  );
}
