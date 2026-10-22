import type { Dataset } from "./types";
import type { CatalogItem } from "./CreationCatalog";

export type CatalogEntry = CatalogItem & { updated_at?: number };
export type ProductMatch = {
  schema_version: 2;
  underlying: string;
  quote_currency: string;
  historical_product: string;
  live_product: string;
  relationship: string;
  historical_evidence: string | null;
  live_evidence: string | null;
  rationale: string;
  reviewed: boolean;
};
export type CatalogSnapshot = {
  account_scope: string;
  provider_symbol: string;
  asset_type: string;
  precision: number;
};
export type MatchCheck = {
  status: "ready" | "needs_information";
  errors: Partial<Record<keyof ProductMatch, string>>;
  suggestion: ProductMatch;
  snapshot: CatalogSnapshot;
  sources: { url: string; scope: string }[];
  difference: string | null;
  rule: string | null;
  conclusion: string;
};
export type SavedMapping = {
  id: string;
  current_account: boolean;
  valid_for_selection: boolean;
  target_display_symbol?: string;
  target_identity: {
    provider_symbol: string;
    environment: string;
    account_scope: string;
  };
  note?: { version: number; rationale: string; historical_evidence: string | null; live_evidence: string | null } | null;
  match: ProductMatch & { target_catalog: { symbol: string; type: string; precision: number } };
};
export const products = [
  ["spot_fx", "现货外汇报价"],
  ["spot_metal", "现货金属"],
  ["metal_quote", "金属报价（账户合约类型未作等价断言）"],
  ["crypto", "加密资产"],
  ["index", "指数"],
  ["cfd", "差价合约"],
  ["future", "期货"],
  ["other", "其他 / 待核实"],
];

// A pair is a draft identity hint only, never a product-equivalence decision.
export function pair(code: string, asset: string) {
  if (!["forex", "metal"].includes(asset)) return null;
  const parts = /^([A-Z]{3})[/_]?([A-Z]{3})$/.exec(code);
  return parts ? { underlying: parts[1], quote_currency: parts[2] } : null;
}
export function initialMatch(dataset: Dataset): ProductMatch {
  return {
    schema_version: 2, underlying: "", quote_currency: "",
    ...pair(dataset.identity.provider_symbol, dataset.asset_class),
    historical_product: "", live_product: "", relationship: "",
    historical_evidence: null, live_evidence: null, rationale: "", reviewed: false,
  };
}
export function matchFields(value: ProductMatch): ProductMatch {
  return {
    schema_version: 2, underlying: value.underlying, quote_currency: value.quote_currency,
    historical_product: value.historical_product, live_product: value.live_product,
    relationship: value.relationship, historical_evidence: value.historical_evidence || null,
    live_evidence: value.live_evidence || null, rationale: value.rationale || "", reviewed: !!value.reviewed,
  };
}
export function matchKey(value: ProductMatch) {
  const fields = matchFields(value);
  for (const key of ["historical_evidence", "live_evidence"] as const) {
    try { if (fields[key]) fields[key] = new URL(fields[key]).href; } catch { /* inline validation */ }
  }
  return JSON.stringify(fields);
}
export function validMatch(value: ProductMatch) {
  const errors: Partial<Record<keyof ProductMatch, string>> = {};
  if (!/^[A-Z0-9]{1,30}$/.test(value.underlying)) errors.underlying = "填写准确标的代码";
  if (!/^[A-Z]{3,8}$/.test(value.quote_currency)) errors.quote_currency = "填写报价币种";
  for (const key of ["historical_product", "live_product"] as const)
    if (!products.some(([v]) => v === value[key])) errors[key] = "产品类型待核实";
  if (!["same_product", "same_underlying_different_product"].includes(value.relationship)) errors.relationship = "产品关系待核实";
  for (const key of ["historical_evidence", "live_evidence"] as const) {
    if (!value[key]) continue;
    try {
      const url = new URL(value[key]);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw Error();
    } catch { errors[key] = "填写不含凭据的产品资料网址，或留空"; }
  }
  if (value.rationale.length > 1000) errors.rationale = "备注不超过 1000 字";
  return errors;
}
