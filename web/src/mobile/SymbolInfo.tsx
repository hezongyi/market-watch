import FitText from "./FitText";
import { watchDescription } from "./watchIdentity";

export function symbolProvider(source?: string) {
  const value = (source || "来源待确认")
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
    )[value.toUpperCase()] || value
  );
}

/** Shared information hierarchy; Watch alone owns its fixed-column geometry. */
export default function SymbolInfo({
  code,
  name = "",
  source,
  custom = false,
  compact = false,
  sourceDescription,
}: {
  code: string;
  name?: string;
  source?: string;
  custom?: boolean;
  compact?: boolean;
  sourceDescription?: string;
}) {
  const description = watchDescription(code, name);
  const provider = symbolProvider(source);
  return (
    <span
      className={compact ? "mobile-watch-symbol symbol-info" : "symbol-info"}
    >
      <strong title={code}>{compact ? <FitText text={code} /> : code}</strong>
      <span
        className="mobile-watch-description symbol-description"
        title={name}
      >
        {description || "名称待确认"}
      </span>
      <span
        title={sourceDescription || source}
        className={`mobile-watch-origin symbol-origin${custom ? " mobile-watch-origin-custom" : ""}`}
      >
        {custom && <span className="mobile-watch-kind">自建</span>}
        <span className="mobile-watch-provider">{provider}</span>
      </span>
    </span>
  );
}
