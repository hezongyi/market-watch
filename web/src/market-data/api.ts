import { api as request } from "../api";
export { ApiError } from "../api";

// A hung management request must release its form and allow reconciliation.
// A mutation timeout describes an unknown result; it does not stop the server.
export function api<T = any>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(20000);
  return request<T>(path, body, signal ? AbortSignal.any([signal, timeout]) : timeout).catch(error => {
    if (timeout.aborted && !signal?.aborted)
      throw Error(body === undefined ? "读取超时，请稍后重试。" : "请求超时，请核查提交结果后重试。");
    throw error;
  });
}
