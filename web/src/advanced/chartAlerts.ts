export type IndicatorSpec = {
  name: "SMA" | "EMA" | "RSI" | "MACD" | "ROLLING_RANGE_SQUEEZE";
  version: "1";
  params: Record<string, number | boolean>;
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
  offset?: {
    kind: "atr";
    version: "1";
    timeframe: string;
    period: number;
    multiplier: string;
    reference: "closed_at_evaluation_bar_open";
  } | null;
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
  series_kind: "managed" | "provider" | "composite";
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
  published?: boolean;
  composite_revision_id?: string | null;
  seam_policy?: "reject" | "accept_raw";
};
export type AlertContext = {
  request_id: string;
  instrument: string;
  series_kind: "managed" | "provider" | "composite";
  timeframe: string;
  price?: string;
  display_label?: string;
  price_presentation?: {text: string; value: string};
  source?: string;
  association: Association;
  line?: LineGeometry;
  indicator?: IndicatorSpec;
  calculation_origin?: number | null;
  published?: boolean;
  composite_revision_id?: string | null;
};
export type AlertRow = {
  display_label?: string;
  id: string;
  name: string;
  version: number;
  control_revision: number;
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
export function offsetSnapshot(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return [v.base_target, v.atr, v.signed_offset, v.threshold].every(x => typeof x === "string")
    ? `原目标 ${v.base_target} · ATR ${v.atr} · 偏移 ${v.signed_offset} · 实际边界 ${v.threshold}` : null;
}
export type AlertEvent = {
  display_label?: string;
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
    series_kind: "managed" | "provider" | "composite";
    basis: string;
    available: boolean;
    reason: string | null;
    observation_basis: string;
    atr_frames?: string[];
  }[];
  modes: string[];
  indicators: string[];
  indicator_metadata?: Record<string, {label:string;parameter_schema:Record<string,{label?:string;min:number;max:number;type:string}>;series:{key:string;label?:string;type:string}[]}>;
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
  coverage_pending: "判定依赖待核实",
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
export const indicatorDefaults: Record<string, Record<string, number | boolean>> = {
  SMA: { period: 20 },
  EMA: { period: 20 },
  RSI: { period: 14 },
  MACD: { fast: 12, slow: 26, signal: 9 },
  ROLLING_RANGE_SQUEEZE: { k: 10, lookback: 252, low_pct: 5, confirm_on_close: true },
};

export function indicatorUnit(value: IndicatorSpec): string {
  if (value.name === "ROLLING_RANGE_SQUEEZE")
    return ({sma:"price", signal:"boolean", pct_rank:"percent"} as Record<string,string>)[value.output] || "ratio";
  return value.name === "RSI" ? "RSI" : value.name === "MACD" ? "MACD" : "price";
}
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
    (v.series_kind === "composite" ? /^[a-f0-9]{64}$/.test(v.instrument) : /^[A-Za-z0-9:_-]{1,40}$/.test(v.instrument)) &&
    ["managed", "provider", "composite"].includes(v.series_kind) &&
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
  const squeeze = context.indicator?.name === "ROLLING_RANGE_SQUEEZE" && context.indicator.output === "signal";
  return {
    name: squeeze ? "Rolling Range Squeeze" : (context.display_label || context.instrument) + " 告警",
    instrument: context.instrument,
    series_kind: context.series_kind,
    source: context.source || "",
    timeframe: context.timeframe,
    mode: "close",
    condition: {
      relation: squeeze ? "above" : "cross_up",
      left: context.indicator
        ? { kind: "indicator", indicator: context.indicator }
        : { kind: "price" },
      right: context.line
        ? { kind: "line", line: context.line }
        : { kind: "constant", value: squeeze ? "0" : context.price || "" },
    },
    max_triggers: 1,
    expires_at: null,
    message: squeeze ? "Rolling Range Squeeze triggered" : "",
    notify_web: true,
    notify_ntfy: false,
    late_delivery: "log_only",
    association: context.association,
    calculation_version: "chart-python-v1",
    calculation_origin: context.calculation_origin ?? null,
    published: context.published ?? false,
    ...(context.series_kind === "composite" ? {composite_revision_id:context.composite_revision_id ?? null,
      seam_policy:"reject" as const} : {}),
  };
}

/** A relation owns one mutually exclusive payload, including restored drafts. */
export function normalizeCondition(value: Condition, relation = value.relation): Condition {
  if (["enter", "exit", "break_upper", "break_lower"].includes(relation))
    return { relation, left: { kind: "price" }, lower: value.lower ?? "", upper: value.upper ?? "" };
  const left = value.left;
  const unit = (operand: Operand) => operand.kind === "constant" ? "constant" :
    operand.indicator ? indicatorUnit(operand.indicator) : "price";
  let right = value.right ?? { kind: "constant" as const, value: "" };
  if (unit(right) !== "constant" && unit(left) !== unit(right)) right = { kind: "constant", value: "" };
  const offset = value.offset && ["cross_up", "cross_down", "above", "below"].includes(relation) &&
    unit(left) === "price" && ["constant", "line", "indicator"].includes(right.kind) &&
    ["price", "constant"].includes(unit(right)) ? value.offset : undefined;
  return { relation, left, right, ...(offset ? { offset } : {}) };
}

/** Historical presentation is derived solely from the event's frozen config. */
export function eventPresentation(event: AlertEvent) {
  const config = event.evidence?.config;
  const operand = (value?: Operand | null) => value?.kind === "indicator" ?
    `${value.indicator?.name ?? "指标"} ${value.indicator?.output ?? ""}` :
    value?.kind === "constant" ? value.value ?? "" : value?.kind === "line" ? "画线" : "价格";
  const c = config?.condition;
  const summary = c ? `${operand(c.left)} ${relations[c.relation] ?? c.relation} ${
    ["enter", "exit", "break_upper", "break_lower"].includes(c.relation) ? `${c.lower ?? ""}–${c.upper ?? ""}` : operand(c.right)}` : "";
  const name = config?.name ?? "";
  return { name, summary, search: [name, summary, config?.instrument, event.display_label, event.message].filter(Boolean).join(" ").toLocaleLowerCase() };
}
