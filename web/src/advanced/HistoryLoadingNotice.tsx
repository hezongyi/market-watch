import { useEffect, useState } from "react";
import type { HistoryProgress } from "./nativeHistoryLoads";

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
}: {
  loads: Record<string, NativeLoad>;
  onCancel: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, []);
  const groups = new Map<string, NativeLoad[]>();
  for (const load of Object.values(loads)) {
    if (now - load.started < 250) continue;
    const key = load.instrument + "|" + load.timeframe;
    groups.set(key, [...(groups.get(key) || []), load]);
  }
  if (!groups.size) return null;
  return (
    <aside className="advanced-loading-notice" aria-label="历史数据加载">
      <strong>
        正在加载历史数据{groups.size > 1 ? ` · ${groups.size} 个品种周期` : ""}
      </strong>
      <div role="status" aria-live="polite">
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
                {pages ? ` · 已缓存 ${pages} 页` : ""}
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
      <p>补齐的历史会保存在缓存中，后续访问通常更快。</p>
      <button
        disabled={Object.values(loads).every((load) => load.ended)}
        onClick={onCancel}
      >
        取消历史加载
      </button>
    </aside>
  );
}
