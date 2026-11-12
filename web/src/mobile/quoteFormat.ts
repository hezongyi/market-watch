/** Display rounding only; chart observations and cached prices retain precision. */
export function formatWatchPrice(price: unknown, precision?: unknown, symbol = "") {
  if (typeof price !== "number" || !Number.isFinite(price)) return "—";
  const valid = typeof precision === "number" && Number.isInteger(precision) && precision >= 0 && precision <= 12;
  const currencies = new Set(["USD", "EUR", "JPY", "GBP", "CHF", "CAD", "AUD", "NZD", "CNH", "CNY", "HKD", "SGD", "NOK", "SEK", "DKK", "ZAR", "MXN", "TRY", "PLN"]);
  const pair = symbol.toUpperCase().replace(/\/|=X/g, "");
  const forex = pair.length === 6 && currencies.has(pair.slice(0, 3)) && currencies.has(pair.slice(3));
  const digits = forex ? pair.endsWith("JPY") ? 3 : 5 : valid ? precision : 8;
  return price.toLocaleString("en-US", { minimumFractionDigits: forex || valid ? digits : 0, maximumFractionDigits: digits });
}

/** Fractional pip stays small; the preceding two digits are the quick-scan focus. */
export function watchPriceParts(formatted: string) {
  const fraction = formatted.split(".")[1];
  if (!fraction || fraction.length < 3) return { prefix: formatted, focus: "", tail: "" };
  return { prefix: formatted.slice(0, -3), focus: formatted.slice(-3, -1), tail: formatted.slice(-1) };
}
