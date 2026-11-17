import { logEvent } from "./logs";
import { api } from "../api";
import {
  providerSubscriptions,
  type MarketTransportState,
} from "../advanced/providerSubscriptions";

export type MarketEvent = {
  listener: string;
  type: string;
  quotes?: any[];
  [key: string]: any;
};
export function seriesIdentity(ticker: string) {
  for (const [prefix, kind] of [
    ["MWP:", "provider"],
    ["MWH:", "history"],
    ["MWC:", "composite"],
  ])
    if (ticker.startsWith(prefix))
      return { instrument: ticker.slice(prefix.length), series_kind: kind };
  return { instrument: ticker, series_kind: "managed" };
}
/** One application client, including native chart listeners and visible quote rows. */
export function mobileMarket(report: (message: string) => void) {
  const client = crypto.randomUUID();
  const receivers = new Map<string, (event: MarketEvent) => void>();
  const registrations = new Map<string, any>();
  const observers = new Set<(value: MarketTransportState) => void>();
  const inactive = () => document.hidden ||
    (typeof navigator !== "undefined" && navigator.onLine === false);
  let disposed = false, paused = inactive(), transportSince = Date.now();
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const watch = () => {
    clearTimeout(watchdog);
    if (disposed || paused || !registrations.size) return;
    watchdog = setTimeout(() => {
      const last = Math.max(state.openedAt || 0, state.messageAt || 0,
        state.heartbeatAt || 0, transportSince);
      // The server emits heartbeats even when prices do not change. Price
      // movement is never used as transport-health evidence.
      if (state.state !== "idle" && Date.now() - last >= 15_000) {
        logEvent({module:"行情",action:"行情连接",message:"行情心跳超时，正在重新同步",level:"warning",result:"failure"});
        provider.reconnect(client);
      }
      watch();
    }, 5_000);
  };
  let state: MarketTransportState = {
    client,
    state: "idle",
    openedAt: null,
    messageAt: null,
    heartbeatAt: null,
  };
  const provider = providerSubscriptions(
    (path, body) => api(path, body, AbortSignal.timeout(15_000)),
    () =>
      new EventSource(
        "/api/charts/stream/events?client=" + encodeURIComponent(client),
      ),
    (event) => receivers.get(event.listener)?.(event),
    (error) => report(String(error)),
    undefined,
    undefined,
    async (args) => {
      const query = args.query as { series_kind: string; instrument: string };
      if (query?.series_kind !== "composite") return true;
      const meta = await api("/market-data/resolve", {
        ...query,
        timeframe: "M1",
      }, AbortSignal.timeout(15_000));
      return meta.created === true;
    },
    (value) => {
      if (state.state !== value.state || state.openedAt !== value.openedAt)
        transportSince = Date.now();
      if(state.state!==value.state && value.state==="error")logEvent({module:"行情",action:"行情连接",message:"连接中断，正在自动重连",level:"warning",result:"failure"});
      if(state.state==="error" && value.state==="open")logEvent({module:"行情",action:"行情连接",message:"连接已恢复",result:"recovery"});
      state = value;
      observers.forEach((observer) => observer(value));
    },
  );
  const visibility = () => {
    if (paused === inactive()) return;
    paused = inactive();
    if (paused) void provider.clear().catch((error) => report(String(error)));
    else
      for (const args of registrations.values())
        void provider.subscribe(args).catch((error) => report(String(error)));
    watch();
  };
  const online = () => {
    if (disposed) return;
    const wasPaused = paused;
    visibility();
    if (!wasPaused && !paused) provider.reconnect(client);
  };
  document.addEventListener("visibilitychange", visibility);
  addEventListener("online", online);
  addEventListener("offline", visibility);
  return {
    client,
    observe(callback: (value: MarketTransportState) => void) {
      observers.add(callback);
      callback(state);
      return () => {
        observers.delete(callback);
      };
    },
    async subscribe(args: any, receive: (event: MarketEvent) => void) {
      receivers.set(args.listener, receive);
      const registration = { ...args, client };
      registrations.set(args.listener, registration);
      watch();
      try {
        if (!paused) await provider.subscribe(registration);
      } catch (error) {
        receivers.delete(args.listener);
        throw error;
      }
    },
    async unsubscribe(args: any) {
      const current = registrations.get(args.listener);
      if (current?.generation != null && args.generation != null &&
          args.generation < current.generation) return;
      receivers.delete(args.listener);
      registrations.delete(args.listener);
      watch();
      await provider.unsubscribe({ ...args, client });
    },
    accept(args: any) {
      return provider.accept({ ...args, client });
    },
    established: provider.established,
    dispose() {
      disposed = true;
      clearTimeout(watchdog);
      document.removeEventListener("visibilitychange", visibility);
      removeEventListener("online", online);
      removeEventListener("offline", visibility);
      registrations.clear();
      receivers.clear();
      observers.clear();
      return provider.dispose();
    },
  };
}
export type MobileMarket = ReturnType<typeof mobileMarket>;
