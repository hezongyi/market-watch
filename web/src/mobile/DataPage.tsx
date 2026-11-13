import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../api";
import {
  ChevronRight,
  Search,
  SlidersHorizontal,
  Plus,
  Check,
  ListTodo,
  Radio,
  Database,
  Info,
} from "lucide-react";
import {
  profileActive,
  readSnapshot,
  writeSnapshot,
  type Profile,
} from "./cache";
import { seriesIdentity } from "./market";
import {
  addSymbol,
  allSymbols,
  saveWatchlists,
  watchContent,
  watchPreference,
  type WatchPreference,
  type WatchList,
} from "./watchlists";
import MobileSheet from "./MobileSheet";
import { Button as MobileButton } from "./components/ui/button";
import { MobileOverlaysProvider } from "./WatchOverlays";
import MobileSelect from "./MobileSelect";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import { Badge } from "./components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "./components/ui/card";
import { Alert, AlertTitle, AlertDescription } from "./components/ui/alert";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "./components/ui/collapsible";
import WatchGroupSelect from "./WatchGroupSelect";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
} from "./components/ui/input-group";
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group";
import { FieldGroup, Field, FieldLabel } from "./components/ui/field";
import {
  DataEmpty as MobileEmpty,
  DataLoading as MobileLoading,
} from "./DataStates";

import type { Dataset } from "../market-data/types";
import {
  actionableRow,
  continuationLabel,
  datasetRow,
  loadManaged,
  marketType,
  rowKey,
  type MarketRow as Row,
} from "./dataMarkets";

