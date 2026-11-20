import type { Dataset, Period, Plan } from "../market-data/types";
import { frames, names, time } from "../market-data/types";
import type { Continuation } from "../market-data/DatasetContinuation";
import { Badge } from "./components/ui/badge";
export const modes: Record<string, string> = {
  base_m1: "M1派生",
  base_d1: "D1派生",
  native_periods: "原生周期",
};
export function historyTags(dataset: Dataset) {
  const mode = dataset.identity.mode || dataset.mode;
  const basis =
    (
      {
        bid: "bid",
        ask: "ask",
        mid: "mid",
        trade: "trade",
        trades: "trade",
      } as Record<string, string>
    )[dataset.identity.basis] || dataset.price_basis_display;
  const adjustment = (
    {
      none: "不复权",
      raw: "不复权",
      qfq: "前复权",
      hfq: "后复权",
      provider: "来源价格",
      supplier: "来源价格",
    } as Record<string, string>
  )[dataset.identity.adjustment || ""];
  const calendar =
    (
      {
        ny17: "NY17",
        utc0: "UTC0",
        source_date: "来源交易日",
      } as Record<string, string>
    )[dataset.aggregation_calendar] || dataset.aggregation_calendar;
  return [
    mode ? modes[mode] || mode : undefined,
    basis,
    dataset.asset_class === "equity" ||
    !["none", "raw"].includes(dataset.identity.adjustment || "")
      ? adjustment
      : undefined,
    calendar,
  ].filter((value): value is string => !!value);
}
export function HistoryTags({ dataset }: { dataset: Dataset }) {
  return (
    <div className="data-history-tags" aria-label="数据特点">
      {historyTags(dataset).map((label) => (
        <Badge key={label} variant="secondary">
          {label}
        </Badge>
      ))}
    </div>
  );
}
export function periodRows(dataset: Dataset) {
  const keys = new Set([
    ...(dataset.maintenance.timeframes || []),
    ...dataset.periods.map((p) => p.timeframe),
  ]);
  return [...keys]
    .sort((a, b) => frames.indexOf(a) - frames.indexOf(b))
    .map((frame) => ({
      frame,
      period: currentPeriod(dataset, frame),
    }));
}
/** Latest manifest can report failure while an older published artifact stays usable. */
export function currentPeriod(dataset: Dataset, frame: string) {
  const period = dataset.periods.find((p) => p.timeframe === frame);
  const input =
    (dataset.identity.mode || dataset.mode) === "base_d1" ? "D1" : frame;
  const latest = dataset.frames?.[input];
  if (
    period &&
    latest &&
    ["failed", "unavailable", "configuration_error", "partial"].includes(
      latest.status,
    )
  )
    return { ...period, freshness: latest.status };
  return period;
}
export function periodState(period?: Period) {
  if (!period) return "尚无数据";
  const available = !!period.available_version_id;
  const old =
    period.freshness === "stale" ||
    period.freshness === "inherited" ||
    (available &&
      !!period.version_id &&
      period.version_id !== period.available_version_id);
  const failed =
    ["failed", "configuration_error", "partial"].includes(period.status) ||
    ["failed", "unavailable", "configuration_error", "partial"].includes(
      period.freshness || "",
    );
  if (failed)
    return available ? "更新失败，已有历史可用" : "更新失败，尚无数据";
  if (old) return "沿用上次数据";
  if (available) return "可用";
  if (
    ["pending", "running", "deriving", "preparing", "retrying"].includes(
      period.status,
    )
  )
    return names[period.status] || "生成中";
  return "尚无数据";
}
export function coverageConclusion(dataset: Dataset) {
  const range = dataset.history_range;
  if (!range)
    return dataset.periods.some((p) => p.available_version_id)
      ? "范围待核实"
      : "尚无历史";
  const date = (value: number) =>
    new Intl.DateTimeFormat("zh-CN", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(value));
  return `${date(range.start)} → ${date(range.end)}`;
}
export function maintenanceSummary(dataset: Dataset) {
  const plan = dataset.maintenance;
  if (plan.archived) return "已归档";
  if (plan.paused) return "已暂停";
  if (!plan.configured) return "未配置";
  if (plan.frame_plan && Object.keys(plan.frame_plan).length)
    return "按周期更新";
  if (plan.frequency !== "daily") return "一次性";
  const minute = plan.daily_minute;
  return `每日 ${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}（${plan.timezone}）`;
}
function maintenanceFailed(plan: Plan) {
  const automaticallyProcessing = [
    "pending",
    "running",
    "retrying",
    "preparing",
    "deriving",
  ].includes(plan.task_status || "");
  return !!(
    (plan.task_error && !automaticallyProcessing) ||
    ["failed", "partial", "configuration_error"].includes(
      plan.task_status || "",
    )
  );
}
export function historyError(error?: string) {
  if (!error) return undefined;
  return (
    (
      {
        unavailable: "历史来源暂不可用",
        timeout: "历史读取超时",
        rate_limited: "历史来源暂时限流",
        unauthorized: "历史来源授权异常",
        invalid_payload: "历史来源返回的数据未通过校验",
        all_periods_failed: "本次历史更新失败",
        no_confirmed_bars: "历史来源暂未返回已确认的 K 线",
        history_source_configuration: "历史来源配置需检查",
      } as Record<string, string>
    )[error] || error
  );
}
export function historyUpdateError(dataset: Dataset) {
  const error = historyError(dataset.maintenance.task_error);
  if (!error) return undefined;
  const retry = dataset.maintenance.task_status === "retrying";
  const available = dataset.periods.some((p) => p.available_version_id);
  return `${error}${retry ? "，系统自动重试" : ""}；${available ? "已有历史仍可查看" : "尚无可用历史"}`;
}
export function maintenanceState(dataset: Dataset) {
  const plan = dataset.maintenance;
  if (plan.archived) return "已归档";
  if (maintenanceFailed(plan)) return "维护需处理";
  if (plan.paused) return "维护已暂停";
  return plan.configured ? "维护已配置" : "维护待配置";
}

