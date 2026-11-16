import { logEvent, logFailure } from "./logs";
import {
  HistoryTags,
  HistoryFacts,
  liveSummary,
  maintenanceState,
  liveSettingLabel,
  liveNeedsAttention,
  liveRuntimeSummary,
} from "./ManagedDataFacts";
import { time as detailTime } from "../market-data/types";
import SymbolIdentityRow from "./SymbolIdentityRow";
import { sourceLabel, configurationDifference } from "./marketIdentity";
import DataSourceTools from "./DataSourceTools";
import { Switch } from "./components/ui/switch";
import { errorMessage } from "../api";
import { HeaderIconButton } from "./components/HeaderIconButton";
import { SymbolAddButton } from "./SymbolSearch";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ChevronRight,
  Search,
  Database,
  Radio,
  RefreshCw,
  X,
} from "lucide-react";
import { api } from "../api";
import type { Dataset, Task } from "../market-data/types";
import type { Continuation } from "../market-data/DatasetContinuation";
import {
  profileActive,
  readSnapshot,
  writeSnapshot,
  type Profile,
} from "./cache";
import { actionableRow, datasetRow, managedCode } from "./dataMarkets";
import {
  addSymbol,
  allSymbols,
  saveWatchlists,
  watchContent,
  watchPreference,
  type WatchPreference,
} from "./watchlists";
import { MobileConfirm } from "./WatchOverlays";
import MobileSheet from "./MobileSheet";
import { Button } from "./components/ui/button";
import { FieldGroup } from "./components/ui/field";
import { DataEmpty, DataLoading } from "./DataStates";
import { DataFeedback, DataInput, DataMore, DataSelect } from "./DataFormParts";
import {
  dataSources,
  dataRequest,
  dataTime,
  sourceName,
  taskName,
  useDataCommand,
  useDataRead,
} from "./dataOperations";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  TabsPanels,
} from "./components/ui/tabs";
import { usePullRefresh, PULL_THRESHOLD } from "./usePullRefresh";
import { useManagedList } from "./useManagedList";
import DataCatalogSheet from "./DataCatalogSheet";
import DataMaintenanceSheet, {
  type MaintenanceView,
} from "./DataMaintenanceSheet";
import DataContinuationSheet from "./DataContinuationSheet";

