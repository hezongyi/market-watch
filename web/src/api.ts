let csrf = "";
import { ApiError, responseError, errorMessage } from "./apiErrors";
export { ApiError, errorMessage, rpcError } from "./apiErrors";
export function apiErrorDetails(error: unknown) {
  return error instanceof ApiError ? {code:error.code, status:error.status, message:error.message, fieldErrors:error.fieldErrors, retryable:error.retryable, retryAfter:error.retryAfter, ...(error.notice_source_id?{notice_source_id:error.notice_source_id}:{}), ...(error.display_retry ? {display_retry:error.display_retry} : {})} :
    {message:errorMessage(error), code:error instanceof DOMException && error.name === 'AbortError' ? 'HISTORY_CANCELLED' :
      error instanceof DOMException && error.name === 'TimeoutError' ? 'HISTORY_TIMEOUT' :
      error instanceof TypeError ? 'NETWORK_FAILED' : 'HISTORY_UNAVAILABLE'};
}
type RequestDiagnostic = {
  at: number; path: string; method: string; elapsedMs: number;
  attempt: number; outcome: "ok" | "http" | "network" | "cancelled" | "timeout" | "payload";
  status?: number;
};
const requestDiagnostics: RequestDiagnostic[] = [];
const responseDiagnostics = new WeakMap<Response, RequestDiagnostic>();
/** Bounded, credential-free support evidence. No bodies, query strings or identities. */
export function apiRequestDiagnostics() { return requestDiagnostics.map(row => ({...row})); }
declare global { interface Window { MWChartRequestDiagnostics: typeof apiRequestDiagnostics } }
if(typeof window !== "undefined")
  Object.defineProperty(window,"MWChartRequestDiagnostics",{value:apiRequestDiagnostics,configurable:true});
