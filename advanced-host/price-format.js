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

// Native format is captured from the initiating pane. Convert only the pinned
// formatter's decimal notation, with grouping validated before removing it.
// This is deliberately independent of an optional/private formatter.parse.
function chartAlertPricePresentation(chart, price) {
  const formatter = chart.priceFormatter?.();
  const text = formatter?.format(price);
  const normalized = value => String(value || '').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,'').replace(/\u2212/g, '-');
  const decimal = normalized(text);
  const info = chart.symbolExt?.();
  if (info?.fractional && /^[+]?\d+'\d+(?:'\d+)?$/.test(decimal)) {
    const parts = decimal.replace(/^\+/,'').split("'");
    const scale=info.pricescale, factor=info.minmove2 || 1;
    const digits=(value,base,second=false)=>{
      const special=base===2 ? [0,5] : base===4 ? [0,2,5,7] : base===8 && second ? [0,1,2,3,5,6,7,8] : null;
      return special ? special.indexOf(Number(value)) : Number(value);
    };
    const first=digits(parts[1],scale/factor),second=parts.length===3 ? digits(parts[2],factor,true) : 0;
    if(!Number.isSafeInteger(scale) || scale<=0 || ![1,2,4,8].includes(factor) ||
        parts.length!==(factor===1 ? 2 : 3) || first<0 || first>=scale/factor || second<0 || second>=factor)
      throw Error('当前分数报价格式无法确定十进制阈值，请在告警表单中输入价格');
    // Exact finite decimal conversion, independent of native/private parse.
    const denominator=BigInt(scale),numerator=BigInt(parts[0])*denominator+BigInt(first*factor+second);
    let remainder=numerator%denominator,value=String(numerator/denominator),fraction='';
    for(let place=0;remainder && place<16;place++) {
      remainder*=10n;fraction+=String(remainder/denominator);remainder%=denominator;
    }
    if(remainder) throw Error('分数报价无法用有限十进制表示，请输入价格');
    if(fraction)value+='.'+fraction;
    if(Number(value)<=0 || normalized(formatter.format(Number(value)))!==decimal)
      throw Error('分数报价核对失败，请在告警表单中输入价格');
    return {text,value};
  }
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(decimal))
    throw Error('当前报价格式无法确定十进制阈值，请在告警表单中输入价格');
  const value = decimal.replace(/,/g, '').replace(/^\+/, '');
  if (!Number.isFinite(Number(value)) || Number(value) <= 0)
    throw Error('告警价格必须大于零');
  return {text, value};
}
