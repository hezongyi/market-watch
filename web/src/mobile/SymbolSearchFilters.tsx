import { useId, useState } from "react";
import { ListFilter, X } from "lucide-react";
import { Button } from "./components/ui/button";
import { HeaderIconButton } from "./components/HeaderIconButton";
import { Collapsible, CollapsibleContent } from "./components/ui/collapsible";
import { FieldGroup } from "./components/ui/field";
import { DataSelect } from "./DataFormParts";

const sources = [
  { value: "", label: "全部来源" },
  { value: "oanda", label: "OANDA" },
  { value: "dukascopy", label: "Dukas" },
  { value: "fxcm", label: "FXCM" },
  { value: "yahoo", label: "Yahoo" },
  { value: "binance", label: "Binance" },
  { value: "sina", label: "新浪财经" },
  { value: "tencent", label: "腾讯财经" },
  { value: "eastmoney", label: "东方财富" },
  { value: "akshare", label: "AKShare（全部）" },
];
const categories = [
  { value: "", label: "全部分类" },
  { value: "forex", label: "外汇" },
  { value: "commodity", label: "贵金属" },
  { value: "stock", label: "股票" },
  { value: "fund", label: "ETF / 基金" },
  { value: "index", label: "指数" },
  { value: "futures", label: "期货" },
  { value: "crypto", label: "加密" },
  { value: "other", label: "其他" },
];

export type SymbolSearchCriteria = { source: string; category: string };
const empty: SymbolSearchCriteria = { source: "", category: "" };

export function useSymbolSearchFilters() {
  const [expanded, setExpanded] = useState(false);
  const [value, setValue] = useState(empty);
  const id = useId();
  return {
    expanded,
    setExpanded,
    value,
    setValue,
    id,
    clear: () => setValue(empty),
    reset: () => {
      setValue(empty);
      setExpanded(false);
    },
  };
}
export type SymbolSearchFilterState = ReturnType<typeof useSymbolSearchFilters>;

/** Use existing server-side qualification before either directory is paginated. */
export function symbolSearchRequest(
  query: string,
  criteria: SymbolSearchCriteria = empty,
) {
  const upstream = ["sina", "tencent", "eastmoney"].includes(criteria.source);
  const term = upstream
    ? sources.find((item) => item.value === criteria.source)!.label
    : "";
  return {
    query: [query.trim(), term].filter(Boolean).join(" "),
    source: upstream ? "akshare" : criteria.source,
    symbol_type: criteria.category,
    asset_class:
      (
        {
          stock: "equity",
          fund: "etf",
          futures: "future",
          commodity: "metal",
        } as Record<string, string>
      )[criteria.category] || criteria.category,
  };
}

export function SymbolSearchFilterButton({
  state,
}: {
  state: SymbolSearchFilterState;
}) {
  const count = Number(!!state.value.source) + Number(!!state.value.category);
  return (
    <HeaderIconButton
      icon={ListFilter}
      label="增强搜索"
      title="筛选来源与分类"
      aria-expanded={state.expanded}
      aria-controls={state.id}
      active={count > 0}
      onClick={() => state.setExpanded(!state.expanded)}
    />
  );
}

export function SymbolSearchFilters({
  state,
}: {
  state: SymbolSearchFilterState;
}) {
  const summary = [
    state.value.source &&
      sources.find((item) => item.value === state.value.source)?.label,
    state.value.category &&
      categories.find((item) => item.value === state.value.category)?.label,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="symbol-search-enhanced">
      <Collapsible open={state.expanded} onOpenChange={state.setExpanded}>
        <CollapsibleContent
          id={state.id}
          className="symbol-search-filter-panel"
        >
          <FieldGroup className="symbol-search-filter-fields">
            <DataSelect
              label="来源"
              value={state.value.source}
              items={sources}
              onChange={(source) =>
                state.setValue((old) => ({ ...old, source }))
              }
            />
            <DataSelect
              label="品种分类"
              value={state.value.category}
              items={categories}
              onChange={(category) =>
                state.setValue((old) => ({ ...old, category }))
              }
            />
          </FieldGroup>
        </CollapsibleContent>
      </Collapsible>
      {summary && (
        <div className="symbol-search-filter-summary">
          <span aria-label="已选筛选">{summary}</span>
          <Button
            variant="plain"
            size="icon"
            className="symbol-search-entry"
            aria-label="清除搜索筛选"
            onClick={state.clear}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      )}
    </div>
  );
}
