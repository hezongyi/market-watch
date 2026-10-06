import { useEffect, useState } from "react";
import { api } from "../api";

export type QualifiedSeries = {
  id: string;
  ticker: string;
  symbol: string;
  series_kind: "history" | "composite";
  dataset_id: string;
  historical_source: string;
  basis: string;
  calendar: string;
  description: string;
  created?: boolean;
};

export function seriesLabel(row: QualifiedSeries) {
  const source = row.historical_source === "dukascopy" ? "Dukascopy" : row.historical_source === "oanda" ? "OANDA" : row.historical_source;
  const phase = row.calendar === "ny17" ? "NY17" : row.calendar === "utc0" ? "UTC 00:00" : row.calendar;
  return `${row.symbol} · ${source}${row.series_kind === "composite" ? " → OANDA Practice" : ""} · ${row.basis === "bid" ? "Bid" : row.basis} · ${phase}`;
}

/** Pure search; only its caller's explicit submit/open may create live demand. */
export default function SeriesPicker({ kind, selected, onSelect }: {
  kind: "history" | "composite";
  selected: QualifiedSeries | null;
  onSelect: (row: QualifiedSeries | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<QualifiedSeries[]>([]);
  const [pending, setPending] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const title = kind === "history" ? "自建行情" : "组合行情";
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    const timer = setTimeout(async () => {
      try {
        const [items, candidates] = await Promise.all([
          api<QualifiedSeries[]>(`/market-data/series/search?kind=${kind}&query=${encodeURIComponent(query)}&limit=100`, undefined, controller.signal),
          api<any>(kind === "history"
            ? `/market-data/center/datasets?query=${encodeURIComponent(query)}&page_size=100`
            : `/market-data/center/composite-candidates?query=${encodeURIComponent(query)}&page_size=100`, undefined, controller.signal),
        ]);
        if (!controller.signal.aborted) {
          setRows(items);
          setPending(kind === "history" ? candidates.items.filter((r: any) => r.availability !== "available")
            : candidates.items.filter((r: any) => r.status !== "ready_to_open"));
        }
      } catch (e) {
        if (!controller.signal.aborted) setError(String(e));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [query, kind, retry]);
  const options = selected ? [selected, ...rows.filter(row => kind === "history"
    ? row.dataset_id !== selected.dataset_id : row.id !== selected.id)] : rows;
  return <div className="qualified-series-picker">
    <label>查找{title}<input type="search" value={query} maxLength={100}
      onChange={e => setQuery(e.target.value)} placeholder="品种或准确来源代码" /></label>
    <label>品种<select value={selected?.id ?? ""} onChange={e => onSelect(options.find(row => row.id === e.target.value) ?? null)}>
      <option value="">选择{title}</option>
      {options.map(row => <option key={row.id} value={row.id}>{seriesLabel(row)} · {kind === "history" ? "已发布" : row.created ? "已建立" : "首次使用时准备"}</option>)}
    </select></label>
    <div role="status">{loading ? "正在查找…" : error ? "查找失败，所选行情保留。" : !rows.length ? "没有符合条件的可用行情。" : `找到 ${rows.length} 条${title}${rows.length === 100 ? "，请缩小搜索范围查看其他结果" : ""}。`}</div>
    {!loading&&!error&&!rows.length&&<p>可以缩小或更换品种关键词，或<a href="/market-data">去数据中心维护与配置</a>。</p>}
    {error && <p role="alert">{error} <button type="button" className="secondary" onClick={() => setRetry(n => n + 1)}>重试搜索</button></p>}
    {selected && <p>{seriesLabel(selected)} · {kind === "history" ? "下一步选择固定发布版本及区间" : "提交规则后维护实时需求；搜索不会启动采集"}</p>}
    {pending.length > 0 && <details><summary>{pending.length} 条{title}待准备或配置</summary>
      <ul>{pending.map(row => {
        const dataset = kind === "history" ? row : row.dataset;
        return <li key={dataset.id}>{dataset.logical_symbol} · {dataset.identity.source} · {dataset.aggregation_calendar === "ny17" ? "NY17" : "UTC 00:00"} · {kind === "history" ? "尚无可用发布" : row.reason || (row.status === "needs_mapping" ? "缺少实时映射" : "历史待维护")}
          {" "}<a href={`/market-data/datasets/${dataset.id}${kind === "composite" && row.status === "needs_mapping" ? "/mapping" : ""}`}>{kind === "composite" && row.status === "needs_mapping" ? "配置映射" : "查看进度与维护"}</a></li>;
      })}</ul>
    </details>}
  </div>;
}
