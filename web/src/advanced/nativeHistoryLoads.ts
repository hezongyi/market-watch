import { api, ApiError } from "../api";

export type HistoryCapabilities = {
  protocol: number;
  version: string;
  mode: string;
  max_bars: number;
  workspace_bars: number;
  response_bytes: number;
  task_seconds: number;
};

/** One final datafeed result; progress belongs to the host UI, not getBars. */
export async function loadNativeHistory(
  query: unknown,
  signal: AbortSignal,
  capabilities: HistoryCapabilities,
  progress: (text: string) => void,
) {
  let handle: string | undefined;
  const deadline = Date.now() + capabilities.task_seconds * 1000;
  try {
    let reply = await api(
      "/charts/history-loads",
      { request_id: crypto.randomUUID(), query },
      signal,
    );
    if (reply.result) return reply.result;
    handle = reply.load?.id;
    if (!handle) throw Error("历史加载协议不匹配，请刷新工作区");
    let delay = 200;
    while (true) {
      if (signal.aborted)
        throw new DOMException("已取消历史加载", "AbortError");
      if (Date.now() >= deadline)
        throw new ApiError(
          "历史加载超过时间预算，请重试",
          503,
          "HISTORY_TIMEOUT",
        );
      const state = reply.load;
      if (["failed", "cancelled", "expired"].includes(state?.state)) {
        const error = state.error;
        throw new ApiError(
          error?.message || "历史加载已结束",
          error?.status || 503,
          error?.code || "HISTORY_UNAVAILABLE",
        );
      }
      progress(
        state?.pages
          ? `正在加载历史，已缓存 ${state.pages} 页`
          : "正在等待历史数据",
      );
      if (state?.state === "ready")
        reply = await api(
          `/charts/history-loads/${handle}/result`,
          undefined,
          signal,
        );
      else {
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            reject(new DOMException("已取消历史加载", "AbortError"));
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
          }, delay);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
        reply = {
          load: await api(`/charts/history-loads/${handle}`, undefined, signal),
        };
        delay = Math.min(1500, delay * 1.4);
      }
      if (reply.result) return reply.result;
    }
  } finally {
    progress("");
    if (handle)
      await api(
        `/charts/history-loads/${handle}/cancel`,
        {},
        AbortSignal.timeout(5000),
      ).catch(() => {});
  }
}
