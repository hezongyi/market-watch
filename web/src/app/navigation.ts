import { centerLocation } from "../market-data/location";

const workspace = "[a-zA-Z0-9-]{1,40}";
const businessPath = new RegExp(
  `^(?:/advanced-charts(?:/${workspace})?|/signals|/replay(?:/${workspace})?|/settings(?:/(?:notifications|sound|system|account))?|/legacy/monitoring|/chart-workspaces(?:/${workspace})?)$`,
);
export const defaultChart = "/advanced-charts";
/** A continuation is a bounded, known business location, never an endpoint. */
export function safeNext(value: string | null): string {
  if (
    !value ||
    value.length > 6000 ||
    !value.startsWith("/") ||
    /^\/[/\\]/.test(value) ||
    /[\\\u0000-\u001f\u007f]/.test(value)
  )
    return defaultChart;
  try {
    const url = new URL(value, "https://app.invalid");
    if (url.origin !== "https://app.invalid") return defaultChart;
    if (url.pathname === "/") return defaultChart;
    if (url.pathname.startsWith("/market-data")) {
      const allowed = centerLocation(url.pathname + url.search + url.hash);
      return allowed === "/market-data" && url.pathname !== "/market-data"
        ? defaultChart
        : allowed;
    }
    if (!businessPath.test(url.pathname)) return defaultChart;
    return url.pathname + url.search + url.hash;
  } catch {
    return defaultChart;
  }
}
export function pageName(path: string) {
  if (path.startsWith("/advanced-charts")) return "图表";
  if (path === "/login") return "登录";
  if (path === "/signals") return "通知";
  if (path.startsWith("/replay")) return "历史演练";
  if (path.startsWith("/settings")) return "设置";
  if (path === "/legacy/monitoring") return "旧版监控";
  if (path.startsWith("/chart-workspaces")) return "旧图表工作区";
  return "页面不存在";
}
export function chartReturn() {
  const path = safeNext(sessionStorage.getItem("mw.chart-return.v1"));
  return path.startsWith("/advanced-charts") ? path : defaultChart;
}
