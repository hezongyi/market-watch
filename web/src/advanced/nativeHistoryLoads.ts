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
  result_polling?: boolean;
};

export type HistoryProgress = {
  phase:
    "queued" | "checking" | "waiting" | "filling" | "delivering" | "applying";
  pages?: number;
  estimatedPages?: number;
  received?: number;
};

// Returning prices releases the bridge request, not the server handle. Keep
// the original four-load budget until cleanup finishes so rapid switches do
// not turn detached cleanup into unbounded owner tasks or API traffic.
const historyLifetimes = 4;
let admitted = 0;
let cleaning = 0;
let cleanupFailures = 0;
const admissions: Array<{
  grant: () => void;
  cancel: (error: Error) => void;
}> = [];
const capacityListeners = new Set<(available: number) => void>();

// The bridge keeps unsent work in its own focus-aware queue. Snapshots include
// cleanup from a previous workspace; its local dispatches remain provisional
// until the loader acknowledges that they acquired a lifetime.
export function subscribeHistoryLoadCapacity(listener: (available: number) => void) {
  capacityListeners.add(listener);
  listener(historyLifetimes - admitted);
  return () => { capacityListeners.delete(listener); };
}

function notifyCapacity() {
  for (const listener of capacityListeners) {
    try { listener(historyLifetimes - admitted); }
    catch { /* An observer must not interrupt lifetime acquisition or release. */ }
  }
}

export function historyLoadDiagnostics() {
  return { admitted, cleaning, queued: admissions.length, cleanupFailures };
}

declare global {
  interface Window { MWHistoryLoadDiagnostics: typeof historyLoadDiagnostics }
}
if (typeof window !== "undefined")
  Object.defineProperty(window, "MWHistoryLoadDiagnostics", {
    value: historyLoadDiagnostics, configurable: true,
  });

function drainAdmissions() {
  while (admitted < historyLifetimes && admissions.length)
    admissions[0].grant();
}

function acquireLifetime(signal: AbortSignal, deadline: number) {
  return new Promise<() => void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("已取消历史加载", "AbortError"));
      return;
    }
    if (deadline <= Date.now()) {
      reject(new ApiError("历史加载超过时间预算，请重试", 503, "HISTORY_TIMEOUT"));
      return;
    }
    if (admissions.length >= 64) {
      reject(new ApiError("历史加载任务繁忙，请稍后重试", 503, "HISTORY_BUSY"));
      return;
    }
    const dispose = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const entry = {
      grant: () => {
        if (signal.aborted) {
          entry.cancel(new DOMException("已取消历史加载", "AbortError"));
          return;
        }
        if (deadline <= Date.now()) {
          entry.cancel(new ApiError("历史加载超过时间预算，请重试", 503, "HISTORY_TIMEOUT"));
          return;
        }
        admissions.splice(admissions.indexOf(entry), 1);
        dispose();
        admitted++;
        notifyCapacity();
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          admitted--;
          drainAdmissions();
          notifyCapacity();
        });
      },
      cancel: (error: Error) => {
        const index = admissions.indexOf(entry);
        if (index < 0) return;
        admissions.splice(index, 1);
        dispose();
        reject(error);
      },
    };
    const abort = () => entry.cancel(new DOMException("已取消历史加载", "AbortError"));
    const timer = setTimeout(() => entry.cancel(new ApiError(
      "历史加载超过时间预算，请重试", 503, "HISTORY_TIMEOUT",
    )), Math.max(0, deadline - Date.now()));
    admissions.push(entry);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else drainAdmissions();
  });
}

/** One final datafeed result; progress belongs to the host UI, not getBars. */
export async function loadNativeHistory(
  query: unknown,
  signal: AbortSignal,
  capabilities: HistoryCapabilities,
  progress: (state: HistoryProgress) => void,
  noticeContext: Record<string, string> = {},
  onAdmitted?: (available: number) => void,
) {
  let handle: string | undefined;
  let delivered = false;
  const deadline = Date.now() + capabilities.task_seconds * 1000;
  const demand = query as { countBack?: number; limit?: number; history_page_bars?: number };
  const pageBars = demand.history_page_bars === 1000 ? 1000 : 4000;
  const estimate = Math.max(1, Math.ceil((demand.countBack || demand.limit || 1) / pageBars));
  const release = await acquireLifetime(signal, deadline);
  try {
    onAdmitted?.(historyLifetimes - admitted);
    progress({ phase: "checking", estimatedPages: estimate });
    let reply = await api(
      "/charts/history-loads",
      { request_id: crypto.randomUUID(), query, notice_context: noticeContext },
      signal,
    );
    if (reply.result) {
      progress({
        phase: "delivering",
        received: reply.result.bars?.length || 0,
      });
      delivered = true;
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
        ), state.state==='failed'?{notice_source_id:state.notice_source_id || 'native_history:'+handle}:{});
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
        // This endpoint already returns progress while unfinished. Capable
        // servers include final page counts beside data, so readiness does
        // not require a second HTTP round trip after readiness is observed.
        reply = capabilities.result_polling
          ? await api(`/charts/history-loads/${handle}/result`, undefined, signal)
          : {load: await api(`/charts/history-loads/${handle}`, undefined, signal)};
        delay = Math.min(1500, delay * 1.4);
      }
      if (reply.result) {
        const pages = reply.load?.pages ?? state?.pages ?? 0;
        progress({
          phase: "delivering",
          pages,
          estimatedPages: pages,
          received: reply.result.bars?.length || 0,
        });
        delivered = true;
        return {...reply.result,history_pages:pages};
      }
    }
  } finally {
    if (handle) {
      cleaning++;
      const cleanup = api(
        `/charts/history-loads/${handle}/cancel`,
        {},
        AbortSignal.timeout(5000),
      ).catch(() => {
        // Remote TTL remains the fallback after a transport failure. Retain
        // a bounded counter so failures are distinguishable from completion.
        cleanupFailures++;
      }).finally(() => {
        cleaning--;
        release();
      });
      if (!delivered) await cleanup;
    } else release();
  }
}
