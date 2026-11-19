import { useContext } from "react";
import { EventChartNavigation } from "./alertChartTarget";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { api, ApiError, errorMessage } from "../api";
import {
  Plus,
  Search,
  ChevronRight,
  Archive,
  Activity,
  X,
} from "lucide-react";
import { useAlertData } from "../advanced/useAlertData";
import { alertCode } from "../advanced/alertPresentation";
import type { AlertConfig, AlertRow } from "../advanced/chartAlerts";
import type { NoticeRuntime } from "../notifications/runtime";
import { editableRule, newPriceConfig, uncertainError } from "./alerts";
import {
  monitorState,
  ruleState,
  ruleProgress,
  ruleIdentity,
  expiredRule,
} from "./alertView";
import { readRuleSpan } from "./alertRules";
import { seriesIdentity } from "./market";
import { readSnapshot, writeSnapshot, type Profile } from "./cache";
import { logEvent, logFailure } from "./logs";
import { ManagedDetails } from "./DataManagedPage";
import type { MarketRow } from "./dataMarkets";
import MobileSheet from "./MobileSheet";
import { MobileOverlaysProvider, MobileConfirm } from "./WatchOverlays";
import PriceRuleSheet from "./PriceRuleSheet";
import RecordsSheet from "./RecordsSheet";
import AlertRecords from "./AlertRecords";
import AlertListRefresh from "./AlertListRefresh";
import AlertSymbolPicker from "./AlertSymbolPicker";
import DataCatalogSheet from "./DataCatalogSheet";
import SymbolInfo from "./SymbolInfo";
import { stamp } from "./alertTime";
import { Button } from "./components/ui/button";
import { HeaderIconButton } from "./components/HeaderIconButton";
import { Badge } from "./components/ui/badge";
import { Switch } from "./components/ui/switch";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  TabsPanels,
} from "./components/ui/tabs";
import { FieldGroup } from "./components/ui/field";
import { DataInput, DataSelect, DataMore } from "./DataFormParts";
import { DataEmpty, DataLoading } from "./DataStates";

