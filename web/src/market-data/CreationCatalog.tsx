import { useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  NativeInput,
  NativeSelect,
  NativeSlot,
  NativeUiContext,
} from "./NativeControls";
import { MarketTabs } from "./MarketList";
import { api } from "./api";
import { names } from "./types";

export type CatalogItem = {
  catalog_id: string;
  source: string;
  provider_symbol: string;
  display_symbol?: string;
  logical_symbol: string;
  label: string;
  asset_class: string;
  precision: number | null;
};
type CatalogPage = {
  items: CatalogItem[];
  total: number;
  sources: {
    source: string;
    requires_refresh: boolean;
    connection_configured: boolean;
  }[];
};
export type CatalogFilters = { source: string; query: string; asset: string };
const categories = [
  ["", "全部"],
  ["forex", "外汇"],
  ["commodity", "金属"],
  ["index", "指数"],
  ["crypto", "加密"],
  ["other", "其他"],
] as const;

/** Selection uses the actual native symbol-search renderer, with draft-only actions. */
export function CreationCatalog({
  initialFilters,
  saveFilters,
  selected,
  select,
  fixedSource,
  autoRefresh = false,
  onRefresh,
  disabled = false,
}: {
  initialFilters: CatalogFilters;
  saveFilters: (filters: CatalogFilters) => void;
  selected: CatalogItem | null;
  select: (item: CatalogItem) => void;
  fixedSource?: "oanda";
  autoRefresh?: boolean;
  onRefresh?: () => void;
  disabled?: boolean;
}) {
  const ui = useContext(NativeUiContext);
  const [filters, setFilters] = useState(initialFilters);
  const [metadata, setMetadata] = useState<CatalogPage["sources"]>([]);
  const [revision, refresh] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [fallback, setFallback] = useState<{
    items: CatalogItem[];
    total: number;
  } | null>(null);
  const [loading, setLoading] = useState(false),
    [offset, setOffset] = useState(0),
    [retry, retryRead] = useState(0);
  const known = useRef(new Map<string, CatalogItem>()),
    active = useRef(""),
    alive = useRef(true);
  const sentinel = useRef<HTMLDivElement>(null),
    list = useRef<HTMLDivElement>(null);
  const latest = useRef(select);
  latest.current = select;
  const savedFilters = useRef(saveFilters);
  savedFilters.current = saveFilters;
  const refreshed = useRef(onRefresh);
  refreshed.current = onRefresh;
  const attemptedRefresh = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const getPage = useCallback(
    async ({ text = "", type = "", exchange = "", start = 0, signal }: any) => {
      const source = fixedSource || exchange.toLowerCase(),
        signature = JSON.stringify([source, text, type]);
      if (signature !== active.current || start === 0) {
        known.current.clear();
        active.current = signature;
      }
      const result = await api<CatalogPage>(
        `/market-data/history-catalog/search?${new URLSearchParams({ source, query: text, symbol_type: type, offset: String(start), limit: "50" })}`,
        undefined,
        signal,
      );
      if (signal.aborted || !alive.current || active.current !== signature)
        throw new DOMException("查询已取消", "AbortError");
      setFilters({ source, query: text, asset: type });
      savedFilters.current({ source, query: text, asset: type });
      setMetadata(result.sources);
      return {
        symbols: result.items.filter(item => !fixedSource || item.source === fixedSource).map((item) => {
          known.current.set(item.catalog_id, item);
          return {
            ticker: item.catalog_id,
            full_name: item.catalog_id,
            symbol: item.display_symbol || item.provider_symbol,
            description: item.label,
            exchange: item.source.toUpperCase(),
            sourceName: names[item.source],
            type: item.asset_class === "metal" ? "commodity" : item.asset_class,
            category:
              categories.find(
                ([type]) =>
                  type ===
                  (item.asset_class === "metal"
                    ? "commodity"
                    : item.asset_class),
              )?.[1] || "其他",
            rowId: `catalog-${item.catalog_id.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
            available: true,
          };
        }),
        symbols_remaining: Math.max(
          0,
          result.total - start - result.items.length,
        ),
      };
    },
    [fixedSource],
  );
  const choose = useCallback(async (ticker: string) => {
    const item = known.current.get(ticker);
    if (!item) throw Error("目录已变化，请重新选择品种");
    latest.current(item);
  }, []);
  useEffect(() => {
    if (ui) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void api<CatalogPage>(
        `/market-data/history-catalog/search?${new URLSearchParams({ source: fixedSource || filters.source, query: filters.query, symbol_type: filters.asset, offset: String(offset), limit: "50" })}`,
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        setMetadata(result.sources);
        setFallback((old) => ({
          items: offset
            ? [...(old?.items || []), ...result.items.filter(item => !fixedSource || item.source === fixedSource)]
            : result.items.filter(item => !fixedSource || item.source === fixedSource),
          total: result.total,
        }));
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(String(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [
    ui,
    filters.source,
    filters.query,
    filters.asset,
    offset,
    revision,
    retry,
    fixedSource,
  ]);
  useEffect(() => {
    if (
      ui ||
      !sentinel.current ||
      loading ||
      error ||
      !fallback ||
      fallback.items.length >= fallback.total
    )
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          setOffset(fallback.items.length);
      },
      { root: list.current },
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [ui, loading, error, fallback]);
  async function refreshDirectory() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api("/market-data/history-catalog/refresh", {});
      if (!alive.current) return;
      setOffset(0);
      refresh((v) => v + 1);
      refreshed.current?.();
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (!autoRefresh || attemptedRefresh.current || busy) return;
    if (metadata.some(s => s.source === "oanda" && s.connection_configured && s.requires_refresh)) {
      attemptedRefresh.current = true;
      void refreshDirectory();
    }
  }, [autoRefresh, metadata, busy]);
  function change(key: keyof typeof filters, value: string) {
    const next = { ...filters, [key]: value };
    setFilters(next);
    savedFilters.current(next);
    setOffset(0);
    setFallback(null);
  }
  return (
    <div className="dc-create-catalog">
      {metadata.some(
        (s) =>
          s.source === "oanda" &&
          (!s.connection_configured || s.requires_refresh),
      ) && (
        <div className="dc-create-notice">
          {metadata.find((s) => s.source === "oanda")?.connection_configured ? (
            <>
              OANDA 账户目录尚未准备。
              <button disabled={busy || disabled} onClick={() => void refreshDirectory()}>
                {busy ? "刷新中…" : "刷新账户品种目录"}
              </button>
            </>
          ) : (
            "OANDA Practice 连接未配置，请由管理员配置后再选择。"
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {ui ? (
        <NativeSlot
          key={revision}
          kind="platformSearch"
          props={{
            mode: "select",
            title: fixedSource ? "选择实时品种" : "选择自建品种",
            settingsScope: fixedSource ? "mw.data-center.mapping" : "mw.data-center.creation",
            allowedSources: fixedSource ? [fixedSource] : ["dukascopy", "oanda"],
            fixedSource,
            query: filters.query,
            source: fixedSource || filters.source,
            asset: filters.asset,
            symbolTypes: categories.map(([value, name]) => ({ value, name })),
            selectedTicker: selected?.catalog_id,
            busy: busy || disabled,
            getPage,
            onOpen: choose,
          }}
        />
      ) : (
        <>
          <NativeInput
            type="search"
            aria-label="搜索品种"
            value={filters.query}
            placeholder="品种代码或名称"
            onChange={(e) => change("query", e.target.value)}
          />
          <MarketTabs
            label="品种类别"
            value={filters.asset}
            items={categories}
            change={(value) => change("asset", value)}
          />
          <div className="dc-market-table-head">
            <span>品种与名称</span>
            {fixedSource ? <span>OANDA Practice · 当前账户</span> : <NativeSelect
              aria-label="来源"
              value={filters.source}
              onChange={(e) => change("source", e.target.value)}
            >
              <option value="">全部来源</option>
              <option value="dukascopy">Dukascopy</option>
              <option value="oanda">OANDA Practice</option>
            </NativeSelect>}
          </div>
          <div className="dc-market-list" ref={list}>
            {fallback?.items.map((item) => (
              <div
                className="dc-create-catalog-row"
                key={item.catalog_id}
                data-selected={selected?.catalog_id === item.catalog_id}
              >
                <button disabled={busy || disabled} onClick={() => select(item)}>
                  {item.display_symbol || item.provider_symbol}
                </button>
                <span>
                  {item.label} · {names[item.source]}
                </span>
                <button
                  disabled={busy || disabled}
                  aria-pressed={selected?.catalog_id === item.catalog_id}
                  onClick={() => select(item)}
                >
                  {selected?.catalog_id === item.catalog_id ? "已选择" : "选择"}
                </button>
              </div>
            ))}
            <div className="dc-market-status" ref={sentinel}>
              {loading ? (
                "正在读取…"
              ) : error ? (
                <button onClick={() => retryRead((v) => v + 1)}>
                  重试读取
                </button>
              ) : fallback?.items.length ? (
                fallback.items.length >= fallback.total ? (
                  "已全部加载"
                ) : (
                  "继续下滚加载"
                )
              ) : (
                "没有符合条件的品种"
              )}
            </div>
          </div>
        </>
      )}
      {metadata.some(
        (s) =>
          s.source === "oanda" &&
          s.connection_configured &&
          !s.requires_refresh,
      ) && (
        <div className="dc-create-catalog-tools">
          <button disabled={busy || disabled} onClick={() => void refreshDirectory()}>
            {busy ? "刷新中…" : "刷新账户品种目录"}
          </button>
        </div>
      )}
    </div>
  );
}
