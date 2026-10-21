import { useContext, useEffect, useRef, useState } from "react";
import { NativeButton, NativeInput, NativeUiContext } from "./NativeControls";
import { useMounted } from "./router";
import { api } from "./api";

/** Scoped source catalog lookup, returning a draft value without chart demand. */
export function NativeCatalogPicker({
  source,
  onSelect,
  disabled = false,
  query = "",
  label = "选择品种",
  asset = "",
}: {
  source: string;
  onSelect: (row: any) => void;
  disabled?: boolean;
  query?: string;
  label?: string;
  asset?: string;
}) {
  const mounted = useMounted();
  const latest = useRef({ source, onSelect, disabled });
  latest.current = { source, onSelect, disabled };
  const assetType =
    (
      {
        metal: "commodity",
        equity: "stock",
        etf: "fund",
        future: "futures",
      } as Record<string, string>
    )[asset] || asset;
  const category = [
    "forex",
    "commodity",
    "index",
    "stock",
    "fund",
    "futures",
    "crypto",
    "other",
  ].includes(assetType)
    ? assetType
    : "";
  const ui = useContext(NativeUiContext),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [fallback, setFallback] = useState(false),
    [text, setText] = useState(query),
    [page, setPage] = useState(1),
    [results, setResults] = useState<any>(null);
  useEffect(() => {
    if (ui || !fallback) return;
    const abort = new AbortController();
    setResults(null);
    setError("");
    api<any>(
      `/market-data/history-catalog?source=${source}&query=${encodeURIComponent(text)}&page=${page}&page_size=25&symbol_type=${encodeURIComponent(category)}`,
      undefined,
      abort.signal,
    )
      .then((value) => {
        if (!abort.signal.aborted) setResults(value);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(String(e));
      });
    return () => abort.abort();
  }, [ui, fallback, source, text, page, category]);
  async function pick() {
    if (busy || disabled) return;
    if (!ui) {
      setText(query);
      setPage(1);
      setFallback(true);
      return;
    }
    setBusy(true);
    setError("");
    const known = new Map<string, any>();
    try {
      const selected = await ui.pick({
        dialogTitle:
          source === "oanda" ? "选择 OANDA Practice 品种" : "选择来源品种",
        defaultValue: query,
        initialSymbolType: category,
        selectedSymbolSettingsKey: `mw.data-center.picker.${source}.category`,
        filterValuesSettingsKey: `mw.data-center.picker.${source}.filters`,
        hiddenFilterIds: ["exchange"],
        symbolTypes: [
          { name: "全部", value: "" },
          { name: "外汇", value: "forex" },
          { name: "金属", value: "commodity" },
          { name: "指数", value: "index" },
          { name: "股票类", value: "stock" },
          { name: "基金", value: "fund" },
          { name: "期货", value: "futures" },
          { name: "加密", value: "crypto" },
          { name: "其他", value: "other" },
        ],
        overrideQueryParams: { exchange: source.toUpperCase() },
        customSearchSymbols: async ({
          text,
          start = 0,
          type = "",
          signal,
        }: any) => {
          try {
            const pageSize = 50,
              page = Math.floor(start / pageSize) + 1;
            const result = await api<any>(
              `/market-data/history-catalog?source=${source}&query=${encodeURIComponent(text || "")}&page=${page}&page_size=${pageSize}&symbol_type=${encodeURIComponent(type)}`,
              undefined,
              signal,
            );
            if (mounted.current && !signal?.aborted) setError("");
            const symbols = result.items.map((row: any) => {
              known.set(row.catalog_id, row);
              return {
                symbol: row.display_symbol || row.provider_symbol,
                ticker: row.catalog_id,
                description: `${row.label} · ${row.product_label || row.asset_class}`,
                exchange: source.toUpperCase(),
                type:
                  (
                    {
                      metal: "commodity",
                      equity: "stock",
                      etf: "fund",
                      future: "futures",
                    } as Record<string, string>
                  )[row.asset_class] || row.asset_class,
              };
            });
            return {
              symbols,
              symbols_remaining: Math.max(
                0,
                result.total - start - symbols.length,
              ),
            };
          } catch (e) {
            if (mounted.current && !signal?.aborted) setError(String(e));
            return { symbols: [], symbols_remaining: 0 };
          }
        },
      });
      if (
        selected &&
        mounted.current &&
        !latest.current.disabled &&
        latest.current.source === source
      ) {
        const row = known.get(selected.ticker);
        if (!row) throw Error("所选来源目录已变化，请重新选择");
        latest.current.onSelect(row);
      }
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <div className="dc-catalog-picker">
      <NativeButton disabled={disabled || busy} onClick={() => void pick()}>
        {busy ? "正在选择…" : label}
      </NativeButton>
      {error && (
        <span role="alert" className="error">
          {error}
        </span>
      )}
      {fallback && (
        <div
          className="dc-catalog-fallback"
          role="region"
          aria-label="选择来源品种"
        >
          <label>
            搜索来源品种
            <NativeInput
              type="search"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setPage(1);
              }}
            />
          </label>
          {!results && !error && <p role="status">正在读取品种…</p>}
          {results?.items.map((row: any) => (
            <NativeButton
              key={row.catalog_id}
              disabled={disabled}
              onClick={() => {
                onSelect(row);
                setFallback(false);
              }}
            >{`${row.display_symbol || row.provider_symbol} · ${row.label}`}</NativeButton>
          ))}
          {results && !results.total && <p>未找到匹配品种，请修改关键词。</p>}
          <div className="dc-actions">
            <NativeButton
              disabled={page === 1}
              onClick={() => setPage((v) => v - 1)}
            >
              上一页
            </NativeButton>
            <NativeButton
              disabled={!results || page * 25 >= results.total}
              onClick={() => setPage((v) => v + 1)}
            >
              下一页
            </NativeButton>
            <NativeButton onClick={() => setFallback(false)}>
              取消选择
            </NativeButton>
          </div>
        </div>
      )}
    </div>
  );
}
