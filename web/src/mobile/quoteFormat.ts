/** Display rounding only; chart observations and cached prices retain precision. */
export function formatWatchPrice(price: unknown, precision?: unknown) {
  if (typeof price !== "number" || !Number.isFinite(price)) return "—";
  const digits = typeof precision === "number" && Number.isInteger(precision) &&
    precision >= 0 && precision <= 12 ? precision : 8;
  return price.toLocaleString(undefined, { maximumFractionDigits: digits });
}
