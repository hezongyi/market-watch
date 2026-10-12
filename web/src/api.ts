let csrf = "";
export class ApiError extends Error {
  constructor(message: string, public status: number, public code: string) {
    super(message);
    this.name = "ApiError";
  }
}
export function apiErrorDetails(error: unknown) {
  return error instanceof ApiError ? {code:error.code, status:error.status} :
    {code:error instanceof DOMException && error.name === 'AbortError' ? 'HISTORY_CANCELLED' : 'HISTORY_UNAVAILABLE'};
}
export function apiResponse(path: string, body: unknown, signal?: AbortSignal) {
  return fetch(`/api${path}`, {
    method: "POST", credentials: "same-origin", signal,
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify(body),
  });
}
export function setCsrf(value: string) {
  csrf = value;
}
export async function api<T = any>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    signal,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok)
    throw new ApiError(
      typeof result.detail === "string"
        ? result.detail
        : typeof result.detail?.message === "string"
          ? result.detail.message
          : JSON.stringify(result.detail),
      response.status,
      typeof result.detail?.code === 'string' ? result.detail.code :
        response.status === 503 ? 'HISTORY_BUSY' : 'HISTORY_UNAVAILABLE',
    );
  return result;
}
export type Bar = {
  start: number;
  end: number;
  open: string;
  high: string;
  low: string;
  close: string;
  complete: boolean;
  revision: number;
};
export type Instrument = {
  id: string;
  label: string;
  symbol?: string;
  logical_symbol?: string;
  dataset_identity?: {
    source: string;
    channel: string;
    environment: string;
    account_scope: string;
    provider_symbol: string;
    basis: string;
    calendar_version: string;
  };
  source: string;
  basis: string;
  calendar: string;
  calendar_profile?: {revision?: string; closures?: {start: string; end: string; reason: string; source: string}[]};
  precision: number;
  quality: string;
  price: string | null;
  price_at: number | null;
  error: string | null;
};
export type Watch = {
  market_identity?: Record<string, any>;
  health?: string;
  health_reason?: string | null;
  runtime?: Record<string, any>;
  id: string;
  instrument_id: string;
  name: string;
  rule: Record<string, any>;
  status: string;
  armed_at: number;
  paused_reason: string | null;
  state: Record<string, any>;
};
export type Signal = {
  id: string;
  instrument_id: string;
  direction: string;
  reason: string;
  price: string;
  threshold: string;
  occurred_at: number;
  notification_id: string;
  notification_status: string;
  retry_available: boolean;
  device_delivery: "received" | "unknown";
  ack_at: number | null;
  evidence?: {
    rule_version?: string | number;
    indicator?: string;
    indicator_version?: string;
    indicator_params?: {fast?: number; slow?: number};
    indicator_previous?: {value: string; reference: string};
    indicator_current?: {value: string; reference: string};
    trigger_bar?: { start: string; end: string; open: string; high: string; low: string; close: string; revision: number };
    previous_bar?: { high: string; low: string; close: string; revision: number };
    previous_day?: { high: string; low: string; revision: number } | null;
  } & ({
    chart_alert: true;
    unit: "price" | "price_delta" | "rsi";
    left: string;
    ordinal: number;
    detected_at: number;
    late: boolean;
    config: {notify_web: boolean; timeframe: string};
    market_identity: {source: string};
    observation: Record<string, unknown>;
  } | {chart_alert?: false});
};
export const date = (n: number) =>
  new Date(n).toLocaleString("zh-CN", { hour12: false });
