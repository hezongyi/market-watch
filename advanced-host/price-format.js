/* Price presentation through the public formatter API. Data stays unrounded. */
function chartPriceFormatter(symbolInfo, minTick) {
  const precision = symbolInfo?.mw_display_precision;
  if (symbolInfo?.mw_range_source !== "yahoo" || minTick !== "default" ||
      !Number.isInteger(precision) || precision < 0 || precision > 8) return null;
  const number = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: precision, maximumFractionDigits: precision,
  });
  const format = (price, options) => {
    if (!Number.isFinite(price)) return "—";
    // Do not show a negative zero for a price change smaller than display precision.
    if (Math.abs(price) < .5 * 10 ** -precision) price = 0;
    return (options?.signPositive && price > 0 ? "+" : "") + number.format(price);
  };
  return { format, formatChange: (current, previous, options) => format(current - previous, options) };
}
