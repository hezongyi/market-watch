export type IndicatorSpec = {
  name: "SMA" | "EMA" | "RSI" | "MACD";
  version: "1";
  params: Record<string, number>;
  output: string;
};
export type LineGeometry = {
  kind: "horizontal_line" | "horizontal_ray" | "trend_line" | "ray";
  points: { time: number; index: number; price: string }[];
  scale: "linear" | "log";
  extend_left: boolean;
  extend_right: boolean;
  mapping_version: "bar-index-v1";
};
export type Operand = {
  kind: "price" | "constant" | "indicator" | "line";
  value?: string | null;
  indicator?: IndicatorSpec | null;
  line?: LineGeometry | null;
};
export type Condition = {
  relation: string;
  left: Operand;
  right?: Operand | null;
  lower?: string | null;
  upper?: string | null;
};
export type Association = {
  workspace_id: string;
  chart_id: string;
  generation: string;
  object_id: string | null;
  object_kind: "drawing" | "indicator" | null;
  native_object_id?: string | null;
  chart_index?: number | null;
};
export type AlertConfig = {
  name: string;
  instrument: string;
  series_kind: "managed" | "provider";
  source: string;
  timeframe: string;
  mode: "close" | "intrabar";
  condition: Condition;
  max_triggers: 1 | 2 | 3;
  expires_at: number | null;
  message: string;
  notify_web: boolean;
  notify_ntfy: boolean;
  late_delivery: "log_only" | "notify";
  association: Association | null;
  calculation_version: "chart-python-v1";
  calculation_origin?: number | null;
};
export type AlertContext = {
  request_id: string;
  instrument: string;
  series_kind: "managed" | "provider";
  timeframe: string;
  price?: string;
  source?: string;
  association: Association;
  line?: LineGeometry;
  indicator?: IndicatorSpec;
  calculation_origin?: number | null;
};
export type AlertRow = {
  id: string;
  name: string;
  version: number;
  run: number;
  status: string;
  health: string;
  health_reason: string | null;
  count: number;
  max_triggers: number;
  effective_at: number;
  created_at: number;
  updated_at: number;
  config: AlertConfig;
  condition_summary: string;
  runtime: Record<string, unknown>;
};
export type AlertEvent = {
  id: string;
  alert_id: string;
  occurred_at: number;
  detected_at: number;
  direction: string;
  price: string;
  threshold: string;
  evidence: {
    rule_version: number;
    ordinal: number;
    left: string;
    late: boolean;
    config: AlertConfig;
    observation: Record<string, unknown>;
  };
  message: string;
  notification_id: string;
  notification_status: string;
  ack_at: number | null;
  delivery_status: string;
};
export type Capabilities = {
  sources: {
    source: string;
    series_kind: "managed" | "provider";
    basis: string;
    available: boolean;
    reason: string | null;
    observation_basis: string;
  }[];
  modes: string[];
  indicators: string[];
  line_mapping: string;
};
export const statuses: Record<string, string> = {
  active: "监控中",
  paused: "已暂停",
  completed: "已完成",
  expired: "已到期",
  archived: "已删除",
};
export const healthNames: Record<string, string> = {
  warming: "等待数据 / 预热",
  ready: "数据就绪",
  stale: "数据陈旧 / 缺口",
  blocked: "等待处理",
  error: "判定失败",
};
export const relations: Record<string, string> = {
  cross: "穿过",
  cross_up: "上穿",
  cross_down: "下穿",
  above: "高于",
  below: "低于",
  enter: "进入价格区间",
  exit: "离开价格区间",
  break_upper: "上破区间上沿",
  break_lower: "下破区间下沿",
};
export const deliveryNames: Record<string, string> = {
  web_only: "仅网页",
  pending: "等待投递",
  sending: "正在投递",
  server_accepted: "推送服务已接受",
  acknowledged: "已确认",
  suppressed: "迟到，仅记录",
  late_suppressed: "迟到，仅记录",
  delivery_error: "投递失败",
  blocked: "投递受阻",
  cancelled: "已停止此事件投递",
};
export const indicatorDefaults: Record<string, Record<string, number>> = {
  SMA: { period: 20 },
  EMA: { period: 20 },
  RSI: { period: 14 },
  MACD: { fast: 12, slow: 26, signal: 9 },
};
export function validAlertContext(
  value: unknown,
  workspace: string | undefined,
): value is AlertContext {
  if (
    !value ||
    typeof value !== "object" ||
    JSON.stringify(value).length > 12_000
  )
    return false;
  const v = value as AlertContext,
    a = v.association;
  return (
    typeof v.request_id === "string" &&
    v.request_id.length <= 100 &&
    typeof v.instrument === "string" &&
    /^[A-Za-z0-9:_-]{1,40}$/.test(v.instrument) &&
    ["managed", "provider"].includes(v.series_kind) &&
    ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN"].includes(
      v.timeframe,
    ) &&
    !!a &&
    a.workspace_id === workspace &&
    [a.chart_id, a.generation].every(
      (s) => typeof s === "string" && s.length > 0 && s.length <= 100,
    ) &&
    (v.price === undefined ||
      (typeof v.price === "string" &&
        Number.isFinite(Number(v.price)) &&
        Number(v.price) > 0))
  );
}
export function freshDraft(context: AlertContext): AlertConfig {
  return {
    name: context.instrument + " 告警",
    instrument: context.instrument,
    series_kind: context.series_kind,
    source: context.source || "",
    timeframe: context.timeframe,
    mode: "close",
    condition: {
      relation: "cross_up",
      left: context.indicator
        ? { kind: "indicator", indicator: context.indicator }
        : { kind: "price" },
      right: context.line
        ? { kind: "line", line: context.line }
        : { kind: "constant", value: context.price || "" },
    },
    max_triggers: 1,
    expires_at: null,
    message: "",
    notify_web: true,
    notify_ntfy: false,
    late_delivery: "log_only",
    association: context.association,
    calculation_version: "chart-python-v1",
    calculation_origin: context.calculation_origin ?? null,
  };
}
