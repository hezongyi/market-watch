import { api } from "../api";
import { prepareChart } from "../runtime/chart";
import { loadNativeHistory, startupHistoryQuery, type HistoryCapabilities, type StartupPreparation } from "../advanced/nativeHistoryLoads";
import { profileActive, readSnapshot, type ChartDocument, type Profile } from "./cache";
import { chartSymbolKey, sameChartSymbol } from "./chartIdentity";

export const mobileChartManifest = () => document.querySelector<HTMLMetaElement>('meta[name="mw-chart-manifest"]')?.content;

/** Phone-session preparation only. Historical quantities remain server-owned. */
export function mobileChartPreparation(profile: Profile) {
  const controller = new AbortController();
  let configuration: Promise<[any, HistoryCapabilities]> | undefined;
  let candidates: string[] = [], focused = false, paused = document.hidden;
  let timer: ReturnType<typeof setTimeout> | undefined, running = false;
  let resourcesPrepared = false;
  let reschedule = false;
  let lastInterval = "60";
  const intervals = new Map<string, string>(), completed = new Set<string>();
  const startup = { current: null as StartupPreparation | null };
  const config = () => configuration ||= Promise.all([
    api("/advanced-charts/catalog", undefined, controller.signal),
    api<HistoryCapabilities>("/charts/history-capabilities", undefined, controller.signal),
  ]).catch(error => { configuration = undefined; throw error; });
  const active = () => !controller.signal.aborted && profileActive(profile);
  const schedule = () => {
    clearTimeout(timer);
    if (resourcesPrepared && candidates.every(ticker => completed.has(ticker+"|"+(intervals.get(ticker) || lastInterval)))) return;
    if (running) {reschedule = true; return;}
    if (active() && !paused && !focused && !running) timer = setTimeout(() => void warm(), 1200);
  };
  const cancel = () => { startup.current?.controller.abort(); startup.current = null; };
  async function warm() {
    if (!active() || paused || focused || running) return;
    running = true;
    try {
      await Promise.all([prepareChart(mobileChartManifest()), config()]);
      resourcesPrepared = true;
      const saved = await readSnapshot<ChartDocument>(profile, "chart").catch(() => undefined);
      lastInterval = saved?.value.interval || lastInterval;
      if (saved?.value.symbol) intervals.set(chartSymbolKey(saved.value.symbol), lastInterval);
      const [, capabilities] = await config();
      for (const ticker of candidates) {
        if (!active() || paused || focused) break;
        const interval = intervals.get(ticker) || lastInterval;
        const key = ticker + "|" + interval;
        if (completed.has(key)) continue;
        // Reuse the existing startup preparation protocol (one opportunity
        // page); it warms the authoritative cache, not a second candle store.
        const query = startupHistoryQuery({symbol:ticker, interval});
        completed.add(key);
        if (!query || !capabilities.startup_preparation) continue;
        const warming = new AbortController();
        const result = loadNativeHistory({...query, native_history:{...query.native_history, focused:false}},
          warming.signal, capabilities, () => {}, {}, undefined, true);
        const preparation = {...query, controller:warming, result:result.catch(() => undefined)};
        startup.current = preparation;
        try {
          await result;
          if (!warming.signal.aborted) completed.add(key);
        } catch { /* The foreground chart owns user-visible failures/retry. */ }
        finally { if (startup.current === preparation) startup.current = null; }
      }
    } catch { /* Opening a chart retries failed resource/config preparation. */ }
    finally { running = false; if(reschedule){reschedule=false;schedule();} }
  }
  return {
    config, startup,
    update(last: string, first: string, visible: boolean) {
      candidates = [...new Set([last, first].filter(Boolean).map(chartSymbolKey))].slice(0, 2);
      focused = visible;
      if (visible && startup.current && !sameChartSymbol("MWP:" + startup.current.instrument, last)) cancel();
      schedule();
    },
    foreground(ticker: string, timeframe?: string) {
      const interval = ({M1:"1",M5:"5",M15:"15",M30:"30",H1:"60",H4:"240",D1:"1D",W1:"1W",MN:"1M"} as Record<string,string>)[timeframe || ""];
      if (interval) { lastInterval = interval; intervals.set(chartSymbolKey(ticker), interval); }
      const pending = startup.current;
      if (pending && (!sameChartSymbol("MWP:" + pending.instrument, ticker) || timeframe && pending.timeframe !== timeframe)) cancel();
      clearTimeout(timer);
    },
    visibility(hidden: boolean) { paused = hidden; if (hidden) { clearTimeout(timer); cancel(); } else schedule(); },
    dispose() { clearTimeout(timer); controller.abort(); cancel(); },
  };
}
export type MobileChartPreparation = ReturnType<typeof mobileChartPreparation>;