type Page = {
  items: Row[];
  next_offset?: number | null;
  next_cursor?: string | null;
  has_more?: boolean;
};
const dateTime = (value: number) =>
  new Date(value).toLocaleString("zh-CN", {
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

const sources = [
  ["", "全部来源"],
  ["oanda", "OANDA"],
  ["dukascopy", "Dukascopy"],
  ["fxcm", "FXCM"],
  ["binance", "Binance"],
  ["yahoo", "Yahoo"],
  ["akshare", "AKShare"],
];

// Keep backend statuses explicit without suggesting configuration proves readiness.
function statusLabel(status?: string) {
  const labels: Record<string, string> = {
    supported: "支持原生周期",
    supported_when_enabled: "启用后支持",
    symbol_probe_required: "需按品种核验",
    complete: "完整分区",
    partial: "部分目录",
    failed: "读取失败",
    published: "已发布",
    preparing: "准备中",
    running: "执行中",
    queued: "排队中",
    cancelled: "已取消",
    paused: "已暂停",
    available: "可用",
    needs_maintenance: "待维护",
    connected: "已连接",
    recovering: "恢复中",
    disconnected: "已断开",
    inactive: "采集未活动",
    closed: "闭市",
  };
  return status ? labels[status] || status : "状态待确认";
}

type DataPageProps = {
  profile: Profile;
  online: boolean;
  visible: boolean;
  open(ticker: string): void;
  report(message: string): void;
  searchMode?: boolean;
  initialGroup?: string;
};

export default function DataPage(props: DataPageProps) {
  if (props.searchMode) return <DataContent {...props} />;
  return (
    <section
      hidden={!props.visible}
      className="mobile-content mobile-data mobile-controls"
    >
      <MobileOverlaysProvider>
        <DataContent {...props} />
      </MobileOverlaysProvider>
    </section>
  );
}

function DataContent({
  profile,
  online,
  visible,
  open,
  report,
  searchMode = false,
  initialGroup = "",
}: DataPageProps) {
  const [kind, setKind] = useState("native"),
    [query, setQuery] = useState(""),
    [source, setSource] = useState("");
  const [pages, setPages] = useState<{ offset: number; cursor?: string }[]>([
    { offset: 0 },
  ]);
  const [page, setPage] = useState<Page>(),
    [loaded, setLoaded] = useState(false),
    [loading, setLoading] = useState(false);
  const [readAt, setReadAt] = useState<number>(),
    [retry, setRetry] = useState(0),
    [error, setError] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailRetry, setDetailRetry] = useState(0);
  const [selected, setSelected] = useState<Row>(),
    [detail, setDetail] = useState<any>(),
    [detailError, setDetailError] = useState("");
  const [groups, setGroups] = useState<WatchList[]>([]),
    [targetGroup, setTargetGroup] = useState(initialGroup);
  const [versions, setVersions] = useState<any[]>();
  const [favorites, setFavorites] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [added, setAdded] = useState(false);
  const [support, setSupport] = useState<{
    title: string;
    rows: any[];
    page: number;
    total?: number;
  }>();
  const [toolsOpen, setToolsOpen] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false),
    [supportLoading, setSupportLoading] = useState(false),
    [supportError, setSupportError] = useState("");
  const [versionsOpen, setVersionsOpen] = useState(false),
    [versionsLoading, setVersionsLoading] = useState(false),
    [versionsError, setVersionsError] = useState("");
  const supportRequest = useRef<AbortController | undefined>(undefined),
    versionsRequest = useRef<AbortController | undefined>(undefined);
  const afterTools = useRef<(() => void) | undefined>(undefined),
    afterDetails = useRef<(() => void) | undefined>(undefined),
    afterVersions = useRef<(() => void) | undefined>(undefined);
  const adding = useRef(false);
  useEffect(
    () => () => {
      supportRequest.current?.abort();
      versionsRequest.current?.abort();
    },
    [],
  );
  const generation = useRef(0);
  const position = pages.at(-1)!;
  const cacheName =
    "data-page:two-kinds:" + JSON.stringify([kind, query, source, position]);
  useEffect(() => {
    if (!visible) return;
    const token = ++generation.current,
      controller = new AbortController();
    setLoading(true);
    setError("");
    setLoaded(false);
    setPage(undefined);
    setReadAt(undefined);
    const timer = setTimeout(async () => {
      try {
        const cached = await readSnapshot<Page>(profile, cacheName);
        if (token !== generation.current || controller.signal.aborted) return;
        if (cached) {
          setPage(cached.value);
          setReadAt(cached.readAt);
          setLoaded(true);
        }
        if (!online) return;
        const params = new URLSearchParams({
          query,
          source,
          page_size: "25",
          ...(kind === "native"
            ? {
                kind: "provider",
                include_total: "false",
                offset: String(position.offset),
              }
            : { page: String(pages.length) }),
        });
        if (position.cursor) params.set("cursor", position.cursor);
        let value: Page;
        if (kind === "managed") {
          const result = await api<{ items: Dataset[]; total: number }>(
            "/market-data/center/dataset-summaries?" + params,
            undefined,
            controller.signal,
          );
          value = {
            items: result.items.map(datasetRow),
            next_offset:
              pages.length * 25 < result.total ? pages.length * 25 : null,
          };
        } else {
          value = await api<Page>(
            "/market-data/series/page?" + params,
            undefined,
            controller.signal,
          );
        }
        if (token !== generation.current || controller.signal.aborted) return;
        setPage(value);
        setLoaded(true);
        setReadAt(undefined);
        await writeSnapshot(profile, cacheName, value).catch(() =>
          report("目录快照未能写入本机"),
        );
      } catch (error) {
        if (!controller.signal.aborted && token === generation.current) {
          setError(errorMessage(error));
        }
      } finally {
        if (token === generation.current) setLoading(false);
      }
    }, 250);
    return () => {
      ++generation.current;
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    online,
    visible,
    cacheName,
    retry,
    profile.origin,
    profile.subject,
    report,
  ]);
  useEffect(() => {
    if (!visible || !online) return;
    const controller = new AbortController();
    void api<WatchPreference[]>(
      "/advanced-charts/preferences",
      undefined,
      controller.signal,
    )
      .then((rows) => {
        if (!controller.signal.aborted) {
          const content = watchContent(watchPreference(rows));
          setFavorites(allSymbols(content));
          setGroups(content.lists);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) report(String(error));
      });
    return () => controller.abort();
  }, [visible, online, report]);
  useEffect(() => {
    if (!selected || !detailsOpen) return;
    const controller = new AbortController();
    setDetail(undefined);
    setDetailError("");
    setAdded(favorites.includes(selected.ticker));
    const name = "data-detail:two-kinds:" + rowKey(selected);
    void (async () => {
      try {
        const cached = await readSnapshot<any>(profile, name);
        if (controller.signal.aborted) return;
        if (cached) setDetail({ ...cached.value, cachedAt: cached.readAt });
        if (!online) return;
        const current = selected.managed
          ? await loadManaged(selected, controller.signal)
          : selected;
        const identity = seriesIdentity(current.ticker);
        const meta = current.ticker
          ? await api<any>(
              "/market-data/resolve",
              { ...identity, timeframe: current.frames?.[0] || "M1" },
              controller.signal,
            )
          : {};
        let extra: any = {};
        if (
          current.ticker &&
          identity.series_kind === "composite" &&
          meta.created !== false
        )
          extra = await api(
            "/market-data/composites/" +
              encodeURIComponent(identity.instrument),
            undefined,
            controller.signal,
          );
        else if (current.ticker && identity.series_kind === "history")
          extra = await api(
            "/market-data/versions/" + encodeURIComponent(identity.instrument),
            undefined,
            controller.signal,
          );
        const value = {
          ...current,
          ...extra,
          ...meta,
          ticker: current.ticker,
          selection_key: rowKey(selected),
          ...(extra.active_revision_id
            ? { active_revision_id: extra.active_revision_id }
            : {}),
          revision: extra.revision,
          periods: current.managed ? current.periods : extra.periods,
          preparation: extra.preparation,
          mapping: extra.mapping,
        };
        if (controller.signal.aborted) return;
        setDetail(value);
        await writeSnapshot(profile, name, value).catch(() => {});
      } catch (error) {
        if (!controller.signal.aborted) {
          setDetailError(errorMessage(error));
        }
      }
    })();
    return () => controller.abort();
  }, [
    selected && rowKey(selected),
    detailsOpen,
    detailRetry,
    online,
    profile.origin,
    profile.subject,
    report,
  ]);
  async function add(row: Row) {
    if (!online || adding.current) return;
    adding.current = true;
    setBusy(true);
    try {
      row = await actionableRow(row);
      if (!profileActive(profile)) return;
      setPage(
        (current) =>
          current && {
            ...current,
            items: current.items.map((item) =>
              rowKey(item) === rowKey(row) ? row : item,
            ),
          },
      );
      const baseline = watchPreference(
        await api<WatchPreference[]>("/advanced-charts/preferences"),
      );
      if (!profileActive(profile)) return;
      const content = watchContent(baseline);
      if (
        (targetGroup
          ? content.lists.find((list) => list.id === targetGroup)?.symbols || []
          : allSymbols(content)
        ).includes(row.ticker)
      ) {
        setAdded(true);
        return;
      }
      const saved = await saveWatchlists(
        api,
        baseline,
        addSymbol(content, row.ticker, targetGroup),
      );
      if (!profileActive(profile)) return;
      setFavorites(allSymbols(watchContent(saved)));
      setGroups(watchContent(saved).lists);
      setAdded(true);
      await writeSnapshot(profile, "watchlists", saved).catch(() =>
        report("自选已保存，本机快照未更新"),
      );
      dispatchEvent(new Event("mw-mobile-watchlists-changed"));
      report("已加入自选");
    } catch (error) {
      report(String(error));
    } finally {
      adding.current = false;
      setBusy(false);
    }
  }
  const detailTicker =
    detail && selected && detail.selection_key === rowKey(selected)
      ? detail.ticker
      : selected?.managed
        ? ""
        : selected?.ticker;
  useEffect(() => {
    setAdded(
      !!detailTicker &&
        (targetGroup
          ? groups.find((list) => list.id === targetGroup)?.symbols || []
          : favorites
        ).includes(detailTicker),
    );
  }, [detailTicker, targetGroup, groups, favorites]);
  async function openRow(row: Row, fromDetails = false) {
    if (adding.current) return;
    adding.current = true;
    setBusy(true);
    try {
      const current = await actionableRow(row);
      if (!profileActive(profile)) return;
      if (fromDetails) showChart(current.ticker);
      else open(current.ticker);
    } catch (error) {
      report(errorMessage(error));
    } finally {
      adding.current = false;
      setBusy(false);
    }
  }
  async function statuses(title: string, pageNumber = 1) {
    if (!online) {
      report("连接核验后可读取最新任务与来源状态");
      return;
    }
    supportRequest.current?.abort();
    const controller = new AbortController();
    supportRequest.current = controller;
    setSupport({ title, rows: [], page: pageNumber });
    setSupportOpen(true);
    setSupportLoading(true);
    setSupportError("");
    try {
      const params = new URLSearchParams({
        page: String(pageNumber),
        page_size: "20",
        query,
        source,
      });
      if (title === "来源状态") {
        const [capabilities, directory, live] = await Promise.all([
          api<any[]>("/market-data/sources", undefined, controller.signal),
          api<any[]>(
            "/market-data/catalog/directory-status",
            undefined,
            controller.signal,
          ),
          api<any>("/market-data/live/status", undefined, controller.signal),
        ]);
        if (controller.signal.aborted) return;
        setSupport({
          title,
          rows: [
            ...capabilities.map((row) => ({
              ...row,
              id: "capability:" + row.source,
              display_symbol:
                sources.find(([key]) => key === row.source)?.[1] || row.source,
              category: "来源能力",
            })),
            ...(Array.isArray(directory) ? directory : []).map((row) => ({
              ...row,
              id: ["directory", row.source, row.scope, row.partition].join(":"),
              display_symbol:
                sources.find(([key]) => key === row.source)?.[1] || row.source,
              category: "目录同步",
            })),
            {
              ...live.provider,
              id: "live:provider",
              display_symbol: "OANDA · Practice",
              category: "实时配置",
              status:
                live.provider.configured === false
                  ? "来源未配置"
                  : live.provider.authentication_hold
                    ? "鉴权暂停"
                    : live.provider.error
                      ? "来源异常"
                      : live.provider.configured
                        ? "已配置 · 连接以品种状态为准"
                        : "配置状态未提供",
            },
            ...(live.datasets || []).map((row: any) => ({
              ...row,
              id: "live:" + row.dataset_id,
              category: "品种实时状态",
              status: row.authentication_hold
                ? "鉴权暂停"
                : row.market_session === "closed"
                  ? "闭市"
                  : row.connection || "连接待确认",
            })),
          ],
          page: 1,
        });
      } else {
        const value = await api<any>(
          title === "任务记录"
            ? "/market-data/center/tasks?" + params
            : "/market-data/center/datasets?" + params,
          undefined,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setSupport({
          title,
          rows: value.items || [],
          page: pageNumber,
          total: value.total,
        });
      }
    } catch (error) {
      if (!controller.signal.aborted) setSupportError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setSupportLoading(false);
    }
  }
  async function loadVersions(datasetId: string) {
    if (!online) return;
    versionsRequest.current?.abort();
    const controller = new AbortController();
    versionsRequest.current = controller;
    setVersionsOpen(true);
    setVersions(undefined);
    setVersionsLoading(true);
    setVersionsError("");
    try {
      const rows = await api<any[]>(
        "/market-data/versions?dataset_id=" + encodeURIComponent(datasetId),
        undefined,
        controller.signal,
      );
      if (!controller.signal.aborted) setVersions(rows);
    } catch (error) {
      if (!controller.signal.aborted) setVersionsError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setVersionsLoading(false);
    }
  }
  function showChart(ticker: string) {
    afterDetails.current = () => open(ticker);
    setDetailsOpen(false);
  }
  const typeName = marketType;
  const displaySource = (row: Row) =>
    row.source_display ||
    sources.find(([value]) => value === row.source)?.[1] ||
    row.source;
  const panelError = (message: string, retry: () => void) => (
    <Alert variant="destructive" className="data-feedback">
      <Info aria-hidden="true" />
      <AlertTitle>暂时无法读取</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
      <MobileButton variant="outline" onClick={retry}>
        重试读取
      </MobileButton>
    </Alert>
  );
  const listing = (
    <>
      <InputGroup className="watch-search-input data-search-input">
        <InputGroupAddon>
          <Search aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          aria-label="搜索代码或中文"
          placeholder="搜索代码或中文名称"
          value={query}
          maxLength={100}
          onChange={(event) => {
            setQuery(event.target.value);
            setPages([{ offset: 0 }]);
          }}
        />
      </InputGroup>
      {searchMode ? (
        <ToggleGroup
          className="mobile-source-filters"
          aria-label="搜索来源"
          value={[source || "all"]}
          onValueChange={(values) => {
            if (values.length) {
              setSource(values[0] === "all" ? "" : String(values[0]));
              setPages([{ offset: 0 }]);
            }
          }}
        >
          {sources.map(([value, title]) => (
            <ToggleGroupItem key={value} value={value || "all"}>
              {value ? title : "全部"}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : (
        <div className="mobile-source-bar data-source-bar">
          <MobileSelect
            label="来源"
            value={source || "all"}
            onChange={(value) => {
              setSource(value === "all" ? "" : value);
              setPages([{ offset: 0 }]);
            }}
            items={sources.map(([value, label]) => ({
              value: value || "all",
              label,
            }))}
          />
          <span className="data-catalog-note">
            {kind === "native" ? "原生目录" : "历史与实时接续"}
          </span>
        </div>
      )}
      {readAt && (
        <Alert className="data-feedback" role="status">
          <Info aria-hidden="true" />
          <AlertTitle>当前显示上次读取</AlertTitle>
          <AlertDescription>
            {dateTime(readAt)} · 连接恢复后核验最新状态
          </AlertDescription>
        </Alert>
      )}
      {loading && !loaded && <MobileLoading label="正在读取目录…" />}
      {loading && loaded && (
        <p className="mobile-rows-note" role="status">
          正在更新目录…
        </p>
      )}
      {error &&
        loaded &&
        panelError(error, () => setRetry((value) => value + 1))}
      {!loading && !loaded && (
        <MobileEmpty
          offline={!online}
          title={online ? "目录暂时无法读取" : "暂无本地数据"}
          action={
            <MobileButton
              variant="outline"
              disabled={!online}
              onClick={() => setRetry((value) => value + 1)}
            >
              重新读取
            </MobileButton>
          }
        >
          {online ? error || "请稍后重试。" : "连接恢复后自动读取。"}
        </MobileEmpty>
      )}
      {loaded && !page?.items.length && (
        <MobileEmpty title="没有符合条件的行情">
          尝试其他代码、中文名称或来源。
        </MobileEmpty>
      )}
      <div className="data-series-list">
        {page?.items.map((row) =>
          searchMode ? (
            <div className="mobile-search-row" key={rowKey(row)}>
              <div className="mobile-search-info">
                <strong>
                  {row.display_symbol || row.symbol || row.ticker}
                </strong>
                {(row.instrument_name || row.description) && (
                  <span className="mobile-search-name">
                    {row.instrument_name || row.description}
                  </span>
                )}
                <small>
                  {typeName(row)} · {displaySource(row)}
                  {row.continuation?.enabled &&
                    ` · 实时接续${continuationLabel(row.continuation.status)}`}
                  <span className="watch-search-frames">
                    {row.frames?.join(" / ") || "周期见详情"}
                  </span>
                </small>
              </div>
              <div className="watch-search-actions">
                <MobileButton
                  variant="secondary"
                  className="mobile-search-add"
                  disabled={
                    !online ||
                    busy ||
                    (targetGroup
                      ? groups.find((group) => group.id === targetGroup)
                          ?.symbols || []
                      : favorites
                    ).includes(row.ticker)
                  }
                  onClick={() => void add(row)}
                >
                  {(targetGroup
                    ? groups.find((group) => group.id === targetGroup)
                        ?.symbols || []
                    : favorites
                  ).includes(row.ticker) ? (
                    <>
                      <Check data-icon="inline-start" aria-hidden="true" />
                      已添加
                    </>
                  ) : (
                    <>
                      <Plus data-icon="inline-start" aria-hidden="true" />
                      {targetGroup ? "分组" : "自选"}
                    </>
                  )}
                </MobileButton>
                <MobileButton
                  variant="ghost"
                  className="mobile-link-button"
                  onClick={() => {
                    setSelected(row);
                    setDetailsOpen(true);
                  }}
                >
                  详情
                </MobileButton>
                <MobileButton
                  variant="ghost"
                  className="mobile-link-button"
                  disabled={!online || busy}
                  onClick={() => void openRow(row)}
                >
                  开图
                </MobileButton>
              </div>
            </div>
          ) : (
            <MobileButton
              variant="plain"
              className="mobile-series data-series"
              key={rowKey(row)}
              onClick={() => {
                setSelected(row);
                setDetailsOpen(true);
              }}
            >
              <span className="data-series-top">
                <strong>
                  {row.display_symbol || row.symbol || row.ticker}
                </strong>
                {!row.continuation?.enabled &&
                  favorites.includes(row.ticker) && (
                    <Badge variant="secondary">
                      <Check aria-hidden="true" />
                      已关注
                    </Badge>
                  )}
                <ChevronRight aria-hidden="true" />
              </span>
              {(row.instrument_name || row.description) && (
                <span className="data-series-name">
                  {row.instrument_name || row.description}
                </span>
              )}
              <span className="data-series-meta">
                <span>{displaySource(row) || typeName(row)}</span>
                <span>
                  {row.frames?.length ? row.frames.join(" · ") : "周期见详情"}
                </span>
              </span>
              {row.continuation && (
                <span className="data-series-range">
                  实时接续 · {continuationLabel(row.continuation.status)}
                </span>
              )}
              {kind === "managed" && row.latest_at && (
                <span className="data-series-range">
                  数据至 {dateTime(row.latest_at)}
                </span>
              )}
            </MobileButton>
          ),
        )}
      </div>
      <nav
        className="mobile-inline-actions data-pagination"
        aria-label="行情分页"
      >
        <MobileButton
          variant="outline"
          disabled={loading || pages.length < 2}
          onClick={() => setPages((value) => value.slice(0, -1))}
        >
          上一页
        </MobileButton>
        <span>第 {pages.length} 页</span>
        <MobileButton
          variant="outline"
          disabled={
            loading || !page || (!page.next_cursor && page.next_offset == null)
          }
          onClick={() =>
            setPages((value) => [
              ...value,
              {
                offset: page?.next_offset || position.offset + 25,
                ...(page?.next_cursor ? { cursor: page.next_cursor } : {}),
              },
            ])
          }
        >
          下一页
        </MobileButton>
      </nav>
      {!searchMode && (
        <p className="data-footnote">
          {kind === "native"
            ? "目录可查询，不代表历史行情已全部下载。"
            : "创建、维护和实时接续配置请在桌面完成。"}
        </p>
      )}
    </>
  );
  return (
    <section
      hidden={!visible}
      className={
        searchMode
          ? "mobile-search-content mobile-data-surface"
          : "mobile-data-body mobile-data-surface"
      }
    >
      {!searchMode && (
        <header className="mobile-title data-title">
          <div>
            <h1>数据</h1>
            <small>查找行情，查看数据与来源</small>
          </div>
          <MobileButton
            variant="ghost"
            size="icon"
            aria-label="任务与来源"
            aria-haspopup="dialog"
            aria-expanded={toolsOpen}
            onClick={() => setToolsOpen(true)}
          >
            <SlidersHorizontal aria-hidden="true" />
          </MobileButton>
        </header>
      )}
      <Tabs
        value={kind}
        className="data-kind-tabs"
        onValueChange={(value) => {
          setKind(String(value));
          setPages([{ offset: 0 }]);
        }}
      >
        <TabsList aria-label="行情类型">
          <TabsTrigger value="native">原生</TabsTrigger>
          <TabsTrigger value="managed">自建</TabsTrigger>
        </TabsList>
        <TabsContent key={kind} value={kind}>
          {listing}
        </TabsContent>
      </Tabs>
      <MobileSheet
        title="任务与来源"
        open={toolsOpen}
        close={() => setToolsOpen(false)}
        onClosed={() => {
          const next = afterTools.current;
          afterTools.current = undefined;
          next?.();
        }}
      >
        <div className="data-tools">
          {[
            {
              title: "任务记录",
              description: "查看数据准备与同步进度",
              icon: ListTodo,
            },
            {
              title: "来源状态",
              description: "来源能力、目录与实时连接",
              icon: Radio,
            },
            ...(kind === "managed"
              ? [
                  {
                    title: "自建维护",
                    description: "查看维护配置与最近执行",
                    icon: Database,
                  },
                ]
              : []),
          ].map(({ title, description, icon: Icon }) => (
            <MobileButton
              variant="ghost"
              aria-label={title}
              key={title}
              onClick={() => {
                afterTools.current = () => void statuses(title);
                setToolsOpen(false);
              }}
            >
              <span className="data-tool-icon">
                <Icon aria-hidden="true" />
              </span>
              <span>
                <strong>{title}</strong>
                <small>{description}</small>
              </span>
              <ChevronRight aria-hidden="true" />
            </MobileButton>
          ))}
        </div>
      </MobileSheet>
      {selected && (
        <MobileSheet
          title="行情详情"
          open={detailsOpen}
          dismissible={!busy}
          close={() => setDetailsOpen(false)}
          onClosed={() => {
            setSelected(undefined);
            const next = afterDetails.current;
            afterDetails.current = undefined;
            next?.();
          }}
        >
          <div className="data-details">
            <div className="data-detail-heading">
              <h3>
                {selected.display_symbol || selected.symbol || selected.ticker}
              </h3>
              <Badge variant="secondary">{typeName(selected)}</Badge>
            </div>
            <p className="data-detail-name">
              {selected.instrument_name ||
                selected.description ||
                displaySource(selected)}
            </p>
            {detail?.cachedAt && (
              <Alert className="data-feedback" role="status">
                <AlertTitle>上次读取的详情</AlertTitle>
                <AlertDescription>
                  {dateTime(detail.cachedAt)} · 当前待确认
                </AlertDescription>
              </Alert>
            )}
            {detailError &&
              panelError(detailError, () => {
                setDetailRetry((v) => v + 1);
              })}
            {!detail &&
              !detailError &&
              (online ? (
                <MobileLoading label="正在读取详情…" rows={2} />
              ) : (
                <MobileEmpty offline title="没有详情缓存">
                  连接恢复后自动读取。
                </MobileEmpty>
              ))}
            {detail && (
              <>
                <dl className="mobile-facts data-facts">
                  {[
                    [
                      "来源",
                      displaySource({
                        ticker: selected.ticker,
                        source_display: detail.source_display,
                        source: detail.historical_source || detail.source,
                      }) || displaySource(selected),
                    ],
                    [
                      "数据状态",
                      detail.cachedAt
                        ? "上次读取 · 当前待确认"
                        : selected.ticker.startsWith("MWP:")
                          ? "目录可查询"
                          : statusLabel(
                              detail.status ||
                                detail.preparation_status ||
                                detail.availability,
                            ),
                    ],
                    [
                      "价格口径",
                      detail.price_basis_display ||
                        (
                          {
                            bid: "买价",
                            ask: "卖价",
                            mid: "中间价",
                            last: "成交价",
                          } as Record<string, string>
                        )[detail.basis] ||
                        detail.basis,
                    ],
                    [
                      "历史区间",
                      (detail.start ?? detail.revision?.history_start) != null
                        ? `${dateTime(detail.start ?? detail.revision.history_start)} — ${dateTime(detail.end ?? detail.revision.history_end)}`
                        : undefined,
                    ],
                    [
                      "实时接续",
                      (detail.continuation
                        ? continuationLabel(detail.continuation.status)
                        : "") ||
                        detail.realtime_source_display ||
                        detail.mapping?.source_display ||
                        detail.live_source,
                    ],
                    [
                      "接续来源",
                      detail.live_source_display ||
                        detail.mapping?.source_display,
                    ],
                    [
                      "拼接点",
                      detail.revision?.seam
                        ? dateTime(detail.revision.seam)
                        : undefined,
                    ],
                  ]
                    .filter(([, value]) => value)
                    .map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                </dl>
                <h4>可用周期</h4>
                <div className="mobile-chip-list data-periods">
                  {(detail.frames || detail.timeframes || [])
                    .filter((frame: any) => typeof frame === "string")
                    .map((frame: string) => (
                      <Badge variant="outline" key={frame}>
                        {frame}
                      </Badge>
                    ))}
                </div>
                {!(detail.frames || detail.timeframes || []).length && (
                  <p className="mobile-rows-note">暂无已确认周期</p>
                )}
                {detail.selectionError && (
                  <p className="mobile-rows-note" role="status">
                    {detail.selectionError}
                  </p>
                )}
                {detail.periods?.map((period: any) => (
                  <p className="data-period-status" key={period.timeframe}>
                    {period.timeframe} · {statusLabel(period.status)} ·{" "}
                    {period.rows ?? period.available_rows ?? "未知"} 根
                  </p>
                ))}
                <Collapsible className="data-identity">
                  <CollapsibleTrigger render={<MobileButton variant="ghost" />}>
                    <span>数据身份与修订</span>
                    <ChevronRight aria-hidden="true" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="watch-collapse-panel">
                    <dl className="mobile-facts data-facts">
                      {[
                        ["系列标识", detailTicker],
                        ["系列类型", typeName(selected)],
                        [
                          "当前修订",
                          detail.active_revision_id || detail.revision_id,
                        ],
                        [
                          "固定版本",
                          detail.history_version_id ||
                            detail.revision?.history_version_id ||
                            (selected.ticker.startsWith("MWH:")
                              ? detail.id
                              : undefined),
                        ],
                      ]
                        .filter(([, value]) => value)
                        .map(([label, value]) => (
                          <div key={label}>
                            <dt>{label}</dt>
                            <dd>{value}</dd>
                          </div>
                        ))}
                    </dl>
                  </CollapsibleContent>
                </Collapsible>
                {(detail.dataset_id || selected.dataset_id) && (
                  <div className="data-related-actions">
                    {detail.dataset_id && (
                      <MobileButton
                        variant="outline"
                        disabled={!online || versionsLoading}
                        onClick={() => void loadVersions(detail.dataset_id)}
                      >
                        固定历史版本
                      </MobileButton>
                    )}
                    {selected.dataset_id && (
                      <MobileButton
                        variant="ghost"
                        disabled={!online}
                        onClick={() => void statuses("自建维护")}
                      >
                        查看维护状态
                      </MobileButton>
                    )}
                  </div>
                )}
                <p className="data-footnote">
                  目录存在不代表历史已完整获取。来源配置、历史维护与实时接续配置请在桌面完成。
                </p>
              </>
            )}
            <div className="mobile-sheet-actions watch-detail-actions data-detail-actions">
              <FieldGroup>
                <Field orientation="horizontal" className="watch-target-group">
                  <FieldLabel>添加到分组</FieldLabel>
                  <WatchGroupSelect
                    value={targetGroup}
                    onChange={setTargetGroup}
                    groups={groups}
                    disabled={busy}
                  />
                </Field>
              </FieldGroup>
              <div className="watch-detail-buttons">
                <MobileButton
                  variant="outline"
                  disabled={
                    !online ||
                    busy ||
                    added ||
                    (selected.managed &&
                      (!detailTicker || !!detail?.cachedAt || !!detailError))
                  }
                  onClick={() => void add(selected)}
                >
                  {added ? "已添加" : busy ? "正在添加…" : "加入自选"}
                </MobileButton>
                <MobileButton
                  variant="default"
                  className="primary"
                  disabled={
                    busy ||
                    (selected.managed &&
                      (!online ||
                        !detailTicker ||
                        !!detail?.cachedAt ||
                        !!detailError))
                  }
                  onClick={() => void openRow(selected, true)}
                >
                  打开图表
                </MobileButton>
              </div>
            </div>
          </div>
        </MobileSheet>
      )}
      <MobileSheet
        title="固定历史版本"
        open={versionsOpen}
        close={() => {
          versionsRequest.current?.abort();
          setVersionsOpen(false);
        }}
        onClosed={() => {
          setVersions(undefined);
          setVersionsLoading(false);
          setVersionsError("");
          const next = afterVersions.current;
          afterVersions.current = undefined;
          next?.();
        }}
      >
        <div className="data-panel">
          {versionsLoading && (
            <MobileLoading label="正在读取固定版本…" rows={2} />
          )}
          {versionsError &&
            panelError(
              versionsError,
              () => void loadVersions(detail?.dataset_id),
            )}
          {!versionsLoading &&
            !versionsError &&
            versions &&
            !versions.length && (
              <MobileEmpty title="暂无固定历史版本">
                发布后的可用版本将在这里显示。
              </MobileEmpty>
            )}
          {versions?.map((version) => (
            <Card className="data-status-card" key={version.id}>
              <CardHeader>
                <CardTitle>
                  版本 {version.id.slice(0, 8)}…{version.id.slice(-6)}
                </CardTitle>
                <CardDescription>
                  {dateTime(version.start)} — {dateTime(version.end)}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Badge variant="secondary">{statusLabel(version.status)}</Badge>
                <Collapsible className="data-version-identity">
                  <CollapsibleTrigger render={<MobileButton variant="ghost" />}>
                    完整版本标识
                    <ChevronRight aria-hidden="true" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="watch-collapse-panel">
                    <p>{version.id}</p>
                  </CollapsibleContent>
                </Collapsible>
                {version.payload_available === false && <p>版本数据暂不可用</p>}
              </CardContent>
              <CardFooter>
                <MobileButton
                  variant="outline"
                  disabled={
                    version.status !== "published" ||
                    version.payload_available === false
                  }
                  onClick={() => {
                    afterVersions.current = () =>
                      showChart("MWH:" + version.id);
                    setVersionsOpen(false);
                  }}
                >
                  打开此固定版本
                </MobileButton>
              </CardFooter>
            </Card>
          ))}
        </div>
      </MobileSheet>
      <MobileSheet
        title={support?.title || "任务与来源"}
        open={supportOpen}
        close={() => {
          supportRequest.current?.abort();
          setSupportOpen(false);
        }}
        onClosed={() => {
          setSupport(undefined);
          setSupportLoading(false);
          setSupportError("");
        }}
      >
        <div className="data-panel">
          <p className="data-footnote">
            {support?.title === "来源状态"
              ? "来源能力、目录同步与实时连接分别展示。目录已缓存不代表实时行情可用。"
              : "手机查看维护信息；创建、编辑、补齐与重构请在桌面完成。"}
          </p>
          {supportLoading && <MobileLoading label="正在读取状态…" rows={2} />}
          {supportError &&
            panelError(
              supportError,
              () => void statuses(support!.title, support!.page),
            )}
          {!supportLoading && !supportError && !support?.rows.length && (
            <MobileEmpty title="本页暂无记录">
              当前筛选下没有可展示的记录。
            </MobileEmpty>
          )}
          {support?.rows.map((row, index) => (
            <Card className="data-status-card" key={row.id || index}>
              <CardHeader>
                <CardTitle>
                  {row.display_symbol ||
                    row.logical_symbol ||
                    row.instrument_id ||
                    row.dataset_id ||
                    row.id ||
                    "状态记录"}
                </CardTitle>
                <CardDescription>
                  {[
                    row.category,
                    sources.find(
                      ([key]) => key === (row.identity?.source || row.source),
                    )?.[1] ||
                      row.source_display ||
                      row.identity?.source ||
                      row.source,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Badge variant="secondary">
                  {statusLabel(
                    row.status ||
                      row.native_status ||
                      row.task_status ||
                      row.availability,
                  )}
                </Badge>
                {(row.timeframes || row.native_periods) && (
                  <p>
                    支持周期{" "}
                    {Array.isArray(row.timeframes || row.native_periods)
                      ? (row.timeframes || row.native_periods).join(" · ")
                      : "按来源能力"}
                  </p>
                )}
                {row.category === "目录同步" && (
                  <p>
                    {row.partition || row.scope || "目录"} · {row.count ?? 0} 项
                    {row.last_success
                      ? ` · 最近成功 ${dateTime(row.last_success)}`
                      : " · 暂无成功记录"}
                  </p>
                )}
                {row.category === "品种实时状态" && (
                  <p>
                    {row.observation_mode === "candle_close_sample"
                      ? "K 线采样"
                      : "实时报价"}
                    {(
                      row.observation_mode === "candle_close_sample"
                        ? row.sample_ready
                        : row.quote_ready
                    )
                      ? "已就绪"
                      : "未就绪"}
                    {" · 完成 K 线"}
                    {row.candle_ready ? "已就绪" : "未就绪"}
                  </p>
                )}
                {row.maintenance && (
                  <p>
                    维护
                    {row.maintenance.paused
                      ? "已暂停"
                      : row.maintenance.configured
                        ? "已配置"
                        : "未配置"}
                    {row.maintenance.last_success
                      ? ` · 最近成功 ${dateTime(row.maintenance.last_success)}`
                      : ""}
                  </p>
                )}
                {(row.reason || row.connection_error || row.error) && (
                  <p>{row.reason || row.connection_error || row.error}</p>
                )}
              </CardContent>
            </Card>
          ))}
          {support && support.title !== "来源状态" && (
            <nav
              className="mobile-inline-actions data-pagination"
              aria-label="状态分页"
            >
              <MobileButton
                variant="outline"
                disabled={supportLoading || support.page === 1}
                onClick={() => void statuses(support.title, support.page - 1)}
              >
                上一页
              </MobileButton>
              <span>第 {support.page} 页</span>
              <MobileButton
                variant="outline"
                disabled={
                  supportLoading ||
                  support.rows.length < 20 ||
                  (support.total != null && support.page * 20 >= support.total)
                }
                onClick={() => void statuses(support.title, support.page + 1)}
              >
                下一页
              </MobileButton>
            </nav>
          )}
        </div>
      </MobileSheet>
    </section>
  );
}
