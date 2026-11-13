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
  return compact !== code && /[\u4e00-\u9fff]/.test(compact) ? compact : "";
}
