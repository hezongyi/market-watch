import { useChartTime } from "../time/ChartTimeContext";
import {
  formatTimestamp,
  dayKey,
  clockTime,
  formatAlertMessage,
} from "../time/chartTime";
import { AlertEventTrace } from "../notifications/AlertEventTrace";
import type { NoticeTransport } from "../notifications/types";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiError, api, errorMessage } from "../api";
import { useAlertData } from "./useAlertData";
import { ChartAlertDialog } from "./ChartAlertDialog";
import {
  deliveryNames,
  eventPresentation,
  normalizeCondition,
  freshDraft,
  healthNames,
  offsetSnapshot,
  statuses,
  type AlertConfig,
  type AlertContext,
  type AlertEvent,
  type AlertRow,
} from "./chartAlerts";
import "./chart-alerts.css";
import {
  Plus,
  Search,
  ArrowDownWideNarrow,
  MoreHorizontal,
  X,
  Pause,
  Play,
  Settings2,
  Eraser,
  Trash2,
  Clock3,
  Bell,
} from "lucide-react";
import { AlertLogCleanup } from "./AlertLogCleanup";
import {
  AlertSummary,
  AlertSymbolIcon,
  alertCode,
  alertState,
} from "./alertPresentation";
import { AlertMenu } from "./AlertMenu";
import type { AlertApi } from "./chartAlertUiApi";
import type { NativeAlertDialog } from "./nativeAlertUI";

