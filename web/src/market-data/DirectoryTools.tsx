import { useEffect, useState } from "react";
import { api } from "./api";
import { names, time } from "./types";
import { NativeInput, NativeSelect } from "./NativeControls";

type Status = { source: string; scope: string; partition: string; status: string; count?: number; last_success?: number; error?: string };

/** Local list reads and provider synchronization are separate user actions. */
export function DirectoryTools({ source = "", refreshed }: { source?: string; refreshed: () => void }) {
  const [selected, select] = useState(source || "dukascopy"), [market, setMarket] = useState("a");
  const [statuses, setStatuses] = useState<Status[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [symbol, setSymbol] = useState("");
  async function discover() {
    setBusy(true); setError("");
    try { await api("/market-data/catalog/discover", {symbol}); refreshed(); }
    catch(e) { setError(String(e)); } finally { setBusy(false); }
  }
  const [revision, setRevision] = useState(0);
  useEffect(() => { if (source) select(source); }, [source]);
  useEffect(() => {
    const abort = new AbortController();
    api<Status[]>(`/market-data/catalog/directory-status?source=${selected}`, undefined, abort.signal)
      .then(setStatuses).catch(e => { if (!abort.signal.aborted) setError(String(e)); });
    return () => abort.abort();
  }, [selected, revision]);
  async function sync() {
    setBusy(true); setError("");
    try { await api(`/market-data/history-catalog/refresh?market=${market}`, { source: selected }); refreshed(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); setRevision(v => v + 1); }
  }
  return <div className="dc-create-notice">
    <label>供应商目录 <NativeSelect aria-label="更新目录来源" value={selected} disabled={busy} onChange={e => select(e.target.value)}>
      {Object.entries(names).filter(([key]) => ["dukascopy", "oanda", "binance", "yahoo", "akshare", "fxcm"].includes(key)).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
    </NativeSelect></label>
    {selected === "akshare" && <label>市场 <NativeSelect aria-label="更新目录市场" value={market} disabled={busy} onChange={e => setMarket(e.target.value)}>
      <option value="a">沪深 A 股</option><option value="hk">港股</option><option value="futures">新浪主力连续期货</option>
    </NativeSelect></label>}
    <button disabled={busy} onClick={() => void sync()}>{busy ? "正在更新供应商目录…" : "更新供应商目录"}</button>
    <button disabled={busy} onClick={refreshed}>刷新列表</button>
    {selected === "yahoo" && <p>公开分区：CCC 美元报价加密资产、美国股票筛选。超过分页上限的分区保留旧目录并显示失败；不代表全球全集。排除沪深京及港股。</p>}
    {selected === "yahoo" && <label>精确代码补录 <NativeInput aria-label="Yahoo 精确代码" value={symbol} disabled={busy} onChange={e => setSymbol(e.target.value)} /><button disabled={busy || !symbol.trim()} onClick={() => void discover()}>验证并补录代码</button></label>}
    <div role="status" aria-live="polite">{statuses.length ? statuses.map(row => <p key={`${row.scope}:${row.partition}`}>
      {row.partition} · {row.status === "complete" ? "完整分区" : row.status === "failed" ? "更新失败，保留旧目录" : "部分目录"} · 最近成功 {time(row.last_success ?? null)} · {row.count ?? 0} 项{row.error ? ` · ${row.error}` : ""}
    </p>) : "尚无目录同步记录；可更新供应商目录。"}</div>
    {error && <p role="alert" className="error">{error}</p>}
  </div>;
}
