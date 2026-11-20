import type { AlertApi } from "./chartAlertUiApi";
import { freshDraft, isChartPrice, isChartRange, type AlertConfig, type AlertContext, type AlertRow, type Capabilities } from "./chartAlerts";
import { editAlertPrice } from "./alertPriceEdit";

const frames = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN"];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const priceOperation = (op: unknown) => typeof op === "string" && op.startsWith("price_");

/** Narrow authenticated interface shared by desktop and mobile price gestures.
 * Object/drawing writes retain their separate workspace interface. */
export async function chartPriceAlertRequest(q: any, call: AlertApi, current: () => boolean) {
  if (!q || JSON.stringify(q).length > 16000 || !current()) throw Error("图表告警操作已失效");
  const request: AlertApi = async (path, body) => {
    if (!current()) throw Error("图表已切换，请重新操作");
    const result = await call(path, body, AbortSignal.timeout(15000));
    if (!current()) throw Error("图表已切换，请重新核验操作结果");
    return result;
  };
  const identity = (value: any) => {
    if (!value || value.series_kind !== "composite" || !/^[a-f0-9]{64}$/.test(value.instrument) || !frames.includes(value.timeframe))
      throw Error("仅支持已开启实时的自建行情；请到数据页查看对应自建，核对来源后重新设价");
  };
  if (q.op === "price_previous_day") {
    identity(q);
    return request("/chart-alerts/presets/previous-day", {
      instrument:q.instrument, composite_revision_id:q.composite_revision_id ?? null,
    });
  }
  if (q.op === "price_capabilities") {
    identity(q);
    return request<Capabilities>("/chart-alerts/capabilities", {instrument:q.instrument, series_kind:q.series_kind, timeframe:q.timeframe});
  }
  if (q.op === "price_list") {
    if (!Array.isArray(q.instruments) || q.instruments.length > 8 || q.instruments.some((id: unknown) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)))
      throw Error("无效的图表行情范围");
    const lists = await Promise.all([...new Set<string>(q.instruments)].map(instrument =>
      request<AlertRow[]>("/chart-alerts?" + new URLSearchParams({instrument}))));
    return lists.flat().filter(row => row.config.series_kind === "composite" &&
      (isChartPrice(row.config) || isChartRange(row.config)));
  }
  if (q.op === "price_create") {
    const context = q.context as AlertContext;
    identity(context);
    if (!uuid.test(context.request_id) || context.line || context.indicator || !context.price ||
        !/^\d+(?:\.\d+)?$/.test(context.price) || Number(context.price) <= 0 || !Number.isFinite(Number(context.price)))
      throw Error("无效的快捷告警价格");
    // The menu's exact reviewed intent is frozen, including delivery and revision.
    // Server create still revalidates admission and is idempotent by request_id.
    const config: AlertConfig = freshDraft(context);
    config.source = "composite";
    config.name = config.name.slice(0, 100);
    return request<AlertRow>("/chart-alerts", {request_id:context.request_id, config});
  }
  if (!uuid.test(q.alert_id)) throw Error("无效告警身份");
  const row = await request<AlertRow>(`/chart-alerts/${q.alert_id}`);
  const range = row.config.series_kind === "composite" && isChartRange(row.config);
  if (row.config.series_kind !== "composite" || (!isChartPrice(row.config) && !range)) throw Error("此操作只支持固定价格告警");
  if (q.op === "price_read") return row;
  if (q.op === "price_edit") {
    if (range) throw Error("区间告警请在告警编辑器中修改");
    if (!Number.isInteger(q.version) || !Number.isInteger(q.control_revision)) throw Error("无效告警版本");
    return editAlertPrice({...row,version:q.version,control_revision:q.control_revision}, q.price, request, q.presentation);
  }
  if (q.op === "price_action" && ["pause", "resume", "archive"].includes(q.action) &&
      uuid.test(q.request_id) && Number.isInteger(q.version) && Number.isInteger(q.control_revision)) {
    try {
      return await request<AlertRow>(`/chart-alerts/${row.id}/lifecycle`, {
        action:q.action, version:q.version, control_revision:q.control_revision, request_id:q.request_id,
      });
    } catch (error) {
      let saved: AlertRow | undefined;
      try { saved = await request<AlertRow>(`/chart-alerts/${row.id}`); } catch { /* Do not repeat an uncertain mutation. */ }
      const status = {pause:"paused",resume:"active",archive:"archived"}[q.action as "pause"|"resume"|"archive"];
      if (saved?.status === status && saved.version === q.version && saved.control_revision === q.control_revision + 1) return saved;
      const statusCode = (error as any)?.status;
      const ambiguous = !statusCode || statusCode < 400 || statusCode >= 500 || statusCode === 408;
      if (error instanceof Error) Object.assign(error, {...(saved?{currentRow:saved}:{}),
        ...(ambiguous && (!saved || (saved.version <= q.version && saved.control_revision <= q.control_revision)) ? {outcomeUnknown:true} : {})});
      throw error;
    }
  }
  throw Error("不允许的图表价格告警操作");
}