function diagnosticPath(path: string) {
  return path.split("?")[0].split("/").map(part => {
    let decoded: string;
    try { decoded = decodeURIComponent(part); }
    catch { return ":id"; } // Invalid encoding must not leak an opaque identity.
    return /^[a-f0-9-]{32,}$/i.test(decoded) || /^(?:MW[HPC]:|DUKA:|OANDA:)/.test(decoded) ? ":id" : part;
  }).join("/");
}
async function observedFetch(path: string, init: RequestInit, attempt: number, readBody = false) {
  const started = performance.now(), at = Date.now();
  let outcome: RequestDiagnostic["outcome"] = "network", status: number | undefined;
  const record: RequestDiagnostic = {at,path:diagnosticPath(path),method:init.method || "GET",elapsedMs:0,attempt,outcome};
  try {
    const response = await fetch(`/api${path}`, init);
    status = response.status;
    if (status === 401 && csrf && !["/session", "/login", "/logout"].includes(path))
      dispatchEvent(new Event("mw-session-expired"));
    // Fetch resolves at headers. Keep the abort budget and diagnostic active
    // through body delivery; Safari can report Load failed during that phase.
    const body = readBody ? await response.arrayBuffer() : undefined;
    outcome = response.ok ? "ok" : "http";
    const result = readBody ? new Response([204,205,304].includes(response.status) ? null : body,
      {status:response.status,statusText:response.statusText,headers:response.headers}) : response;
    responseDiagnostics.set(result,record);return result;
  } catch (error) {
    const reason = init.signal?.aborted ? init.signal.reason : error;
    outcome = reason?.name === "TimeoutError" ? "timeout" : init.signal?.aborted ||
      reason?.name === "AbortError" ? "cancelled" : "network";
    throw error;
  } finally {
    Object.assign(record,{elapsedMs:Math.round(performance.now()-started),outcome,...(status ? {status} : {})});
    requestDiagnostics.push(record);
    if(requestDiagnostics.length>100)requestDiagnostics.shift();
  }
}
const readFlights = new Map<string, Promise<Response>>();
const safePostReads = new Set(["/charts/data", "/market-data/history/cache", "/market-data/quotes", "/market-data/resolve"]);
function abortableDelay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve,reject) => {
    const cancel = () => {clearTimeout(timer);signal?.removeEventListener("abort",cancel);reject(signal?.reason || new DOMException("已取消读取","AbortError"));};
    const timer = setTimeout(() => {signal?.removeEventListener("abort",cancel);resolve();},ms);
    if(signal?.aborted)cancel();else signal?.addEventListener("abort",cancel,{once:true});
  });
}
async function readFetch(path: string, init: RequestInit, signal?: AbortSignal) {
  const readable = init.method === "GET" || safePostReads.has(path);
  for(let attempt=1;;attempt++) {
    if(signal?.aborted)throw signal.reason || new DOMException("已取消读取","AbortError");
    try {
      const controller = new AbortController();
      const cancel = () => controller.abort(signal?.reason || new DOMException("已取消读取","AbortError"));
      signal?.addEventListener("abort",cancel,{once:true});
      // Native mandatory history has its own task budget and cancellation.
      let timeoutMs=30000;
      if(path==='/charts/data' && typeof init.body==='string') {
        try {const body=JSON.parse(init.body);if(body.native_history && !body.native_reserve)timeoutMs=610000;}catch { /* ordinary read */ }
      }
      const timer = readable ? setTimeout(() => controller.abort(new DOMException("读取超过时间预算","TimeoutError")),timeoutMs) : undefined;
      let response: Response;
      try {response=await observedFetch(path,{...init,signal:readable ? controller.signal : signal},attempt,true);}
      catch(error) {throw controller.signal.aborted ? controller.signal.reason : error;}
      finally {clearTimeout(timer);signal?.removeEventListener("abort",cancel);}
      if(!readable || attempt>=3 || ![408,429,502,503,504].includes(response.status))return response;
      const retryAfter=response.headers.get("Retry-After");
      // A permanent source/configuration failure must not consume retry budget.
      try { if ((await response.clone().json())?.detail?.retryable === false) return response; } catch { /* non-JSON upstream */ }
      // Long supplier cooldowns are surfaced, not shortened into more requests.
      if(retryAfter && (!/^\d+$/.test(retryAfter) || Number(retryAfter)>2))return response;
      await response.body?.cancel();
      await abortableDelay(Math.max(Number(retryAfter || 0)*1000,150*2**(attempt-1)+Math.random()*100),signal);
    } catch(error) {
      if(!readable || attempt>=3 || signal?.aborted || !(error instanceof TypeError))throw error;
      await abortableDelay(150*2**(attempt-1)+Math.random()*100,signal);
    }
  }
}
function requestFetch(path: string, init: RequestInit, signal?: AbortSignal) {
  // Cancellable consumers own their lifetime. Unsignalled concurrent chart reads
  // share the bounded retry sequence, with independent Response bodies.
  if(signal || !(init.method === "GET" || safePostReads.has(path)))return readFetch(path,init,signal);
  const key=JSON.stringify([csrf,path,init.method,init.body]);
  let flight=readFlights.get(key);
  if(!flight) {
    flight=readFetch(path,init);readFlights.set(key,flight);
    const clear=()=>{if(readFlights.get(key)===flight)readFlights.delete(key);};
    flight.then(clear,clear);
  }
  return flight.then(response=>{const copy=response.clone(),record=responseDiagnostics.get(response);
    if(record)responseDiagnostics.set(copy,record);return copy;});
}
export function apiResponse(path: string, body: unknown, signal?: AbortSignal) {
  return observedFetch(path, {
    method: "POST", credentials: "same-origin", signal,
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify(body),
  }, 1);
}
export function setCsrf(value: string) {
  if(value!==csrf){readFlights.clear();requestDiagnostics.length=0;}
  csrf = value;
}
export async function api<T = any>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await requestFetch(path, {
    method: body === undefined ? "GET" : "POST",
    signal,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, signal);
  let result;
  try {result = await response.json();}
  catch {
    const record=responseDiagnostics.get(response);if(record && response.ok)record.outcome="payload";
    if(response.ok)throw new ApiError("响应格式无法读取，请重试",response.status,"INVALID_RESPONSE");
    result={detail:`请求失败（HTTP ${response.status}）`};
  }
  if (!response.ok)
    throw responseError(result.detail, response.status, response.headers.get("Retry-After"));
  // Both standalone data center and embedded RPC use this authenticated path.
  // Broadcast only an explicit successful establishment, never a list read.
  if (path === '/market-data/composites/use' && body !== undefined &&
      !signal?.aborted && /^[a-f0-9]{64}$/.test(result?.id) && typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel('mw-composite-established-v1');
    channel.postMessage(result.id);
    channel.close();
  }
  return result;
}
export type Bar = {
  start: number;
  end: number;
  open: string;
  high: string;
  low: string;
  close: string;
  complete: boolean;
  revision: number;
};
export type Instrument = {
  id: string;
  label: string;
  symbol?: string;
  logical_symbol?: string;
  dataset_identity?: {
    source: string;
    channel: string;
    environment: string;
    account_scope: string;
    provider_symbol: string;
    basis: string;
    calendar_version: string;
  };
  source: string;
  basis: string;
  calendar: string;
  calendar_profile?: {revision?: string; closures?: {start: string; end: string; reason: string; source: string}[]};
  precision: number;
  quality: string;
  price: string | null;
  price_at: number | null;
  error: string | null;
};
export type Watch = {
  market_identity?: Record<string, any>;
  health?: string;
  health_reason?: string | null;
  runtime?: Record<string, any>;
  id: string;
  instrument_id: string;
  name: string;
  rule: Record<string, any>;
  status: string;
  armed_at: number;
  paused_reason: string | null;
  state: Record<string, any>;
};
export type Signal = {
  id: string;
  instrument_id: string;
  direction: string;
  reason: string;
  price: string;
  threshold: string;
  occurred_at: number;
  notification_id: string;
  notification_status: string;
  retry_available: boolean;
  device_delivery: "received" | "unknown";
  ack_at: number | null;
  evidence?: {
    rule_version?: string | number;
    indicator?: string;
    indicator_version?: string;
    indicator_params?: {fast?: number; slow?: number};
    indicator_previous?: {value: string; reference: string};
    indicator_current?: {value: string; reference: string};
    trigger_bar?: { start: string; end: string; open: string; high: string; low: string; close: string; revision: number };
    previous_bar?: { high: string; low: string; close: string; revision: number };
    previous_day?: { high: string; low: string; revision: number } | null;
  } & ({
    chart_alert: true;
    unit: "price" | "price_delta" | "rsi";
    left: string;
    ordinal: number;
    detected_at: number;
    late: boolean;
    config: {notify_web: boolean; timeframe: string};
    market_identity: {source: string};
    observation: Record<string, unknown>;
  } | {chart_alert?: false});
};
export const date = (n: number) =>
  new Date(n).toLocaleString("zh-CN", { hour12: false });