type LiveSetting = {
  enabled: boolean;
  status: string;
  rollover?: { requires_attention?: boolean } | null;
};
export function liveNeedsAttention(live?: LiveSetting) {
  return (
    !!live?.enabled &&
    (["attention", "account_changed"].includes(live.status) ||
      !!live.rollover?.requires_attention)
  );
}
/** The data manager describes saved intent, not momentary connection health. */
export function liveSettingLabel(live?: LiveSetting) {
  return liveNeedsAttention(live)
    ? "实时需处理"
    : live?.enabled
      ? "实时已开启"
      : "实时未开启";
}
export function liveRuntimeSummary(
  live: Pick<Continuation, "enabled" | "status"> &
    Partial<Pick<Continuation, "composite">>,
) {
  const health = live.composite?.health;
  if (!live.enabled) return "实时未开启";
  if (live.status === "unauthorized") return "连接认证失败，系统自动重试";
  if (live.status === "recovering")
    return health?.quote_ready
      ? "报价已恢复，分钟线补齐中"
      : "正在自动恢复连接或补齐分钟线";
  if (live.status === "receiving")
    return health?.sample_ready === false
      ? "分钟线已接续，当前报价暂不可用"
      : "实时接续正常";
  return (
    (
      {
        preparing: "接续数据准备中",
        inactive: "等待实时来源连接",
        market_closed: "来源已休市",
        provider_maintenance: "来源维护中，系统自动重试",
        account_changed: "来源账户已变化，请重新核对实时来源",
        attention: "接续配置或数据准备需处理",
      } as Record<string, string>
    )[live.status] || "运行状态待核实"
  );
}
export function liveSummary(
  live?: Continuation,
  error?: string,
  readAt?: number,
) {
  if (!live) return error ? "读取失败 · 状态待核实" : "读取中";
  const value =
    !live.supported && !live.enabled
      ? "暂不支持"
      : live.enabled
        ? liveNeedsAttention(live)
          ? "已开启 · 需处理"
          : "已开启"
        : "未开启";
  return error || readAt ? `${value} · 上次状态，待核实` : value;
}
export function HistoryFacts({ dataset }: { dataset: Dataset }) {
  const plan = dataset.maintenance,
    rows = periodRows(dataset),
    usable = rows.filter((r) => r.period?.available_version_id),
    pending = rows.filter((r) => !r.period?.available_version_id);
  const failed = maintenanceFailed(plan);
  const active = !!plan.active_version_id && !failed;
  return (
    <>
      <dl className="mobile-facts data-facts">
        <div className="data-coverage-fact">
          <dt>历史范围</dt>
          <dd className="data-history-range">
            {coverageConclusion(dataset)}
            {dataset.history_range && (
              <small className="data-fact-note">UTC</small>
            )}
          </dd>
        </div>
        <div>
          <dt>可用周期</dt>
          <dd>
            <span className="data-usable-periods">
              {usable.length
                ? usable.map((r) => <span key={r.frame}>{r.frame}</span>)
                : "尚无历史"}
            </span>
            {pending.length > 0 && (
              <small className="data-fact-note">
                {pending
                  .map((r) => `${r.frame} ${periodState(r.period)}`)
                  .join(" · ")}
              </small>
            )}
          </dd>
        </div>
        <div>
          <dt>维护设置</dt>
          <dd>
            {maintenanceSummary(dataset)}
            {!plan.paused &&
              !plan.archived &&
              plan.configured &&
              plan.next_at != null && (
                <small className="data-fact-note">
                  下次计划 {time(plan.next_at)}
                </small>
              )}
          </dd>
        </div>
        {(plan.task_status || plan.last_success) && (
          <div>
            <dt>最近执行</dt>
            <dd>
              {failed
                ? `${plan.task_status === "partial" ? "部分更新失败" : "更新失败"}${usable.length ? "，已有历史可用" : "，尚无历史"}`
                : active
                  ? names[plan.task_status || ""] || "正在更新"
                  : plan.last_success
                    ? `更新成功 · ${time(plan.last_success)}`
                    : names[plan.task_status || ""] || plan.task_status}
            </dd>
          </div>
        )}
      </dl>
      {rows.some(
        (r) =>
          r.period?.available_version_id && periodState(r.period) !== "可用",
      ) && (
        <p className="data-caption">
          {rows
            .filter(
              (r) =>
                r.period?.available_version_id &&
                periodState(r.period) !== "可用",
            )
            .map((r) => `${r.frame} ${periodState(r.period)}`)
            .join(" · ")}
        </p>
      )}
    </>
  );
}
