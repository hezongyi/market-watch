import { NativeInput, NativeSelect } from "./NativeControls";
import { useEffect, useState } from "react";
import { api } from "./api";

export type QualifiedSeries = {
  id: string;
  ticker: string;
  symbol: string;
  display_symbol?: string;
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
  return `${row.display_symbol || row.symbol} · ${source}${row.series_kind === "composite" ? " → OANDA Practice" : ""} · ${row.basis === "bid" ? "Bid" : row.basis} · ${phase}`;
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
  const [source, setSource] = useState(""), [calendar, setCalendar] = useState("");
  const [offsets, setOffsets] = useState([0]), [nextOffset, setNextOffset] = useState<number | null>(null);
  const [pendingPage, setPendingPage] = useState(1), [pendingTotal, setPendingTotal] = useState(0);
  const title = kind === "history" ? "自建行情" : "组合行情";
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    const timer = setTimeout(async () => {
      try {
        const filters = `query=${encodeURIComponent(query)}&source=${source}&calendar=${calendar}`;
        const [items, candidates] = await Promise.all([
          api<{items:QualifiedSeries[];next_offset:number|null}>(`/market-data/series/page?kind=${kind}&${filters}&page_size=25&offset=${offsets.at(-1)}`, undefined, controller.signal),
          api<any>(kind === "history"
            ? `/market-data/center/datasets?${filters}&page_size=25&page=${pendingPage}`
            : `/market-data/center/composite-candidates?${filters}&page_size=25&page=${pendingPage}`, undefined, controller.signal),
        ]);
        if (!controller.signal.aborted) {
          setRows(items.items); setNextOffset(items.next_offset); setPendingTotal(candidates.total);
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
  }, [query, kind, retry, source, calendar, offsets, pendingPage]);
  function resetPages() { setOffsets([0]); setPendingPage(1); }
  const options = selected ? [selected, ...rows.filter(row => kind === "history"
    ? row.dataset_id !== selected.dataset_id : row.id !== selected.id)] : rows;
  return <div className="qualified-series-picker">
    <label>查找{title}<NativeInput type="search" value={query} maxLength={100}
      onChange={e => { setQuery(e.target.value); resetPages(); }} placeholder="品种或准确来源代码" /></label>
    <label>历史来源<NativeSelect aria-label="历史来源" value={source} onChange={e => { setSource(e.target.value); resetPages(); }}>
      <option value="">全部来源</option><option value="dukascopy">Dukascopy</option><option value="oanda">OANDA</option><option value="fxcm">FXCM Demo</option><option value="binance">Binance</option>
    </NativeSelect></label>
    <label>聚合日界<NativeSelect aria-label="聚合日界" value={calendar} onChange={e => { setCalendar(e.target.value); resetPages(); }}>
      <option value="">全部日界</option><option value="ny17">NY17</option><option value="utc0">UTC 00:00</option>
    </NativeSelect></label>
    <label>品种<NativeSelect disabled={loading} value={selected?.id ?? ""} onChange={e => onSelect(options.find(row => row.id === e.target.value) ?? null)}>
      <option value="">选择{title}</option>
      {options.map(row => <option key={row.id} value={row.id}>{seriesLabel(row)} · {kind === "history" ? "已发布" : row.created ? "已建立" : "首次使用时准备"}</option>)}
    </NativeSelect></label>
    <div role="status">{loading ? "正在查找…" : error ? "查找失败，所选行情保留。" : !rows.length ? "没有符合条件的可用行情。" : `本页 ${rows.length} 条${title}。`}</div>
    <nav className="dc-actions" aria-label={`${title}搜索分页`}>
      <button type="button" disabled={loading || offsets.length === 1} onClick={() => setOffsets(current => current.slice(0,-1))}>上一页行情</button>
      <span>第 {offsets.length} 页</span>
      <button type="button" disabled={loading || error !== "" || nextOffset === null} onClick={() => setOffsets(current => [...current,nextOffset!])}>下一页行情</button>
    </nav>
    {!loading&&!error&&!rows.length&&<p>可以缩小或更换品种关键词，请从图表顶部的数据中心维护与配置。</p>}
    {error && <p role="alert">{error} <button type="button" className="secondary" onClick={() => setRetry(n => n + 1)}>重试搜索</button></p>}
    {selected && <p>{seriesLabel(selected)} · {kind === "history" ? "下一步选择固定发布版本及区间" : "提交规则后维护实时需求；搜索不会启动采集"}</p>}
    {pendingTotal > 0 && <details><summary>查看{title}准备与配置（本页待处理 {pending.length} 条）</summary>
      <ul>{pending.map(row => {
        const dataset = kind === "history" ? row : row.dataset;
        return <li key={dataset.id}>{dataset.display_symbol || dataset.logical_symbol} · {dataset.identity.source} · {dataset.aggregation_calendar === "ny17" ? "NY17" : "UTC 00:00"} · {kind === "history" ? "尚无可用发布" : row.reason || (row.status === "needs_mapping" ? "缺少实时映射" : "历史待维护")}
          。请从图表顶部的数据中心维护与配置。</li>;
      })}</ul>
      {pending.length === 0 && <p>本页没有待准备或配置项，可继续翻页查看其他自建行情。</p>}
      <nav className="dc-actions" aria-label="准备与配置分页">
        <button type="button" disabled={loading || pendingPage === 1} onClick={() => setPendingPage(n => n-1)}>上一页维护状态</button>
        <span>自建行情共 {pendingTotal} 条 · 第 {pendingPage} 页</span>
        <button type="button" disabled={loading || pendingPage*25 >= pendingTotal} onClick={() => setPendingPage(n => n+1)}>下一页维护状态</button>
      </nav>
    </details>}
  </div>;
}
