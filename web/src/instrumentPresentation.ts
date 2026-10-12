import type { Instrument } from "./api";

const sources: Record<string, string> = {
  oanda: "OANDA",
  dukascopy: "Dukascopy",
  binance: "Binance",
  yahoo: "Yahoo",
};
export function instrumentName(instrument: Instrument) {
  if (instrument.logical_symbol) return instrument.logical_symbol;
  const symbol = instrument.symbol || instrument.label;
  // Normalize only familiar FX/metal codes; retain unknown provider products.
  const compact = symbol.toUpperCase().replace(/[_/]/g, "");
  return ["EURUSD", "XAUUSD", "BTCUSD", "BTCUSDT"].includes(compact)
    ? compact
    : symbol;
}
export function instrumentIcon(instrument: Instrument) {
  const symbol = instrumentName(instrument);
  return symbol === "XAUUSD"
    ? { text: "Au", className: "xauusd" }
    : symbol === "EURUSD"
      ? { text: "€", className: "eurusd" }
      : /^BTC(USD|USDT)$/.test(symbol)
        ? { text: "₿", className: "btcusd" }
        : { text: "·", className: "generic" };
}
export function instrumentIdentity(instrument: Instrument) {
  const identity = instrument.dataset_identity;
  const basis = identity?.basis || instrument.basis;
  const source = identity?.source || instrument.source;
  return [
    sources[source] || source,
    identity?.environment || "旧绑定 · 环境未核实",
    identity?.channel,
    identity?.account_scope && identity.account_scope !== "public"
      ? `账户范围 …${identity.account_scope.slice(-8)}`
      : null,
    basis === "bid" ? "Bid" : basis === "last" ? "Last" : basis,
    instrument.calendar === "ny17"
      ? "NY17"
      : instrument.calendar === "utc0"
        ? "UTC 00:00"
        : instrument.calendar,
  ]
    .filter(Boolean)
    .join(" · ");
}
