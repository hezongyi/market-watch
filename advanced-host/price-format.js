/* Price presentation through the public formatter API. Data stays unrounded. */
function chartPricePrecision(symbolInfo) {
  if (!symbolInfo || symbolInfo.fractional ||
      symbolInfo.variable_tick_size) return null;
  const type = symbolInfo.type;
  const storagePrecision = ["yahoo", "dukascopy"].includes(symbolInfo.mw_range_source);
  if (!storagePrecision && !["stock", "fund"].includes(type)) return null;
  const hint = symbolInfo.mw_display_precision;
  const validHint = Number.isInteger(hint) && hint >= 0 && hint <= 8;
  // Storage precision and adjusted observations are not quote tick sizes.
  // Stocks/funds use cents; currencies retain reasonable supplier suggestions.
  const base = ["stock", "fund"].includes(type) ? 2 : type === "forex" ?
    (validHint ? Math.min(5, hint) : 5) : validHint ? hint :
      type === "commodity" ? 3 : 2;
  return reference => {
    const magnitude = Math.abs(reference);
    return magnitude > 0 && magnitude < 1 ?
      Math.min(8, Math.max(base, Math.ceil(-Math.log10(magnitude)) + 2)) : base;
  };
}
function chartPriceFormatter(symbolInfo, minTick) {
  // Explicit settings and supplier tick rules stay with the native formatter.
  if (minTick !== "default") return null;
  const precisionFor = chartPricePrecision(symbolInfo);
  if (!precisionFor) return null;
  const numbers = new Map();
  const format = (price, options, reference = price) => {
    if (!Number.isFinite(price)) return "—";
    const precision = precisionFor(reference);
    if (!numbers.has(precision)) numbers.set(precision, new Intl.NumberFormat("en-US", {
      minimumFractionDigits: precision, maximumFractionDigits: precision,
    }));
    // Do not show a negative zero for a price change smaller than display precision.
    if (Math.abs(price) < .5 * 10 ** -precision) price = 0;
    return (options?.signPositive && price > 0 ? "+" : "") + numbers.get(precision).format(price);
  };
  return { format, formatChange: (current, previous, options) =>
    format(current - previous, options, Math.max(Math.abs(current), Math.abs(previous))) };
}

/* Quote display metadata is independent of the unrounded snapshot values. */
function chartQuotePresentation({ s, n, v }, meta) {
  const precisionFor = chartPricePrecision({ mw_range_source: meta?.source,
    mw_display_precision: meta?.display_precision,
    type: ({ EQUITY: "stock", ETF: "fund", CURRENCY: "forex", METAL: "commodity" })[meta?.asset_type] });
  return { s, n, v: precisionFor && s === "ok" && Number.isFinite(v?.lp) ?
    { ...v, mw_display_pricescale: 10 ** precisionFor(v.lp) } : v };
}

function chartQuoteScale(quote, symbolInfo) {
  const scale = quote.v?.mw_display_pricescale;
  return quote.s === "ok" && Number.isInteger(scale) && scale >= 1 && scale <= 1e8 &&
    Number.isInteger(Math.log10(scale)) && !symbolInfo.fractional && !symbolInfo.variable_tick_size ?
      scale : symbolInfo.pricescale;
}
