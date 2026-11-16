import {
  displayIdentity,
  seriesDifference,
  type IdentityInput,
} from "./marketIdentity";
import { watchDescription } from "./watchIdentity";
export function MarketBadge({ category }: { category: string }) {
  const family = [
    "深A",
    "沪A",
    "北A",
    "港股",
    "美股",
    "日股",
    "英股",
    "德股",
    "股票",
  ].includes(category)
    ? "stock"
    : (
        {
          外汇: "forex",
          贵金属: "metal",
          股指: "index",
          指数: "index",
          期货: "future",
          商品: "future",
          加密: "crypto",
          ETF: "fund",
          基金: "fund",
        } as Record<string, string>
      )[category] || "neutral";
  return (
    <span
      className="market-badge"
      data-category={category}
      data-family={family}
    >
      {category}
    </span>
  );
}
export default function SymbolIdentityRow({
  row,
  code,
  name,
  custom = false,
  configuration = "",
  variant = "search",
}: {
  row: IdentityInput;
  code: string;
  name?: string;
  custom?: boolean;
  configuration?: string;
  variant?: "search" | "data";
}) {
  const info = displayIdentity(row),
    description = watchDescription(code, name || "") || name || "名称待确认";
  return (
    <span className={`symbol-identity symbol-identity-${variant}`}>
      <span className="symbol-primary-code">
        <strong title={info.provider_symbol || code}>{code}</strong>
        <MarketBadge category={info.category} />
      </span>
      <span className="symbol-primary-name">
        {description}
        {variant === "data" && (
          <>
            {" "}
            · {info.provider}
            {configuration && <> · {configuration}</>}
          </>
        )}
      </span>
      {variant !== "data" && (
        <>
          <span className="symbol-secondary-source">
            {info.provider}
            {custom && <span className="symbol-custom-text"> · 自建</span>}
          </span>
          <span className="symbol-secondary-facts">
            {seriesDifference(row, custom, configuration)}
          </span>
        </>
      )}
    </span>
  );
}
