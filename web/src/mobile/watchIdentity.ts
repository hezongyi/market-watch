/** Compact watch labels; full source descriptions remain in detail/management. */
export function watchDescription(code: string, name: string) {
  const known: Record<string, string> = {
    AAPL: "苹果", NVDA: "英伟达", MSFT: "微软", TSLA: "特斯拉", AMZN: "亚马逊",
    GOOGL: "谷歌", GOOG: "谷歌", META: "Meta", XAUUSD: "黄金", XAGUSD: "白银",
  };
  const crypto: Record<string, string> = { BTC: "比特币", ETH: "以太坊", SOL: "索拉纳", BNB: "币安币", XRP: "瑞波币", DOGE: "狗狗币", LTC: "莱特币", ADA: "艾达币" };
  const shown = code.toUpperCase();
  if (known[shown]) return known[shown];
  const base = shown.match(/^(BTC|ETH|SOL|BNB|XRP|DOGE|LTC|ADA)(?:USDT|USDC|USD|BTC|ETH)(?:[-.]PERP)?$/)?.[1];
  if (base) return crypto[base];
  const compact = name.split(" · ")[0].replace(/\s*[/／]\s*/g, "").replace(/公司$/, "").trim();
  if (compact !== code && /[\u4e00-\u9fff]/.test(compact)) return compact;
  // Fixed histories may carry only the code, without a translated instrument name.
  const currencies: Record<string, string> = {
    USD: "美元", EUR: "欧元", GBP: "英镑", JPY: "日元", CHF: "瑞郎",
    AUD: "澳元", NZD: "新西兰元", CAD: "加元", CNH: "离岸人民币",
    CNY: "人民币", HKD: "港元", SGD: "新加坡元", NOK: "挪威克朗",
    SEK: "瑞典克朗", DKK: "丹麦克朗", ZAR: "南非兰特",
    TRY: "土耳其里拉", MXN: "墨西哥比索", PLN: "波兰兹罗提",
  };
  return shown.length === 6 && currencies[shown.slice(0, 3)] && currencies[shown.slice(3)]
    ? currencies[shown.slice(0, 3)] + currencies[shown.slice(3)] : "";
}
