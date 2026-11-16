import { ApiError, api } from "../api";
import {
  isFixedPrice,
  type AlertConfig,
  type AlertRow,
  type Capabilities,
} from "../advanced/chartAlerts";

export const editablePrice = (row: AlertRow) =>
  isFixedPrice(row.config) &&
  !row.config.association?.object_kind &&
  ["active", "paused", "expired", "completed"].includes(row.status);
export const editableRule = (row: AlertRow) =>
  editablePrice(row) ||
  (row.config.series_kind === "composite" &&
    row.status !== "archived" &&
    !row.config.association?.object_kind &&
    !row.config.condition.offset &&
    row.config.condition.left.kind === "indicator" &&
    row.config.condition.right?.kind === "constant");
export function admission(
  capabilities: Capabilities | undefined,
  config: AlertConfig,
) {
  const source = capabilities?.sources.find(
    (row) =>
      row.series_kind === config.series_kind && row.source === config.source,
  );
  return source?.price_modes?.[config.mode];
}
export function newPriceConfig(
  instrument: string,
  revision: string | null,
): AlertConfig {
  return {
    name: "",
    instrument,
    series_kind: "composite",
    source: "composite",
    timeframe: "M1",
    mode: "close",
    condition: {
      relation: "cross_up",
      left: { kind: "price" },
      right: { kind: "constant", value: "" },
    },
    max_triggers: 1,
    expires_at: null,
    message: "",
    notify_web: true,
    notify_ntfy: false,
    late_delivery: "log_only",
    association: null,
    calculation_version: "chart-python-v1",
    composite_revision_id: revision,
    seam_policy: "reject",
  };
}
function canonical(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export const sameConfig = (a: AlertConfig, b: AlertConfig) =>
  canonical(a) === canonical(b);
export const uncertainError = (error: unknown) =>
  !(error instanceof ApiError) ||
  error.status >= 500 ||
  error.status === 408 ||
  (error.status >= 200 && error.status < 300 && error.code === "INVALID_RESPONSE");
/** A lost edit response is resolved against the complete submitted config and version. */
export async function savePriceRule(
  config: AlertConfig,
  requestId: string,
  editing?: AlertRow,
  request = api,
  resolving = false,
) {
  if (editing && !editableRule(editing))
    throw Error("此规则仅支持查看、暂停或归档");
  // Resolve an uncertain edit before resubmitting its old version. A second
  // POST would return 409 even when the first write was saved successfully.
  if (editing && resolving) {
    const latest = await request<AlertRow>(
      `/chart-alerts/${editing.id}`,
      undefined,
      AbortSignal.timeout(10000),
    );
    if (latest.version > editing.version && sameConfig(latest.config, config))
      return latest;
    if (latest.version !== editing.version)
      throw new ApiError("规则已改变，当前输入已保留。", 409, "ALERT_CONFLICT");
  }
  try {
    return await request<AlertRow>(
      editing ? `/chart-alerts/${editing.id}/edit` : "/chart-alerts",
      editing
        ? { version: editing.version, config }
        : { request_id: requestId, config },
      AbortSignal.timeout(20000),
    );
  } catch (error) {
    if (editing && uncertainError(error)) {
      const latest = await request<AlertRow>(
        `/chart-alerts/${editing.id}`,
        undefined,
        AbortSignal.timeout(10000),
      ).catch(() => undefined);
      if (
        latest &&
        latest.version > editing.version &&
        sameConfig(latest.config, config)
      )
        return latest;
    }
    throw error;
  }
}
