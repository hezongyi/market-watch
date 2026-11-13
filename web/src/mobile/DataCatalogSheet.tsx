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
  const [offset, setOffset] = useState(0),
    [selected, setSelected] = useState<CatalogItem>();
  const [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [change, setChange] = useState(false);
  const [symbol, setSymbol] = useState(""),
    [market, setMarket] = useState("a");
  const state = useCallback((nextBusy: boolean, nextDirty: boolean) => {
    setBusy(nextBusy);
    setDirty(nextDirty);
  }, []);
  const params = new URLSearchParams({
    query,
    source: source === "all" ? "" : source,
    symbol_type: asset,
    offset: String(offset),
    limit: "25",
  });
  const result = useDataRead<{
    items: CatalogItem[];
    total: number;
    sources: {
      source: string;
      requires_refresh: boolean;
      connection_configured: boolean;
    }[];
  }>(
    profile,
    "/market-data/history-catalog/search?" + params,
    active && !selected,
    online,
  );
  const command = useDataCommand(profile, online);
  function filter(fn: () => void) {
    fn();
    setOffset(0);
  }
  function back() {
    if (dirty) setChange(true);
    else setSelected(undefined);
  }
  return (
    <MobileSheet
      title={selected ? "创建自建行情" : "添加行情"}
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
        <div className="data-workflow-form">
          <InputGroup className="data-search-input">
            <InputGroupAddon>
              <Search aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="搜索原生行情"
              type="search"
              placeholder="代码或中文名称"
              value={query}
              onChange={(e) => filter(() => setQuery(e.target.value))}
            />
          </InputGroup>
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
                        disabled={!online || command.busy || !symbol.trim()}
                        onClick={() =>
                          void command.run(async (request) => {
                            await request(
                              profile,
                              "/market-data/catalog/discover",
                              { symbol: symbol.trim() },
                            );
                            setQuery(symbol.trim());
                            setOffset(0);
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
          <DataFeedback
            error={result.error || command.error}
            notice={
              command.notice ||
              (!online ? "离线显示上次读取，联网后可添加" : undefined)
            }
          />
          {result.loading && !result.data && (
            <DataLoading label="正在读取原生目录…" />
          )}
          {result.data?.sources.some(
            (s) =>
              s.requires_refresh && (source === "all" || source === s.source),
          ) && (
            <p className="data-caption">
              部分来源目录尚未同步，可选择来源后更新目录。
            </p>
          )}
          {result.data && !result.data.items.length && (
            <DataEmpty title="没有找到品种">
              换个代码或来源，或更新目录。
            </DataEmpty>
          )}
          <div className="data-series-list">
            {result.data?.items.map((item) => (
              <Button
                key={item.catalog_id}
                variant="plain"
                className="data-catalog-row"
                disabled={!online || command.busy}
                onClick={() => {
                  setDirty(false);
                  setSelected(item);
                }}
              >
                <span>
                  <strong>{item.display_symbol || item.provider_symbol}</strong>
                  <span>{item.label}</span>
                  <small>{sourceName(item.source)}</small>
                </span>
                <ChevronRight aria-hidden="true" />
              </Button>
            ))}
          </div>
          <div className="data-pager">
            <Button
              variant="ghost"
              disabled={offset === 0 || result.loading}
              onClick={() => setOffset((n) => n - 25)}
            >
              上一页
            </Button>
            <span>第 {offset / 25 + 1} 页</span>
            <Button
              variant="ghost"
              disabled={
                result.loading ||
                !result.data ||
                offset + 25 >= result.data.total
              }
              onClick={() => setOffset((n) => n + 25)}
            >
              下一页
            </Button>
          </div>
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
