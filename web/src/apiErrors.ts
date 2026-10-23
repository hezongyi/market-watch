export type FieldError = { field: string; message: string };
export type ErrorDetails = {
  code: string;
  message: string;
  status: number;
  retryable: boolean;
  fieldErrors: FieldError[];
  retryAfter?: number;
};
export class ApiError extends Error {
  notice_source_id?: string;
  fieldErrors: FieldError[] = [];
  retryable: boolean;
  retryAfter?: number;
  constructor(
    message: string,
    public status: number,
    public code: string,
    public display_retry?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
    this.retryable = [408, 429, 502, 503, 504].includes(status);
  }
}
export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "请求未完成，请稍后重试";
}
const fields: Record<string, string> = {
  value: "比较值",
  lower: "下限",
  upper: "上限",
  expires_at: "到期时间",
  name: "警报名称",
  period: "计算长度",
  fast: "快线周期",
  slow: "慢线周期",
  signal: "信号周期",
  multiplier: "ATR 乘数",
};
// Legacy endpoints return localized plain strings. Unrecognized bodies and
// exception dumps must never become UI text, including across old RPC peers.
function publicMessage(value: unknown, fallback: string): string {
  return typeof value === "string" &&
    value.length <= 200 &&
    /[\u3400-\u9fff]/.test(value) &&
    !/[{}\[\]\r\n]|https?:|ApiError:|Traceback|password|cookie|token|secret/i.test(
      value,
    )
    ? value
    : fallback;
}
/** Allowlisted validation translation. Never copy input, ctx or raw bodies. */
export function responseError(
  detail: unknown,
  status: number,
  retryAfter?: string | null,
): ApiError {
  const fieldErrors: FieldError[] = [];
  if (typeof detail === "string") {
    if (detail.includes("到期时间"))
      fieldErrors.push({
        field: "expires_at",
        message: "请选择晚于当前时间的到期时间",
      });
    if (detail.includes("MACD"))
      fieldErrors.push({
        field: "condition",
        message: "MACD 参数不合法，请检查快线小于慢线及计算长度",
      });
  }
  if (Array.isArray(detail))
    for (const issue of detail) {
      const loc: string[] = Array.isArray(issue?.loc)
        ? issue.loc
            .map(String)
            .filter((s: string) => s !== "body" && s !== "config")
        : [];
      const key = loc.at(-1) || "condition";
      let message = `${fields[key] || (loc.includes("indicator") ? "指标参数" : "条件")}格式不正确，请检查`;
      const known = [
        "区间下限必须小于上限",
        "MACD fast 必须小于 slow",
        "到期时间必须晚于当前时间",
      ];
      const match = known.find(
        (text) => typeof issue.msg === "string" && issue.msg.includes(text),
      );
      if (match) message = match;
      if (loc.includes("indicator"))
        message = "指标参数不合法，请检查计算长度及 MACD 快线小于慢线";
      if (loc.includes("expires_at"))
        message = "请选择有效且晚于当前时间的到期时间";
      fieldErrors.push({ field: loc.join(".") || "condition", message });
    }
  const d =
    detail && typeof detail === "object" && !Array.isArray(detail)
      ? (detail as Record<string, unknown>)
      : {};
  const fallback =
    status === 409
      ? "内容已在其他窗口修改，请保留草稿并重新读取"
      : status === 422
        ? "输入不合法，请检查条件和到期时间"
        : "服务暂不可用，请稍后重试";
  const message = fieldErrors.length
    ? fieldErrors[0].message
    : publicMessage(typeof detail === "string" ? detail : d.message, fallback);
  const error = new ApiError(
    message,
    status,
    typeof d.code === "string"
      ? d.code
      : status === 422
        ? "VALIDATION_ERROR"
        : status === 503
          ? "HISTORY_BUSY"
          : "HISTORY_UNAVAILABLE",
    d.display_retry as Record<string, string> | undefined,
  );
  error.fieldErrors = fieldErrors;
  if (typeof d.notice_source_id === "string")
    error.notice_source_id = d.notice_source_id;
  if (typeof d.retryable === "boolean") error.retryable = d.retryable;
  if (retryAfter && /^\d+$/.test(retryAfter))
    error.retryAfter = Number(retryAfter);
  return error;
}
export function rpcError(error: unknown): ApiError {
  const value = error as Partial<ErrorDetails> & {
    display_retry?: Record<string, string>;
    notice_source_id?: string;
  };
  const result = new ApiError(
    publicMessage(
      typeof value?.message === "string" ? value.message : error,
      "请求未完成，请稍后重试",
    ),
    value?.status || 500,
    value?.code || "ALERT_REQUEST_FAILED",
    value?.display_retry,
  );
  result.notice_source_id = value?.notice_source_id;
  result.fieldErrors = Array.isArray(value?.fieldErrors)
    ? value.fieldErrors
    : [];
  result.retryable = value?.retryable ?? result.retryable;
  result.retryAfter = value?.retryAfter;
  return result;
}
