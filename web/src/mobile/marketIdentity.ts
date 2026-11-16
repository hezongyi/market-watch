/** Display only. Never use labels as acquisition, paging or deduplication keys. */
export type MobileIdentity = {
  category: string;
  provider: string;
  channel: string;
  product: string;
  environment: string;
  provider_symbol: string;
};
export type IdentityInput = {
  mobile_identity?: MobileIdentity;
  source?: string;
  source_display?: string;
  asset_class?: string;
  price_basis_display?: string;
  basis?: string;
  frames?: string[] | Record<string, unknown>;
  capabilities?: { native_periods?: string[] };
  identity?: {
    source?: string;
    basis?: string;
    adjustment?: string;
    mode?: string;
  };
};
export function sourceLabel(source = "") {
  // Known presentation formats only; unknown upstream names remain untouched.
  return source
    .replace(/东方财富（AKShare）/g, "东方财富")
    .replace(/新浪(?:财经)?(?:（AKShare）)?/g, "新浪财经")
    .replace(/腾讯(?:财经)?(?:（AKShare）)?/g, "腾讯财经");
}
export function compactProvider(source = "") {
  const value = sourceLabel(source)
    .replace(/^历史[：:]\s*/, "")
    .split(/\s*→\s*实时[：:]/)[0]
    .trim();
  return (
    (
      {
        DUKASCOPY: "Dukas",
        "YAHOO FINANCE": "Yahoo",
        YAHOO: "Yahoo",
        "BINANCE SPOT": "Binance",
        BINANCE: "Binance",
        OANDA: "OANDA",
        "OANDA PRACTICE": "OANDA",
        "OANDA LIVE": "OANDA",
        FXCM: "FXCM",
        "FXCM DEMO": "FXCM",
        "FXCM REAL": "FXCM",
        AKSHARE: "AKShare",
      } as Record<string, string>
    )[value.toUpperCase()] ||
    value ||
    "来源待确认"
  );
}
export function displayIdentity(row: IdentityInput) {
  const fallback: MobileIdentity = {
    category:
      (
        {
          equity: "股票",
          stock: "股票",
          forex: "外汇",
          metal: "贵金属",
          crypto: "加密",
          index: "指数",
          future: "期货",
          futures: "期货",
        } as Record<string, string>
      )[row.asset_class || ""] || "待分类",
    provider: compactProvider(
      row.source_display || row.identity?.source || row.source,
    ),
    channel:
      (row.identity?.source || row.source) === "akshare" ? "AKShare" : "",
    product: "",
    environment: "",
    provider_symbol: "",
  };
  return row.mobile_identity || fallback;
}
export function seriesDifference(
  row: IdentityInput,
  custom = false,
  configuration = "",
) {
  const info = displayIdentity(row);
  const adjustment = (
    {
      none: "不复权",
      qfq: "前复权",
      hfq: "后复权",
      auto: "来源复权",
    } as Record<string, string>
  )[row.identity?.adjustment || ""];
  const rawBasis = row.identity?.basis || row.basis;
  const basis = (
    { bid: "bid", ask: "ask", mid: "mid" } as Record<string, string>
  )[rawBasis || ""];
  const frames =
    row.capabilities?.native_periods ||
    (Array.isArray(row.frames) ? row.frames : undefined);
  const limitation =
    !custom && frames?.length && !frames.some((f) => /^(M\d|H\d)/.test(f))
      ? frames.length === 1 && frames[0] === "D1"
        ? "仅日线"
        : "日周月"
      : "";
  return [
    info.product,
    info.environment,
    basis || adjustment || row.price_basis_display,
    limitation,
    configuration,
  ]
    .filter((x, i, a) => x && a.indexOf(x) === i)
    .join(" · ");
}

/** Only show configuration dimensions that actually distinguish same-name rows. */
export function configurationDifference(
  row: IdentityInput & { aggregation_calendar?: string },
  peers: (IdentityInput & { aggregation_calendar?: string })[],
) {
  const sameProvider = peers.filter(
    (other) =>
      displayIdentity(other).provider === displayIdentity(row).provider,
  );
  if (sameProvider.length < 2) return "";
  const differs = (
    read: (
      value: IdentityInput & { aggregation_calendar?: string },
    ) => string | undefined,
  ) => new Set(sameProvider.map(read)).size > 1;
  const parts: string[] = [];
  if (differs((r) => r.identity?.mode))
    parts.push(
      (
        {
          base_m1: "M1派生",
          base_d1: "D1派生",
          native_periods: "原生周期",
        } as Record<string, string>
      )[row.identity?.mode || ""] || "",
    );
  if (differs((r) => r.aggregation_calendar))
    parts.push(
      (
        { ny17: "NY17", utc0: "UTC0", source_date: "来源交易日" } as Record<
          string,
          string
        >
      )[row.aggregation_calendar || ""] || "",
    );
  if (differs((r) => r.identity?.basis)) parts.push(row.identity?.basis || "");
  if (differs((r) => r.identity?.adjustment))
    parts.push(
      (
        {
          none: "不复权",
          qfq: "前复权",
          hfq: "后复权",
          supplier: "来源价格",
        } as Record<string, string>
      )[row.identity?.adjustment || ""] || "",
    );
  return parts.filter(Boolean).join(" · ");
}

export function boundSource(identity: unknown = {}) {
  const saved = identity && typeof identity === "object" ? identity as Record<string, unknown> : {};
  const source = typeof saved.source === "string" ? saved.source : "";
  const family = typeof saved.source_family === "string" ? saved.source_family : "";
  if (source === "akshare") return ({"sina-a":"新浪财经","sina-hk":"新浪财经","sina-futures":"新浪财经","tencent-a":"腾讯财经","tencent-hk":"腾讯财经","eastmoney-a":"东方财富"} as Record<string,string>)[family] || "AKShare";
  return compactProvider(source === "composite" ? "" : source);
}
