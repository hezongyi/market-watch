import type { Dataset } from "./types";

export type CatalogEntry = {
  catalog_id: string;
  provider_symbol: string;
  display_symbol?: string;
  label: string;
  asset_class: string;
  precision: number;
  updated_at?: number;
};
export type ProductMatch = {
  underlying: string;
  quote_currency: string;
  historical_product: string;
  live_product: string;
  relationship: string;
  historical_evidence: string;
  live_evidence: string;
  rationale: string;
  reviewed: boolean;
};
export type SavedMapping = {
  id: string;
  current_account: boolean;
  target_display_symbol?: string;
  target_identity: {
    provider_symbol: string;
    environment: string;
    account_scope: string;
  };
  match: ProductMatch & { target_catalog: { symbol: string } };
};
export const products = [
  ["spot_fx", "现货外汇"],
  ["spot_metal", "现货金属"],
  ["crypto", "加密资产"],
  ["index", "指数"],
  ["cfd", "差价合约"],
  ["future", "期货"],
  ["other", "其他"],
];

// Only the supported FX/metal pair formats are unambiguous. Never infer an
// index/CFD's economic product or quote currency by chopping a display name.
export function pair(code: string, asset: string) {
  if (!["forex", "metal"].includes(asset)) return null;
  const parts = /^([A-Z]{3})[/_]?([A-Z]{3})$/.exec(code);
  return parts
    ? {
        underlying: parts[1],
        quote_currency: parts[2],
      }
    : null;
}
export function initialMatch(dataset: Dataset): ProductMatch {
  return {
    underlying: "",
    quote_currency: "",
    ...pair(dataset.identity.provider_symbol, dataset.asset_class),
    historical_product:
      (
        {
          forex: "spot_fx",
          metal: "spot_metal",
          crypto: "crypto",
          index: "index",
          future: "future",
        } as Record<string, string>
      )[dataset.asset_class] || "other",
    live_product: "",
    relationship: "",
    historical_evidence: "",
    live_evidence: "",
    rationale: "",
    reviewed: false,
  };
}
export function matchFields(value: ProductMatch): ProductMatch {
  return Object.fromEntries(
    Object.keys(initialKeys).map((key) => [
      key,
      value[key as keyof ProductMatch],
    ]),
  ) as ProductMatch;
}
const initialKeys = {
  underlying: 0,
  quote_currency: 0,
  historical_product: 0,
  live_product: 0,
  relationship: 0,
  historical_evidence: 0,
  live_evidence: 0,
  rationale: 0,
  reviewed: 0,
};
export function matchKey(value: ProductMatch) {
  const fields = matchFields(value);
  // Pydantic HttpUrl canonicalizes bare host URLs (including their trailing /).
  for (const key of ["historical_evidence", "live_evidence"] as const) {
    try {
      fields[key] = new URL(fields[key]).href;
    } catch {
      /* validation reports invalid drafts */
    }
  }
  return JSON.stringify(fields);
}
export function validMatch(value: ProductMatch) {
  const errors: Partial<Record<keyof ProductMatch, string>> = {};
  if (!/^[A-Z0-9]{1,30}$/.test(value.underlying))
    errors.underlying = "填写准确标的代码";
  if (!/^[A-Z]{3,8}$/.test(value.quote_currency))
    errors.quote_currency = "填写报价币种";
  for (const key of ["historical_product", "live_product"] as const)
    if (!products.some(([v]) => v === value[key])) errors[key] = "选择产品类型";
  if (
    !["same_product", "same_underlying_different_product"].includes(
      value.relationship,
    )
  )
    errors.relationship = "确认两来源的产品关系";
  else if (
    value.relationship === "same_product" &&
    value.historical_product !== value.live_product
  )
    errors.relationship = "产品类型不同，请明确选择相同标的、不同产品";
  for (const key of ["historical_evidence", "live_evidence"] as const) {
    try {
      const url = new URL(value[key]);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw Error();
    } catch {
      errors[key] = "填写不含凭据的官方产品说明网址";
    }
  }
  if (value.rationale.length < 10 || value.rationale.length > 1000)
    errors.rationale = "核对说明需要 10–1000 个字";
  if (!value.reviewed) errors.reviewed = "请完成产品与价格口径核对";
  return errors;
}
