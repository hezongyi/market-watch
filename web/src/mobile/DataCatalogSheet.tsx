import { useLayoutEffect, useRef } from "react";
import SymbolIdentityRow from "./SymbolIdentityRow";
import { SymbolSearchPanel, SymbolSearchRow } from "./SymbolSearch";
import {
  SymbolSearchFilterButton,
  SymbolSearchFilters,
  symbolSearchRequest,
  useSymbolSearchFilters,
} from "./SymbolSearchFilters";
import { useSymbolSearch } from "./useSymbolSearch";
import { dataRequest } from "./dataOperations";
import { useCallback, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { CatalogItem } from "../market-data/CreationCatalog";
import type { Profile } from "./cache";
import MobileSheet from "./MobileSheet";
import { MobileConfirm } from "./WatchOverlays";
import { Button } from "./components/ui/button";
import { DataEmpty } from "./DataStates";
import { DataFeedback } from "./DataFormParts";
import DataCreateSheet from "./DataCreateSheet";

export default function DataCatalogSheet({
  profile,
  online,
  active,
  open,
  close,
  done,
  onClosed,
}: {
  profile: Profile;
  online: boolean;
  active: boolean;
  open: boolean;
  close(): void;
  done(id: string, isNew?: boolean, archived?: boolean): void;
  onClosed(): void;
}) {
  const [query, setQuery] = useState("");
  const filters = useSymbolSearchFilters();
  const [selected, setSelected] = useState<CatalogItem>();
  const scrollTop = useRef(0),
    searchHost = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!selected) {
      const scroll = searchHost.current?.closest(".mobile-drawer-scroll");
      if (scroll) scroll.scrollTop = scrollTop.current;
    }
  }, [selected]);
  const [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [change, setChange] = useState(false);
  const state = useCallback((nextBusy: boolean, nextDirty: boolean) => {
    setBusy(nextBusy);
    setDirty(nextDirty);
  }, []);
  const result = useSymbolSearch<CatalogItem>({
    profile,
    queryKey: JSON.stringify(["catalog-v3", query, filters.value]),
    active: active && open && !selected,
    online,
    identity: (item) => item.catalog_id,
    fetchPage: async (cursor, signal) => {
      const offset = Number(cursor || 0);
      const request = symbolSearchRequest(query, filters.value);
      const params = new URLSearchParams({
        query: request.query,
        ...(request.source ? { source: request.source } : {}),
        ...(request.symbol_type ? { symbol_type: request.symbol_type } : {}),
        mobile: "true",
        exclude_existing: "true",
        include_total: "false",
        offset: String(offset),
        limit: "25",
      });
      const value = await dataRequest<{
        items: CatalogItem[];
        total?: number;
        has_more?: boolean;
        sources: { source: string; requires_refresh: boolean }[];
      }>(
        profile,
        "/market-data/history-catalog/search?" + params,
        undefined,
        signal,
      );
      return {
        items: value.items,
        next:
          (value.has_more ?? offset + 25 < (value.total || 0))
            ? String(offset + 25)
            : undefined,
        note: value.sources.some((item) => item.requires_refresh)
          ? "部分目录尚未同步，可在数据页的任务与来源中更新。"
          : undefined,
      };
    },
  });
  function back() {
    if (dirty) setChange(true);
    else setSelected(undefined);
  }
  return (
    <MobileSheet
      title="添加自建"
      headerActions={!selected && <SymbolSearchFilterButton state={filters} />}
      open={open}
      onClosed={onClosed}
      fullHeight
      dirty={dirty}
      dismissible={!busy}
      close={close}
    >
      {selected ? (
        <>
          <Button variant="ghost" disabled={busy} onClick={back}>
            <ArrowLeft data-icon="inline-start" aria-hidden="true" />
            更换品种
          </Button>
          <DataCreateSheet
            key={selected.catalog_id}
            item={selected}
            profile={profile}
            online={online}
            done={done}
            state={state}
          />
        </>
      ) : (
        <div ref={searchHost}>
          <SymbolSearchPanel
            query={query}
            resetKey={JSON.stringify([query, filters.value])}
            maxLength={90}
            enhancedFilters={<SymbolSearchFilters state={filters} />}
            onQuery={setQuery}
            label="搜索原生行情"
            active={active && open}
            online={online}
            loading={result.loading}
            loaded={result.loaded}
            error={result.error}
            retry={result.retry}
            hasNext={!!result.next}
            loadNext={result.loadNext}
            note={<DataFeedback notice={result.note} />}
          >
            {result.loaded && !result.items.length && (
              <DataEmpty title="没有找到品种">
                尝试代码、中文名、来源或类别，例如 xau oa。已自建品种不再显示。
              </DataEmpty>
            )}
            <div className="data-series-list">
              {result.items.map((item) => (
                <SymbolSearchRow
                  key={item.catalog_id}
                  catalog
                  disabled={!online}
                  onSelect={() => {
                    scrollTop.current =
                      searchHost.current?.closest(".mobile-drawer-scroll")
                        ?.scrollTop || 0;
                    setDirty(false);
                    setSelected(item);
                  }}
                >
                  <SymbolIdentityRow
                    row={item}
                    code={item.display_symbol || item.provider_symbol}
                    name={item.label}
                  />
                </SymbolSearchRow>
              ))}
            </div>
          </SymbolSearchPanel>
        </div>
      )}
      {change && (
        <MobileConfirm
          title="放弃创建设置？"
          description="返回品种目录后，本次修改不会保留。"
          actionLabel="返回目录"
          onAccept={() => {
            setDirty(false);
            setChange(false);
            setSelected(undefined);
          }}
          onClose={() => setChange(false)}
        />
      )}
    </MobileSheet>
  );
}
