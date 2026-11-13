/** Native widgets uppercase dataset IDs; the picker and API keep them lowercase. */
export function chartSymbolKey(symbol: string) {
  return symbol
    .replace(/^(MWP:(?:YAHOO|AKSHARE|DUKA|NATIVE|FXCM):)([a-f0-9]{32})$/i,
      (_, prefix: string, id: string) => prefix.toUpperCase() + id.toLowerCase())
    .replace(/^(MW[CH]:)([a-f0-9-]+)$/i,
      (_, prefix: string, id: string) => prefix.toUpperCase() + id.toLowerCase());
}
export const sameChartSymbol = (left: string, right: string) => chartSymbolKey(left) === chartSymbolKey(right);
