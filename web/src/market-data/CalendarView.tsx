import { useCenter, useSearchParams } from "./router";
import { useSnapshot } from "./useSnapshot";
import { NativeInput, NativeSelect } from "./NativeControls";

type CalendarRow = {
  source: string; version: string; scope: string; timezone: string; regular_hours: string;
  status: string; checked_at: string | null; review_due_at: string | null; valid_from: string | null;
  valid_until: string | null; mappings: string[]; evidence: string[];
  row_id?: string; enabled?: boolean; market_session?: string; session_reason?: string;
  coverage_note?: string;
  target_id?: string; target_kind?: string; review_target?: string;
  native_parameters?: Record<string, unknown>;
  identity?: {channel?:string;environment?:string;account_scope?:string;price_basis?:string;provider_symbol?:string};
  audit?: {reviewed_at:string;reviewer?:string;method?:string;evidence_version?:string;review_due_at?:string};
  exceptions?: { date?: string; reason?: string; hours?: string; start?: string; end?: string; source?: string }[];
};
type CalendarResponse = { items: CalendarRow[]; sources: string[]; checked_at: string; review_due: number };
const names: Record<string, string> = { dukascopy: "Dukascopy", oanda: "OANDA", fxcm: "FXCM Demo", binance: "Binance", yahoo: "Yahoo" };
const statusNames: Record<string, string> = {
  verified: "已核实", review_due: "待复核", expired: "已过期",
  not_yet_valid: "尚未生效", unverified: "未核实",
};
const targetNames: Record<string, string> = {registered:"已登记品种", catalog:"来源目录", provider:"平台已用系列", configured:"来源配置"};
const targetUses: Record<string, string> = {registered:"用于现有行情与策略绑定", catalog:"用于来源检索及登记前核对", provider:"用于平台图表的来源口径", configured:"用于已配置的来源品种"};

export function CalendarView() {
  const { timezone = "UTC" } = useCenter();
  const [params, setParams] = useSearchParams();
  const source = params.get("source") || "", query = params.get("query") || "";
  const snapshot = useSnapshot<CalendarResponse>(`/market-data/center/calendars?source=${encodeURIComponent(source)}&query=${encodeURIComponent(query)}`);
  const rows = snapshot.data?.items || [];
  const update = (key: string, value: string) => { const next = new URLSearchParams(params); value ? next.set(key, value) : next.delete(key); setParams(next, { replace: true }); };
  const moment = (value: string | undefined, ruleZone: string) => {
    if (!value) return "未提供";
    if (!value.includes("T")) return value;
    const zone = timezone === "exchange" ? ruleZone : timezone;
    try { return new Intl.DateTimeFormat("zh-CN", {timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",timeZoneName:"shortOffset",hour12:false}).format(new Date(value)) + ` (${zone})`; }
    catch { return value; }
  };
  return <section className="data-center dc-calendars" aria-label="交易日历">
    <header className="dc-heading" data-source-loading={snapshot.loading}>
      <div><h1 tabIndex={-1}>交易日历</h1><p>版本化规则和官方依据；状态缺少适用证据时保持未核实。</p></div>
    </header>
    <div className="dc-calendar-search">
      <label>品种搜索<NativeInput aria-label="品种搜索" type="search" value={query} onChange={event => update("query", event.target.value)} placeholder="来源或商品代码" /></label>
    </div>
    <div className="dc-calendar-table-head"><span>品种、规则与适用身份</span><div className="dc-market-head-filters">
      <label>来源<NativeSelect aria-label="来源筛选" value={source} onChange={event => update("source", event.target.value)}><option value="">全部来源</option>{(snapshot.data?.sources || ["dukascopy", "oanda", "fxcm", "binance", "yahoo"]).map(item => <option key={item} value={item}>{names[item] || item}</option>)}</NativeSelect></label>
    </div></div>
    {snapshot.loading && !snapshot.data && <p role="status">正在读取交易日历…</p>}
    {snapshot.error && <p role="alert" className="error">交易日历暂时无法读取；稍后重试。</p>}
    {!snapshot.loading && !rows.length && <p role="status">没有符合条件的交易日历规则。</p>}
    <div className="dc-calendar-table">{rows.map(row => <details className="dc-calendar-row" key={row.row_id || row.version}>
        <summary><strong>{row.mappings.length ? row.mappings.join("、") : "当前品种待映射"}</strong><span>{targetNames[row.target_kind || ""] || "通用规则"} · {names[row.source] || row.source} · {row.enabled === false ? "未启用 · " : ""}{statusNames[row.status] || row.status}</span><small>{row.version} · 核实于 {row.checked_at ? moment(row.checked_at,row.timezone) : "未记录"}</small>
          <span className="dc-calendar-identity">{row.identity ? [row.identity.environment || "环境未记录", row.identity.channel || "通道未记录", row.identity.account_scope && row.identity.account_scope !== "public" ? `账户范围 …${row.identity.account_scope.slice(-8)}` : row.identity.account_scope, row.identity.price_basis].filter(Boolean).join(" · ") : "适用身份未记录"} · {row.scope}</span>
        </summary>
        {row.target_id && <p>适用对象：{targetNames[row.target_kind || ""]} · {row.target_id}。{targetUses[row.target_kind || ""]}；每个适用对象独立审核，审核不会自动转移到同名品种。</p>}
        {!!Object.keys(row.native_parameters || {}).length && <p>来源口径参数：{Object.entries(row.native_parameters || {}).map(([key,value])=>`${key}=${String(value)}`).join(" · ")}</p>}
        {row.audit && <p>审核记录：{row.audit.reviewer} · {row.audit.method} · 证据版本 {row.audit.evidence_version}</p>}
        <dl><div><dt>适用范围</dt><dd>{row.scope}</dd></div><div><dt>常规时段</dt><dd>{row.regular_hours}</dd></div><div><dt>官方规则时区</dt><dd>{row.timezone}</dd></div><div><dt>有效范围</dt><dd>{moment(row.valid_from || undefined, row.timezone)} 至 {row.valid_until ? moment(row.valid_until, row.timezone) : "未设上限"}</dd></div><div><dt>建议复核</dt><dd>{row.review_due_at || "未记录"}</dd></div>{row.market_session && <div><dt>当前时段</dt><dd>{({closed:"休市",scheduled_open:"交易时段内",unknown:"时段未核实"} as Record<string,string>)[row.market_session]}{row.session_reason ? ` · ${row.session_reason}` : ""}</dd></div>}</dl>
        <p>{row.coverage_note}</p>
        <div>例外记录：{row.exceptions?.length ? row.exceptions.map((item, index) => <p key={index}>{item.date || (item.start ? `${moment(item.start, row.timezone)} 至 ${moment(item.end, row.timezone)}` : "")} · {item.reason} {item.hours} {item.source && <a href={item.source} target="_blank" rel="noreferrer">例外官方依据</a>}</p>) : "当前版本没有独立已登记例外；请按维护日期复核官方公告。"}</div>
        <p>官方依据：{row.evidence.map(url => <a key={url} href={url} target="_blank" rel="noreferrer">{url}</a>)}</p>
      </details>)}</div>
    <p role="status">待核实适用对象 {snapshot.data?.review_due ?? "—"} · 显示时区：{timezone}。同名品种的绑定与来源口径可能不同，分别保留审核状态；建议每月及重要假日前核实官方公告。</p>
  </section>;
}
