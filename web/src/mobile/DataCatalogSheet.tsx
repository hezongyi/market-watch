import MobileSelect from "./MobileSelect";
import { useLayoutEffect, useRef } from "react";
import SymbolInfo from "./SymbolInfo";
import { SymbolSearchPanel, SymbolSearchRow } from "./SymbolSearch";
import { useSymbolSearch } from "./useSymbolSearch";
import { dataRequest } from "./dataOperations";
import { useCallback, useState } from "react";
import { ArrowLeft, ChevronRight, Search } from "lucide-react";
import type { CatalogItem } from "../market-data/CreationCatalog";
import type { Profile } from "./cache";
import MobileSheet from "./MobileSheet";
import { MobileConfirm } from "./WatchOverlays";
import { Button } from "./components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "./components/ui/input-group";
import { FieldGroup } from "./components/ui/field";
import { DataEmpty, DataLoading } from "./DataStates";
import { DataFeedback, DataInput, DataMore, DataSelect } from "./DataFormParts";
import {
  dataSources,
  sourceName,
  useDataCommand,
  useDataRead,
} from "./dataOperations";
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
  const [query, setQuery] = useState(""),
    [source, setSource] = useState("all"),
    [asset, setAsset] = useState("");
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
  const [symbol, setSymbol] = useState(""),
    [market, setMarket] = useState("a");
  const state = useCallback((nextBusy: boolean, nextDirty: boolean) => {
    setBusy(nextBusy);
    setDirty(nextDirty);
  }, []);
  const result = useSymbolSearch<CatalogItem>({
    profile,
    queryKey: JSON.stringify(["catalog", query, source, asset]),
    active: active && open && !selected,
    online,
    identity: (item) => item.catalog_id,
    fetchPage: async (cursor, signal) => {
      const offset = Number(cursor || 0);
      const params = new URLSearchParams({
        query,
        source: source === "all" ? "" : source,
        symbol_type: asset,
        offset: String(offset),
        limit: "25",
      });
      const value = await dataRequest<{
        items: CatalogItem[];
        total: number;
        sources: { source: string; requires_refresh: boolean }[];
      }>(
        profile,
        "/market-data/history-catalog/search?" + params,
        undefined,
        signal,
      );
      return {
        items: value.items,
        next: offset + 25 < value.total ? String(offset + 25) : undefined,
        note: value.sources.some(
          (item) =>
            item.requires_refresh &&
            (source === "all" || item.source === source),
        )
          ? "部分来源目录尚未同步，可选择来源后更新目录。"
          : undefined,
      };
    },
  });
  const command = useDataCommand(profile, online);
  function filter(fn: () => void) {
    fn();
  }
  function back() {
    if (dirty) setChange(true);
    else setSelected(undefined);
  }
  return (
    <MobileSheet
      title="添加自建"
      open={open}
      onClosed={onClosed}
      fullHeight
      dirty={dirty}
      dismissible={!busy && !command.busy}
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
            resetKey={JSON.stringify([query, source, asset])}
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
            note={
              <DataFeedback
                error={command.error}
                notice={
                  command.notice ||
                  result.note ||
                  (result.readAt ? "离线显示上次目录，联网后核验" : undefined)
                }
              />
            }
            filters={
              <>
                <DataSelect
                  label="来源"
                  value={source}
                  onChange={(v) => filter(() => setSource(v))}
                  items={dataSources}
                />
                <DataMore title="目录筛选与更新">
                  <FieldGroup>
                    <DataSelect
                      label="品种类别"
                      value={asset}
                      onChange={(v) => filter(() => setAsset(v))}
                      items={[
                        ["", "全部类别"],
                        ["forex", "外汇"],
                        ["commodity", "金属"],
                        ["stock", "股票"],
                        ["fund", "基金"],
                        ["index", "指数"],
                        ["futures", "期货"],
                        ["crypto", "加密"],
                      ].map(([value, label]) => ({ value, label }))}
                    />
                    {source !== "all" && (
                      <>
                        {source === "akshare" && (
                          <DataSelect
                            label="更新目录市场"
                            value={market}
                            onChange={setMarket}
                            items={[
                              { value: "a", label: "沪深 A 股" },
                              { value: "hk", label: "港股" },
                              { value: "futures", label: "主力连续期货" },
                            ]}
                          />
                        )}
                        <Button
                          variant="outline"
                          disabled={!online || command.busy}
                          onClick={() =>
                            void command.run(async (request) => {
                              await request(
                                profile,
                                `/market-data/history-catalog/refresh?market=${market}`,
                                { source },
                              );
                              result.refresh();
                              command.setNotice("目录已更新");
                            })
                          }
                        >
                          更新此来源目录
                        </Button>
                        {source === "yahoo" && (
                          <>
                            <DataInput
                              label="未找到品种？填写 Yahoo 准确代码"
                              value={symbol}
                              onChange={(e) => setSymbol(e.target.value)}
                            />
                            <Button
                              variant="outline"
                              disabled={
                                !online || command.busy || !symbol.trim()
                              }
                              onClick={() =>
                                void command.run(async (request) => {
                                  await request(
                                    profile,
                                    "/market-data/catalog/discover",
                                    { symbol: symbol.trim() },
                                  );
                                  setQuery(symbol.trim());
                                  result.refresh();
                                })
                              }
                            >
                              验证并补录代码
                            </Button>
                          </>
                        )}
                      </>
                    )}
                  </FieldGroup>
                </DataMore>
              </>
            }
          >
            {result.loaded && !result.items.length && (
              <DataEmpty title="没有找到品种">
                换个代码或来源，或更新目录。
              </DataEmpty>
            )}
            <div className="data-series-list">
              {result.items.map((item) => (
                <SymbolSearchRow
                  key={item.catalog_id}
                  catalog
                  disabled={!online || command.busy}
                  onSelect={() => {
                    scrollTop.current =
                      searchHost.current?.closest(".mobile-drawer-scroll")
                        ?.scrollTop || 0;
                    setDirty(false);
                    setSelected(item);
                  }}
                >
                  <SymbolInfo
                    code={item.display_symbol || item.provider_symbol}
                    name={item.label}
                    source={item.source}
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
