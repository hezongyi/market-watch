import { boundSource } from "./marketIdentity";
import type { AlertRow, AlertEvent } from "../advanced/chartAlerts";
import { alertCode } from "../advanced/alertPresentation";

export type RuleState = {
  key: string;
  label: string;
  attention: boolean;
  message?: string;
  issue?: "service" | "input" | "delivery";
};
type MonitorState = RuleState & { verified: boolean };
type MonitorHealth = {
  chart_alerts?: {
    enabled?: boolean;
    loop?: { state?: string; heartbeat_at?: number };
  };
};

/** A recent HTTP response and a live evaluator heartbeat are separate evidence. */
export function monitorState(
  health: MonitorHealth | undefined,
  online: boolean,
  readAt: number,
  rulesVerified: boolean,
  now = Date.now(),
): MonitorState {
  const unknown = {
    verified: false,
    key: "unknown",
    label: "状态待确认",
    attention: false,
  };
  if (!online)
    return {
      ...unknown,
      label: "离线待确认",
      message: "当前显示本机记录，联网后自动核验监控状态。",
    };
  if (!readAt || now - readAt >= 45000)
    return {
      ...unknown,
      message: "暂未取得最新服务状态，恢复连接后自动核验。",
    };
  const monitor = health?.chart_alerts,
    loop = monitor?.loop;
  if (
    ["running", "ready", "idle", "waiting_input"].includes(loop?.state || "") &&
    !!loop?.heartbeat_at &&
    now - loop.heartbeat_at < 60000
  )
    return rulesVerified
      ? { ...unknown, verified: true }
      : { ...unknown, message: "规则状态尚未更新，不能确认当前执行情况。" };
  if (
    monitor?.enabled === false &&
    ["unknown", "missing", "stopped", undefined].includes(loop?.state)
  )
    return {
      verified: false,
      key: "service_disabled",
      label: "服务未开启",
      attention: true,
      issue: "service",
      message: "规则已启用，但服务器未开启告警执行服务，当前不会判定或触发。",
    };
  if (
    ["stale", "stopped", "missing", "error", "degraded"].includes(
      loop?.state || "",
    ) ||
    (!!loop?.heartbeat_at && now - loop.heartbeat_at >= 60000)
  )
    return {
      verified: false,
      key: "service_unavailable",
      label: "监控已中断",
      attention: true,
      issue: "service",
      message:
        "告警执行服务未正常运行，当前无法保证判定；服务恢复后会自动接续。",
    };
  return {
    ...unknown,
    message:
      loop?.state === "starting"
        ? "告警服务正在启动，等待后台接管。"
        : "暂未确认告警执行服务，请检查服务器运行状态。",
  };
}

