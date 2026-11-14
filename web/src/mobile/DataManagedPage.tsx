import SymbolInfo from "./SymbolInfo";
import { SymbolSearchButton } from "./SymbolSearch";
import { useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  Search,
  SlidersHorizontal,
  Database,
  Radio,
  RefreshCw,
} from "lucide-react";
import { api } from "../api";
import type { Dataset, Task } from "../market-data/types";
import type { Continuation } from "../market-data/DatasetContinuation";
import { profileActive, writeSnapshot, type Profile } from "./cache";
import {
  actionableRow,
  continuationLabel,
  datasetRow,
  managedCode,
} from "./dataMarkets";
import {
  addSymbol,
  allSymbols,
  saveWatchlists,
  watchContent,
  watchPreference,
  type WatchList,
  type WatchPreference,
} from "./watchlists";
import { MobileConfirm } from "./WatchOverlays";
import MobileSheet from "./MobileSheet";
import WatchGroupSelect from "./WatchGroupSelect";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { FieldGroup } from "./components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "./components/ui/input-group";
import { DataEmpty, DataLoading } from "./DataStates";
import { DataFeedback, DataMore, DataSelect } from "./DataFormParts";
import {
  dataSources,
  dataRequest,
  dataTime,
  sourceName,
  taskName,
  useDataCommand,
  useDataRead,
} from "./dataOperations";
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
type SummaryPage = {
  items: Dataset[];
  total: number;
  anchor_position?: number | null;
};
export default function DataManagedPage(props: Props) {
  const { profile, online, visible } = props;
  const [query, setQuery] = useState(""),
    [source, setSource] = useState("all"),
    [status, setStatus] = useState("all"),
    [page, setPage] = useState(1);
  const [filters, setFilters] = useState(false),
    [catalog, setCatalog] = useState(false),
    [catalogMounted, setCatalogMounted] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
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
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  const active = visible && onlineView;
  const params = new URLSearchParams({
    query,
    source: source === "all" ? "" : source,
    status,
    page: String(page),
    page_size: "25",
    ...(anchor ? { anchor: "dataset-" + anchor } : {}),
  });
  const result = useDataRead<SummaryPage>(
    profile,
    "/market-data/center/dataset-summaries?" + params,
    active,
    online,
    refreshRate,
  );
  useEffect(() => {
    setRefreshRate(
      result.data?.items.some((item) => item.maintenance.active_version_id)
        ? 5000
        : 15000,
    );
  }, [result.data]);
  useEffect(() => {
    if (!anchor || !result.data) return;
    if (result.data.anchor_position) {
      const target = Math.ceil(result.data.anchor_position / 25);
      if (target !== page) {
        setPage(target);
        return;
      }
      requestAnimationFrame(() =>
        document
          .getElementById("managed-" + anchor)
          ?.scrollIntoView({ block: "center", behavior: "smooth" }),
      );
    }
    setAnchor("");
  }, [anchor, result.data, page]);
  function pick(id: string) {
    setSelected(id);
    setDetailsOpen(true);
  }
  function created(id: string, isNew = true, archived = false) {
    next.current = () => {
      setQuery("");
      setSource("all");
      setStatus(archived ? "archived" : "all");
      setPage(1);
      setAnchor(id);
      result.refresh();
      setNotice(
        isNew ? "自建行情已创建，历史正在后台准备" : "已定位已有自建行情",
      );
    };
    setCatalog(false);
  }
  function changed() {
    result.refresh();
    dispatchEvent(new Event("mw-mobile-data-changed"));
  }
  return (
    <div className="mobile-data-body mobile-data-surface data-managed">
      <header className="mobile-title data-title">
        <h1>数据</h1>
        <SymbolSearchButton
          label="搜索并添加行情"
          expanded={catalog}
          onClick={() => {
            setCatalogMounted(true);
            setCatalog(true);
          }}
        />
      </header>
      <div className="data-list-filter">
        <InputGroup className="data-search-input">
          <InputGroupAddon>
            <Search aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            aria-label="筛选自建行情"
            placeholder="筛选自建行情"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
          />
        </InputGroup>
        <Button
          variant="ghost"
          size="icon"
          aria-label="筛选与数据工具"
          onClick={() => setFilters(true)}
        >
          <SlidersHorizontal aria-hidden="true" />
        </Button>
      </div>
      <div className="data-list-caption">
        <span>
          {status === "archived" ? "已归档" : "自建行情"}
          {result.data ? ` · ${result.data.total}` : ""}
        </span>
        {(source !== "all" || status !== "all") && (
          <Button
            variant="ghost"
            onClick={() => {
              setSource("all");
              setStatus("all");
              setPage(1);
            }}
          >
            清除筛选
          </Button>
        )}
      </div>
      <DataFeedback
        error={result.error}
        notice={
          result.readAt
            ? `上次读取 ${dataTime(result.readAt)} · 当前状态待核实`
            : notice || undefined
        }
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
            query || source !== "all" || status !== "all"
              ? "没有符合条件的自建行情"
              : "还没有自建行情"
          }
          action={
            query || source !== "all" || status !== "all" ? (
              <Button
                variant="outline"
                onClick={() => {
                  setQuery("");
                  setSource("all");
                  setStatus("all");
                  setPage(1);
                }}
              >
                清除筛选
              </Button>
            ) : (
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
          从原生目录选择品种，准备自己的历史数据。
        </DataEmpty>
      )}
      <div className="data-series-list">
        {result.data?.items.map((dataset) => {
          const plan = dataset.maintenance;
          const label = plan.task_error
            ? "更新需处理"
            : plan.task_status &&
                (plan.active_version_id || plan.task_status === "partial")
              ? taskName(plan.task_status)
              : plan.paused
                ? "维护已暂停"
                : dataset.continuation?.enabled
                  ? `实时${continuationLabel(dataset.continuation.status)}`
                  : dataset.availability === "available"
                    ? "历史可用"
                    : "待准备";
          return (
            <Button
              variant="plain"
              className="data-managed-row"
              id={"managed-" + dataset.id}
              key={dataset.id}
              onClick={() => pick(dataset.id)}
            >
              <span className="data-managed-identity">
                <SymbolInfo
                  code={managedCode(dataset)}
                  name={dataset.instrument_name || ""}
                  source={dataset.source_display || dataset.identity.source}
                  custom
                />
                {result.data!.items.filter(
                  (other) =>
                    managedCode(other) === managedCode(dataset) &&
                    other.identity.source === dataset.identity.source,
                ).length > 1 && (
                  <small className="symbol-configuration">
                    {[
                      dataset.identity.mode === "base_d1"
                        ? "D1派生"
                        : dataset.identity.mode === "native_periods"
                          ? "原生多周期"
                          : "M1派生",
                      dataset.aggregation_calendar,
                      dataset.identity.basis,
                      dataset.identity.adjustment !== "none"
                        ? dataset.identity.adjustment
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                )}
              </span>
              <span className="data-managed-status">
                <Badge variant="secondary">{label}</Badge>
                <small>
                  {dataset.available_end
                    ? `数据至 ${dataTime(dataset.available_end)}`
                    : "尚无已发布历史"}
                </small>
              </span>
              <ChevronRight aria-hidden="true" />
            </Button>
          );
        })}
      </div>
      {!!result.data?.total && result.data.total > 25 && (
        <div className="data-pager">
          <Button
            variant="ghost"
            disabled={page === 1 || result.loading}
            onClick={() => setPage((n) => n - 1)}
          >
            上一页
          </Button>
          <span>第 {page} 页</span>
          <Button
            variant="ghost"
            disabled={page * 25 >= result.data.total || result.loading}
            onClick={() => setPage((n) => n + 1)}
          >
            下一页
          </Button>
        </div>
      )}
      <MobileSheet
        title="筛选与工具"
        open={filters}
        close={() => setFilters(false)}
        onClosed={() => {
          const action = next.current;
          next.current = undefined;
          action?.();
        }}
      >
        <FieldGroup>
          <DataSelect
            label="来源"
            value={source}
            items={dataSources}
            onChange={(v) => {
              setSource(v);
              setPage(1);
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
              setPage(1);
            }}
          />
          <Button
            variant="outline"
            onClick={() => {
              next.current = () => {
                setToolsMounted(true);
                setTools(true);
              };
              setFilters(false);
            }}
          >
            <Radio data-icon="inline-start" aria-hidden="true" />
            任务与来源
          </Button>
        </FieldGroup>
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

function ManagedDetails({
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
  const [group, setGroup] = useState(""),
    [groups, setGroups] = useState<WatchList[]>([]),
    [added, setAdded] = useState(false);
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
          setGroups(watchContent(watchPreference(rows)).lists);
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
      const baseline = watchPreference(
        await dataRequest<WatchPreference[]>(
          profile,
          "/advanced-charts/preferences",
        ),
      );
      if (!profileActive(profile)) return;
      const content = watchContent(baseline),
        symbols = group
          ? content.lists.find((item) => item.id === group)?.symbols || []
          : allSymbols(content);
      if (!symbols.includes(row.ticker)) {
        const saved = await saveWatchlists(
          (path, body, signal) => dataRequest(profile, path, body, signal),
          baseline,
          addSymbol(content, row.ticker, group),
        );
        if (!profileActive(profile)) return;
        await writeSnapshot(profile, "watchlists", saved).catch(() => {});
        setGroups(watchContent(saved).lists);
        dispatchEvent(new Event("mw-mobile-watchlists-changed"));
      }
      setAdded(true);
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
        <div className="data-workflow-form">
          {result.loading && !dataset && <DataLoading label="正在读取行情…" />}
          <DataFeedback
            error={result.error || live.error || command.error}
            notice={
              command.notice ||
              (result.readAt ? "当前为上次读取，等待联网核验" : undefined)
            }
          />
          {(result.error || live.error) && (
            <Button variant="outline" onClick={refresh}>
              重新读取
            </Button>
          )}
          {dataset && (
            <>
              <div className="data-selection">
                <strong>{managedCode(dataset)}</strong>
                <span>
                  {dataset.instrument_name} ·{" "}
                  {dataset.source_display ||
                    sourceName(dataset.identity.source)}
                </span>
              </div>
              <section className="data-detail-section">
                <h3>
                  <Database aria-hidden="true" />
                  历史数据
                </h3>
                <dl className="mobile-facts data-facts">
                  <div>
                    <dt>可用范围</dt>
                    <dd>
                      {dataTime(dataset.available_start)} —{" "}
                      {dataTime(dataset.available_end)}
                    </dd>
                  </div>
                  <div>
                    <dt>可用周期</dt>
                    <dd>{dataset.usable_timeframes.join(" · ") || "准备中"}</dd>
                  </div>
                  <div>
                    <dt>定时维护</dt>
                    <dd>
                      {dataset.maintenance.archived
                        ? "已归档"
                        : dataset.maintenance.paused
                          ? "已暂停"
                          : dataset.maintenance.frequency === "daily"
                            ? "每日更新"
                            : "一次性"}
                    </dd>
                  </div>
                  {!!dataset.maintenance.last_success && (
                    <div>
                      <dt>最近成功</dt>
                      <dd>{dataTime(dataset.maintenance.last_success)}</dd>
                    </div>
                  )}
                  {dataset.maintenance.task_status && (
                    <div>
                      <dt>当前任务</dt>
                      <dd>{taskName(dataset.maintenance.task_status)}</dd>
                    </div>
                  )}
                </dl>
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
              <section className="data-detail-section">
                <h3>
                  <Radio aria-hidden="true" />
                  实时行情
                </h3>
                <p>
                  {live.data?.enabled
                    ? `已开启 · ${continuationLabel(live.data.status)}`
                    : "未开启"}
                </p>
                {live.data?.reason && (
                  <p className="data-caption">{live.data.reason}</p>
                )}
                {live.data?.baseline_seam != null && (
                  <p className="data-caption">
                    基线至 {dataTime(live.data.baseline_seam)}
                  </p>
                )}
                {live.data?.rollover &&
                  ["preparing", "ready", "deferred", "updated"].includes(
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
                {live.data?.rollover?.warning && (
                  <p className="data-caption" role="status">
                    {live.data.rollover.warning}
                  </p>
                )}
                {live.data && (
                  <Button
                    variant={live.data.enabled ? "outline" : "secondary"}
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
              </section>
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
              <FieldGroup>
                <WatchGroupSelect
                  value={group}
                  onChange={(value) => {
                    setGroup(value);
                    setAdded(false);
                  }}
                  groups={groups}
                  disabled={locked}
                />
              </FieldGroup>
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
        <DataMore title="来源能力与目录">
          {sources.data?.map((source) => (
            <div className="data-task-card" key={source.source}>
              <strong>{sourceName(source.source)}</strong>
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