type Props = {
  profile: Profile;
  online: boolean;
  visible: boolean;
  open(ticker: string): void;
  report(message: string): void;
};
export default function DataManagedPage(props: Props) {
  const { profile, visible } = props;
  const [networkOnline, setNetworkOnline] = useState(navigator.onLine);
  const online = props.online && networkOnline;
  const [query, setQuery] = useState(""),
    [source, setSource] = useState("all"),
    [status, setStatus] = useState("all"),
    [category, setCategory] = useState("all");
  const [hydrated, setHydrated] = useState(false);
  const [categories, setCategories] = useState<
    { value: string; label: string }[]
  >([]);
  const scroll = useRef<HTMLDivElement>(null),
    sentinel = useRef<HTMLDivElement>(null);
  const positions = useRef<Record<string, number>>({});
  const categoryNav = useRef<HTMLDivElement>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refreshTarget = useRef<number | undefined>(undefined);
  const [filters, setFilters] = useState(false),
    [catalog, setCatalog] = useState(false),
    [catalogMounted, setCatalogMounted] = useState(false);
  const [confirmedRows, setConfirmedRows] = useState<
    Record<string, { value: Continuation; revision: number }>
  >({});
  const runtimeSeen = useRef(new Map<string, string>());
  const [pendingRows, setPendingRows] = useState<Record<string, boolean>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const changing = useRef(new Set<string>());
  const [tools, setTools] = useState(false),
    [toolsMounted, setToolsMounted] = useState(false);
  const [selected, setSelected] = useState(""),
    [detailsOpen, setDetailsOpen] = useState(false),
    [anchor, setAnchor] = useState("");
  const [refreshRate, setRefreshRate] = useState(15000),
    [onlineView, setOnlineView] = useState(!document.hidden);
  const next = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    const change = () => setOnlineView(!document.hidden);
    const network = () => setNetworkOnline(navigator.onLine);
    document.addEventListener("visibilitychange", change);
    addEventListener("online", network);
    addEventListener("offline", network);
    return () => {
      document.removeEventListener("visibilitychange", change);
      removeEventListener("online", network);
      removeEventListener("offline", network);
    };
  }, []);
  const active = visible && onlineView;
  const paramsFor = (category: string) =>
    new URLSearchParams({
      query: query.trim(),
      mobile: "true",
      source: source === "all" ? "" : source,
      status,
      ...(category !== "all" ? { category } : {}),
      include_categories: "true",
    });
  const params = paramsFor(category);
  const result = useManagedList(
    profile,
    params.toString(),
    active && hydrated && !filters,
    online,
    refreshRate,
  );
  const listKey = JSON.stringify([category, source, status, query.trim()]);
  useEffect(() => {
    let cancelled = false;
    void readSnapshot<string>(profile, "data-category")
      .then((saved) => {
        if (!cancelled) {
          if (saved?.value) setCategory(saved.value);
          setHydrated(true);
        }
      })
      .catch(() => {
        if (!cancelled) setHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, [profile]);
  useEffect(() => {
    if (hydrated)
      void writeSnapshot(profile, "data-category", category).catch(() => {});
  }, [profile, category, hydrated]);
  useEffect(() => {
    if (result.data?.categories) setCategories(result.data.categories);
  }, [result.data?.categories]);
  useLayoutEffect(() => {
    if (scroll.current && active)
      scroll.current.scrollTop = positions.current[listKey] || 0;
  }, [listKey, active, !!result.data]);
  useEffect(() => {
    if (
      !active ||
      !online ||
      !result.data ||
      result.loading ||
      result.loadingMore ||
      result.error ||
      filters ||
      catalog ||
      detailsOpen ||
      tools
    )
      return;
    const node = sentinel.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) result.loadMore();
      },
      { root: scroll.current, rootMargin: "160px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [
    active,
    online,
    result.data,
    result.loading,
    result.loadingMore,
    result.error,
    filters,
    catalog,
    detailsOpen,
    tools,
    result.loadMore,
  ]);
  useEffect(() => {
    if (active)
      categoryNav.current
        ?.querySelector("[data-active]")
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, category, categories.length]);
  function requestRefresh() {
    if (!online || refreshing) return;
    refreshTarget.current = result.refresh();
    setRefreshing(true);
  }
  const pullDistance = usePullRefresh(
    scroll,
    active &&
      online &&
      hydrated &&
      !filters &&
      !catalog &&
      !detailsOpen &&
      !tools,
    refreshing,
    requestRefresh,
    listKey,
  );
  useEffect(() => {
    if (
      refreshTarget.current !== undefined &&
      result.settledRevision !== undefined &&
      result.settledRevision >= refreshTarget.current
    ) {
      refreshTarget.current = undefined;
      setRefreshing(false);
    }
  }, [result.settledRevision]);
  useEffect(() => {
    refreshTarget.current = undefined;
    setRefreshing(false);
  }, [listKey, active, online]);
  useEffect(() => {
    // Only a server read started after the command can replace its response.
    // Offline snapshots and older in-flight reads must not revert the Switch.
    const freshRevision = result.freshRevision;
    if (freshRevision === undefined) return;
    setConfirmedRows((old) =>
      Object.fromEntries(
        Object.entries(old).filter(([, row]) => row.revision > freshRevision),
      ),
    );
  }, [result.freshRevision]);
  useEffect(() => {
    setRefreshRate(
      result.data?.items.some((item) => item.maintenance.active_version_id)
        ? 5000
        : 15000,
    );
  }, [result.data]);
  useEffect(() => {
    // Runtime changes belong in support history, not the saved-setting label.
    // Do not interpret an offline snapshot as a newly observed connection event.
    if (!active || !online || result.readAt || result.error || !result.data)
      return;
    for (const dataset of result.data.items) {
      const live = dataset.continuation;
      if (!live) continue;
      const key = JSON.stringify([
        profile.origin,
        profile.subject,
        profile.generation,
        dataset.id,
      ]);
      const previous = runtimeSeen.current.get(key);
      const status = live.enabled ? live.status : "disabled";
      runtimeSeen.current.set(key, status);
      if (previous === status || !live.enabled) continue;
      const abnormal = [
        "unauthorized",
        "provider_maintenance",
        "attention",
        "account_changed",
      ].includes(status);
      const recovery =
        previous !== undefined &&
        !["disabled", "receiving", "market_closed"].includes(previous) &&
        status === "receiving";
      if (
        !abnormal &&
        !recovery &&
        !["preparing", "recovering"].includes(status)
      )
        continue;
      logEvent(
        {
          module: "数据",
          action: "实时接续运行",
          object: managedCode(dataset),
          code: status,
          message: liveRuntimeSummary(live),
          level: abnormal ? "warning" : "info",
          result: recovery ? "recovery" : "info",
        },
        profile,
      );
    }
  }, [result.data, result.readAt, result.error, active, online, profile]);
  useEffect(() => {
    if (!anchor || !result.data || result.loading || result.loadingMore) return;
    const node = document.getElementById("managed-" + anchor);
    if (node) {
      node.scrollIntoView({ block: "center", behavior: "smooth" });
      setAnchor("");
    } else if (result.hasMore && !result.error) result.loadMore();
    else setAnchor("");
  }, [anchor, result.data, result.loading, result.loadingMore, result.error]);
  function pick(id: string) {
    setSelected(id);
    setDetailsOpen(true);
  }
  function created(id: string, isNew = true, archived = false) {
    next.current = () => {
      setQuery("");
      setSource("all");
      setStatus(archived ? "archived" : "all");
      setCategory("all");
      setAnchor(id);
      result.refresh();
      logEvent({
        module: "数据",
        action: isNew ? "创建自建" : "定位自建",
        object: id,
        message: isNew ? "历史正在后台准备" : "已定位已有自建",
        result: "success",
      });
    };
    setCatalog(false);
  }
  function changed() {
    const revision = result.refresh();
    dispatchEvent(new Event("mw-mobile-data-changed"));
    return revision;
  }
  async function toggleRow(dataset: Dataset, enabled: boolean) {
    if (!online || result.readAt || changing.current.has(dataset.id)) return;
    changing.current.add(dataset.id);
    setPendingRows((old) => ({ ...old, [dataset.id]: true }));
    setRowErrors((old) => ({ ...old, [dataset.id]: "" }));
    const path = `/market-data/datasets/${dataset.id}/continuation`;
    try {
      let actual: Continuation;
      try {
        actual = await dataRequest<Continuation>(profile, path, {
          enabled,
          ...(enabled
            ? { mapping_id: dataset.continuation?.default_mapping_id }
            : {}),
        });
      } catch (error) {
        actual = await dataRequest<Continuation>(profile, path);
        if (actual.enabled !== enabled) throw error;
      }
      if (!profileActive(profile)) return;
      const revision = changed();
      setConfirmedRows((old) => ({
        ...old,
        [dataset.id]: { value: actual, revision },
      }));
      logEvent({
        module: "数据",
        action: enabled ? "开启实时" : "关闭实时",
        object: managedCode(dataset),
        source: dataset.source_display || dataset.identity.source,
        message: actual.status,
        result: "success",
      });
    } catch (error) {
      logFailure(
        "数据",
        enabled ? "开启实时" : "关闭实时",
        error,
        managedCode(dataset),
      );
      if (profileActive(profile))
        setRowErrors((old) => ({ ...old, [dataset.id]: errorMessage(error) }));
      result.refresh();
    } finally {
      changing.current.delete(dataset.id);
      setPendingRows((old) => ({ ...old, [dataset.id]: false }));
    }
  }
  function renderPanel(
    category: string,
    current: boolean,
    result: ReturnType<typeof useManagedList>,
  ) {
    return (
      <TabsContent
        key={category}
        value={category}
        className="data-category-panel"
      >
        <div
          ref={current ? scroll : undefined}
          className="data-managed-scroll"
          onScroll={(event) => {
            positions.current[
              JSON.stringify([category, source, status, query.trim()])
            ] = event.currentTarget.scrollTop;
          }}
        >
          <div
            className="mobile-pull-refresh"
            style={{
              height: current
                ? refreshing
                  ? PULL_THRESHOLD
                  : pullDistance
                : 0,
            }}
            role="status"
            data-refreshing={refreshing || undefined}
          >
            {current && (refreshing || pullDistance > 8) && (
              <>
                <RefreshCw
                  aria-hidden="true"
                  style={
                    refreshing
                      ? undefined
                      : { transform: `rotate(${pullDistance * 3}deg)` }
                  }
                />
                <span>
                  {refreshing
                    ? "正在刷新…"
                    : pullDistance >= PULL_THRESHOLD
                      ? "松开刷新"
                      : "下拉刷新"}
                </span>
              </>
            )}
          </div>
          {(query.trim() || source !== "all" || status !== "all") && (
            <div className="data-list-caption">
              <span>
                {[
                  query.trim(),
                  source !== "all" ? sourceName(source) : "",
                  {
                    attention: "需要处理",
                    paused: "维护已暂停",
                    archived: "已归档",
                  }[status],
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              {(query.trim() || source !== "all" || status !== "all") && (
                <Button
                  variant="plain"
                  size="icon"
                  className="data-clear-filter"
                  aria-label="清除筛选"
                  onClick={() => {
                    setQuery("");
                    setSource("all");
                    setStatus("all");
                  }}
                >
                  <X aria-hidden="true" />
                </Button>
              )}
            </div>
          )}
          <DataFeedback
            error={result.error}
            notice={!online && result.data ? "当前离线" : undefined}
          />
          {result.loading && !result.data && (
            <DataLoading label="正在读取自建行情…" />
          )}
          {!result.loading && !result.data && (
            <DataEmpty
              title={online ? "暂时无法读取" : "暂无本地数据"}
              offline={!online}
              action={
                <Button
                  variant="outline"
                  disabled={!online}
                  onClick={result.refresh}
                >
                  重新读取
                </Button>
              }
            >
              连接恢复后可读取自建行情。
            </DataEmpty>
          )}
          {result.data && !result.data.items.length && (
            <DataEmpty
              title={
                query.trim() ||
                category !== "all" ||
                source !== "all" ||
                status !== "all"
                  ? "没有符合条件的自建行情"
                  : "还没有自建行情"
              }
              action={
                query.trim() ||
                category !== "all" ||
                source !== "all" ||
                status !== "all" ? undefined : (
                  <Button
                    disabled={!online}
                    onClick={() => {
                      setCatalogMounted(true);
                      setCatalog(true);
                    }}
                  >
                    添加行情
                  </Button>
                )
              }
            >
              {query.trim() ||
              category !== "all" ||
              source !== "all" ||
              status !== "all"
                ? category !== "all"
                  ? "当前分类暂无符合条件的自建行情。"
                  : "换个筛选条件，或清除筛选查看全部。"
                : "搜索并选择品种，建立自己的历史行情。"}
            </DataEmpty>
          )}
          <div className="data-series-list" aria-label="自建行情列表">
            {result.data?.items.map((dataset) => {
              const confirmed = confirmedRows[dataset.id]?.value;
              const continuation = confirmed
                ? {
                    ...dataset.continuation,
                    enabled: confirmed.enabled,
                    status: confirmed.status,
                    rollover: confirmed.rollover,
                    can_disable: confirmed.enabled,
                    can_enable: confirmed.ready_to_enable,
                    default_mapping_id: confirmed.default_mapping_id,
                  }
                : dataset.continuation;
              const maintenance = maintenanceState(dataset);
              const needsAttention = liveNeedsAttention(continuation);
              return (
                <div
                  className="data-managed-row"
                  aria-busy={!!pendingRows[dataset.id]}
                  id={
                    (current ? "managed-" : `managed-preview-${category}-`) +
                    dataset.id
                  }
                  key={dataset.id}
                >
                  <Button
                    variant="plain"
                    className="data-managed-open"
                    aria-label={`查看 ${managedCode(dataset)}`}
                    onClick={() => pick(dataset.id)}
                  >
                    <span className="data-managed-identity">
                      <SymbolIdentityRow
                        variant="data"
                        row={dataset}
                        code={managedCode(dataset)}
                        name={dataset.instrument_name || ""}
                        configuration={configurationDifference(
                          dataset,
                          result.data!.items.filter(
                            (other) =>
                              managedCode(other) === managedCode(dataset) &&
                              other.identity.source === dataset.identity.source,
                          ),
                        )}
                      />
                      <small
                        className="data-maintenance-summary"
                        data-attention={
                          maintenance === "维护需处理" || undefined
                        }
                      >
                        {maintenance}
                      </small>
                    </span>
                  </Button>
                  <div className="data-managed-status">
                    <div className="data-live-switch-target">
                      <Switch
                        size="lg"
                        checked={!!continuation?.enabled}
                        aria-label={`${managedCode(dataset)} 实时`}
                        aria-describedby={`live-reason-${category}-${dataset.id}`}
                        disabled={
                          !online ||
                          !!result.readAt ||
                          !!pendingRows[dataset.id] ||
                          (continuation?.enabled
                            ? !continuation.can_disable
                            : !continuation?.can_enable)
                        }
                        onCheckedChange={(enabled) =>
                          void toggleRow(dataset, enabled)
                        }
                      />
                    </div>
                    <small
                      id={`live-reason-${category}-${dataset.id}`}
                      data-attention={needsAttention || undefined}
                    >
                      {pendingRows[dataset.id]
                        ? "正在更新…"
                        : !continuation?.enabled && !continuation?.can_enable
                          ? continuation?.disabled_reason || "待配置"
                          : liveSettingLabel(continuation)}
                    </small>
                  </div>
                  {rowErrors[dataset.id] && (
                    <p className="data-row-error" role="alert">
                      {rowErrors[dataset.id]}
                    </p>
                  )}
                  {needsAttention && (
                    <p className="data-row-error">
                      {continuation?.rollover?.requires_attention
                        ? continuation.rollover.warning ||
                          "实时历史基线需更新，请查看详情"
                        : continuation?.status === "account_changed"
                          ? "来源账户已变化，请重新核对实时来源"
                          : "接续配置或数据准备需处理，请查看详情"}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          {!!result.data && result.hasMore && (
            <div
              ref={current ? sentinel : undefined}
              className="data-load-more"
            >
              <Button
                variant="ghost"
                disabled={!online || result.loading || result.loadingMore}
                onClick={result.error ? result.refresh : result.loadMore}
              >
                {result.loadingMore
                  ? "正在加载…"
                  : result.error
                    ? "重试加载"
                    : "加载更多"}
              </Button>
            </div>
          )}
        </div>
      </TabsContent>
    );
  }
  return (
    <div className="mobile-data-body mobile-data-surface data-managed">
      <header className="mobile-title data-title">
        <h1>数据</h1>
        <div className="data-header-actions">
          <HeaderIconButton
            icon={Search}
            label="搜索自建行情"
            aria-expanded={filters}
            aria-haspopup="dialog"
            active={!!query.trim() || source !== "all" || status !== "all"}
            onClick={() => setFilters(true)}
          />
          <SymbolAddButton
            label="添加自建"
            expanded={catalog}
            onClick={() => {
              setCatalogMounted(true);
              setCatalog(true);
            }}
          />
        </div>
      </header>
      <Tabs
        swipe
        value={category}
        onValueChange={(value) => setCategory(String(value))}
        className="data-category-tabs"
      >
        <div
          ref={categoryNav}
          className="data-category-nav mobile-page-tabs-nav"
        >
          <TabsList
            variant="line"
            aria-label="行情分类"
            activateOnFocus={false}
          >
            <TabsTrigger value="all">全部</TabsTrigger>
            {categories.map((item) => (
              <TabsTrigger key={item.value} value={item.value}>
                {item.label}
              </TabsTrigger>
            ))}
            {category !== "all" &&
              !categories.some((item) => item.value === category) && (
                <TabsTrigger value={category}>
                  {(
                    {
                      forex: "外汇",
                      metal: "贵金属",
                      "a-stock": "A股",
                      "us-stock": "美股",
                      "hk-stock": "港股",
                      crypto: "加密",
                      index: "指数",
                      future: "期货",
                      etf: "ETF",
                      fund: "基金",
                      stock: "其他股票",
                      commodity: "商品",
                      bond: "债券",
                      option: "期权",
                      other: "其他",
                    } as Record<string, string>
                  )[category] || "其他"}
                </TabsTrigger>
              )}
          </TabsList>
        </div>
        <TabsPanels>
          {[
            "all",
            ...categories.map((item) => item.value),
            ...(category !== "all" &&
            !categories.some((item) => item.value === category)
              ? [category]
              : []),
          ].map((panelCategory) => {
            const current = panelCategory === category;
            const cached = result.peek(paramsFor(panelCategory).toString());
            const panelResult = current
              ? result
              : {
                  ...result,
                  data: undefined,
                  error: "",
                  loading: true,
                  loadingMore: false,
                  ...cached,
                  hasMore:
                    !!cached?.data && cached.pages * 25 < cached.data.total,
                };
            return renderPanel(panelCategory, current, panelResult);
          })}
        </TabsPanels>
      </Tabs>
      <MobileSheet
        title="搜索自建行情"
        open={filters}
        close={() => setFilters(false)}
        onClosed={() => {
          const action = next.current;
          next.current = undefined;
          action?.();
        }}
      >
        <div className="data-filter-form data-workflow-form">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setQuery(query.trim());
              setFilters(false);
            }}
          >
            <FieldGroup>
              <DataInput
                label="搜索自建行情"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="代码、中文名、来源或类别"
                maxLength={100}
                enterKeyHint="search"
              />
              <DataSelect
                label="来源"
                value={source}
                items={dataSources}
                onChange={(v) => {
                  setSource(v);
                }}
              />
              <DataSelect
                label="显示范围"
                value={status}
                items={[
                  { value: "all", label: "全部未归档" },
                  { value: "attention", label: "需要处理" },
                  { value: "paused", label: "维护已暂停" },
                  { value: "archived", label: "已归档" },
                ]}
                onChange={(v) => {
                  setStatus(v);
                }}
              />
              <Button type="submit" className="data-primary">
                查看行情
              </Button>
            </FieldGroup>
          </form>
          <Button
            className="data-filter-tools"
            variant="ghost"
            onClick={() => {
              next.current = () => {
                setToolsMounted(true);
                setTools(true);
              };
              setFilters(false);
            }}
          >
            <Radio data-icon="inline-start" aria-hidden="true" />
            <span>任务与来源</span>
            <ChevronRight data-icon="inline-end" aria-hidden="true" />
          </Button>
        </div>
      </MobileSheet>
      {catalogMounted && (
        <DataCatalogSheet
          profile={profile}
          online={online}
          active={active && catalog}
          open={catalog}
          close={() => setCatalog(false)}
          done={created}
          onClosed={() => {
            setCatalogMounted(false);
            const action = next.current;
            next.current = undefined;
            action?.();
          }}
        />
      )}
      {selected && (
        <ManagedDetails
          {...props}
          active={active}
          id={selected}
          opened={detailsOpen}
          close={() => setDetailsOpen(false)}
          changed={changed}
          onClosed={() => setSelected("")}
        />
      )}
      {toolsMounted && (
        <DataTools
          profile={profile}
          online={online}
          active={active && tools}
          opened={tools}
          close={() => setTools(false)}
          onClosed={() => setToolsMounted(false)}
          pick={(id) => {
            next.current = () => pick(id);
            setTools(false);
          }}
          afterClose={() => {
            const action = next.current;
            next.current = undefined;
            action?.();
          }}
        />
      )}
    </div>
  );
}

export function ManagedDetails({
  id,
  opened,
  active,
  close,
  changed,
  onClosed,
  ...props
}: Props & {
  id: string;
  opened: boolean;
  active: boolean;
  close(): void;
  changed(): void;
  onClosed(): void;
}) {
  const { profile, online } = props;
  const [favorites, setFavorites] = useState<string[]>([]);
  const [aux, setAux] = useState<{
      view: MaintenanceView | "live";
      dataset: Dataset;
    }>(),
    [auxOpen, setAuxOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(opened),
    [confirmation, setConfirmation] = useState<{
      title: string;
      description: string;
      run(): void;
    }>();
  const next = useRef<(() => void) | undefined>(undefined),
    updateId = useRef<string | undefined>(undefined);
  const result = useDataRead<Dataset>(
    profile,
    `/market-data/center/datasets/${id}`,
    active && opened && detailOpen,
    online,
    3000,
  );
  const live = useDataRead<Continuation>(
    profile,
    `/market-data/datasets/${id}/continuation`,
    active && opened && detailOpen,
    online,
    3000,
  );
  const dataset = result.data,
    command = useDataCommand(profile, online);
  useEffect(() => setDetailOpen(opened), [opened]);
  useEffect(() => {
    if (!active || !online || !detailOpen) return;
    const controller = new AbortController();
    void api<WatchPreference[]>(
      "/advanced-charts/preferences",
      undefined,
      controller.signal,
    )
      .then((rows) => {
        if (!controller.signal.aborted && profileActive(profile))
          setFavorites(allSymbols(watchContent(watchPreference(rows))));
      })
      .catch(() => {});
    return () => controller.abort();
  }, [active, online, detailOpen]);
  function refresh() {
    result.refresh();
    live.refresh();
    changed();
  }
  function handoff(view: MaintenanceView | "live") {
    if (!dataset) return;
    next.current = () => {
      setAux({ view, dataset });
      setAuxOpen(true);
    };
    setDetailOpen(false);
  }
  function chart(ticker: string) {
    next.current = () => {
      close();
      onClosed();
      props.open(ticker);
    };
    setDetailOpen(false);
  }
  async function update() {
    await command.run(async (request) => {
      updateId.current ||= crypto.randomUUID();
      await request(profile, `/market-data/datasets/${id}/tasks`, {
        request_id: updateId.current,
      });
      updateId.current = undefined;
      refresh();
      command.setNotice("更新任务已提交，后台继续处理");
    });
  }
  async function control(action: string) {
    await command.run(async (request) => {
      const path = `/market-data/datasets/${id}/maintenance/control`;
      try {
        await request(profile, path, { action });
      } catch (error) {
        const plan = await request<any>(
          profile,
          `/market-data/datasets/${id}/maintenance`,
        );
        if (
          (action === "pause" && !plan.paused) ||
          (action === "resume" && plan.paused) ||
          (action === "archive" && !plan.archived) ||
          (action === "unarchive" && plan.archived)
        )
          throw error;
      }
      refresh();
      command.setNotice(
        action === "pause"
          ? "定时维护已暂停；当前任务与实时继续运行"
          : action === "archive"
            ? "已归档，历史与引用保留；实时及当前任务单独控制"
            : "维护状态已更新",
      );
    });
  }
  async function toggleLive(enabled: boolean) {
    if (!dataset) return;
    if (
      enabled &&
      (!live.data?.default_mapping_id ||
        !live.data.mappings.some(
          (m) =>
            m.id === live.data!.default_mapping_id &&
            m.current_account &&
            m.valid_for_selection,
        ))
    ) {
      handoff("live");
      return;
    }
    await command.run(async (request) => {
      const path = `/market-data/datasets/${id}/continuation`;
      try {
        await request(profile, path, {
          enabled,
          ...(enabled ? { mapping_id: live.data?.default_mapping_id } : {}),
        });
      } catch (error) {
        const actual = await request<Continuation>(profile, path);
        if (actual.enabled !== enabled) throw error;
      }
      refresh();
      command.setNotice(
        enabled
          ? "实时已开启，运行状态以来源实际连接为准"
          : "实时已关闭，历史和接续配置已保留",
      );
    });
  }
  async function use(ticker?: string) {
    if (!dataset) return;
    await command.run(async () => {
      const row = ticker
        ? { ticker }
        : await actionableRow(datasetRow(dataset));
      if (!profileActive(profile)) return;
      chart(row.ticker);
    });
  }
  async function add() {
    if (!dataset) return;
    await command.run(async () => {
      const row = await actionableRow(datasetRow(dataset));
      if (!profileActive(profile)) return;
      const selection = await readSnapshot<string>(profile, "watch-group");
      if (!profileActive(profile)) return;
      const baseline = watchPreference(
        await dataRequest<WatchPreference[]>(
          profile,
          "/advanced-charts/preferences",
        ),
      );
      if (!profileActive(profile)) return;
      const content = watchContent(baseline);
      if (!allSymbols(content).includes(row.ticker)) {
        const saved = await saveWatchlists(
          (path, body, signal) => dataRequest(profile, path, body, signal),
          baseline,
          addSymbol(content, row.ticker, selection?.value || ""),
        );
        if (!profileActive(profile)) return;
        await writeSnapshot(profile, "watchlists", saved).catch(() => {});
        setFavorites(allSymbols(watchContent(saved)));
        dispatchEvent(new Event("mw-mobile-watchlists-changed"));
      } else {
        setFavorites(allSymbols(content));
      }
      command.setNotice("已加入自选");
    });
  }
  const locked = command.busy || !online || !!result.readAt || !!result.error;
  const liveLocked = locked || !!live.readAt || !!live.error || !live.data;
  const fixed =
    dataset?.periods.find((period) => period.timeframe === "M1") ||
    dataset?.periods[0];
  const usable =
    !!fixed?.available_version_id &&
    (!live.data?.enabled ||
      (live.data.ready_to_enable &&
        live.data.composite?.preparation.status === "queried"));
  const currentTicker = dataset
    ? live.data?.enabled && live.data.composite
      ? `MWC:${live.data.composite.id}`
      : datasetRow(dataset).ticker
    : "";
  const added = !!currentTicker && favorites.includes(currentTicker);
  return (
    <>
      <MobileSheet
        title="自建行情"
        open={detailOpen}
        dismissible={!command.busy}
        close={close}
        onClosed={() => {
          const action = next.current;
          next.current = undefined;
          if (action) action();
          else onClosed();
        }}
      >
        <div className="data-workflow-form data-managed-detail">
          {result.loading && !dataset && <DataLoading label="正在读取行情…" />}
          <DataFeedback
            error={result.error || live.error || command.error}
            notice={!online && dataset ? "当前离线" : undefined}
          />
          {(result.error || live.error) && (
            <Button variant="outline" onClick={refresh}>
              重新读取
            </Button>
          )}
          {dataset && (
            <>
              <div className="data-detail-identity">
                <SymbolIdentityRow
                  variant="data"
                  row={dataset}
                  code={managedCode(dataset)}
                  name={dataset.instrument_name || ""}
                />
                <HistoryTags dataset={dataset} />
                {dataset.identity.source === "akshare" && (
                  <p className="data-caption data-channel-note">
                    采集通道 AKShare
                  </p>
                )}
              </div>
              <section className="data-detail-section">
                <h3>
                  <Database aria-hidden="true" />
                  历史数据
                </h3>
                <HistoryFacts dataset={dataset} />
                <DataFeedback error={dataset.maintenance.task_error} />
                <div className="data-action-row">
                  <Button
                    variant="secondary"
                    disabled={locked || dataset.maintenance.archived}
                    onClick={() =>
                      dataset.maintenance.active_version_id
                        ? handoff("tasks")
                        : void update()
                    }
                  >
                    <RefreshCw data-icon="inline-start" aria-hidden="true" />
                    {dataset.maintenance.active_version_id
                      ? "查看进度"
                      : "立即更新"}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={locked}
                    onClick={() => handoff("settings")}
                  >
                    维护设置
                  </Button>
                </div>
              </section>
              <section className="data-detail-section data-live-section">
                <div className="data-section-heading">
                  <h3>
                    <Radio aria-hidden="true" />
                    实时行情
                  </h3>
                  <span className="data-live-summary">
                    {liveSummary(
                      live.data,
                      live.error,
                      !online || live.error ? live.readAt : undefined,
                    )}
                  </span>
                </div>
                {live.data?.reason && (
                  <p className="data-caption">{live.data.reason}</p>
                )}
                {live.data?.composite && (
                  <p className="data-caption">
                    实时来源{" "}
                    {sourceLabel(live.data.composite.live_source_display) ||
                      (live.data.composite.live_source
                        ? sourceName(live.data.composite.live_source)
                        : "待核实")}{" "}
                    ·{" "}
                    {live.data.composite.mapping?.target_identity
                      ?.provider_symbol ||
                      live.data.mappings.find(
                        (m) => m.id === live.data!.default_mapping_id,
                      )?.target_identity.provider_symbol ||
                      "品种待核实"}
                  </p>
                )}
                {live.data?.composite?.preparation.error && (
                  <DataFeedback error={live.data.composite.preparation.error} />
                )}
                {live.data?.rollover?.warning && (
                  <p className="data-caption" role="status">
                    {live.data.rollover.warning}
                  </p>
                )}
                {live.data?.enabled && (
                  <DataMore title="最近运行情况">
                    <p className="data-caption">
                      {liveRuntimeSummary(live.data)}
                      {!online || live.error ? " · 上次状态，待核实" : ""}
                    </p>
                    {live.data.composite?.health?.next_probe_at != null && (
                      <p className="data-caption">
                        下次连接检查{" "}
                        {detailTime(live.data.composite.health.next_probe_at)}
                      </p>
                    )}
                    {live.data.composite?.preparation.confirmed_end != null &&
                      live.data.composite.preparation.confirmed_end > 0 && (
                        <p className="data-caption">
                          实时已确认至{" "}
                          {detailTime(
                            live.data.composite.preparation.confirmed_end,
                          )}
                        </p>
                      )}
                    {live.data?.baseline_seam != null && (
                      <p className="data-caption">
                        历史接到 {detailTime(live.data.baseline_seam)}
                      </p>
                    )}
                    {live.data?.rollover &&
                      ["preparing", "ready", "deferred"].includes(
                        live.data.rollover.status,
                      ) && (
                        <p className="data-caption" role="status">
                          {
                            {
                              preparing: "新基线准备中",
                              ready: "新基线即将接管",
                              deferred: "基线轮换暂缓",
                              updated: "基线已更新",
                            }[live.data.rollover.status]
                          }
                          {live.data.rollover.reason &&
                            `：${live.data.rollover.reason}`}
                        </p>
                      )}
                  </DataMore>
                )}
                <div className="data-action-row data-live-actions">
                  {live.data && (
                    <Button
                      variant={
                        live.data.enabled || !live.data.supported
                          ? "outline"
                          : "secondary"
                      }
                      disabled={
                        liveLocked ||
                        (!live.data.enabled &&
                          (!live.data.supported ||
                            !dataset.periods.some(
                              (period) =>
                                period.timeframe === "M1" &&
                                period.available_version_id,
                            ) ||
                            (dataset.identity.mode || "base_m1") !== "base_m1"))
                      }
                      onClick={() =>
                        live.data!.enabled
                          ? setConfirmation({
                              title: "关闭实时行情？",
                              description:
                                "历史和配置会保留，依赖此接续的告警暂停判定；同一历史身份的接续会共同受影响。",
                              run: () => void toggleLive(false),
                            })
                          : void toggleLive(true)
                      }
                    >
                      {live.data.enabled ? "关闭实时" : "开启实时"}
                    </Button>
                  )}
                  {(dataset.identity.mode || "base_m1") === "base_m1" &&
                    dataset.identity.basis === "bid" && (
                      <Button
                        variant="ghost"
                        disabled={liveLocked}
                        onClick={() => handoff("live")}
                      >
                        {live.data?.supported ? "核对实时来源" : "检查实时来源"}
                      </Button>
                    )}
                </div>
              </section>
              <div className="data-action-row">
                <Button
                  disabled={liveLocked || !usable}
                  onClick={() => void use()}
                >
                  打开图表
                </Button>
                <Button
                  variant="outline"
                  disabled={liveLocked || !usable || added}
                  onClick={() => void add()}
                >
                  {added ? "已加入自选" : "加入自选"}
                </Button>
              </div>
              {live.data?.enabled && (
                <Button
                  variant="ghost"
                  disabled={locked || !fixed?.available_version_id}
                  onClick={() => void use(`MWH:${fixed!.available_version_id}`)}
                >
                  查看固定历史
                </Button>
              )}
              <DataMore title="更多操作">
                <div className="data-more-actions">
                  <Button
                    variant="ghost"
                    disabled={locked}
                    onClick={() => handoff("tasks")}
                  >
                    维护任务与记录
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={locked || dataset.maintenance.archived}
                    onClick={() => handoff("range")}
                  >
                    区间补数与复查
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={!online}
                    onClick={() => handoff("versions")}
                  >
                    固定历史版本
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={locked}
                    onClick={() =>
                      void control(
                        dataset.maintenance.paused ? "resume" : "pause",
                      )
                    }
                  >
                    {dataset.maintenance.paused
                      ? "恢复定时维护"
                      : "暂停定时维护"}
                  </Button>
                  <p className="data-caption">
                    仅控制后续定时维护，当前任务与实时不受影响。
                  </p>
                  <Button
                    variant="ghost"
                    disabled={locked}
                    onClick={() =>
                      setConfirmation({
                        title: dataset.maintenance.archived
                          ? "恢复此行情？"
                          : "归档此行情？",
                        description:
                          "历史和引用保留，当前任务、实时和暂停状态分别控制。",
                        run: () =>
                          void control(
                            dataset.maintenance.archived
                              ? "unarchive"
                              : "archive",
                          ),
                      })
                    }
                  >
                    {dataset.maintenance.archived ? "取消归档" : "归档行情"}
                  </Button>
                </div>
              </DataMore>
            </>
          )}
        </div>
        {confirmation && (
          <MobileConfirm
            title={confirmation.title}
            description={confirmation.description}
            actionLabel="确认"
            onAccept={() => {
              confirmation.run();
              setConfirmation(undefined);
            }}
            onClose={() => setConfirmation(undefined)}
          />
        )}
      </MobileSheet>
      {aux && aux.view !== "live" && (
        <DataMaintenanceSheet
          dataset={aux.dataset}
          profile={profile}
          online={online}
          active={active && auxOpen}
          open={auxOpen}
          view={aux.view}
          close={() => setAuxOpen(false)}
          changed={refresh}
          openChart={(ticker) => {
            next.current = () => {
              close();
              onClosed();
              props.open(ticker);
            };
            setAuxOpen(false);
          }}
          onClosed={() => {
            setAux(undefined);
            const action = next.current;
            next.current = undefined;
            if (action) action();
            else setDetailOpen(true);
          }}
        />
      )}
      {aux?.view === "live" && (
        <DataContinuationSheet
          dataset={aux.dataset}
          profile={profile}
          online={online}
          active={active && auxOpen}
          open={auxOpen}
          close={() => setAuxOpen(false)}
          changed={refresh}
          onClosed={() => {
            setAux(undefined);
            setDetailOpen(true);
          }}
        />
      )}
    </>
  );
}

function DataTools({
  profile,
  online,
  active,
  opened,
  close,
  onClosed,
  afterClose,
  pick,
}: {
  profile: Profile;
  online: boolean;
  active: boolean;
  opened: boolean;
  close(): void;
  onClosed(): void;
  afterClose(): void;
  pick(id: string): void;
}) {
  const [page, setPage] = useState(1);
  const tasks = useDataRead<{ items: Task[]; total: number }>(
    profile,
    `/market-data/center/tasks?page=${page}&page_size=10`,
    active,
    online,
  );
  const sources = useDataRead<any[]>(
    profile,
    "/market-data/sources",
    active,
    online,
  );
  const directory = useDataRead<any[]>(
    profile,
    "/market-data/catalog/directory-status",
    active,
    online,
  );
  const live = useDataRead<any>(
    profile,
    "/market-data/live/status",
    active,
    online,
  );
  return (
    <MobileSheet
      title="任务与来源"
      open={opened}
      close={close}
      onClosed={() => {
        onClosed();
        afterClose();
      }}
    >
      <div className="data-workflow-form">
        <DataFeedback
          error={tasks.error || sources.error || directory.error || live.error}
        />
        {(tasks.error || sources.error || directory.error || live.error) && (
          <Button
            variant="outline"
            onClick={() => {
              tasks.refresh();
              sources.refresh();
              directory.refresh();
              live.refresh();
            }}
          >
            重新读取
          </Button>
        )}
        {tasks.loading && !tasks.data && <DataLoading label="正在读取任务…" />}
        <h3>近期维护任务</h3>
        {tasks.data?.items.map((task) => (
          <Button
            className="data-catalog-row"
            variant="plain"
            key={task.id}
            onClick={() => pick(task.dataset.id)}
          >
            <span>
              <strong>{managedCode(task.dataset)}</strong>
              <small>
                {taskName(task.status)} · {dataTime(task.updated_at)}
              </small>
            </span>
            <ChevronRight aria-hidden="true" />
          </Button>
        ))}
        {tasks.data?.total === 0 && <DataEmpty title="暂无任务" />}
        {!!tasks.data && tasks.data.total > 10 && (
          <div className="data-pager">
            <Button
              variant="ghost"
              disabled={page === 1}
              onClick={() => setPage((n) => n - 1)}
            >
              上一页
            </Button>
            <span>第 {page} 页</span>
            <Button
              variant="ghost"
              disabled={page * 10 >= tasks.data.total}
              onClick={() => setPage((n) => n + 1)}
            >
              下一页
            </Button>
          </div>
        )}
        <DataSourceTools
          profile={profile}
          online={online}
          changed={() => {
            directory.refresh();
            sources.refresh();
          }}
        />
        <DataMore title="来源能力与目录">
          {sources.data?.map((source) => (
            <div className="data-task-card" key={source.source}>
              <strong>{sourceName(source.source)}</strong>
              <p>
                {source.enabled === false
                  ? "未启用"
                  : source.configured === false
                    ? "已启用 · 缺配置"
                    : "已启用"}
              </p>
              <p>
                {(
                  {
                    supported: "支持原生行情",
                    supported_when_enabled: "启用来源后可用",
                    symbol_probe_required: "按品种验证可用周期",
                  } as Record<string, string>
                )[source.native_status] || "能力以具体品种为准"}
              </p>
              {!!source.native_periods?.length && (
                <p>{source.native_periods.join(" · ")}</p>
              )}
            </div>
          ))}
          {directory.data?.map((row, index) => (
            <p key={index}>
              {sourceName(row.source)} · {row.partition} ·{" "}
              {(
                {
                  complete: "已同步",
                  running: "同步中",
                  failed: "同步失败",
                  pending: "待同步",
                } as Record<string, string>
              )[row.status] || "状态待核实"}{" "}
              · {row.count ?? 0} 项
            </p>
          ))}
        </DataMore>
        <DataMore title="实时来源状态">
          <p>
            OANDA Practice ·{" "}
            {live.data?.provider?.configured ? "已配置" : "尚未配置"}
          </p>
          <DataFeedback
            error={
              live.data?.provider?.error ||
              (live.data?.provider?.authentication_hold
                ? "实时来源认证需处理，请检查服务器连接配置"
                : undefined)
            }
          />
          {live.data?.datasets?.map((row: any) => (
            <p key={row.dataset_id}>
              {row.provider_symbol || row.dataset_id.slice(0, 8)} ·{" "}
              {row.market_session === "closed"
                ? "闭市"
                : (
                    {
                      connected: "已连接",
                      connecting: "连接中",
                      recovering: "恢复中",
                      disconnected: "已断开",
                      inactive: "未运行",
                    } as Record<string, string>
                  )[row.connection] || "连接待确认"}
            </p>
          ))}
        </DataMore>
      </div>
    </MobileSheet>
  );
}