type Props = {
  profile: Profile;
  online: boolean;
  visible: boolean;
  symbol: string;
  createToken: number;
  runtime: NoticeRuntime;
  records: boolean;
  closeRecords(): void;
  showRecords(): void;
  report(message: string): void;
  openChart?(ticker: string, timeframe?: string): void;
};
type Editor = {
  config: AlertConfig;
  row?: AlertRow;
  frames: string[];
  label: string;
  source?: string;
  name?: string;
  dataset?: string;
};
export default function AlertsPage({
  profile,
  online,
  visible,
  symbol,
  createToken,
  runtime,
  records,
  closeRecords,
  showRecords,
  report,
  openChart,
}: Props) {
  const eventChart=useContext(EventChartNavigation);
  const eventSuspended=useRef(false);eventSuspended.current=eventChart.suspended;
  const location = useLocation();
  const entry = new URLSearchParams(location.search);
  const notificationEntry = /^n_[a-f0-9]{32}$/.test(entry.get("signal") || "")
    ? entry.get("signal")!.slice(2).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5")
    : undefined;
  const signalEntry = notificationEntry ? undefined : entry.get("signal") || undefined;
  const recordEntry = entry.get("records");
  const [cached, setCached] = useState<AlertRow[]>([]),
    [readAt, setReadAt] = useState<number>(),
    [loaded, setLoaded] = useState(false);
  const [health, setHealth] = useState<any>(),
    [healthAt, setHealthAt] = useState(0);
  const [clockNow, setClockNow] = useState(Date.now);
  const [tab, setTab] = useState("rules"),
    [filter, setFilter] = useState("current"),
    [query, setQuery] = useState("");
  useEffect(() => {
    if (!visible) return;
    if (signalEntry) setTab("records");
    else if (notificationEntry || recordEntry === "alerts" || recordEntry === "system") showRecords();
  }, [visible, location.key]);
  const [filtersOpen, setFiltersOpen] = useState(false),
    [archived, setArchived] = useState<AlertRow[]>([]),
    [archiveError, setArchiveError] = useState("");
  const [selection, setSelected] = useState<AlertRow>(),
    [detailOpen, setDetailOpen] = useState(false),
    [judgments, setJudgments] = useState<any[]>([]);
  const [editor, setEditor] = useState<Editor>(),
    [editorOpen, setEditorOpen] = useState(false);
  const [pickerMounted, setPickerMounted] = useState(false),
    [pickerOpen, setPickerOpen] = useState(false);
  const [maintenance, setMaintenance] = useState(""),
    [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const [ruleRecords, setRuleRecords] = useState(""),
    [ruleRecordsOpen, setRuleRecordsOpen] = useState(false);
  useEffect(()=>{const abandon=()=>setRuleRecordsOpen(false);addEventListener("mw-event-chart-abandon",abandon);return()=>removeEventListener("mw-event-chart-abandon",abandon);},[]);
  const [catalogMounted, setCatalogMounted] = useState(false),
    [catalogOpen, setCatalogOpen] = useState(false);
  const catalogNext = useRef<(() => void) | undefined>(undefined);
  const [recheck, setRecheck] = useState(0);
  const [notifications, setNotifications] = useState(false);
  const [busy, setBusy] = useState(false),
    [actionError, setActionError] = useState("");
  const [unknownAction, setUnknownAction] = useState<{
    row: AlertRow;
    action: string;
    requestId: string;
  }>();
  const [confirmation, setConfirmation] = useState<{
    row: AlertRow;
    action: string;
  }>();
  const live = useRef(online),
    mounted = useRef(true),
    flight = useRef(false);
  const healthGeneration = useRef(0);
  const rulesRequest = useRef<AbortController | undefined>(undefined);
  const [rulesAt, setRulesAt] = useState(0);
  const editorNext = useRef<(() => void) | undefined>(undefined);
  const rulePages = useRef(1);
  const [archivePages, setArchivePages] = useState(1);
  const [rulesMore, setRulesMore] = useState(false),
    [archivesMore, setArchivesMore] = useState(false);
  const [rulesLoading, setRulesLoading] = useState(false),
    [archivesLoading, setArchivesLoading] = useState(false);
  const ruleSentinel = useRef<HTMLDivElement>(null);
  const archiveRequest = useRef<AbortController | undefined>(undefined);
  const next = useRef<(() => void) | undefined>(undefined);
  live.current = online;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      rulesRequest.current?.abort();
    };
  }, []);
  const request = useCallback(
    (async (path: string, body?: unknown, signal?: AbortSignal) => {
      if (!live.current) throw Error("离线，只读；联网后可读取告警");
      if (path === "/chart-alerts" && body === undefined) {
        const controller = new AbortController();
        rulesRequest.current = controller;
        setRulesLoading(true);
        try {
          const value = await readRuleSpan(
            rulePages.current,
            AbortSignal.any([
              controller.signal,
              ...(signal ? [signal] : []),
              AbortSignal.timeout(15000),
            ]),
          );
          if (controller.signal.aborted || !live.current)
            throw new DOMException("读取已取消", "AbortError");
          if (mounted.current) {
            setLoaded(true);
            setReadAt(undefined);
            setRulesMore(value.hasMore);
            setRulesAt(Date.now());
          }
          return value.items;
        } finally {
          if (mounted.current) setRulesLoading(false);
          if (rulesRequest.current === controller)
            rulesRequest.current = undefined;
        }
      }
      return api(path, body, signal);
    }) as typeof api,
    [profile.origin, profile.subject],
  );
  const onRows = useCallback(
    (rows: AlertRow[]) => {
      setCached(rows);
      void writeSnapshot(profile, "alert-rules", rows).catch(() =>
        report("告警快照未写入本机"),
      );
    },
    [profile.origin, profile.subject, report],
  );
  const data = useAlertData(request, onRows, false);
  useEffect(() => {
    if (!online) {
      ++healthGeneration.current;
      setHealthAt(0);
      setRulesAt(0);
      rulesRequest.current?.abort();
    }
  }, [online]);
  useEffect(() => {
    let active = true;
    void readSnapshot<AlertRow[]>(profile, "alert-rules")
      .then((value) => {
        if (active && value) {
          setCached(value.value);
          setReadAt(value.readAt);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [profile.origin, profile.subject]);
  const refresh = useCallback(async () => {
    if (!live.current || document.hidden) return;
    const generation = ++healthGeneration.current;
    const rules = data.refresh();
    try {
      const value = await api("/health", undefined, AbortSignal.timeout(10000));
      if (
        mounted.current &&
        live.current &&
        generation === healthGeneration.current
      ) {
        setHealth(value);
        setHealthAt(Date.now());
      }
    } catch (error) {
      if (mounted.current && generation === healthGeneration.current) {
        setHealthAt(0);
        logFailure("告警", "核验执行服务", error);
      }
    }
    await rules;
  }, [data.refresh]);
  useEffect(() => {
    if ((!visible && !records) || !online) return;
    let timer: ReturnType<typeof setInterval>;
    const visibility = () => {
      clearInterval(timer);
      if (!document.hidden) {
        void refresh();
        timer = setInterval(() => void refresh(), 15000);
      }
    };
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [visible, records, online, refresh]);
  useEffect(() => {
    if (!visible && !records) return;
    const timer = setInterval(() => setClockNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [visible, records]);
  const refreshArchives = useCallback(async () => {
    archiveRequest.current?.abort();
    const controller = new AbortController();
    archiveRequest.current = controller;
    setArchiveError("");
    setArchivesLoading(true);
    await readRuleSpan(archivePages, controller.signal, "archived")
      .then((value) => {
        const rows = value.items;
        if (controller.signal.aborted) return;
        setArchivesMore(value.hasMore);
        setArchived(rows);
        void writeSnapshot(profile, "alert-rules:archived", rows).catch(
          () => {},
        );
      })
      .catch((error) => {
        if (!controller.signal.aborted) setArchiveError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setArchivesLoading(false);
      });
  }, [archivePages, profile.origin, profile.subject]);
  useEffect(() => {
    if (filter !== "archived" || !online || !visible) return;
    void refreshArchives();
    return () => archiveRequest.current?.abort();
  }, [filter, online, visible, data.rows, refreshArchives]);
  useEffect(() => {
    if (filter !== "archived" || online) return;
    let active = true;
    void readSnapshot<AlertRow[]>(profile, "alert-rules:archived").then(
      (value) => {
        if (active) setArchived(value?.value || []);
      },
    );
    return () => {
      active = false;
    };
  }, [filter, online]);
  useEffect(() => {
    const node = ruleSentinel.current;
    const more = filter === "archived" ? archivesMore : rulesMore;
    if (
      !node ||
      !visible ||
      tab !== "rules" ||
      !online ||
      !more ||
      rulesLoading ||
      archivesLoading ||
      data.error ||
      archiveError
    )
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        if (filter === "archived") setArchivePages((value) => value + 1);
        else {
          rulePages.current++;
          void data.refresh();
        }
      },
      { rootMargin: "0px 0px 160px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [
    visible,
    tab,
    online,
    filter,
    rulesMore,
    archivesMore,
    rulesLoading,
    archivesLoading,
    data.error,
    archiveError,
    data.refresh,
  ]);
  const rows = loaded ? data.rows : cached;
  const selected =
    selection &&
    ([...rows, ...archived].find((row) => row.id === selection.id) ||
      selection);
  const monitor = monitorState(
    health,
    online,
    healthAt,
    loaded && !readAt && !data.error && !!rulesAt && clockNow - rulesAt < 45000,
    clockNow,
  );
  const ntfy =
    online &&
    !!healthAt &&
    clockNow - healthAt < 45000 &&
    Boolean(health?.ntfy_configured && health?.delivery_enabled);
  const status = selected && ruleState(selected, monitor, clockNow);
  const progress = selected && ruleProgress(selected);
  const activity = selected && (selected.execution || selected.activity);
  useEffect(() => {
    if (!selected || !detailOpen || !online) return;
    const controller = new AbortController();
    setJudgments([]);
    void api<any>(
      `/chart-alerts/${selected.id}/judgments?limit=10`,
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setJudgments(value.items || value);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          logFailure("告警", "读取判定记录", error);
      });
    return () => controller.abort();
  }, [
    selected?.id,
    selected?.version,
    selected?.run,
    activity?.last_evaluated_at,
    detailOpen,
    online,
  ]);
  function create() {
    setActionError("");
    setPickerMounted(true);
    setPickerOpen(true);
  }
  function maintain(id: string) {
    setMaintenance(id);
    setMaintenanceOpen(true);
  }
  async function edit(row?: AlertRow, picked?: MarketRow) {
    if (!online || flight.current) return;
    const ticker = row
      ? "MWC:" + row.config.instrument
      : picked?.ticker || symbol;
    const identity = seriesIdentity(ticker);
    if (identity.series_kind !== "composite") {
      create();
      return;
    }
    flight.current = true;
    setBusy(true);
    setActionError("");
    try {
      const [detail, meta] = await Promise.all([
        api<any>(
          `/market-data/composites/${encodeURIComponent(identity.instrument)}`,
        ),
        api<any>("/market-data/resolve", {
          ...identity,
          timeframe: row?.config.timeframe || "M1",
        }),
      ]);
      if (!mounted.current || !live.current) return;
      const value: Editor = {
        config: row
          ? structuredClone(row.config)
          : newPriceConfig(identity.instrument, detail.active_revision_id, ntfy),
        row,
        frames: meta.frames || [],
        label: row
          ? alertCode(row, "品种")
          : picked?.display_symbol ||
            detail.display_symbol ||
            detail.logical_symbol ||
            "自建行情",
        source:
          picked?.source_display ||
          picked?.source ||
          String(row?.market_identity?.source || detail.source || ""),
        name: picked?.description || "",
        dataset:
          picked?.dataset_id ||
          String(row?.market_identity?.dataset_id || detail.dataset_id || ""),
      };
      if (pickerOpen) {
        next.current = () => {
          setEditor(value);
          setEditorOpen(true);
        };
        setPickerOpen(false);
      } else {
        setEditor(value);
        setEditorOpen(true);
      }
    } catch (error) {
      setActionError(errorMessage(error));
      logFailure("告警", "打开条件编辑", error);
      throw error;
    } finally {
      flight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (createToken && online) void edit().catch(() => {});
  }, [createToken]);
  async function lifecycle(
    row: AlertRow,
    action: string,
    requestId: string = crypto.randomUUID(),
  ) {
    if (!online || flight.current) return;
    flight.current = true;
    setBusy(true);
    setActionError("");
    try {
      const saved = await api<AlertRow>(
        `/chart-alerts/${row.id}/lifecycle`,
        {
          version: row.version,
          control_revision: row.control_revision,
          action,
          request_id: requestId,
        },
        AbortSignal.timeout(20000),
      );
      if (!mounted.current) return;
      data.commit(saved);
      setSelected(saved);
      setUnknownAction(undefined);
      if (saved.status === "archived") {
        setArchived((old) => [
          saved,
          ...old.filter((item) => item.id !== saved.id),
        ]);
        setDetailOpen(false);
      }
      logEvent({
        module: "告警",
        action: (
          {
            pause: "暂停规则",
            resume: "恢复规则",
            restart: "再次启用",
            archive: "归档规则",
          } as Record<string, string>
        )[action],
        object: saved.name,
        message: "服务器已保存",
        result: "success",
      });
      void refresh();
    } catch (error) {
      if (!mounted.current) return;
      setActionError(errorMessage(error));
      logFailure("告警", "修改规则状态", error, row.name);
      if (uncertainError(error)) {
        setSelected(row);
        setDetailOpen(true);
        setUnknownAction({ row, action, requestId });
      } else {
        setUnknownAction(undefined);
        if (error instanceof ApiError && error.status === 409)
          setActionError("规则已改变，请读取最新状态后重试。");
      }
    } finally {
      flight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function latest() {
    if (!selected || busy || !online) return;
    setBusy(true);
    try {
      const row = await api<AlertRow>(
        `/chart-alerts/${selected.id}`,
        undefined,
        AbortSignal.timeout(10000),
      );
      data.commit(row);
      setSelected(row);
      setActionError("");
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  const matches = (row: AlertRow) => {
    const state = ruleState(row, monitor, clockNow);
    return (
      (filter === "all" ||
        filter === "archived" ||
        (filter === "current" &&
          (["active", "paused"].includes(row.status) ||
            row.execution?.settlement_pending)) ||
        (filter === "attention" && state.attention) ||
        (filter === "ended" &&
          ["completed", "expired"].includes(row.status) &&
          !row.execution?.settlement_pending)) &&
      query
        .toLocaleLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .every((token) =>
          [
            row.name,
            row.display_label,
            row.condition_summary,
            ...Object.values(ruleIdentity(row)),
          ]
            .join(" ")
            .toLocaleLowerCase()
            .includes(token),
        )
    );
  };
  const filtered = (filter === "archived" ? archived : rows).filter(matches);
  const stateLabel = (
    {
      current: "当前规则",
      attention: "需处理",
      ended: "已结束",
      archived: "已归档",
      all: "全部规则",
    } as Record<string, string>
  )[filter];
  return (
    <>
      <div className="mobile-controls mobile-alerts" hidden={!visible}>
        <MobileOverlaysProvider>
          <section className="mobile-content alert-page">
            <header className="mobile-title alert-title">
              <h1>告警</h1>
              <div className="alert-header-actions">
                {tab === "rules" && (
                  <HeaderIconButton
                    icon={Search}
                    active={filter !== "current" || !!query.trim()}
                    label="搜索规则"
                    aria-haspopup="dialog"
                    aria-expanded={filtersOpen}
                    onClick={() => setFiltersOpen(true)}
                  />
                )}
                <HeaderIconButton
                  icon={Plus}
                  label="创建告警"
                  disabled={!online || busy}
                  onClick={create}
                />
              </div>
            </header>
            {!online && (
              <p className="alert-offline">离线，只读 · 运行状态待联网核验</p>
            )}
            <Tabs
              swipe
              value={tab}
              onValueChange={(value) => setTab(String(value))}
              className="alert-main-tabs"
            >
              <div className="alert-tabbar mobile-page-tabs-nav">
                <TabsList variant="line" aria-label="告警视图">
                  <TabsTrigger value="rules">规则</TabsTrigger>
                  <TabsTrigger value="records" aria-label="事件记录">
                    记录
                  </TabsTrigger>
                </TabsList>
                {tab === "records" && (
                  <Button
                    variant="plain"
                    className="alert-filter-entry"
                    onClick={showRecords}
                  >
                    异常/恢复
                    <ChevronRight data-icon="inline-end" aria-hidden="true" />
                  </Button>
                )}
              </div>
              <TabsPanels>
                <TabsContent value="rules" className="alert-list-panel">
                  <AlertListRefresh
                    active={
                      visible &&
                      tab === "rules" &&
                      !filtersOpen &&
                      !detailOpen &&
                      !editorOpen &&
                      !pickerOpen &&
                      !records
                    }
                    online={online}
                    loading={rulesLoading || archivesLoading}
                    resetKey={filter + ":" + query}
                    refresh={filter === "archived" ? refreshArchives : refresh}
                  >
                    {actionError && !detailOpen && !editorOpen && (
                      <p role="alert" className="mobile-inline-error">
                        {actionError}
                      </p>
                    )}
                    {(filter === "archived" ? archiveError : data.error) && (
                      <div className="alert-read-error">
                        <p role="alert">
                          {filter === "archived" ? archiveError : data.error}
                        </p>
                        <Button
                          variant="ghost"
                          disabled={!online}
                          onClick={() =>
                            void (filter === "archived"
                              ? refreshArchives()
                              : refresh())
                          }
                        >
                          重试
                        </Button>
                      </div>
                    )}
                    {(query || filter !== "current") && (
                      <div className="alert-query">
                        <span>
                          {query ? `${stateLabel} · ${query}` : stateLabel}
                        </span>
                        <Button
                          variant="plain"
                          size="icon"
                          aria-label="清除规则筛选"
                          onClick={() => {
                            setQuery("");
                            setFilter("current");
                          }}
                        >
                          <X aria-hidden="true" />
                        </Button>
                      </div>
                    )}
                    {!loaded && !readAt && online ? (
                      <DataLoading label="正在读取规则…" />
                    ) : !filtered.length ? (
                      <DataEmpty
                        title={
                          rows.length || filter === "archived"
                            ? "没有匹配的规则"
                            : "还没有告警"
                        }
                        action={
                          !rows.length && filter !== "archived" ? (
                            <Button disabled={!online} onClick={create}>
                              创建告警
                            </Button>
                          ) : undefined
                        }
                      >
                        {rows.length || filter === "archived"
                          ? "试试其他筛选，或创建新的规则。"
                          : "选一个自建品种，设置价格或指标条件。"}
                      </DataEmpty>
                    ) : (
                      <div className="alert-rule-list">
                        {filtered.map((row) => {
                          const identity = ruleIdentity(row);
                          const checked = (row.execution || row.activity)
                            ?.last_checked_at;
                          const state = ruleState(row, monitor, clockNow);
                          return (
                            <article className="alert-rule" key={row.id}>
                              <Button
                                variant="plain"
                                className="alert-rule-open"
                                aria-label={`查看${row.name}`}
                                onClick={() => {
                                  setSelected(row);
                                  setDetailOpen(true);
                                  setActionError("");
                                }}
                              >
                                <div
                                  className="alert-rule-heading"
                                  data-long-code={
                                    identity.code.length > 12 || undefined
                                  }
                                >
                                  <SymbolInfo {...identity} />
                                  <div className="alert-rule-condition">
                                    <strong>{row.condition_summary}</strong>
                                    <small>
                                      {row.config.mode === "close"
                                        ? `${row.config.timeframe} 收盘`
                                        : "触价"}{" "}
                                      · {row.count}/{row.max_triggers} 次
                                    </small>
                                  </div>
                                </div>
                              </Button>
                              <div className="alert-rule-status">
                                <span
                                  data-attention={state.attention || undefined}
                                  data-state={state.key}
                                >
                                  <i data-state={state.key} />
                                  {state.label}
                                </span>
                                {state.attention && state.message && (
                                  <small>{state.message}</small>
                                )}
                                {checked && !state.attention && (
                                  <small className="alert-rule-checked">
                                    {monitor.verified ? "最近检查" : "上次检查"}{" "}
                                    {stamp(checked)}
                                  </small>
                                )}
                                {row.execution?.last_gap?.unrecoverable && (
                                  <small>曾中断，部分时段无法补判</small>
                                )}
                              </div>
                              <Switch
                                size="lg"
                                aria-label={`启用${row.name}`}
                                checked={row.status === "active"}
                                disabled={
                                  !online ||
                                  busy ||
                                  !!unknownAction ||
                                  !["active", "paused"].includes(row.status) ||
                                  (row.status === "paused" &&
                                    (row.config.series_kind !== "composite" ||
                                      expiredRule(row) ||
                                      row.count >= row.max_triggers))
                                }
                                onCheckedChange={(checked) =>
                                  void lifecycle(
                                    row,
                                    checked ? "resume" : "pause",
                                  )
                                }
                              />
                            </article>
                          );
                        })}
                      </div>
                    )}
                    <div ref={ruleSentinel} className="alert-list-end">
                      {(filter === "archived" ? archivesMore : rulesMore) && (
                        <Button
                          variant="ghost"
                          disabled={!online || rulesLoading || archivesLoading}
                          onClick={() => {
                            if (filter === "archived")
                              setArchivePages((value) => value + 1);
                            else {
                              rulePages.current++;
                              void data.refresh();
                            }
                          }}
                        >
                          {rulesLoading || archivesLoading
                            ? "正在加载…"
                            : "加载更多规则"}
                        </Button>
                      )}
                    </div>
                  </AlertListRefresh>
                </TabsContent>
                <TabsContent value="records" className="alert-list-panel">
                  <AlertRecords
                    key="records"
                    profile={profile}
                    online={online}
                    active={visible && tab === "records"}
                    runtime={runtime}
                    pullToRefresh
                    targetEvent={signalEntry}
                  />
                </TabsContent>
              </TabsPanels>
            </Tabs>
          </section>
          <MobileSheet
            title="搜索规则"
            open={filtersOpen}
            close={() => setFiltersOpen(false)}
          >
            <FieldGroup>
              <DataInput
                label="搜索规则"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="品种、名称或条件"
              />
              <DataSelect
                label="规则范围"
                value={filter}
                onChange={setFilter}
                items={[
                  { value: "current", label: "当前规则" },
                  { value: "attention", label: "需处理" },
                  { value: "ended", label: "已结束" },
                  { value: "archived", label: "已归档" },
                  { value: "all", label: "全部未归档" },
                ]}
              />
              <Button onClick={() => setFiltersOpen(false)}>查看规则</Button>
            </FieldGroup>
          </MobileSheet>
          <MobileSheet
            title="规则详情"
            open={detailOpen}
            close={() => setDetailOpen(false)}
            dismissible={!busy && !unknownAction}
            onClosed={() => {
              setSelected(undefined);
              setActionError("");
              const action = next.current;
              next.current = undefined;
              action?.();
            }}
          >
            {selected && status && (
              <div className="alert-detail">
                <div
                  className="alert-detail-identity"
                  data-long-code={
                    ruleIdentity(selected).code.length > 12 || undefined
                  }
                >
                  <SymbolInfo {...ruleIdentity(selected)} />
                  <div className="alert-state-line">
                    <Badge
                      variant={status.attention ? "destructive" : "secondary"}
                    >
                      {status.label}
                    </Badge>
                    {!online && <span>离线，只读</span>}
                  </div>
                </div>
                <h3 className="alert-condition-title">
                  {selected.condition_summary}
                </h3>
                <div className="alert-detail-summary" aria-label="规则设置">
                  <span>
                    {selected.config.mode === "close"
                      ? `${selected.config.timeframe} 收盘确认`
                      : "实时抽样触价"}
                  </span>
                  <span>{selected.count}/{selected.max_triggers} 次</span>
                  <span>
                    {selected.config.expires_at
                      ? `${stamp(selected.config.expires_at)} 到期`
                      : "不限到期"}
                  </span>
                </div>
                {status.message && (
                  <div className="alert-issue">
                    <p>{status.message || "等待服务器建立观察基准"}</p>
                    {(status.issue === "input" ||
                      status.key === "recovering") &&
                      !!selected.market_identity?.dataset_id && (
                        <Button
                          variant="outline"
                          onClick={() =>
                            maintain(
                              String(selected.market_identity!.dataset_id),
                            )
                          }
                        >
                          去数据详情
                        </Button>
                      )}
                    {status.issue === "delivery" &&
                      selected.config.notify_ntfy && (
                        <Button
                          variant="ghost"
                          onClick={() => setNotifications(true)}
                        >
                          检查通知设置
                        </Button>
                      )}
                  </div>
                )}
                <dl className="alert-facts">
                  <div>
                    <dt>{monitor.verified ? "最近检查" : "上次检查"}</dt>
                    <dd>{stamp(activity?.last_checked_at)}</dd>
                  </div>
                  <div>
                    <dt>最近判定</dt>
                    <dd>
                      {progress?.label}
                      {progress?.at
                        ? ` · ${stamp(progress.at)}`
                        : selected.config.mode === "close" &&
                            !status.attention &&
                            monitor.verified
                          ? ` · 等待 ${selected.config.timeframe} 收盘数据`
                          : ""}
                    </dd>
                  </div>
                  <div>
                    <dt>提醒</dt>
                    <dd>
                      {selected.config.notify_ntfy ? "手机推送 · " : ""}
                      {selected.config.notify_web ? "应用内" : "仅记录"}
                    </dd>
                  </div>
                  <div>
                    <dt>最近触发</dt>
                    <dd>{stamp(selected.last_triggered_at)}</dd>
                  </div>
                </dl>
                {selected.execution?.last_gap &&
                  (selected.execution.last_gap.unrecoverable ||
                    status.key !== "monitoring") && (
                    <p className="alert-gap">
                      {selected.execution.last_gap.unrecoverable
                        ? "曾中断，部分时段无法补判"
                        : "曾有数据缺口"}{" "}
                      · {stamp(selected.execution.last_gap.start)} —{" "}
                      {stamp(selected.execution.last_gap.end)}
                    </p>
                  )}
                {actionError && (
                  <p role="alert" className="mobile-inline-error">
                    {actionError}
                  </p>
                )}
                {unknownAction && (
                  <>
                    <p className="alert-muted">结果未知，请核查同一次操作。</p>
                    <Button
                      disabled={!online || busy}
                      onClick={() =>
                        void lifecycle(
                          unknownAction.row,
                          unknownAction.action,
                          unknownAction.requestId,
                        )
                      }
                    >
                      核查同一次操作
                    </Button>
                  </>
                )}
                {expiredRule(selected) &&
                  selected.status !== "archived" &&
                  !selected.execution?.settlement_pending && (
                    <p className="alert-muted">
                      先编辑并更新到期时间，保存后再恢复。
                    </p>
                  )}
                {!unknownAction &&
                  selected.status !== "archived" &&
                  !selected.execution?.settlement_pending && (
                    <div className="alert-detail-actions">
                      {selected.status === "active" ? (
                        <Button
                          variant="outline"
                          disabled={!online || busy}
                          onClick={() => void lifecycle(selected, "pause")}
                        >
                          暂停
                        </Button>
                      ) : (
                        selected.config.series_kind === "composite" && (
                          <Button
                            variant="outline"
                            disabled={!online || busy || expiredRule(selected)}
                            onClick={() =>
                              selected.count >= selected.max_triggers
                                ? setConfirmation({
                                    row: selected,
                                    action: "restart",
                                  })
                                : void lifecycle(selected, "resume")
                            }
                          >
                            {selected.count >= selected.max_triggers
                              ? "再次启用"
                              : "恢复"}
                          </Button>
                        )
                      )}
                      {editableRule(selected) && (
                        <Button
                          disabled={!online || busy}
                          onClick={() => void edit(selected).catch(() => {})}
                        >
                          编辑条件
                        </Button>
                      )}
                    </div>
                  )}
                <div className="alert-entry-list">
                  <Button
                    variant="plain"
                    onClick={() => {
                      setRuleRecords(selected.id);
                      setRuleRecordsOpen(true);
                    }}
                  >
                    此规则触发记录
                    <ChevronRight data-icon="inline-end" />
                  </Button>
                  {openChart && (
                    <Button
                      variant="plain"
                      disabled={!online}
                      onClick={() => {
                        const row = selected;
                        next.current = () =>
                          openChart(
                            (row.config.series_kind === "composite"
                              ? "MWC:"
                              : row.config.series_kind === "managed"
                                ? "MWH:"
                                : "MWP:") + row.config.instrument,
                            row.config.timeframe,
                          );
                        setDetailOpen(false);
                      }}
                    >
                      查看品种图表
                      <ChevronRight data-icon="inline-end" />
                    </Button>
                  )}
                </div>
                <DataMore title="排查信息">
                  <dl className="alert-facts">
                    {Object.entries({
                      名称: selected.name,
                      接管: stamp(activity?.taken_over_at),
                      最近检查: stamp(activity?.last_checked_at),
                      最近判定: stamp(activity?.last_evaluated_at),
                      最近输入: stamp(activity?.last_input_at),
                      预期输入: stamp(
                        (selected.execution as any)?.expected_input_at,
                      ),
                      ...(selected.execution?.last_gap
                        ? {
                            排查区间: `${stamp(selected.execution.last_gap.start)} — ${stamp(selected.execution.last_gap.end)}`,
                          }
                        : {}),
                      修订: selected.config.composite_revision_id || "历史来源",
                      推送状态:
                        selected.execution?.notification?.message ||
                        selected.execution?.notification?.status ||
                        "尚无投递证据",
                    }).map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                  {selected.health_reason && (
                    <p className="alert-muted">{selected.health_reason}</p>
                  )}
                  {judgments.length > 0 && (
                    <>
                      <h4>最近判定</h4>
                      {judgments.slice(0, 10).map((item, index) => (
                        <p className="alert-muted" key={item.id || index}>
                          {(
                            {
                              unknown: "无法判定",
                              triggered: "已触发",
                              no_trigger: "未触发",
                              initial_baseline: "初始基准已建立",
                              recovery_baseline: "恢复基准已建立",
                            } as Record<string, string>
                          )[item.outcome] ||
                            item.summary ||
                            item.outcome}{" "}
                          · {stamp(item.event_time || item.created_at)}
                        </p>
                      ))}
                    </>
                  )}
                  <Button
                    variant="outline"
                    disabled={!online || busy || !!unknownAction}
                    onClick={() => void latest()}
                  >
                    读取最新状态
                  </Button>
                </DataMore>
                {!unknownAction && selected.status !== "archived" && (
                  <>
                    {!editableRule(selected) && (
                      <p className="alert-muted">
                        此条件仅支持查看与状态维护；画线关联请在网页端编辑。
                      </p>
                    )}
                    <Button
                      variant="ghost"
                      className="alert-archive"
                      disabled={!online || busy}
                      onClick={() =>
                        setConfirmation({ row: selected, action: "archive" })
                      }
                    >
                      <Archive data-icon="inline-start" />
                      归档规则
                    </Button>
                  </>
                )}
              </div>
            )}
          </MobileSheet>
          {pickerMounted && (
            <AlertSymbolPicker
              profile={profile}
              online={online}
              open={pickerOpen}
              close={() => setPickerOpen(false)}
              pick={(row) => edit(undefined, row)}
              maintain={maintain}
              recheck={recheck}
              add={() => {
                setCatalogMounted(true);
                setCatalogOpen(true);
              }}
              onClosed={() => {
                setPickerMounted(false);
                const action = next.current;
                next.current = undefined;
                action?.();
              }}
            />
          )}
          {editor && (
            <PriceRuleSheet
              key={editor.row?.id || editor.config.instrument}
              initial={editor.config}
              recheck={recheck}
              editing={editor.row}
              label={editor.label}
              source={editor.source}
              name={editor.name}
              frames={editor.frames}
              online={online}
              ntfy={ntfy}
              open={editorOpen}
              close={() => setEditorOpen(false)}
              onClosed={() => {
                setEditor(undefined);
                const action = editorNext.current;
                editorNext.current = undefined;
                action?.();
              }}
              report={report}
              notifications={() => setNotifications(true)}
              maintain={
                editor.dataset ? () => maintain(editor.dataset!) : undefined
              }
              saved={(row) => {
                data.commit(row);
                editorNext.current = () => {
                  setSelected(row);
                  setDetailOpen(true);
                };
                setEditorOpen(false);
                void refresh();
              }}
            />
          )}
          {catalogMounted && (
            <DataCatalogSheet
              profile={profile}
              online={online}
              active={catalogOpen}
              open={catalogOpen}
              close={() => setCatalogOpen(false)}
              done={(id) => {
                catalogNext.current = () => maintain(id);
                setCatalogOpen(false);
              }}
              onClosed={() => {
                setCatalogMounted(false);
                setRecheck((value) => value + 1);
                const action = catalogNext.current;
                catalogNext.current = undefined;
                action?.();
              }}
            />
          )}
          {maintenance && (
            <ManagedDetails
              profile={profile}
              online={online}
              visible={visible}
              active={visible}
              id={maintenance}
              opened={maintenanceOpen}
              close={() => setMaintenanceOpen(false)}
              onClosed={() => {
                setMaintenance("");
                setRecheck((value) => value + 1);
                void refresh();
              }}
              changed={() => void refresh()}
              report={report}
              open={(ticker) => openChart?.(ticker)}
            />
          )}
          <MobileSheet
            title="规则触发记录"
            open={ruleRecordsOpen && !eventChart.suspended}
            retain={ruleRecordsOpen || eventChart.suspended}
            close={() => setRuleRecordsOpen(false)}
            onClosed={() => { if(!eventSuspended.current) setRuleRecords(""); }}
            fullHeight
          >
            {ruleRecords && (
              <AlertRecords
                key={ruleRecords}
                profile={profile}
                online={online}
                active={ruleRecordsOpen}
                runtime={runtime}
                alertId={ruleRecords}
              />
            )}
          </MobileSheet>
          <MobileSheet
            title="后台通知"
            open={notifications}
            close={() => setNotifications(false)}
          >
            <dl className="alert-facts">
              <div>
                <dt>推送配置</dt>
                <dd>
                  {healthAt
                    ? health?.ntfy_configured
                      ? "ntfy 已配置"
                      : "ntfy 尚未配置"
                    : "待核验"}
                </dd>
              </div>
              <div>
                <dt>服务器投递</dt>
                <dd>
                  {healthAt
                    ? health?.delivery_enabled
                      ? "已开启"
                      : "未开启"
                    : "待核验"}
                </dd>
              </div>
            </dl>
            <p className="alert-muted">
              手机后台通知由 ntfy
              提供。请允许通知与后台运行；锁屏实收需要在手机检查。
            </p>
            <p className="alert-muted">
              请到“更多 → 后台通知”配置与测试；未配置也能创建站内记录。
            </p>
            <Button
              variant="outline"
              disabled={!online}
              onClick={() => void refresh()}
            >
              <Activity data-icon="inline-start" />
              重新核验
            </Button>
          </MobileSheet>
          {confirmation && (
            <MobileConfirm
              title={
                confirmation.action === "archive"
                  ? "归档这条规则？"
                  : "再次启用？"
              }
              description={
                confirmation.action === "archive"
                  ? "停止检测并保留历史记录。归档后不能恢复。"
                  : "触发次数归零，保留历史，从新的观察重新建立基准。"
              }
              actionLabel={
                confirmation.action === "archive" ? "确认归档" : "再次启用"
              }
              destructive={confirmation.action === "archive"}
              onClose={() => setConfirmation(undefined)}
              onAccept={() => {
                const value = confirmation;
                setConfirmation(undefined);
                void lifecycle(value.row, value.action);
              }}
            />
          )}
        </MobileOverlaysProvider>
      </div>
      <RecordsSheet
        open={records}
        profile={profile}
        online={online}
        events={[]}
        runtime={runtime}
        close={closeRecords}
        report={report}
        targetNotification={visible ? notificationEntry : undefined}
        initialTab={visible ? (notificationEntry || recordEntry === "system" ? "system" : "alerts") : "triggers"}
      />
    </>
  );
}
