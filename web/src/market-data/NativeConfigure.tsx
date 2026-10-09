import { NativeInput, NativeSelect } from "./NativeControls";
import { useEffect, useState } from "react";
import { Link, useSearchParams, useDirtyForm, useActionLock } from "./router";
import { OpenChart } from "./OpenChart";
import { api } from "./api";
import { centerReturn } from "./navigation";

type Parameters = {
  price: "B" | "A" | "M";
  smooth: boolean;
  dailyAlignment: number;
  alignmentTimezone: string;
  weeklyAlignment: string;
};
const defaults: Parameters = {
  price: "B", smooth: false, dailyAlignment: 17,
  alignmentTimezone: "America/New_York", weeklyAlignment: "Sunday",
};
const weekdays = [
  ["Monday", "周一"], ["Tuesday", "周二"], ["Wednesday", "周三"],
  ["Thursday", "周四"], ["Friday", "周五"], ["Saturday", "周六"], ["Sunday", "周日"],
];

export function NativeConfigure() {
  const [query] = useSearchParams(), instrument = query.get("instrument") || "";
  const [values, setValues] = useState(defaults);
  const [meta, setMeta] = useState<{ name: string; symbol: string; display_symbol?: string } | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(0);
  const [result, setResult] = useState<{ ticker: string; metadata: { name: string } } | null>(null);
  const actionLock = useActionLock();
  useDirtyForm("native-configure", values, `${meta?.symbol || ""}:${saved}`);
  useEffect(() => {
    const controller = new AbortController();
    setMeta(null); setResult(null); setError(""); setValues(defaults);
    void api<{ name: string; symbol: string; display_symbol?: string; source: string; native_parameters: Parameters }>(
      "/market-data/resolve", { instrument, series_kind: "provider", timeframe: "M1" }, controller.signal,
    ).then(data => {
      if (controller.signal.aborted) return;
      if (data.source !== "oanda") throw Error("请选择 OANDA 平台品种");
      setMeta(data); setValues(data.native_parameters);
    }).catch(e => { if (!controller.signal.aborted) setError(String(e)); });
    return () => controller.abort();
  }, [instrument]);
  function change<K extends keyof Parameters>(key: K, value: Parameters[K]) {
    setValues(current => ({ ...current, [key]: value })); setResult(null); setError("");
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (!actionLock.acquire()) return; setBusy(true); setError("");
    try {
      setResult(await api("/charts/provider/configure", { instrument, parameters: values })); setSaved(v => v + 1);
    } catch (e) { setError(String(e)); }
    finally { actionLock.release(); setBusy(false); }
  }
  return <section className="data-center">
    <Link to={centerReturn(query, "/market-data?tab=platform")}>返回平台品种</Link>
    <h1>配置原生行情</h1>
    <p>{meta ? `${meta.name} · ${meta.display_symbol || meta.symbol} · OANDA Practice` : "正在核对平台品种…"}</p>
    <p>直接读取 OANDA 返回的各周期原始柱。参数改变会使用独立配置和缓存。</p>
    <form className="dc-form" onSubmit={submit}>
      <fieldset className="dc-native-fields" disabled={!meta || busy}>
        <legend>供应商原生参数</legend>
        <label htmlFor="native-price">价格口径</label><NativeSelect id="native-price" value={values.price} onChange={e => change("price", e.target.value as Parameters["price"])}>
          <option value="B">Bid（买方报价）</option><option value="A">Ask（卖方报价）</option><option value="M">Mid（中间价）</option>
        </NativeSelect>
        <label htmlFor="native-smooth">开盘价</label><NativeSelect id="native-smooth" value={String(values.smooth)} onChange={e => change("smooth", e.target.value === "true")}>
          <option value="false">非平滑：使用本周期首个报价</option><option value="true">平滑：使用上一柱收盘价</option>
        </NativeSelect>
        <label>日对齐小时<NativeInput type="number" min="0" max="23" step="1" required value={values.dailyAlignment}
          onChange={e => change("dailyAlignment", Number(e.target.value))} /></label>
        <label>对齐时区<NativeInput required maxLength={64} list="native-timezones" value={values.alignmentTimezone}
          onChange={e => change("alignmentTimezone", e.target.value)} aria-describedby="native-timezone-hint" /></label>
        <datalist id="native-timezones"><option value="America/New_York" /><option value="UTC" /><option value="Europe/London" /></datalist>
        <p id="native-timezone-hint">使用 IANA 时区名称；夏令时由该时区规则处理。</p>
        <label htmlFor="native-week">周对齐</label><NativeSelect id="native-week" value={values.weeklyAlignment} onChange={e => change("weeklyAlignment", e.target.value)}>
          {weekdays.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </NativeSelect>
        <p>这些是原生柱的供应商参数。自建历史与组合行情使用各自保存的聚合规则。</p>
        <div className="dc-actions"><button type="button" onClick={() => { setValues(defaults); setResult(null); setError(""); }}>恢复默认参数</button>
          <button type="submit" className="primary">{busy ? "保存中…" : "保存原生配置"}</button></div>
      </fieldset>
    </form>
    {error && <p role="alert" className="error">{error}。已填写的参数保留。</p>}
    {result && <div role="status"><p>配置已保存：{result.metadata.name}</p>
      <OpenChart ticker={result.ticker} frame="M1" label="打开配置图表" />
    </div>}
  </section>;
}
