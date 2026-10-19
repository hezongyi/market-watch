import { useSyncExternalStore } from "react";
import { validTimeZone } from "./chartTime";
import "./chart-time.css";

export type ChartTimeSnapshot = { zone: string; label: string };
let current: ChartTimeSnapshot = { zone: "UTC", label: "UTC（图表初始化前）" };
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const getSnapshot = () => current;
/** The chart bridge is the only publisher; React roots share one subscription source. */
export function setChartTime(zone: string, label: string) {
  const resolved = validTimeZone(zone);
  const next = resolved
    ? { zone: resolved, label }
    : { zone: "UTC", label: "UTC（图表时区不可用）" };
  if (next.zone === current.zone && next.label === current.label) return;
  current = next;
  listeners.forEach((listener) => listener());
}
export const useChartTime = () =>
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
declare global {
  var MWChartTime: { set: typeof setChartTime };
}
globalThis.MWChartTime = { set: setChartTime };
