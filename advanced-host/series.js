/* Bare tickers remain managed, including all pre-dual-series saved drawings. */
const MWSeries = (() => {
  const prefix = "MWP:";
  function decode(ticker) {
    if (typeof ticker !== "string" || !ticker) throw Error("无效行情标识");
    if (ticker.startsWith("MWPY_")) {
      const payload = JSON.parse(atob(ticker.slice(5)));
      const base = decode(payload.symbol);
      if (base.spec) throw Error("指标不能嵌套行情标识");
      if (payload.series_kind && payload.series_kind !== base.series_kind)
        throw Error("指标行情系列不一致");
      return { ...base, spec: payload.spec, key: payload.key };
    }
    for (const [prefix, series_kind, pattern] of [
      ["MWH:", "history", /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/],
      ["MWC:", "composite", /^[a-f0-9]{64}$/],
    ]) if (ticker.startsWith(prefix)) {
      const symbol = ticker.slice(prefix.length).toLowerCase();
      if (!pattern.test(symbol)) throw Error("无效固定行情标识");
      return {symbol, series_kind, ticker};
    }
    const series_kind = ticker.startsWith(prefix) ? "provider" : "managed";
    let symbol = series_kind === "provider" ? ticker.slice(prefix.length) : ticker;
    if (/^(YAHOO|DUKA|NATIVE):[A-Fa-f0-9]{32}$/.test(symbol)) {
      const parts=symbol.split(":");symbol=parts[0]+":"+parts[1].toLowerCase();
    }
    if (!/^[A-Za-z0-9:_-]{1,40}$/.test(symbol)) throw Error("无效品种标识");
    return { symbol, series_kind, ticker };
  }
  function encode(symbol, series_kind = "managed") {
    if (["history", "composite"].includes(series_kind)) {
      const ticker = (series_kind === "history" ? "MWH:" : "MWC:") + symbol;
      decode(ticker);
      return ticker;
    }
    if (!["provider", "managed"].includes(series_kind)) throw Error("未知行情系列");
    if (decode(symbol).series_kind !== "managed") throw Error("需要基础品种标识");
    const canonical = decode(symbol).symbol;
    return series_kind === "provider" ? prefix + canonical : canonical;
  }
  function same(left, right) {
    const a = decode(left), b = decode(right);
    return a.symbol === b.symbol && a.series_kind === b.series_kind;
  }
  const display = symbol => symbol.split(":").at(-1).replace(/[_/]/g, "").toUpperCase();
  return { decode, encode, same, display };
})();
