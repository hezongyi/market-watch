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
  ["active", "paused"].includes(row.status);
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
  !(error instanceof ApiError) || error.status >= 500 || error.status === 408;
/** A lost edit response is resolved against the complete submitted config and version. */
export async function savePriceRule(
  config: AlertConfig,
  requestId: string,
  editing?: AlertRow,
  request = api,
) {
  if (editing && !editablePrice(editing))
    throw Error("此规则仅支持查看、暂停或归档");
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
