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
  result_waiting?: boolean;
  startup_preparation?: boolean;
};

export type HistoryProgress = {
  phase:
    "queued" | "checking" | "waiting" | "filling" | "delivering" | "applying";
  pages?: number;
  estimatedPages?: number;
  received?: number;
};

export type StartupPreparation = {
  instrument: string;
  timeframe: string;
  controller: AbortController;
  result: Promise<any>;
};

export async function waitStartupPreparation(preparation: StartupPreparation | null | undefined,
  instrument: string, signal: AbortSignal) {
  if (!preparation || preparation.instrument !== instrument || preparation.controller.signal.aborted) return;
  const waiting = AbortSignal.any([signal, preparation.controller.signal]);
  waiting.throwIfAborted();
  let abort: () => void = () => {};
  try {
    return await Promise.race([preparation.result, new Promise<never>((_, reject) => {
      abort = () => reject(new DOMException("已取消启动等待", "AbortError"));
      waiting.addEventListener("abort", abort, {once:true});
    })]);
  } finally {
    waiting.removeEventListener("abort", abort);
  }
}

/** Reuse Yahoo's worker metadata instead of starting a second SDK request. */
export async function startupMetadata(preparation: StartupPreparation | null | undefined,
  instrument: string, signal: AbortSignal) {
  if (!preparation || preparation.instrument !== instrument ||
      !instrument.startsWith("YAHOO:") || preparation.controller.signal.aborted) return;
  const value = await waitStartupPreparation(preparation, instrument, signal);
  if (value?.prepared && value.metadata?.source === "yahoo" &&
      value.metadata.id?.toUpperCase() === instrument.toUpperCase()) return value.metadata;
}

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
  prepare = false,
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
      "/charts/history-loads" + (capabilities.result_waiting ? "?wait_ms=3000" : ""),
      { request_id: crypto.randomUUID(), query, notice_context: noticeContext, ...(prepare ? {prepare: true} : {}) },
      signal,
    );
    handle = reply.load?.id;
    if (reply.result) {
      progress({
        phase: "delivering",
        received: reply.result.bars?.length || 0,
      });
      delivered = true;
      return {...reply.result,history_pages:reply.load?.pages ?? 0};
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
      else if (capabilities.result_waiting) {
        reply = await api(`/charts/history-loads/${handle}/result?wait_ms=1500`, undefined, signal);
      } else {
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

/** Only the authoritative single-chart state may start an optional page early. */
export function startupHistoryQuery(document: Record<string, any>, initialSymbol?: {ticker: string; metadata: Record<string, unknown>}) {
  let state = document.state;
  if (state && !state.charts && typeof state.content === "string") {
    try { state = JSON.parse(state.content); } catch { return null; }
  }
  let ticker = document.symbol, resolution = document.interval || "240";
  if (state?.charts?.length) {
    if (state.charts.length !== 1) return null;
    const sources = (state.charts[0].panes || []).flatMap((pane: any) => pane.sources || []);
    if (sources.some((source: any) => /study/i.test(source.type || ""))) return null;
    const mains = sources.filter((source: any) => source.type === "MainSeries");
    if (mains.length !== 1) return null;
    ticker = mains[0].state?.symbol;
    resolution = mains[0].state?.interval || resolution;
  }
  if (typeof ticker !== "string" || !ticker.startsWith("MWP:")) return null;
  const metadata = initialSymbol?.ticker === ticker ? initialSymbol.metadata : undefined;
  const source = ({OANDA:"oanda", NATIVE:"oanda", BINANCE:"binance", DUKA:"dukascopy",
    YAHOO:"yahoo", AKSHARE:"akshare", TENCENT:"akshare", FXCM:"fxcm"} as Record<string,string>)[ticker.split(":")[1]]
    || metadata?.source;
  if (!(["oanda","binance","dukascopy","yahoo","akshare","fxcm"] as unknown[]).includes(source)) return null;
  const timeframe = ({"1":"M1","5":"M5","15":"M15","30":"M30","60":"H1","240":"H4","1D":"D1","1W":"W1","1M":"MN"} as Record<string,string>)[resolution];
  if (!timeframe || source === "yahoo" && timeframe === "H4" ||
      Array.isArray(metadata?.frames) && !metadata.frames.includes(timeframe)) return null;
  return {instrument:ticker.slice(4), series_kind:"provider", timeframe,
    limit:1, countBack:1, firstDataRequest:true, indicators:[], history_page_bars:4000,
    native_history:{chart_count:1,focused:true,screen_bars:1,batch_screens:1}};
}