/** Do not label a baseline as a condition evaluation or an old trigger as the latest result. */
export function ruleProgress(row: AlertRow) {
  const activity = row.execution || row.activity;
  const outcome = activity?.last_outcome || row.runtime?.last_outcome;
  const at = activity?.last_evaluated_at;
  return {
    at,
    label: String(outcome).endsWith("_baseline")
      ? "基准已建立"
      : at
        ? "已完成判定"
        : "尚未判定",
  };
}
/** Enable intent, execution and delivery are independent facts. */
export function ruleState(
  row: AlertRow,
  verification: boolean | MonitorState = true,
  now = Date.now(),
): RuleState {
  const execution = row.execution;
  const triggerNotification = row.last_notification;
  const triggerDeliveryFailed =
    !!triggerNotification &&
    !triggerNotification.ack_at &&
    (triggerNotification.status === "delivery_error" ||
      ["failed", "dead", "blocked"].includes(
        triggerNotification.outbox_status,
      ));
  const deliveryMessage = triggerDeliveryFailed
    ? triggerNotification.outbox_status === "blocked"
      ? "最近触发的推送认证失败，修正通知设置后可重试。"
      : "最近触发的推送失败，服务器将自动重试。"
    : undefined;
  const life: Record<string, string> = {
    paused: "已暂停",
    completed: "次数已用完",
    expired: "已到期",
    archived: "已归档",
  };
  if (
    row.status !== "active" &&
    !(row.status === "expired" && execution?.settlement_pending)
  )
    return {
      key: row.status,
      label: life[row.status] || row.status,
      attention: triggerDeliveryFailed,
      issue: triggerDeliveryFailed ? "delivery" : undefined,
      message: deliveryMessage,
    };
  if (typeof verification !== "boolean" && !verification.verified)
    return verification;
  if (verification === false)
    return { key: "unknown", label: "状态待确认", attention: false };
  const activity = execution || row.activity;
  // A healthy global loop alone cannot establish that this individual rule advances.
  if (typeof verification !== "boolean" && activity) {
    if (
      !activity.taken_over_at &&
      (execution?.reason_code === "awaiting_worker" ||
        (!execution && row.health === "warming")) &&
      now - row.effective_at >= 60000
    )
      return {
        key: "not_taken_over",
        label: "尚未接管",
        attention: true,
        issue: "service",
        message: "规则启用后仍未被后台接管，请检查告警执行服务。",
      };
    if (activity.last_checked_at && now - activity.last_checked_at >= 60000)
      return {
        key: "rule_stalled",
        label: "判定未推进",
        attention: true,
        issue: "service",
        message: "此规则已超过一分钟未被检查，请检查告警执行服务。",
      };
  }
  // Confirming/aggregating the next close is part of monitoring once a baseline
  // has been evaluated. The worker promotes overdue input to blocked; preserve
  // that state, recovery incidents and first-time preparation as distinct facts.
  const routineCloseWait =
    execution?.state === "preparing" &&
    [
      "observed_minute_unconfirmed",
      "confirmation_aggregation_pending",
      "confirmation_window_pending",
    ].includes(execution.reason_code || "") &&
    !!execution.taken_over_at &&
    !!execution.last_evaluated_at &&
    execution.last_evaluated_at >= row.effective_at &&
    !row.runtime?.needs_baseline &&
    !row.runtime?.incident;
  const key = routineCloseWait
    ? "monitoring"
    : execution?.state ||
      (!execution && row.runtime?.closed ? "closed" : undefined) ||
      {
        ready: "monitoring",
        warming: "preparing",
        stale: "recovering",
        coverage_pending: "recovering",
        blocked: "blocked",
        error: "blocked",
      }[row.health] ||
      "unknown";
  const label =
    (
      {
        monitoring: "监控中",
        preparing: "准备中",
        recovering: "等待数据",
        closed: "休市",
        blocked: "需处理",
        settling: "结算中",
        settled: "已到期",
        expired: "已到期",
      } as Record<string, string>
    )[key] || "状态待确认";
  const notification = execution?.notification;
  const deliveryFailed =
    ["delivery_error", "blocked", "failed", "error"].includes(
      notification?.status || "",
    ) ||
    ["failed", "dead", "blocked"].includes(notification?.outbox_status || "");
  return {
    key,
    label,
    attention:
      key === "blocked" ||
      deliveryFailed ||
      triggerDeliveryFailed ||
      !!execution?.phone_configuration?.reason_code,
    issue:
      key === "blocked"
        ? "input"
        : deliveryFailed ||
            triggerDeliveryFailed ||
            execution?.phone_configuration?.reason_code
          ? "delivery"
          : undefined,
    message:
      key === "blocked"
        ? execution?.message || row.health_reason || "所需行情暂不可用"
        : deliveryMessage ||
          (deliveryFailed
            ? notification?.message || "推送失败，查看通知设置"
            : (routineCloseWait
                ? execution?.phone_configuration?.message
                : execution?.message ||
                  row.health_reason ||
                  execution?.phone_configuration?.message) || undefined),
  };
}
export function ruleIdentity(row: AlertRow) {
  const market = row.market_identity || {};
  return {
    code: alertCode(row, "品种身份待确认"),
    name: String(market.description || market.name || ""),
    source: String(
      market.source_display ||
        boundSource(
          market.target_identity || {
            source:
              market.source ||
              row.display_identity?.source ||
              row.config.source,
            source_family: market.source_family,
          },
        ),
    ),
    custom: row.config.series_kind !== "provider",
  };
}
export function eventIdentity(event: AlertEvent) {
  const config = event.evidence?.config;
  const market = (event.evidence as any)?.market_identity || {};
  return {
    code: alertCode(event, "历史告警"),
    name: String(market.description || ""),
    source: String(
      market.source_display ||
        boundSource(
          market.target_identity || {
            source:
              market.source ||
              event.display_identity?.source ||
              config?.source ||
              "",
            source_family: market.source_family,
          },
        ),
    ),
    custom: config?.series_kind !== "provider",
  };
}
export function eventHandled(event: AlertEvent) {
  return event.notice
    ? Boolean(event.notice.handled_at) &&
        (!event.notification_id || Boolean(event.ack_at))
    : Boolean(event.ack_at);
}
export const expiredRule = (row: AlertRow) =>
  row.config.expires_at !== null && row.config.expires_at <= Date.now();
