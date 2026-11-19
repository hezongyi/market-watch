import { createContext } from "react";
import type { AlertEvent } from "../advanced/chartAlerts";
export type AlertChartTarget = {
  compositeRevision?: string;
  historyVersion?: string;
  eventId: string;
  token: number;
  symbol: string;
  resolution: string;
  occurredAtMs: number;
  anchorMs: number;
  bar?: { start: number; end: number };
  anchorKind: "evidence-bar" | "intrabar-time" | "approximate-time";
  price: string;
  threshold: string;
  observed: string;
  unit: string;
  leftKind: "price" | "indicator";
  summary: string;
};
const frames: Record<string, string> = {
  M1: "1",
  M5: "5",
  M15: "15",
  M30: "30",
  H1: "60",
  H4: "240",
  D1: "1D",
  W1: "1W",
  MN: "1M",
};
export function alertChartTarget(
  event: AlertEvent,
  token: number,
): AlertChartTarget {
  const config = event.evidence?.config;
  if (!config?.instrument || !frames[config.timeframe])
    throw Error("记录缺少品种或周期，无法定位图表");
  const prefix =
    config.series_kind === "composite"
      ? "MWC:"
      : config.series_kind === "provider"
        ? "MWP:"
        : config.series_kind === "managed"
          ? ""
          : undefined;
  if (prefix === undefined) throw Error("记录的行情类型无法识别");
  if (!Number.isFinite(event.occurred_at) || event.occurred_at <= 0)
    throw Error("记录缺少发生时间");
  const observation = event.evidence.observation as {
    bar?: { start?: number; end?: number };
  };
  const candidate = observation?.bar;
  const bar =
    candidate &&
    Number.isFinite(candidate.start) &&
    Number.isFinite(candidate.end) &&
    candidate.start! > 0 &&
    candidate.end! > candidate.start!
      ? { start: candidate.start!, end: candidate.end! }
      : undefined;
  const market = (
    event.evidence as { market_identity?: Record<string, unknown> }
  ).market_identity;
  return {
    compositeRevision:
      typeof market?.composite_revision_id === "string"
        ? market.composite_revision_id
        : undefined,
    historyVersion:
      typeof market?.history_version_id === "string"
        ? market.history_version_id
        : undefined,
    eventId: event.id,
    token,
    symbol: prefix + config.instrument,
    resolution: frames[config.timeframe],
    occurredAtMs: event.occurred_at,
    anchorMs: bar?.start ?? event.occurred_at,
    bar,
    anchorKind: bar
      ? "evidence-bar"
      : config.mode === "intrabar"
        ? "intrabar-time"
        : "approximate-time",
    price: event.price,
    threshold: event.threshold,
    observed: event.evidence.left || "未记录",
    unit:
      config.condition.left.kind === "price"
        ? "价格"
        : (event.evidence as { unit?: string }).unit ||
          (config.condition.left as { unit?: string }).unit ||
          "指标原始单位",
    leftKind: config.condition.left.kind === "price" ? "price" : "indicator",
    summary: config.name || "告警触发",
  };
}
export const EventChartNavigation = createContext<{
  suspended: boolean;
  open(event: AlertEvent, restore: () => void): void;
}>({ suspended: false, open() {} });
