import { DetailPanel, useDetailPanel } from "./DetailPanel";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { NativeInput, NativeSelect, NativeSlot, NativeUiContext } from "./NativeControls";
import { api } from "./api";
import { Link, useCenter, useMounted, useSearchParams } from "./router";
import { centerLink, useCenterRowRestore } from "./navigation";
import { names, time, type Page } from "./types";
import { OpenChart } from "./OpenChart";

const categories = [
  ["", "全部"], ["forex", "外汇"], ["stock", "股票"], ["crypto", "加密"],
  ["index", "指数"], ["fund", "基金"], ["futures", "期货"], ["commodity", "金属"], ["other", "其他"],
] as const;
const assetTypes: Record<string, string> = { stock: "equity", fund: "etf", futures: "future", commodity: "metal" };
const symbolTypes = categories.map(([value, name]) => ({ value, name }));
type Instrument = {
  id: string; source: string; provider_symbol: string; display_symbol: string; label: string;
  provider_name?: string;
  asset_class: string; available: boolean; updated_at: number | null; history_precision: number | null;
  logical_symbol?: string;
  capabilities: { native_periods: string[]; history_m1: boolean; native_confirmation: string };
};
type SearchRequest = { text?: string; type?: string; exchange?: string; start?: number; signal: AbortSignal };
const rowId = (id: string) => `platform-${id.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;

/** Native symbol-search presentation with management actions and platform-only data. */
export function PlatformMarket() {
  const ui = useContext(NativeUiContext), { apply, busy } = useCenter(), mounted = useMounted();
  const [params, setParams] = useSearchParams();
  const [detail, setDetail] = useState<Instrument | null>(null), [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [revision, setRevision] = useState(0);
  const panel = useDetailPanel();
  const known = useRef(new Map<string, Instrument>()), active = useRef("");
  const latest = useRef({ params, setParams }); latest.current = { params, setParams };
  const query = params.get("query") || "", source = params.get("source") || "", asset = params.get("asset_class") || "";
  const getPage = useCallback(async ({ text = "", type = "", exchange = "", start = 0, signal }: SearchRequest) => {
    const source = exchange.toLowerCase(), asset = assetTypes[type] || type;
    const signature = JSON.stringify([text, asset, source]);
    if (signature !== active.current || start === 0) { known.current.clear(); active.current = signature; }
    const size = 50, page = Math.floor(start / size) + 1;
    const previous = latest.current.params;
    const restorePages = start === 0 && text === (previous.get("query") || "") && source === (previous.get("source") || "") && asset === (previous.get("asset_class") || "") ? Math.min(100, Math.max(1, Number(previous.get("page")) || 1)) : 1;
    const search = new URLSearchParams({ query: text, source, asset_class: asset, page: String(page), page_size: String(size) });
    const next = new URLSearchParams(latest.current.params);
    next.set("tab", "platform"); next.set("query", text); next.set("source", source); next.set("asset_class", asset); next.delete("page");
    const filtersChanged = text !== (previous.get("query") || "") || source !== (previous.get("source") || "") || asset !== (previous.get("asset_class") || "");
    if (filtersChanged) { setDetail(null); latest.current.setParams(next, { replace: true }); }
    const result = await api<Page<Instrument>>(`/market-data/center/platform?${search}`, undefined, signal);
    // Returning from a management form restores the loaded prefix and row.
    // Filters still start at page one; the UI never exposes page controls.
    for (let nextPage = 2; nextPage <= restorePages && result.items.length < result.total; nextPage++) {
      search.set("page", String(nextPage));
      const continuation = await api<Page<Instrument>>(`/market-data/center/platform?${search}`, undefined, signal);
      result.items.push(...continuation.items);
    }
    if (signal.aborted || !mounted.current || signature !== active.current) throw new DOMException("查询已取消", "AbortError");
    const remembered = new URLSearchParams(next);
    remembered.set("page", String(start === 0 ? Math.ceil(result.items.length / size) || 1 : page));
    if (remembered.toString() !== latest.current.params.toString()) latest.current.setParams(remembered, { replace: true });
    const symbols = result.items.map(row => {
      const ticker = `MWP:${row.id}`; known.current.set(ticker, row);
      const type = Object.entries(assetTypes).find(([, value]) => value === row.asset_class)?.[0] || row.asset_class;
      return { symbol: row.display_symbol || row.provider_symbol, ticker, full_name: ticker,
        description: row.label, exchange: row.source.toUpperCase(), type,
        category: categories.find(([value]) => value === type)?.[1] || "其他", sourceName: row.provider_name || names[row.source] || row.source, rowId: rowId(row.id),
        available: row.available && row.capabilities.native_periods.length > 0 };
    });
    setRevision(value => value + 1);
    return { symbols, symbols_remaining: Math.max(0, result.total - start - result.items.length) };
  }, [mounted]);
  const open = useCallback(async (ticker: string) => {
    const row = known.current.get(ticker);
    if (!row?.available || !row.capabilities.native_periods.length) { setError("所选行情已变化，请重新查询。"); throw Error("所选行情已变化，请重新查询。"); }
    if (busy) return;
    const frame = row.capabilities.native_periods.includes("H1") ? "H1" : row.capabilities.native_periods[0];
    setError("");
    try { await apply(ticker, frame); }
    catch (error) { if (mounted.current) setError(String(error)); throw error; }
  }, [apply, busy, mounted]);
  const selectDetail = useCallback((ticker: string) => { panel.open(); setDetail(known.current.get(ticker) || null); }, [panel.open]);
  useCenterRowRestore(revision);
  return <section className="data-center dc-platform">
    <h1 className="dc-platform-title">平台行情</h1>
    {error && <p role="alert" className="error">{error}</p>}
    {ui ? <NativeSlot key={refresh} kind="platformSearch" className="dc-platform-search" props={{
      query, source, asset: Object.entries(assetTypes).find(([, value]) => value === asset)?.[0] || asset,
      symbolTypes, getPage, onOpen: open, onDetails: selectDetail, busy,
    }} /> : <PlatformFallback key={refresh} query={query} source={source} asset={asset}
      filter={(key, value) => { const next = new URLSearchParams(params); next.set(key, value); next.delete("page"); setDetail(null); setParams(next); }} onDetails={row => { setDetail(row); panel.open(); }} />}
    {detail && panel.opened && <DetailPanel title={`${detail.display_symbol || detail.provider_symbol} · ${detail.label}`} close={() => { setDetail(null); panel.close(); }}>
      <p>来源：{detail.provider_name || names[detail.source] || detail.source} · 原生周期：{detail.capabilities.native_periods.join(" · ") || "尚未接入"}</p>
      <p>M1 历史：{detail.capabilities.history_m1 ? "支持" : "未开放"} · 目录更新时间：{time(detail.updated_at)}</p>
      {detail.capabilities.native_confirmation === "not_supplied" && <p>来源未提供确认标记；按周期结束时间显示。</p>}
      <div className="dc-actions">
        {detail.available && detail.source === "oanda" && <Link to={centerLink(`/market-data/platform/configure?instrument=${encodeURIComponent(detail.id)}`, params, rowId(detail.id))}>配置原生参数</Link>}
        {["dukascopy", "oanda", "fxcm"].includes(detail.source) && detail.capabilities.history_m1 && (!detail.logical_symbol || detail.logical_symbol.length <= 10) &&
          <Link to={centerLink(`/market-data/datasets/new?source=${detail.source}&symbol=${encodeURIComponent(detail.provider_symbol)}${detail.history_precision == null ? "" : `&precision=${detail.history_precision}`}`, params, rowId(detail.id))}>添加为自建行情</Link>}
        <button onClick={() => { setDetail(null); panel.close(); setRefresh(value => value + 1); }}>刷新目录</button>
      </div>
    </DetailPanel>}
  </section>;
}

/** Resource/version fallback retains the same continuous-list workflow. */
function PlatformFallback({ query, source, asset, filter, onDetails }: {
  query: string; source: string; asset: string; filter: (key: string, value: string) => void; onDetails: (row: Instrument) => void;
}) {
  return <div className="dc-platform-fallback">
    <NativeInput type="search" aria-label="搜索品种" value={query} placeholder="品种代码或名称" onChange={event => filter("query", event.target.value)} />
    <nav className="dc-platform-categories" aria-label="品种类别">{categories.map(([type, label]) => <button key={type} aria-pressed={asset === (assetTypes[type] || type)} onClick={() => filter("asset_class", assetTypes[type] || type)}>{label}</button>)}</nav>
    <div className="dc-platform-table-heading"><span>商品代码</span><span>描述</span><NativeSelect aria-label="来源" value={source} onChange={event => filter("source", event.target.value)}><option value="">全部来源</option>{Object.entries(names).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</NativeSelect></div>
    <FallbackRows key={`${query}:${source}:${asset}`} query={query} source={source} asset={asset} onDetails={onDetails} />
  </div>;
}

function FallbackRows({query, source, asset, onDetails}: {query:string;source:string;asset:string;onDetails:(row:Instrument)=>void}) {
  const [items, setItems] = useState<Instrument[]>([]), [error, setError] = useState("");
  const [loading, setLoading] = useState(true), [remaining, setRemaining] = useState(true), [retry, setRetry] = useState(0);
  const [page, setPage] = useState(1), list = useRef<HTMLDivElement>(null), sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setError("");
    const search = new URLSearchParams({ query, source, asset_class: asset, page: String(page), page_size: "50" });
    api<Page<Instrument>>(`/market-data/center/platform?${search}`, undefined, abort.signal).then(result => {
      if (abort.signal.aborted) return;
      setItems(old => [...new Map([...old, ...result.items].map(row => [row.id, row])).values()]);
      setRemaining(page * 50 < result.total);
    }).catch(error => { if (!abort.signal.aborted) setError(String(error)); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [query, source, asset, page, retry]);
  useEffect(() => {
    if (!sentinel.current || loading || error || !remaining) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) setPage(value => value + 1); }, { root: list.current, rootMargin: "0px 0px 80px" });
    observer.observe(sentinel.current); return () => observer.disconnect();
  }, [loading, error, remaining]);
  return <div className="dc-platform-fallback-list dc-table" ref={list}>
      {items.map(row => <div className="dc-platform-fallback-row" key={row.id} id={rowId(row.id)} tabIndex={-1}>
        <strong>{row.display_symbol || row.provider_symbol}</strong><span>{row.label}</span><span>{row.provider_name || names[row.source]}</span><div>
          {row.available && !!row.capabilities.native_periods.length && <OpenChart ticker={`MWP:${row.id}`} frame={row.capabilities.native_periods.includes("H1") ? "H1" : row.capabilities.native_periods[0]} label="打开图表" />}
          <button onClick={() => onDetails(row)}>详情</button></div></div>)}
      <div ref={sentinel} role={error ? "alert" : "status"} className="mw-platform-status">{error ? <>{error}<button onClick={() => setRetry(value => value + 1)}>重试</button></> : loading ? "正在加载…" : !items.length ? "没有符合筛选的行情" : !remaining ? "已全部加载" : ""}</div>
    </div>;
}
