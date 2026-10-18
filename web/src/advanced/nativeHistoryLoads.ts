import { api, ApiError } from "../api";

export type HistoryCapabilities = {
  protocol: number;
  version: string;
  mode: string;
  max_bars: number;
  workspace_bars: number;
  response_bytes: number;
  task_seconds: number;
  min_bars: number;
  hard_max_bars: number;
  default_bars: number;
};

export type HistoryProgress = {
  phase:
    "queued" | "checking" | "waiting" | "filling" | "delivering" | "applying";
  pages?: number;
  estimatedPages?: number;
  received?: number;
};

/** One final datafeed result; progress belongs to the host UI, not getBars. */
export async function loadNativeHistory(
  query: unknown,
  signal: AbortSignal,
  capabilities: HistoryCapabilities,
  progress: (state: HistoryProgress) => void,
) {
  let handle: string | undefined;
  const deadline = Date.now() + capabilities.task_seconds * 1000;
  const demand = query as { countBack?: number; limit?: number; history_page_bars?: number };
  const pageBars = demand.history_page_bars === 1000 ? 1000 : 4000;
  const estimate = Math.max(1, Math.ceil((demand.countBack || demand.limit || 1) / pageBars));
  try {
    progress({ phase: "checking", estimatedPages: estimate });
    let reply = await api(
      "/charts/history-loads",
      { request_id: crypto.randomUUID(), query },
      signal,
    );
    if (reply.result) {
      progress({
        phase: "delivering",
        received: reply.result.bars?.length || 0,
      });
      return {...reply.result,history_pages:0};
    }
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
        throw Object.assign(new ApiError(
          error?.message || "历史加载已结束",
          error?.status || 503,
          error?.code || "HISTORY_UNAVAILABLE",
        ), state.state==='failed'?{notice_source_id:'native_history:'+handle}:{});
      }
      progress({
        phase:
          state?.state === "ready"
            ? "delivering"
            : state?.state === "filling" || state?.pages
              ? "filling"
              : "waiting",
        pages: state?.pages || 0,
        estimatedPages: state?.state === "ready" ? state.pages || 0 : Math.max(estimate, (state?.pages || 0) + 1),
      });
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
      if (reply.result) {
        progress({
          phase: "delivering",
          pages: state?.pages || 0,
          estimatedPages: state?.pages || 0,
          received: reply.result.bars?.length || 0,
        });
        return {...reply.result,history_pages:state?.pages || 0};
      }
    }
  } finally {
    if (handle)
      await api(
        `/charts/history-loads/${handle}/cancel`,
        {},
        AbortSignal.timeout(5000),
      ).catch(() => {});
  }
}
