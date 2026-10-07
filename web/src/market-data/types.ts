export const frames = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN"];
export const names: Record<string, string> = {
  pending: "排队中",
  running: "下载中",
  retrying: "等待重试",
  configuration_error: "配置需处理",
  published: "已发布",
  paused: "已暂停",
  cancelled: "已取消",
  deriving: "派生中",
  available: "可用",
  preparing: "准备中",
  needs_maintenance: "待维护",
  dukascopy: "Dukascopy",
  oanda: "OANDA Practice",
  binance: "Binance",
  yahoo: "Yahoo",
};
export function time(value?: number | null) {
  return value == null
    ? "—"
    : new Intl.DateTimeFormat("zh-CN", {
        timeZone: "UTC",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(value)) + " UTC";
}
export function phase(value: string) {
  return value === "ny17" ? "NY17" : "UTC0";
}
export type Period = {
  id: string;
  timeframe: string;
  status: string;
  rows: number;
  complete_rows: number;
  version_id?: string;
  available_version_id?: string;
  available_rows?: number;
  available_start?: number;
  available_end?: number;
};
export type Plan = {
  configured: boolean;
  configuration_revision: string;
  target_start: number;
  timeframes: string[];
  frequency: string;
  timezone: string;
  daily_minute: number;
  overlap_minutes: number;
  paused: boolean;
  archived: boolean;
  next_at?: number;
  last_attempt?: number;
  last_success?: number;
  active_version_id?: string;
  task_status?: string;
  task_error?: string;
};
export type Dataset = {
  id: string;
  instrument_id: string;
  logical_symbol: string;
  precision: number;
  asset_class: string;
  aggregation_calendar: string;
  identity: {
    source: string;
    basis: string;
    provider_symbol: string;
    environment: string;
  };
  maintenance: Plan;
  available_start?: number;
  available_end?: number;
  unknown_minutes?: number;
  latest_version_id?: string;
  usable_timeframes: string[];
  periods: Period[];
  availability: string;
};
export type Task = {
  id: string;
  dataset_id: string;
  start: number;
  end: number;
  cursor: number;
  status: string;
  error?: string;
  task_kind: string;
  desired_state?: string;
  controllable: boolean;
  dataset: Dataset;
};
export type Page<T> = {
  items: T[];
  total: number;
  page: number;
  page_size: number;
};
