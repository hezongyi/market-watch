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
  let state: MarketTransportState = {
    client,
    state: "idle",
    openedAt: null,
    messageAt: null,
    heartbeatAt: null,
  };
  const provider = providerSubscriptions(
    api,
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
      });
      return meta.created === true;
    },
    (value) => {
      state = value;
      observers.forEach((observer) => observer(value));
    },
  );
  let paused = document.hidden;
  const visibility = () => {
    paused = document.hidden;
    if (paused) void provider.clear().catch((error) => report(String(error)));
    else
      for (const args of registrations.values())
        void provider.subscribe(args).catch((error) => report(String(error)));
  };
  document.addEventListener("visibilitychange", visibility);
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
      try {
        if (!paused) await provider.subscribe(registration);
      } catch (error) {
        receivers.delete(args.listener);
        throw error;
      }
    },
    async unsubscribe(args: any) {
      receivers.delete(args.listener);
      registrations.delete(args.listener);
      await provider.unsubscribe({ ...args, client });
    },
    accept(args: any) {
      return provider.accept({ ...args, client });
    },
    established: provider.established,
    dispose() {
      document.removeEventListener("visibilitychange", visibility);
      registrations.clear();
      receivers.clear();
      observers.clear();
      return provider.dispose();
    },
  };
}
export type MobileMarket = ReturnType<typeof mobileMarket>;
