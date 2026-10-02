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
    const series_kind = ticker.startsWith(prefix) ? "provider" : "managed";
    const symbol = series_kind === "provider" ? ticker.slice(prefix.length) : ticker;
    if (!/^[A-Za-z0-9:_-]{1,40}$/.test(symbol)) throw Error("无效品种标识");
    return { symbol, series_kind, ticker };
  }
  function encode(symbol, series_kind = "managed") {
    if (!["provider", "managed"].includes(series_kind)) throw Error("未知行情系列");
    if (decode(symbol).series_kind !== "managed") throw Error("需要基础品种标识");
    return series_kind === "provider" ? prefix + symbol : symbol;
  }
  function same(left, right) {
    const a = decode(left), b = decode(right);
    return a.symbol === b.symbol && a.series_kind === b.series_kind;
  }
  const display = symbol => symbol.split(":").at(-1).replace(/[_/]/g, "").toUpperCase();
  return { decode, encode, same, display };
})();
