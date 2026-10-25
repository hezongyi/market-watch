const objectId = "[a-f0-9]{64}";
const knownPath = new RegExp(`^/market-data(?:/platform/configure|/datasets/new|/datasets/${objectId}(?:/mapping)?|/composites/${objectId})?/?$`);
const keys = new Set(["tab", "status", "page", "query", "source", "calendar", "asset_class", "dataset_id", "view", "instrument", "symbol", "precision", "section", "version", "frame", "before", "coverage_page", "request_page", "return_to", "return_key"]);

/** Old addresses carry a bounded location, never a URL to execute or embed. */
export function centerLocation(value: string, base = "/market-data"): string {
  if (value.length > 4000 || value.startsWith("//")) return "/market-data";
  let url: URL;
  try { url = new URL(value, new URL(base, "https://center.invalid")); }
  catch { return "/market-data"; }
  if (url.origin !== "https://center.invalid" || !knownPath.test(url.pathname)) return "/market-data";
  const query = new URLSearchParams();
  for (const [key, item] of url.searchParams) {
    if (!keys.has(key) || item.length > (key === "return_to" ? 1500 : 200)) continue;
    if (key === "return_to" && !/^\/market-data(?:\?[^#]*)?(?:#[a-z0-9-]+)?$/.test(item)) continue;
    if (key === "version" && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(item)) continue;
    if (key === "return_key" && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(item)) continue;
    if (key === "return_to") {
      const back = new URL(item, "https://center.invalid");
      if (back.searchParams.has("return_to") || back.searchParams.has("return_key")) continue;
      query.set(key, centerLocation(item));
      continue;
    }
    if (key === "dataset_id" && !/^[a-f0-9]{64}$/.test(item)) continue;
    if (key === "instrument" && !/^(?:MWP:)?[A-Za-z0-9:_-]{1,40}$/.test(item)) continue;
    if (["page", "coverage_page", "request_page", "before", "precision"].includes(key) && !/^\d{1,16}$/.test(item)) continue;
    if (key === "frame" && !["M1","M5","M15","M30","H1","H4","D1","W1","MN"].includes(item)) continue;
    if (key === "tab" && !["managed","platform","composite","tasks","sources","calendar"].includes(item)) continue;
    if (key === "section" && !["overview","coverage","versions","maintenance","references","chart","seam","usage"].includes(item)) continue;
    if (key === "source" && !["", "dukascopy","oanda","fxcm","binance","yahoo"].includes(item)) continue;
    if (key === "calendar" && !["", "ny17", "utc0"].includes(item)) continue;
    query.set(key, item);
  }
  const hash = /^#[a-z0-9-]{1,90}$/.test(url.hash) ? url.hash : "";
  return url.pathname.replace(/\/$/, "") + (query.size ? `?${query}` : "") + hash;
}

export function centerTab(value: string) {
  const url = new URL(value, "https://center.invalid");
  if (url.pathname.includes("/composites/") || url.pathname.endsWith("/mapping")) return "composite";
  if (url.pathname.includes("/platform/")) return "platform";
  const tab = url.searchParams.get("tab") || "managed";
  return ["managed", "platform", "composite", "tasks", "sources", "calendar"].includes(tab) ? tab : "managed";
}

/** Equivalent addresses must share a saved scroll/focus position. */
export function centerPositionKey(value: string) {
  const url = new URL(centerLocation(value), "https://center.invalid");
  if (new RegExp(`^/market-data/datasets/${objectId}$`).test(url.pathname))
    url.searchParams.set("section", url.searchParams.get("section") || "overview");
  url.searchParams.sort();
  return url.pathname + url.search + url.hash;
}
