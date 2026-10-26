import { useState } from "react";
import { Link } from "./router";
import { useSnapshot } from "./useSnapshot";

type Provider = {
  error: string | null; authentication_hold: boolean; next_probe_at: number | null;
  configured?: boolean; collection_recorded?: boolean;
  connection_started_at?: number | null; authentication_probe_at?: number | null; error_observed_at?: number | null;
};
type Live = {
  dataset_id: string; logical_symbol: string; quality: string;
  market_session: "closed" | "scheduled_open" | "unknown"; calendar_verified: boolean;
  next_session_at: number | null; authentication_hold: boolean; connection_error: string | null;
  error: string | null; connection: string; quote_ready: boolean; candle_ready: boolean; recovery_ready: boolean;
  observation_mode?: "candle_close_sample" | "stream_quote"; sample_ready?: boolean;
  quote: { source_time?: number } | null; received_at: number | null; heartbeat_at: number | null;
  last_confirmed_m1: number | null; next_probe_at: number | null;
  session_configuration?: {profile_reason?: string | null; reviewed_start?: string | null; reviewed_end?: string | null};
};
type Status = { provider: Provider; datasets: Live[] };
const errors: Record<string, string> = {
  unauthorized: "后台记录鉴权失败", provider_maintenance: "后台记录上游维护", timeout: "后台记录请求超时",
  rate_limited: "后台记录请求受限", source_unavailable: "后台记录来源暂不可用",
  invalid_payload: "后台记录数据校验失败", m1_late: "完成分钟柱迟到",
};
const connections: Record<string, string> = {
  connected: "已连接", recovering: "恢复中", disconnected: "已断开", closed: "闭市", inactive: "采集未活动",
};
function statusTime(value?: number | null) {
  return value && Number.isFinite(value)
    ? new Intl.DateTimeFormat("zh-CN", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)) + " UTC"
    : "时间未提供";
}
function ScheduledCheck({ at }: { at?: number | null }) {
  return <span>{at ? `${at <= Date.now() ? "原计划检查时间（已过期）" : "下次计划检查"}：${statusTime(at)}` : "计划检查时间未提供"}</span>;
}
function Session({ row }: { row: Live }) {
  const reasons: Record<string,string> = {
    missing_profile:'尚未配置已审核时段，请核对来源会话配置',
    outside_reviewed_window:'时段审核窗已失效，请复核并更新配置',
    identity_mismatch:'时段配置与当前来源身份不一致，请核对配置',
    boundary_minute:'当前处于开闭市边界，等待来源确认',
  };
  const reason=row.session_configuration?.profile_reason;
  return <>
    <span className="dc-source-session">{row.market_session === "closed" ? "闭市" : row.market_session === "scheduled_open" && row.calendar_verified ? "已核实交易时段" : "时段尚未核实"}</span>
    {row.market_session === "closed" && row.next_session_at ? <small>{row.next_session_at <= Date.now() ? "记录的下一时段时间（已过期）" : "已核实下一时段"}：{statusTime(row.next_session_at)}</small> : null}
    {reason && reasons[reason] ? <small>{reasons[reason]}</small> : null}
  </>;
}
function observationReady(row: Live) {
  return row.observation_mode === "candle_close_sample" ? row.sample_ready : row.quote_ready;
}
function overview(provider: Provider, rows: Live[]) {
  if (provider.configured === false) return "来源未配置";
  if (provider.authentication_hold || rows.some(row => row.authentication_hold)) return "鉴权暂停";
  if (provider.error) return errors[provider.error] || "后台记录实时供源异常";
  if (!rows.length) return "尚无实时采集记录";
  if (rows.every(row => row.market_session === "closed")) return "闭市";
  if (rows.every(row => observationReady(row) && row.candle_ready))
    return rows.some(row => row.observation_mode === "candle_close_sample")
      ? "实时采样与完成 K 线已就绪" : "实时报价与完成 K 线已就绪";
  return "部分实时数据尚未就绪，请查看各品种状态";
}