export type AlertDraft = {
  config: AlertConfig;
  requestId: string;
  editing: { id: string; version: number } | null;
  displayLabel?: string;
  displayCode?: string;
  automaticName?: boolean;
};
export function ChartAlertsPanel(
  props: Parameters<typeof ScopedChartAlertsPanel>[0],
) {
  return (
    <ScopedChartAlertsPanel
      key={`${props.workspaceId}:${props.open}`}
      {...props}
    />
  );
}
function ScopedChartAlertsPanel({
  workspaceId,
  context,
  open,
  theme,
  readonly,
  associationNotices,
  onClose,
  onRequest,
  onLocate,
  onRows,
  onDrawingAction,
  request = api,
  activeInstrument,
  nativeDialog,
  mountTarget,
  initialDraft,
  persistDraft,
  focusEvent,
  noticeRequest,
  creationUnavailable,
  alertUnread,
}: {
  alertUnread?: number;
  creationUnavailable?: string;
  focusEvent?: { id: string; revision: number };
  noticeRequest?: NoticeTransport;
  workspaceId: string;
  context: AlertContext | null;
  open: boolean;
  theme: string;
  readonly: boolean;
  associationNotices: Record<string, string>;
  onDrawingAction: (row: AlertRow, action: "retry" | "restore") => void;
  onClose: () => void;
  onRequest: () => void;
  onLocate: (row: AlertRow, event?: AlertEvent) => void;
  onRows: (rows: AlertRow[]) => void;
  request?: AlertApi;
  activeInstrument?: { instrument: string; series_kind: string } | null;
  nativeDialog?: NativeAlertDialog;
  mountTarget?: HTMLElement | null;
  initialDraft?: AlertDraft | null;
  persistDraft?: (draft: AlertDraft | null) => void;
}) {
  const { zone } = useChartTime();
  const date = (stamp: number) => formatTimestamp(stamp, zone);
  const draftKey = "mw-chart-alert-draft:" + workspaceId;
  const { rows, events, error, setError, refresh, commit } = useAlertData(
    request,
    onRows,
  );
  const [tab, setTab] = useState("alerts"),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState(""),
    [currentOnly, setCurrentOnly] = useState(false);
  const [feedback, setFeedback] = useState(""),
    [busy, setBusy] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false),
    [draft, setDraft] = useState<AlertDraft | null>(() => {
      if (initialDraft !== undefined) return initialDraft;
      try {
        const value = JSON.parse(localStorage.getItem(draftKey) || "null");
        return value?.config?.instrument && value?.requestId ? value : null;
      } catch {
        return null;
      }
    });
  const mounted = useRef(true);
  const pendingActions = useRef(
    new Map<
      string,
      {
        version: number;
        control_revision: number;
        request_id: string;
        action: string;
      }
    >(),
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(""), 5000);
    return () => clearTimeout(timer);
  }, [feedback]);
  useEffect(() => {
    if (!open) return;
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (!context || readonly) return;
    setDraft({
      config: freshDraft(context),
      requestId: context.request_id,
      editing: null,
      displayLabel: context.display_label,
      displayCode: context.display_identity?.code,
      automaticName:
        !!context.display_identity?.code && !context.line && !context.indicator,
    });
    setFormOpen(true);
  }, [context?.request_id]);
  useEffect(() => {
    try {
      if (persistDraft) {
        persistDraft(draft);
        return;
      }
      if (draft) localStorage.setItem(draftKey, JSON.stringify(draft));
      else localStorage.removeItem(draftKey);
    } catch {
      setError("本地草稿保存失败，请保留此表单后重试");
    }
  }, [draft, draftKey]);
  async function action(row: AlertRow, action: string) {
    const key = `${row.id}:${action}`;
    setBusy(row.id);
    setError("");
    try {
      const intent = pendingActions.current.get(key) || {
        version: row.version,
        control_revision: row.control_revision,
        request_id: crypto.randomUUID(),
        action,
      };
      pendingActions.current.set(key, intent);
      const saved = await request<AlertRow>(
        `/chart-alerts/${row.id}/lifecycle`,
        {
          ...intent,
        },
      );
      pendingActions.current.delete(key);
      if (mounted.current) {
        commit(saved);
        setFeedback(`${saved.name}：${statuses[saved.status]}`);
        void refresh();
      }
      return null;
    } catch (e) {
      if (e instanceof ApiError && e.status < 500) {
        pendingActions.current.delete(key);
        await refresh();
      }
      if (mounted.current) setError(errorMessage(e));
      return errorMessage(e);
    } finally {
      if (mounted.current) setBusy(null);
    }
  }
  async function ack(event: AlertEvent) {
    setBusy(event.id);
    try {
      await request(`/notifications/${event.notification_id}/ack`, {});
      if (mounted.current) await refresh();
    } catch (e) {
      if (mounted.current) setError(errorMessage(e));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }
  function edit(row: AlertRow, copy = false) {
    setDraft({
      config: copy
        ? {
            ...structuredClone(row.config),
            name: row.name + " 副本",
            association: null,
          }
        : {
            ...structuredClone(row.config),
            condition: normalizeCondition(row.config.condition),
          },
      requestId: crypto.randomUUID(),
      editing: copy ? null : { id: row.id, version: row.version },
      displayLabel: row.display_label || row.name,
      displayCode: row.display_identity?.code,
      automaticName: false,
    });
    setFormOpen(true);
  }
  const [searchOpen, setSearchOpen] = useState(false),
    [eventSort, setEventSort] = useState("newest"),
    [sort, setSort] = useState("created"),
    [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [showHandled, setShowHandled] = useState(false);
  const [cleared, setCleared] = useState(new Set<string>());
  const [cleanupError, setCleanupError] = useState("");
  const [cleanup, setCleanup] = useState<AlertEvent[] | null>(null);
  const observed = useRef(new Set<string>());
  const observing = useRef(new Set<string>());
  const contentRef = useRef<HTMLDivElement>(null);
  const cleanupRunning = useRef(false);
  const [cleaning, setCleaning] = useState(false);
  async function clearEvents(snapshot: AlertEvent[]) {
    if (!noticeRequest || cleanupRunning.current || readonly) return;
    cleanupRunning.current = true;
    setCleanupError("");
    setCleaning(true);
    let failures = 0;
    const pending = [...snapshot];
    await Promise.all(
      Array.from({ length: Math.min(4, pending.length) }, async () => {
        while (pending.length && mounted.current) {
          const event = pending.shift()!;
          try {
            await noticeRequest({
              action: "observe",
              event_id: event.notice!.id,
              kind: "viewed",
              wait_for_sync: true,
            });
            await noticeRequest({
              action: "observe",
              event_id: event.notice!.id,
              kind: "handled",
              wait_for_sync: true,
            });
            if (mounted.current)
              setCleared((previous) => new Set([...previous, event.id]));
          } catch {
            failures++;
          }
        }
      }),
    );
    cleanupRunning.current = false;
    if (!mounted.current) return;
    setCleaning(false);
    setCleanup(null);
    if (failures)
      setCleanupError(`${failures} 条日志未移除，请重试；手机提醒未改变`);
    else
      setFeedback("已从默认日志列表移除，仍可显示已清理日志；手机提醒未改变");
    void refresh();
  }
  useEffect(() => {
    if (
      !open ||
      tab !== "events" ||
      detail ||
      formOpen ||
      cleanup ||
      !noticeRequest ||
      !contentRef.current
    )
      return;
    const root = contentRef.current,
      view = root.ownerDocument.defaultView!;
    if (!view.IntersectionObserver) return;
    let active = true;
    const observer = new view.IntersectionObserver(
      (entries) => {
        if (!active) return;
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.noticeId;
          if (
            !entry.isIntersecting ||
            entry.intersectionRatio < 0.5 ||
            !id ||
            observed.current.has(id) ||
            observing.current.has(id) ||
            root.ownerDocument.visibilityState !== "visible"
          )
            continue;
          observing.current.add(id);
          void noticeRequest({
            action: "observe",
            event_id: id,
            kind: "viewed",
            wait_for_sync: true,
          })
            .then(() => {
              if (active) observed.current.add(id);
            })
            .catch((e) => {
              if (active) setError(errorMessage(e));
            })
            .finally(() => observing.current.delete(id));
        }
      },
      { root, threshold: 0.5 },
    );
    const observeVisible = () => {
      observer.disconnect();
      for (const node of root.querySelectorAll<HTMLElement>("[data-notice-id]"))
        observer.observe(node);
    };
    observeVisible();
    root.ownerDocument.addEventListener("visibilitychange", observeVisible);
    return () => {
      active = false;
      observer.disconnect();
      root.ownerDocument.removeEventListener(
        "visibilitychange",
        observeVisible,
      );
    };
  }, [
    open,
    tab,
    detail,
    formOpen,
    cleanup,
    events,
    showHandled,
    cleared,
    mountTarget,
    noticeRequest,
  ]);
  const searchInput = useRef<HTMLInputElement>(null);
  const visible = rows.filter(
    (row) =>
      (!search ||
        (row.name + row.condition_summary + row.config.instrument)
          .toLowerCase()
          .includes(search.toLowerCase())) &&
      (!status || row.status === status) &&
      (!currentOnly ||
        (row.config.instrument === (activeInstrument || context)?.instrument &&
          row.config.series_kind ===
            (activeInstrument || context)?.series_kind)),
  );
  useEffect(() => {
    if (!focusEvent) return;
    setTab("events");
    setSearch("");
    setStatus("");
    setCurrentOnly(false);
    setSelected(focusEvent.id);
    void refresh();
  }, [focusEvent]);
  useEffect(() => {
    if (!focusEvent || selected !== focusEvent.id) return;
    mountTarget
      ?.querySelector<HTMLElement>('[data-signal-id="' + focusEvent.id + '"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [focusEvent, selected, events, mountTarget]);
  const filteredEvents = events.filter(
    (event) =>
      (showHandled || (!event.notice?.handled_at && !cleared.has(event.id))) &&
      (!search ||
        eventPresentation(event).search.includes(search.toLowerCase())) &&
      (!currentOnly ||
        (event.evidence.config.instrument ===
          (activeInstrument || context)?.instrument &&
          event.evidence.config.series_kind ===
            (activeInstrument || context)?.series_kind)),
  );
  visible.sort((a, b) =>
    sort === "name"
      ? a.name.localeCompare(b.name)
      : sort === "updated"
        ? b.updated_at - a.updated_at
        : b.created_at - a.created_at,
  );
  filteredEvents.sort((a, b) =>
    eventSort === "oldest"
      ? a.occurred_at - b.occurred_at
      : b.occurred_at - a.occurred_at,
  );
  const grouped = new Map<string, AlertEvent[]>();
  for (const event of filteredEvents) {
    const day = dayKey(event.occurred_at, zone);
    grouped.set(day, [...(grouped.get(day) || []), event]);
  }
  const rowDetails = (row: AlertRow) => (
    <div className="alert-row-detail">
      <p>{row.display_label}</p>
      <p>{row.condition_summary}</p>
      <p>
        {row.config.source} · {row.config.timeframe} ·{" "}
        {row.config.mode === "close" ? "收盘确认" : "盘中观察"}
      </p>
      <p>
        {statuses[row.status]} · 已触发 {row.count} / {row.max_triggers} 次
      </p>
      <p className={`alert-health alert-health-${row.health}`}>
        {healthNames[row.health]}
        {row.health_reason ? "：" + row.health_reason : ""}
      </p>
      {row.config.series_kind === "composite" &&
        typeof row.runtime.quote_health === "string" && (
          <p>
            当前报价：
            {row.runtime.quote_health === "ready" ? "正常" : "暂不可用或已过期"}
          </p>
        )}
      {row.config.condition.offset && offsetSnapshot(row.runtime.offset) && (
        <p>{offsetSnapshot(row.runtime.offset)}</p>
      )}
      <p>
        版本 {row.version} · 生效 {date(row.effective_at)}
      </p>
      {events.find((event) => event.alert_id === row.id) && (
        <p>
          最近触发{" "}
          {date(events.find((event) => event.alert_id === row.id)!.occurred_at)}
        </p>
      )}
      <button onClick={() => onLocate(row)}>定位图表</button>
    </div>
  );
  const eventDetails = (event: AlertEvent) => (
    <div className="alert-row-detail">
      <p>{eventPresentation(event).summary}</p>
      <p>事件时间 {date(event.occurred_at)}</p>
      <p>检测时间 {date(event.detected_at)}</p>
      <p>
        实际值 {event.evidence.left} · 比较值 {event.threshold} · 市场价格{" "}
        {event.price}
      </p>
      {offsetSnapshot(event.evidence.observation.offset) && (
        <p>{offsetSnapshot(event.evidence.observation.offset)}</p>
      )}
      <p>
        规则版本 {event.evidence.rule_version} · 第 {event.evidence.ordinal} 次
      </p>
      <p>
        {event.ack_at
          ? "已确认"
          : deliveryNames[event.notification_status] ||
            deliveryNames[event.delivery_status] ||
            event.notification_status}
      </p>
      <details>
        <summary>查看消息和当时证据</summary>
        <p className="alert-message-text">
          {formatAlertMessage(event.message, event.occurred_at, zone)}
        </p>
        <pre>{JSON.stringify(event.evidence.observation, null, 2)}</pre>
      </details>
      {noticeRequest && (
        <AlertEventTrace signalId={event.id} request={noticeRequest} />
      )}
      <p className="nc-muted">
        查看记录不会停止手机提醒；显式停止无法撤回已在途发送。
      </p>
      <div className="alert-inline-actions">
        <button
          disabled={!rows.some((row) => row.id === event.alert_id)}
          onClick={() => {
            const row = rows.find((row) => row.id === event.alert_id);
            if (row) onLocate(row, event);
          }}
        >
          定位触发位置
        </button>
        <button
          disabled={!!event.ack_at || busy === event.id}
          onClick={() => ack(event)}
        >
          {event.ack_at ? "已停止后续提醒" : "停止后续手机提醒"}
        </button>
      </div>
    </div>
  );
  const panel = open && mountTarget !== null && (
    <aside
      className="chart-alert-panel"
      data-theme={theme}
      aria-label="告警与日志"
    >
      <div
        className="alert-panel-tabs"
        role="tablist"
        aria-label="告警面板标签"
      >
        {["alerts", "events"].map((value, index) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            aria-controls={
              value === "alerts" ? "chart-alert-list" : "chart-alert-events"
            }
            tabIndex={tab === value ? 0 : -1}
            onClick={() => {
              setTab(value);
              setDetail(null);
            }}
            onKeyDown={(event) => {
              if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
                event.preventDefault();
                setTab(value === "alerts" ? "events" : "alerts");
                setDetail(null);
                (
                  event.currentTarget.parentElement!.children[
                    1 - index
                  ] as HTMLElement
                ).focus();
              }
            }}
          >
            {value === "alerts" ? (
              "警报"
            ) : (
              <>
                日志
                {!!alertUnread && (
                  <span
                    className="alert-unread-badge"
                    aria-label={`${alertUnread} 条未读交易日志`}
                  >
                    {alertUnread > 99 ? "99+" : alertUnread}
                  </span>
                )}
              </>
            )}
          </button>
        ))}
      </div>
      <div className="alert-panel-toolbar">
        {tab === "alerts" && (
          <button
            disabled={readonly || !!creationUnavailable}
            onClick={onRequest}
            aria-label="创建告警"
            title={creationUnavailable || "创建警报"}
          >
            <Plus size={20} aria-hidden />
          </button>
        )}
        {tab === "alerts" && creationUnavailable && (
          <small role="status">{creationUnavailable}</small>
        )}
        {tab === "events" && (
          <button
            aria-label="清理当前日志"
            disabled={
              readonly ||
              cleaning ||
              !noticeRequest ||
              !filteredEvents.some(
                (e) => e.notice && !e.notice.handled_at && !cleared.has(e.id),
              )
            }
            onClick={() =>
              setCleanup(
                filteredEvents
                  .filter(
                    (e) =>
                      e.notice && !e.notice.handled_at && !cleared.has(e.id),
                  )
                  .slice(0, 100),
              )
            }
          >
            <Eraser size={19} aria-hidden />
          </button>
        )}
        <span className="alert-toolbar-spacer" />
        <button
          aria-label="搜索告警"
          aria-expanded={searchOpen}
          onClick={() => {
            setSearchOpen(!searchOpen);
            setTimeout(() => searchInput.current?.focus(), 0);
          }}
        >
          <Search size={18} aria-hidden />
        </button>
        <AlertMenu
          label="排序"
          items={
            tab === "events"
              ? [
                  {
                    label: "最新事件在前",
                    checked: eventSort === "newest",
                    run: () => setEventSort("newest"),
                  },
                  {
                    label: "最早事件在前",
                    checked: eventSort === "oldest",
                    run: () => setEventSort("oldest"),
                  },
                ]
              : [
                  {
                    label: "创建时间",
                    checked: sort === "created",
                    run: () => setSort("created"),
                  },
                  {
                    label: "更新时间",
                    checked: sort === "updated",
                    run: () => setSort("updated"),
                  },
                  {
                    label: "名称",
                    checked: sort === "name",
                    run: () => setSort("name"),
                  },
                ]
          }
        >
          <ArrowDownWideNarrow size={18} aria-hidden />
        </AlertMenu>
        <AlertMenu
          label="更多选项"
          items={[
            {
              label: "当前品种",
              checked: currentOnly,
              disabled: !(activeInstrument || context),
              run: () => setCurrentOnly(!currentOnly),
            },
            ...(tab === "alerts"
              ? [
                  {
                    label: "全部状态",
                    checked: status === "",
                    run: () => setStatus(""),
                    divider: true,
                  },
                  ...Object.entries(statuses)
                    .filter(([key]) => key !== "archived")
                    .map(([key, label]) => ({
                      label,
                      checked: status === key,
                      run: () => setStatus(key),
                    })),
                ]
              : [
                  {
                    label: "显示已清理日志",
                    checked: showHandled,
                    run: () => setShowHandled(!showHandled),
                  },
                ]),
            {
              label: "恢复草稿",
              disabled: !draft || readonly,
              run: () => setFormOpen(true),
              divider: true,
            },
            {
              label: "刷新",
              run: () => {
                void refresh();
              },
            },
            { label: "折叠侧栏", run: onClose },
          ]}
        >
          <MoreHorizontal size={19} aria-hidden />
        </AlertMenu>
      </div>
      {searchOpen && (
        <div className="alert-search">
          <Search size={16} aria-hidden />
          <input
            ref={searchInput}
            aria-label="搜索"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="名称、条件或品种"
          />
          <button
            aria-label="关闭搜索"
            onClick={() => {
              setSearch("");
              setSearchOpen(false);
            }}
          >
            <X size={16} aria-hidden />
          </button>
        </div>
      )}
      {(currentOnly || (tab === "alerts" && status)) && (
        <div className="alert-filter-summary">
          {currentOnly
            ? `当前品种 · ${(activeInstrument || context)?.instrument}`
            : ""}
          {tab === "alerts" && status ? " · " + statuses[status] : ""}
        </div>
      )}
      {feedback && (
        <p className="alert-feedback" role="status">
          {feedback}
        </p>
      )}
      {(error || cleanupError) && (
        <p className="alert-error" role="alert">
          {cleanupError || error}
        </p>
      )}
      <div
        id={tab === "alerts" ? "chart-alert-list" : "chart-alert-events"}
        role="tabpanel"
        ref={contentRef}
        aria-label={tab === "alerts" ? `${visible.length} 个警报` : "交易日志"}
        className="alert-panel-content"
      >
        {tab === "alerts" ? (
          <>
            {!visible.length && (
              <div className="alert-empty">
                <Bell size={32} aria-hidden />
                <p>没有符合筛选条件的警报</p>
                <button disabled={readonly} onClick={onRequest}>
                  创建警报
                </button>
              </div>
            )}
            {visible.map((row) => (
              <article
                key={row.id}
                className={`chart-alert-card ${selected === row.id ? "alert-selected" : ""}`}
              >
                <AlertSummary row={row} zone={zone} theme={theme}>
                  <button
                    className="alert-row-summary"
                    aria-pressed={selected === row.id}
                    onClick={() => {
                      setSelected(row.id);
                      onLocate(row);
                    }}
                    onDoubleClick={() => {
                      if (!readonly) edit(row);
                    }}
                  >
                    <span className="alert-row-title">
                      {row.name || row.condition_summary}
                    </span>
                    <span className="alert-row-subtitle">
                      <AlertSymbolIcon
                        code={alertCode(row, row.config.instrument)}
                      />
                      <span
                        className="alert-row-identity"
                        title={row.display_label || row.name}
                      >
                        {alertCode(row, row.name)}
                      </span>
                      <span aria-hidden>·</span>
                      <span
                        className={`alert-state alert-state-${row.status} ${row.status === "active" && row.health !== "ready" ? "alert-state-unhealthy" : ""}`}
                      >
                        {alertState(row)}
                      </span>
                    </span>
                  </button>
                </AlertSummary>
                <div
                  className="alert-row-actions"
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  {["active", "paused", "completed"].includes(row.status) && (
                    <button
                      aria-label={
                        row.status === "active"
                          ? "暂停"
                          : row.status === "paused"
                            ? "恢复"
                            : "重新启用（新一轮）"
                      }
                      disabled={readonly || busy === row.id}
                      onClick={() =>
                        action(
                          row,
                          row.status === "active"
                            ? "pause"
                            : row.status === "paused"
                              ? "resume"
                              : "restart",
                        )
                      }
                    >
                      {row.status === "active" ? (
                        <Pause size={15} aria-hidden />
                      ) : (
                        <Play size={15} aria-hidden />
                      )}
                    </button>
                  )}
                  <button
                    aria-label="编辑"
                    disabled={readonly || busy === row.id}
                    onClick={() => edit(row)}
                  >
                    <Settings2 size={15} aria-hidden />
                  </button>
                  <button
                    aria-label="删除"
                    disabled={readonly || busy === row.id}
                    onClick={() => void action(row, "archive")}
                  >
                    <Trash2 size={15} aria-hidden />
                  </button>
                  <AlertMenu
                    label={`${row.name} 行操作`}
                    items={[
                      { label: "定位图表", run: () => onLocate(row) },
                      {
                        label: "查看详情",
                        run: () => setDetail(detail === row.id ? null : row.id),
                      },
                      {
                        label: "复制为草稿",
                        run: () => edit(row, true),
                        disabled: readonly,
                      },
                      ...(row.config.association?.object_kind === "drawing" &&
                      associationNotices[row.id]
                        ? [
                            {
                              label: "重试画线提交",
                              run: () => onDrawingAction(row, "retry"),
                              disabled: readonly,
                            },
                            {
                              label: "恢复后台画线",
                              run: () => onDrawingAction(row, "restore"),
                              disabled: readonly,
                            },
                          ]
                        : []),
                      ...(row.status === "active" && row.health === "blocked"
                        ? [
                            {
                              label: "核对后重建基准（保留次数）",
                              run: () => {
                                void action(row, "rebaseline");
                              },
                              disabled: readonly || busy === row.id,
                            },
                          ]
                        : []),
                      {
                        label: "删除",
                        divider: true,
                        run: () => {
                          void action(row, "archive");
                        },
                        disabled: readonly || busy === row.id,
                      },
                    ]}
                  >
                    <MoreHorizontal size={15} aria-hidden />
                  </AlertMenu>
                </div>
                {associationNotices[row.id] && (
                  <p className="alert-error">{associationNotices[row.id]}</p>
                )}
              </article>
            ))}
          </>
        ) : (
          <>
            {!filteredEvents.length && (
              <div className="alert-empty">
                <Clock3 size={32} aria-hidden />
                <p>尚无触发事件</p>
              </div>
            )}
            {[...grouped].map(([day, entries]) => (
              <section key={day} className="alert-event-day">
                <h3>
                  {day.slice(0, 4) === dayKey(Date.now(), zone).slice(0, 4)
                    ? `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日`
                    : `${day.slice(0, 4)}年${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日`}
                </h3>
                {entries.map((event) => (
                  <article
                    key={event.id}
                    data-signal-id={event.id}
                    data-notice-id={
                      event.notice && !event.notice.viewed_at
                        ? event.notice.id
                        : undefined
                    }
                    className={`chart-alert-card ${selected === event.id ? "alert-selected" : ""}`}
                  >
                    <AlertSummary event={event} zone={zone} theme={theme}>
                      <button
                        className="alert-row-summary"
                        aria-pressed={selected === event.id}
                        onClick={() => {
                          setSelected(event.id);
                          const row = rows.find(
                            (row) => row.id === event.alert_id,
                          );
                          if (row) onLocate(row, event);
                        }}
                        onDoubleClick={() =>
                          setDetail(detail === event.id ? null : event.id)
                        }
                      >
                        <span className="alert-row-title">
                          {eventPresentation(event).name}
                        </span>
                        <span className="alert-row-subtitle">
                          <AlertSymbolIcon
                            code={alertCode(
                              event,
                              event.evidence.config.instrument,
                            )}
                          />
                          <span
                            className="alert-row-identity"
                            title={event.display_label}
                          >
                            {alertCode(event, event.evidence.config.name)}
                          </span>
                          <span aria-hidden>·</span>
                          <span className="alert-row-time">
                            {clockTime(event.occurred_at, zone)}
                            {event.evidence.late ? " · 迟到" : ""}
                          </span>
                        </span>
                      </button>
                    </AlertSummary>
                    <div className="alert-row-actions">
                      <button
                        aria-label="从日志列表移除"
                        title={
                          !event.notice
                            ? "记录尚未投影或已超出整理保留期"
                            : "从默认日志列表移除；不停止手机提醒"
                        }
                        disabled={
                          readonly ||
                          cleaning ||
                          !noticeRequest ||
                          !event.notice ||
                          !!event.notice.handled_at ||
                          cleared.has(event.id)
                        }
                        onClick={() => setCleanup([event])}
                      >
                        <Trash2 size={15} aria-hidden />
                      </button>
                      <AlertMenu
                        label="日志详情"
                        items={[
                          {
                            label: "查看详情",
                            run: () =>
                              setDetail(detail === event.id ? null : event.id),
                          },
                        ]}
                      >
                        <MoreHorizontal size={15} aria-hidden />
                      </AlertMenu>
                    </div>
                  </article>
                ))}
              </section>
            ))}
          </>
        )}
      </div>
      {detail && (
        <section
          className="alert-detail-drawer"
          aria-label="告警详情"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setDetail(null);
            }
          }}
        >
          <button autoFocus onClick={() => setDetail(null)}>
            关闭详情
          </button>
          {tab === "alerts"
            ? rows
                .filter((row) => row.id === detail)
                .map((row) => <div key={row.id}>{rowDetails(row)}</div>)
            : events
                .filter((event) => event.id === detail)
                .map((event) => (
                  <div key={event.id}>{eventDetails(event)}</div>
                ))}
        </section>
      )}
    </aside>
  );
  return (
    <>
      {mountTarget
        ? createPortal(panel, mountTarget)
        : mountTarget === undefined
          ? panel
          : null}
      {cleanup && (
        <AlertLogCleanup
          ownerDocument={mountTarget?.ownerDocument || document}
          count={cleanup.length}
          busy={cleaning}
          theme={theme}
          onClose={() => setCleanup(null)}
          onConfirm={() => void clearEvents(cleanup)}
        />
      )}
      {formOpen && draft && (
        <ChartAlertDialog
          key={draft.requestId}
          initial={draft.config}
          displayLabel={draft.displayLabel}
          displayCode={draft.displayCode}
          automaticName={draft.automaticName === true}
          onAutomaticName={(automaticName) =>
            setDraft((previous) =>
              previous ? { ...previous, automaticName } : null,
            )
          }
          requestId={draft.requestId}
          editing={draft.editing}
          request={request}
          nativeDialog={nativeDialog}
          onOpenError={(message) => {
            setError(message);
            setFormOpen(false);
          }}
          onDelete={
            draft.editing
              ? async () => {
                  const row = rows.find((row) => row.id === draft.editing?.id);
                  if (!row) throw Error("告警已改变，请刷新列表后重试");
                  const error = await action(row, "archive");
                  if (error) throw Error(error);
                  setDraft(null);
                  setFormOpen(false);
                }
              : undefined
          }
          theme={theme}
          onDraft={(config) =>
            setDraft((previous) => (previous ? { ...previous, config } : null))
          }
          onClose={() => setFormOpen(false)}
          onReload={(row) => {
            commit(row);
            setDraft((previous) =>
              previous
                ? { ...previous, editing: { id: row.id, version: row.version } }
                : null,
            );
          }}
          onSaved={(row) => {
            commit(row);
            setDraft(null);
            setFormOpen(false);
            setFeedback(
              `${row.name}：已保存版本 ${row.version}，${healthNames[row.health]}${row.health_reason ? `（${row.health_reason}）` : ""}`,
            );
            void refresh();
          }}
        />
      )}
    </>
  );
}
