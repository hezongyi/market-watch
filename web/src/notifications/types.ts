export type Notice = {
  id: string;
  version: number;
  first_seq: number;
  source_domain: string;
  source_kind: string;
  source_id: string;
  incident_id: string;
  kind: string;
  severity: string;
  title: string;
  message: string;
  occurred_at: number;
  recorded_at: number;
  viewed_at: number | null;
  handled_at: number | null;
  accepted_at?: number;
  attention: boolean;
  backfill: boolean;
  workspace: string;
  instrument: string;
  instrument_display?: {series_kind: string; symbol: string; label?: string; provenance: string};
  context: Record<string, unknown>;
  evidence: Record<string, unknown>;
  original_evidence?: Record<string, unknown>;
  notification_id?: string;
  notify_web?: boolean;
  channels?: Record<string, any>;
  incident?: {
    id: string;
    count: number;
    closed_at: number | null;
    first_at: number;
    last_at: number;
  };
  local_status?: string;
  client_reported_time?: boolean;
  observation_status?: "ended";
  observation_ended_at?: number;
};
export type BrowserFault = {
  source_kind:
    | "workspace"
    | "indicator"
    | "history"
    | "capacity"
    | "data_center"
    | "preferences"
    | "market"
    | "connection"
    | "chart_shell";
  attempt_id: string;
  code: string;
  title: string;
  message: string;
  context?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  severity?: "info" | "warning" | "error" | "critical";
  observation_ended?: boolean;
};
export type Intake = BrowserFault & {
  schema_version: 1;
  event_id: string;
  profile: string;
  occurred_at: number;
  context: Record<string, unknown>;
  evidence: Record<string, unknown>;
  recovery_of?: string;
};
export type NoticeState = {
  epoch: string;
  revision: number;
  events: Notice[];
  pending: Notice[];
  unread: number;
  status: string;
  gap: string;
  enabled: boolean;
  unlocked: boolean;
  soundLimited: boolean;
  soundStatus: string;
  systemPopups: boolean;
  systemPopupSeconds?: number;
  bubble: Notice | null;
  overflow: number;
  alertPending?: number;
  alertUnread?: number;
  serverTime: number;
};
export type NoticeAction = {
  action: string;
  event_id?: string;
  before?: string | null;
  filters?: Record<string, string>;
  kind?: "viewed" | "handled";
  wait_for_sync?: boolean;
  enabled?: boolean;
  seconds?: number;
  through?: number;
  epoch?: string;
  incident_id?: string;
};
export type NoticeTransport = (action: NoticeAction) => Promise<any>;
export type HistoryPage = {
  events: Notice[];
  before: string | null;
  highwater: number;
  after: string;
  epoch: string;
  unread: number;
  system_unread?: number;
  alert_unread?: number;
  server_time: number;
};
export const severityLabels: Record<string, string> = {
  critical: "严重",
  error: "错误",
  warning: "提醒",
  info: "信息",
};
export const sourceLabels: Record<string, string> = {
  chart_alert: "交易告警",
  workspace: "工作区",
  indicator: "指标",
  history: "图格历史",
  capacity: "历史容量",
  data_center: "数据中心",
  preferences: "偏好设置",
  market: "行情",
  connection: "连接",
  chart_shell: "图表启动",
};

export const seriesKindLabels: Record<string, string> = {
  composite: "组合行情", history: "固定历史", managed: "自建行情", provider: "平台行情",
};
/** Presentation only; opaque storage IDs stay in the expandable diagnostics. */
export function noticeInstrument(notice: Notice): string {
  const raw = notice.instrument || "";
  const display = notice.instrument_display;
  if (display?.symbol && seriesKindLabels[display.series_kind])
    return display.symbol + " · " + seriesKindLabels[display.series_kind] + (display.series_kind === 'composite' ? ' · ' + raw.replace(/^MWC:/i, '').slice(0,8) : '');
  const kind = raw.startsWith("MWC:") ? "composite" : raw.startsWith("MWH:") ? "history" : String(notice.context?.series_kind || "");
  const identity = raw.replace(/^MW[PCHI]:/, "");
  if (/^[a-f0-9]{32,64}$/i.test(identity) || /^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(identity) || /^(?:DUKA|NATIVE|YAHOO|MD):/i.test(identity))
    return (seriesKindLabels[kind] || "行情") + "（名称不可用）· " + identity.slice(0, 8);
  return identity || sourceLabels[notice.source_kind] || "系统消息";
}
