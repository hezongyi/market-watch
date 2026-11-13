import { useEffect, useState } from "react";
import { api } from "./api";
import { Feedback } from "./Center";
import { NativeSelect } from "./NativeControls";
import { OpenChart } from "./OpenChart";
import { Link, useActionLock, useCenter, useMounted } from "./router";
import { useSnapshot } from "./useSnapshot";
import { time } from "./types";

export type Continuation = {
  dataset_id: string; supported: boolean; reason: string | null; enabled: boolean;
  ready_to_enable: boolean; status: string; default_mapping_id: string | null;
  mappings: { id: string; valid_for_selection: boolean; current_account: boolean;
    target_display_symbol?: string; target_identity: { provider_symbol: string }; match: { difference?: string } }[];
  composite: null | { id: string; historical_source_display?: string; live_source_display?: string;
    active_revision_id: string; revision: { history_version_id: string; seam: number };
    preparation: { status: string; confirmed_end: number; error: string | null } };
};
export const continuationNames: Record<string, string> = {
  disabled: "已关闭", preparing: "准备中", receiving: "运行中", recovering: "恢复中",
  inactive: "等待实时来源", market_closed: "闭市", attention: "异常",
  account_changed: "账户已变化", unauthorized: "认证异常", provider_maintenance: "来源维护中",
};

export function DatasetContinuation({ id }: { id: string }) {
  const [refresh, setRefresh] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [selection, setSelection] = useState("");
  const result = useSnapshot<Continuation>(`/market-data/datasets/${id}/continuation`, refresh);
  const row = result.data, mounted = useMounted(), lock = useActionLock();
  useEffect(() => { setSelection(row?.default_mapping_id || ""); }, [row?.default_mapping_id]);
  async function save(enabled: boolean) {
    if (!row || !lock.acquire()) return;
    setBusy(true); setError("");
    try {
      await api(`/market-data/datasets/${id}/continuation`, { enabled, ...(selection ? { mapping_id: selection } : {}) });
      if (mounted.current) setRefresh(value => value + 1);
    } catch (error) { if (mounted.current) setError(String(error)); }
    finally { lock.release(); if (mounted.current) setBusy(false); }
  }
  const valid = row?.mappings.filter(item => item.current_account && item.valid_for_selection) || [];
  const composite = row?.composite;
  return <section className="dc-management-section" aria-label="实时接续">
    <h2>实时接续</h2>
    <p>在固定历史基线上接入实时来源。历史定时维护与实时接续分别控制。</p>
    <Feedback error={result.error} loading={result.loading} empty={!row} />
    {error && <p role="alert" className="error">{error}</p>}
    {row && <>
      <div className="dc-actions">
        <button role="switch" aria-label="实时接续" aria-checked={row.enabled}
          disabled={busy || !!result.error || (!row.enabled && (!row.supported || !selection))}
          onClick={() => void save(!row.enabled)}>{busy ? "正在保存…" : row.enabled ? "关闭实时接续" : "开启实时接续"}</button>
        <span role="status">{continuationNames[row.status] || row.status}</span>
      </div>
      {row.reason && <p>{row.reason}</p>}
      {!!valid.length && <div className="dc-fields"><label>默认接续配置<NativeSelect aria-label="默认接续配置" value={selection} disabled={busy}
        onChange={event => setSelection(event.target.value)}>
        <option value="">请选择配置</option>
        {valid.map(item => <option key={item.id} value={item.id}>OANDA · {item.target_display_symbol || item.target_identity.provider_symbol} · {item.id.slice(0, 8)}</option>)}
      </NativeSelect></label>
      {row.enabled && selection !== row.default_mapping_id && <button disabled={busy || !selection} onClick={() => void save(true)}>使用此接续配置</button>}
      </div>}
      {row.supported && <Link to={`/market-data/datasets/${id}/mapping?return_to=${encodeURIComponent(`/market-data/datasets/${id}?section=continuation`)}`}>配置与核对实时来源</Link>}
      {composite && <>
        <dl className="dc-detail-facts">
          <div><dt>历史来源</dt><dd>{composite.historical_source_display}</dd></div>
          <div><dt>接续来源</dt><dd>{composite.live_source_display || "OANDA Practice"}</dd></div>
          <div><dt>拼接点</dt><dd>{time(composite.revision.seam)}</dd></div>
          <div><dt>最新确认至</dt><dd>{time(composite.preparation.confirmed_end || null)}</dd></div>
        </dl>
        {composite.preparation.error && <p role="alert">{composite.preparation.error}</p>}
        {row.mappings.find(item => item.id === row.default_mapping_id)?.match.difference && <p>{row.mappings.find(item => item.id === row.default_mapping_id)?.match.difference}</p>}
        <div className="dc-actions">
          {row.enabled && composite.preparation.status === "queried" && <OpenChart ticker={`MWC:${composite.id}`} label="打开接续图表" />}
          <OpenChart ticker={`MWH:${composite.revision.history_version_id}`} label="查看固定历史" />
          <Link to={`/market-data/composites/${composite.id}?return_to=${encodeURIComponent(`/market-data/datasets/${id}?section=continuation`)}`}>查看接续修订与健康</Link>
        </div>
      </>}
      {!row.enabled && <p>已确认尾部和配置保留；依赖实时接续的告警暂停判定，重新开启后按原规则恢复。</p>}
    </>}
  </section>;
}

/** Resolve the explicit view only when opened; list rows never poll full details. */
export function ManagedOpenChart({ id, ticker, frame = "M1" }: { id: string; ticker: string; frame?: string }) {
  const { apply, busy: centerBusy } = useCenter(), mounted = useMounted(), lock = useActionLock();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function open() {
    if (centerBusy || !lock.acquire()) return;
    setBusy(true); setError("");
    try {
      const row = await api<Continuation>(`/market-data/datasets/${id}/continuation`);
      if (!mounted.current) return;
      if (row.enabled && (!row.ready_to_enable || !row.composite || row.composite.preparation.status !== "queried")) {
        throw Error(row.reason || "实时接续准备中，可在发布版本中查看固定历史");
      }
      await apply(row.enabled ? `MWC:${row.composite!.id}` : ticker, frame);
    } catch (error) { if (mounted.current) setError(String(error)); }
    finally { lock.release(); if (mounted.current) setBusy(false); }
  }
  return <><button disabled={busy || centerBusy} onClick={() => void open()}>{busy ? "正在打开…" : "打开图表"}</button>{error && <span role="alert" className="error">{error}</span>}</>;
}