/** Stored reads only. Mounting, polling and refreshing never create live demand. */
export function LiveProviderStatus() {
  const [refresh, setRefresh] = useState(0);
  const snapshot = useSnapshot<Status>("/market-data/live/status", refresh);
  const provider = snapshot.data?.provider, rows = snapshot.data?.datasets ?? [];
  const held = provider?.authentication_hold || rows.some(row => row.authentication_hold);
  return <section className="data-center dc-sources" aria-label="来源状态">
    <header className="dc-heading" data-source-loading={snapshot.loading}>
      <div><h1 id="dc-sources-title" tabIndex={-1}>来源状态</h1><p className="dc-source-read-time">最近成功读取：<time>{snapshot.at ? statusTime(snapshot.at) : "尚未成功读取"}</time></p></div>
      <button id="dc-source-refresh" disabled={snapshot.loading} onClick={() => setRefresh(value => value + 1)}>刷新状态</button>
    </header>
    {snapshot.loading && <p role="status">{snapshot.data ? "正在刷新状态…" : "正在读取状态…"}</p>}
    {snapshot.error && <p role="alert" className="error">状态暂时无法读取。{snapshot.data ? "保留上次结果及其读取时间。" : "尚无可展示的状态快照。"}稍后自动重试，也可刷新状态。</p>}
    {provider && <>
      <section className="dc-source-overview" aria-labelledby="dc-source-oanda">
        <h2 id="dc-source-oanda">OANDA · Practice</h2><p className="dc-source-summary">{overview(provider, rows)}</p>
        {provider.configured === false && <p>请检查 OANDA Practice 账户和令牌配置；此页面不会校验或更改账户。</p>}
        {provider.configured === undefined && <p>配置状态未提供。</p>}
        {!rows.length && <p>当前账户暂无品种实时采集记录；读取此页面不会启动采集。</p>}
        {held && <p>鉴权暂停需检查账户和令牌配置，并等待后台账户与报价接口校验；刷新状态只读取结果，不会解除暂停。</p>}
        <p>实时行情与完成 K 线分别按后台就绪结果展示；K 线采样不提供逐笔买卖报价。</p>
      </section>
      {rows.length > 0 && <section aria-labelledby="dc-source-symbols">
        <h2 id="dc-source-symbols">品种状态</h2>
        <table className="dc-source-table" aria-label="OANDA 品种实时状态">
          <thead><tr><th scope="col">商品代码</th><th scope="col">实时行情</th><th scope="col">最后观测时间</th><th scope="col">完成 K 线</th><th scope="col">最后确认分钟柱（结束）</th><th scope="col">交易时段</th></tr></thead>
          <tbody>{rows.map(row => <tr key={row.dataset_id}>
            <th scope="row" data-label="商品代码">{row.logical_symbol}</th>
            <td data-label="实时行情">{observationReady(row) ? "已就绪" : "未就绪"}<small>{row.observation_mode === "candle_close_sample" ? "K 线采样" : "逐笔买卖报价"}</small></td>
            <td data-label="最后观测时间"><time>{row.observation_mode === "candle_close_sample" ? statusTime(row.received_at) : row.quote?.source_time ? statusTime(row.quote.source_time) : "尚无报价记录"}</time></td>
            <td data-label="完成 K 线">{row.candle_ready ? "已就绪" : "未就绪"}<small>{row.candle_ready ? "完成柱确认已就绪" : "完成 K 线尚未就绪"}</small></td>
            <td data-label="最后确认分钟柱（结束）"><time>{row.last_confirmed_m1 ? statusTime(row.last_confirmed_m1) : "尚无分钟柱记录"}</time></td>
            <td data-label="交易时段"><Session row={row} /></td>
          </tr>)}</tbody>
        </table>
      </section>}
      <details className="dc-source-diagnostics">
        <summary id="dc-source-diagnostics-toggle">诊断详情</summary>
        <dl className="dc-source-facts">
          <div><dt>接口账户配置</dt><dd>{provider.configured === undefined ? "未提供" : provider.configured ? "账户和令牌已配置（不代表已校验）" : "未配置"}</dd></div>
          <div><dt>采集记录</dt><dd>{provider.collection_recorded === undefined ? "未提供" : provider.collection_recorded ? "已有后台账户记录" : "暂无后台账户记录"}</dd></div>
          <div><dt>账户连接开始时间</dt><dd>{statusTime(provider.connection_started_at)}</dd></div>
          <div><dt>鉴权暂停</dt><dd>{held ? "已暂停；刷新不能解除" : "快照未记录暂停"}</dd></div>
          <div><dt>来源错误</dt><dd>{provider.error ? `${errors[provider.error] || "后台记录实时供源异常"}（${provider.error}）` : "快照未记录来源错误"}</dd></div>
          <div><dt>来源错误观察时间</dt><dd>{statusTime(provider.error_observed_at)}</dd></div>
          <div><dt>鉴权探测时间</dt><dd>{statusTime(provider.authentication_probe_at)}</dd></div>
          <div><dt>计划检查</dt><dd><ScheduledCheck at={provider.next_probe_at} /></dd></div>
        </dl>
        {rows.map(row => <section className="dc-source-dataset-diagnostics" key={row.dataset_id} aria-label={`${row.logical_symbol} 诊断`}>
          <h3>{row.logical_symbol}</h3>
          <dl className="dc-source-facts">
            <div><dt>连接状态</dt><dd>{connections[row.connection] || row.connection}</dd></div>
            <div><dt>恢复状态</dt><dd>{row.recovery_ready ? "后台恢复已就绪" : "后台恢复尚未就绪"}</dd></div>
            <div><dt>后台质量状态</dt><dd>{row.quality}</dd></div>
            <div><dt>错误记录</dt><dd>{row.connection_error || row.error ? `${errors[row.connection_error || row.error || ""] || "后台记录实时数据异常"}（${row.connection_error || row.error}）` : "快照未记录错误"}</dd></div>
            <div><dt>品种错误观察时间</dt><dd>时间未提供</dd></div>
            <div><dt>来源心跳</dt><dd>{statusTime(row.heartbeat_at)}</dd></div>
            <div><dt>最后行情接收时间</dt><dd>{statusTime(row.received_at)}</dd></div>
            <div><dt>计划检查</dt><dd><ScheduledCheck at={row.next_probe_at} /></dd></div>
          </dl>
        </section>)}
      </details>
      <section className="dc-source-history" aria-labelledby="dc-source-history-title">
        <h2 id="dc-source-history-title">历史读取</h2>
        <p>暂无历史请求状态。实时快照没有匹配账户、品种和时间范围的历史请求记录；实时异常不代表历史读取不可用。</p>
        <Link to="/market-data?tab=tasks">查看任务与记录</Link>
      </section>
    </>}
  </section>;
}
