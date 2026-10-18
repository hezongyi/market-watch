import type { BrowserFault } from "./types";
/** Deliberate final-operation allowlist. Polls, ticks and automatic read retries stay states. */
export function operationFault(
  path: string,
  body: unknown,
  workspace?: string,
): BrowserFault | null {
  const route = path.split("?")[0],
    value = (body && typeof body === "object" ? body : {}) as Record<
      string,
      any
    >;
  let kind: BrowserFault["source_kind"], code: string, title: string;
  if (
    route.startsWith("/advanced-charts/workspaces") ||
    route.startsWith("/advanced-charts/native-charts")
  ) {
    kind = "workspace";
    code =
      body === undefined ? "WORKSPACE_LOAD_FAILED" : "WORKSPACE_SAVE_FAILED";
    title =
      body === undefined ? "工作区读取失败" : "工作区保存失败，请保留草稿";
  } else if (
    body !== undefined &&
    /^\/advanced-charts\/(preferences|watchlists)/.test(route)
  ) {
    kind = "preferences";
    code = "PREFERENCE_SAVE_FAILED";
    title = "图表偏好保存失败";
  } else if (
    body !== undefined &&
    /^\/(market-data|charts\/history-capabilities)/.test(route) &&
    !/\/(quotes|resolve|cache|search|page|snapshot)(?:\/|$)/.test(route)
  ) {
    kind = "data_center";
    code = "DATA_OPERATION_FAILED";
    title = "图表数据中心操作失败";
  } else return null;
  return {
    source_kind: kind,
    code,
    title,
    message: "",
    attempt_id: crypto.randomUUID(),
    context: {
      workspace_id: workspace || "",
      endpoint: route,
      source_id:
        kind === "preferences"
          ? String(value.kind || "") +
            ":" +
            String(value.name || value.id || "")
          : String(value.dataset_id || value.id || ""),
      ...(value.instrument ? { instrument: value.instrument } : {}),
      ...(value.timeframe ? { timeframe: value.timeframe } : {}),
    },
    evidence: {
      operation: body === undefined ? "read" : "write",
      revision: value.revision ?? null,
      result: "失败或结果未知；重试前核查原操作",
    },
  };
}
