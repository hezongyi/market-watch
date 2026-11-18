import { logEvent } from "./logs";
import type { Profile } from "./cache";

type Timing = {
  symbol: string;
  resolution: string;
  at: number;
  steps: Record<string, number>;
  outcome?: "ready" | "failed" | "superseded";
};
const recent: Timing[] = [];
/** Phone-only support evidence: elapsed milestones, never layouts or credentials. */
export const mobileChartDiagnostics = () => recent.map(row => ({ ...row, steps: { ...row.steps } }));
if (typeof window !== "undefined")
  Object.defineProperty(window, "MWMobileChartDiagnostics", { value: mobileChartDiagnostics, configurable: true });

export function chartTiming(profile: Profile, symbol: string, resolution: string) {
  const started = performance.now();
  const row: Timing = { symbol, resolution, at: Date.now(), steps: {} };
  recent.push(row);
  if (recent.length > 30) recent.shift();
  return {
    target(nextSymbol: string, nextResolution: string) { row.symbol = nextSymbol; row.resolution = nextResolution; },
    mark(phase: string) { if (!row.outcome && row.steps[phase] === undefined) row.steps[phase] = Math.round(performance.now() - started); },
    finish(outcome: Timing["outcome"]) {
      if (row.outcome) return;
      row.outcome = outcome;
      if (outcome === "superseded") return;
      logEvent({ module: "图表", action: "加载", object: `${row.symbol} · ${row.resolution}`,
        level: outcome === "failed" ? "warning" : "info", result: outcome === "failed" ? "failure" : "success",
        elapsedMs: Math.round(performance.now() - started),
        message: "自本次加载起：" + Object.entries(row.steps).map(([phase, ms]) => `${phase} ${ms}ms`).join(" · ") }, profile);
    },
  };
}
