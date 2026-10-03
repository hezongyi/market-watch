let csrf = "";
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
    throw new Error(
      typeof result.detail === "string"
        ? result.detail
        : typeof result.detail?.message === "string"
          ? result.detail.message
          : JSON.stringify(result.detail),
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
    rule_version?: string;
    indicator?: string;
    indicator_version?: string;
    indicator_params?: {fast?: number; slow?: number};
    indicator_previous?: {value: string; reference: string};
    indicator_current?: {value: string; reference: string};
    trigger_bar?: { start: string; end: string; open: string; high: string; low: string; close: string; revision: number };
    previous_bar?: { high: string; low: string; close: string; revision: number };
    previous_day?: { high: string; low: string; revision: number } | null;
  };
};
export const date = (n: number) =>
  new Date(n).toLocaleString("zh-CN", { hour12: false });
