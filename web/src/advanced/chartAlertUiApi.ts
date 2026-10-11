import { api } from "../api";

export type AlertApi = typeof api;
export type AlertUiScope = { workspace_id: string; session: string };
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";

// Invoked only after window, origin and channel validation in AdvancedWorkspace.
// A chart renderer cannot choose arbitrary authenticated URLs or API methods.
export async function chartAlertUiRequest(
  query: unknown,
  scope: AlertUiScope,
  current: () => boolean,
  call: AlertApi = api,
) {
  if (
    !query ||
    typeof query !== "object" ||
    JSON.stringify(query).length > 30_000
  )
    throw Error("无效告警界面请求");
  const q = query as AlertUiScope & { path: string; body?: any };
  if (
    !current() ||
    q.session !== scope.session ||
    q.workspace_id !== scope.workspace_id
  )
    throw Error("告警工作区已切换，请重新打开");
  if (typeof q.path !== "string") throw Error("无效告警请求路径");
  const write = q.body !== undefined;
  const readPath =
    q.path === "/chart-alerts" || q.path === "/chart-alerts/events";
  const writePath =
    q.path === "/chart-alerts" ||
    q.path === "/chart-alerts/capabilities" ||
    q.path === "/chart-alerts/geometry" ||
    new RegExp(`^/chart-alerts/${uuid}/(edit|lifecycle)$`).test(q.path) ||
    new RegExp(`^/notifications/${uuid}/ack$`).test(q.path);
  if (!(write ? writePath : readPath)) throw Error("不允许的告警界面操作");
  if (write && (!q.body || typeof q.body !== "object" || Array.isArray(q.body)))
    throw Error("无效告警请求内容");
  if (
    q.path.endsWith("/lifecycle") &&
    !["pause", "resume", "restart", "rebaseline", "archive"].includes(
      q.body.action,
    )
  )
    throw Error("无效告警状态操作");
  if (
    q.body?.config?.association &&
    q.path === "/chart-alerts" &&
    q.body.config.association.workspace_id !== scope.workspace_id
  )
    throw Error("告警发起工作区已改变");
  const result = await call(q.path, q.body);
  if (!current()) throw Error("告警工作区已切换，忽略过期响应");
  return result;
}
