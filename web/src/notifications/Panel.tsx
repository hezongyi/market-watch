import { useContext, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Bell,
  ChevronLeft,
  Filter,
  MoreHorizontal,
  Search,
  Settings,
  Wifi,
  X,
} from "lucide-react";
import {
  AlertButton,
  AlertCheckbox,
  AlertInput,
  AlertSelect,
  AlertSearch,
  AlertIconButton,
  NativeScrollClass,
} from "../advanced/NativeAlertControls";
import { AlertMenu } from "../advanced/AlertMenu";
import type {
  HistoryPage,
  Notice,
  NoticeState,
  NoticeTransport,
} from "./types";
import { severityLabels, sourceLabels, noticeInstrument } from "./types";
import "./notifications.css";
import { SystemOccurrences } from "./SystemOccurrences";
import { messageIcons } from "./icons";
import { useSystemHistory } from "./useSystemHistory";
const time = (value: number | null | undefined) =>
  value ? new Date(value).toLocaleString() : "未知";
const utc = (value: number | null | undefined) =>
  value ? new Date(value).toISOString() : "未知";
const system = (row: Notice) => row.source_kind !== "chart_alert";
const observationLabels: Record<string, string> = {
  received: "网页收到",
  rendered: "网页可见渲染",
  viewed: "标为已读",
  handled: "用户标为已处理",
  phone_state: "手机提醒状态",
  phone_attempt: "手机发送尝试",
  phone_received: "设备报告收到",
  sound_blocked: "声音受阻",
  sound_suppressed: "声音未安排",
  sound_expired: "声音已过期",
  sound_reserved: "声音尝试已预留",
  sound_started: "AudioContext 已开始",
  sound_failed: "声音尝试失败",
  sound_unknown: "声音结果未知",
  sound_manual: "用户手动重播",
};
function SourceIcon({ row }: { row: Notice }) {
  const Icon =
    row.source_kind === "connection"
      ? Wifi
      : row.severity === "info" || row.incident?.closed_at
        ? Bell
        : AlertTriangle;
  return <Icon size={18} aria-hidden />;
}
export function NoticePanel({
  state,
  request,
  eventId,
  onClose,
  onLocate,
  active = true,
  nativePresentation = false,
  focusOnOpen = true,
}: {
  state: NoticeState;
  request: NoticeTransport;
  active?: boolean;
  nativePresentation?: boolean;
  focusOnOpen?: boolean;
  eventId?: string;
  onClose: () => void;
  onLocate?: (notice: Notice) => void | Promise<void>;
}) {
  const [debugOpen, setDebugOpen] = useState(false);
  const [pagedPage, setPage] = useState<HistoryPage | null>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [selection, setSelection] = useState(eventId || ""),
    [settings, setSettings] = useState(false),
    [advanced, setAdvanced] = useState(false);
  const [detail, setDetail] = useState<Notice | null>(null),
    [timeline, setTimeline] = useState<any[]>([]),
    [timelineBefore, setTimelineBefore] = useState<string | null>(null);
  const [error, setError] = useState(""),
    [working, setBusy] = useState(false);
  const [before, setBefore] = useState<string | null>(null),
    [previous, setPrevious] = useState<(string | null)[]>([]);
  const currentSelection = useRef(selection),
    mounted = useRef(true),
    revision = useRef(0),
    closeButton = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null),
    sentinel = useRef<HTMLDivElement>(null);
  const scrollClass = useContext(NativeScrollClass);
  const filterKey = JSON.stringify(filters);
  const history = useSystemHistory({
    request,
    filters,
    epoch: state.epoch,
    revision: state.revision,
    enabled: nativePresentation && active && !settings,
  });
  const page = nativePresentation ? history.page : pagedPage;
  const busy =
    working || (nativePresentation && (history.loading || history.loadingMore));
  const problem = error || (nativePresentation ? history.error : "");
  const scrollStyle =
    nativePresentation && scrollClass ? " " + scrollClass : "";
  currentSelection.current = selection;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      revision.current++;
    };
  }, []);
  useEffect(() => {
    setSelection(eventId || "");
    setSettings(false);
  }, [eventId]);
  useEffect(() => {
    if (active && focusOnOpen) closeButton.current?.focus();
  }, [active, focusOnOpen]);
  useEffect(() => {
    setBefore(null);
    setPrevious([]);
    setPage(null);
  }, [state.epoch]);
  useEffect(() => {
    if (!active || settings || nativePresentation) return;
    const current = ++revision.current;
    setError("");
    setBusy(true);
    // Debounce text input without delaying reads, filters or pagination.
    const timer = setTimeout(
      () => {
        void request({ action: "history", filters, before })
          .then((result) => {
            if (mounted.current && revision.current === current)
              setPage(result);
          })
          .catch((error) => {
            if (!mounted.current || revision.current !== current) return;
            if (
              error?.code === "NOTICE_RESET" ||
              String(error).includes("NOTICE_RESET")
            ) {
              setBefore(null);
              setPrevious([]);
              setPage(null);
            }
            setError(String(error));
          })
          .finally(() => {
            if (mounted.current && revision.current === current) setBusy(false);
          });
      },
      filters.q ? 250 : 0,
    );
    return () => {
      clearTimeout(timer);
      revision.current++;
    };
  }, [
    request,
    filterKey,
    before,
    state.revision,
    state.epoch,
    active,
    settings,
    nativePresentation,
  ]);
  useEffect(() => {
    if (nativePresentation && list.current) list.current.scrollTop = 0;
  }, [nativePresentation, filterKey, state.epoch]);
  useEffect(() => {
    if (
      !nativePresentation ||
      !active ||
      settings ||
      selection ||
      !page?.before ||
      history.loading ||
      history.loadingMore ||
      history.error ||
      history.moreError ||
      !list.current ||
      !sentinel.current
    )
      return;
    const observer =
      new list.current.ownerDocument.defaultView!.IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) history.loadMore();
        },
        { root: list.current, rootMargin: "0px 0px 80px 0px" },
      );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [
    nativePresentation,
    active,
    settings,
    selection,
    page?.before,
    history.loading,
    history.loadingMore,
    history.error,
    history.moreError,
    history.loadMore,
  ]);
  useEffect(() => {
    if (!selection || !active) {
      setDetail(null);
      return;
    }
    let alive = true;
    setDetail((old) => (old?.id === selection ? old : null));
    void Promise.all([
      request({ action: "detail", event_id: selection }),
      request({ action: "timeline", event_id: selection }),
    ])
      .then(([row, line]) => {
        if (!alive) return;
        if (!system(row)) throw Error("交易告警请在右侧告警模块查看");
        setDetail(row);
        setTimeline(line.observations);
        setTimelineBefore(line.before);
      })
      .catch((error) => {
        if (alive) setError(String(error));
      });
    return () => {
      alive = false;
    };
  }, [request, selection, state.revision, state.epoch, active]);
  useEffect(() => {
    if (!selection || !active) return;
    let alive = true;
    void request({ action: "detail", event_id: selection })
      .then((row) => {
        if (alive && system(row))
          return request({
            action: "read-system",
            through: row.first_seq,
            epoch: state.epoch,
            incident_id: row.incident_id,
          });
      })
      .catch((error) => {
        if (alive) setError(String(error));
      });
    return () => {
      alive = false;
    };
  }, [request, selection, active]);
  const setFilter = (key: string, value: string) => {
    setFilters((old) => ({ ...old, [key]: value }));
    setBefore(null);
    setPrevious([]);
  };
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      if (mounted.current) setError(String(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const readAll = () =>
    page &&
    void run(() =>
      request({
        action: "read-system",
        through: page.highwater,
        epoch: page.epoch,
      }),
    );
  const rows = (page?.events || []).filter(system),
    pending = state.pending.filter(system);
  const date = (row: Notice) => new Date(row.occurred_at).toLocaleDateString();
  return (
    <section
      className={"nc-panel" + (nativePresentation ? " nc-native-panel" : "")}
      aria-label="系统消息"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        if (settings) setSettings(false);
        else if (selection) setSelection("");
        else onClose();
      }}
    >
      <header className="nc-heading">
        <h2>{settings ? "系统消息设置" : "系统消息"}</h2>
        {!settings && (
          <small>{state.unread ? `${state.unread} 条未读` : "全部已读"}</small>
        )}
        <div className="nc-heading-tools">
          {!settings && (
            <>
              {nativePresentation ? (
                <AlertIconButton
                  icon={messageIcons.settings}
                  label="系统消息设置"
                  onClick={() => setSettings(true)}
                />
              ) : (
                <button
                  type="button"
                  className="nc-icon"
                  aria-label="系统消息设置"
                  onClick={() => setSettings(true)}
                >
                  <Settings size={18} aria-hidden />
                </button>
              )}
              <AlertMenu
                label="系统消息操作"
                icon={nativePresentation ? messageIcons.more : undefined}
                items={[
                  {
                    label: "全部标为已读",
                    disabled: busy || !page || !state.unread,
                    run: readAll,
                  },
                  { label: "系统消息设置", run: () => setSettings(true) },
                ]}
              >
                <MoreHorizontal size={18} aria-hidden />
              </AlertMenu>
            </>
          )}
          {nativePresentation ? (
            <AlertIconButton
              icon={messageIcons.close}
              label="关闭系统消息"
              reference={(node) => {
                closeButton.current = node;
              }}
              onClick={onClose}
            />
          ) : (
            <button
              ref={closeButton}
              type="button"
              className="nc-icon"
              aria-label="关闭系统消息"
              onClick={onClose}
            >
              <X size={18} aria-hidden />
            </button>
          )}
        </div>
      </header>
      {state.gap && (
        <p className="nc-problem" role="alert">
          {state.gap}
        </p>
      )}
      {problem && (
        <p className="nc-problem" role="alert">
          {problem}
        </p>
      )}
      {settings ? (
        <div className={"nc-detail nc-settings" + scrollStyle}>
          <button
            type="button"
            className="nc-back"
            onClick={() => setSettings(false)}
          >
            <ChevronLeft size={16} aria-hidden />
            返回系统消息
          </button>
          <h3>系统消息</h3>
          <AlertCheckbox
            label="异常即时提示"
            checked={state.systemPopups}
            onChange={(enabled) =>
              void run(() => request({ action: "system-popups", enabled }))
            }
          />
          <p className="nc-muted">
            首次异常或严重程度升级时，使用顶部居中浮窗。重复异常合并计数；普通状态变化只保留记录，恢复后更新原记录。
          </p>
          <h3>交易告警</h3>
          <p className="nc-muted">
            在右侧告警模块中查询和管理，触发时共用顶部居中的即时浮窗。此处的开关只控制系统消息。
          </p>
        </div>
      ) : selection ? (
        detail ? (
          <div className={"nc-detail" + scrollStyle}>
            <button
              type="button"
              className="nc-back"
              onClick={() => setSelection("")}
            >
              <ChevronLeft size={16} aria-hidden />
              系统消息
            </button>
            <p className="nc-detail-source">
              <SourceIcon row={detail} />
              {sourceLabels[detail.source_kind]}
              {detail.instrument && ` · ${noticeInstrument(detail)}`}
            </p>
            <h3>{detail.title}</h3>
            <p>{detail.message}</p>
            <dl className="nc-values">
              <dt>当前状态</dt>
              <dd>
                {detail.incident?.closed_at
                  ? "已恢复"
                  : detail.handled_at
                    ? "已处理"
                    : "仍需关注"}
              </dd>
              <dt>首次发生</dt>
              <dd>{time(detail.incident?.first_at || detail.occurred_at)}</dd>
              <dt>最近发生</dt>
              <dd>{time(detail.incident?.last_at || detail.occurred_at)}</dd>
              <dt>累计发生</dt>
              <dd>{detail.incident?.count || 1} 次</dd>
            </dl>
            <div className="nc-actions">
              {onLocate && detail.workspace && (
                <AlertButton
                  primary
                  onClick={() =>
                    void run(async () => {
                      await onLocate(detail);
                    })
                  }
                >
                  {["workspace", "preferences", "chart_shell"].includes(
                    detail.source_kind,
                  )
                    ? "返回专业图表"
                    : detail.source_kind === "capacity"
                      ? "打开历史容量设置"
                      : detail.source_kind === "data_center" ||
                          detail.context.consumer === "quotes" ||
                          detail.context.timeframe === "quotes"
                        ? "打开数据中心"
                        : "查看相关图表"}
                </AlertButton>
              )}
              <AlertButton
                disabled={busy || !!detail.handled_at}
                onClick={() =>
                  void run(() =>
                    request({
                      action: "observe",
                      event_id: detail.id,
                      kind: "handled",
                    }),
                  )
                }
              >
                {detail.handled_at ? "已处理" : "标为已处理"}
              </AlertButton>
            </div>
            <p className="nc-muted">{detail.workspace}</p>
            <details
              className="nc-debug"
              onToggle={(event) => setDebugOpen(event.currentTarget.open)}
            >
              <summary>排查详情</summary>
              <dl>
                <dt>事件 ID / 事故 ID</dt>
                <dd>
                  {detail.id} / {detail.incident_id}
                </dd>
                <dt>
                  发生时间{detail.client_reported_time ? "（客户端报告）" : ""}
                </dt>
                <dd>
                  {time(detail.occurred_at)}
                  <small>{utc(detail.occurred_at)}</small>
                </dd>
                <dt>服务端记录</dt>
                <dd>
                  {time(detail.recorded_at)}
                  <small>{utc(detail.recorded_at)}</small>
                </dd>
                <dt>已读 / 处理</dt>
                <dd>
                  {time(detail.viewed_at)} / {time(detail.handled_at)}
                </dd>
                <dt>来源身份</dt>
                <dd>
                  {detail.source_kind} / {detail.source_id}
                </dd>
              </dl>
              <pre>
                {JSON.stringify(
                  {
                    context: detail.context,
                    evidence: detail.evidence,
                    original_evidence: detail.original_evidence,
                  },
                  null,
                  2,
                )}
              </pre>
              {debugOpen && (
                <SystemOccurrences
                  key={detail.incident_id}
                  incident={detail.incident_id}
                  request={request}
                />
              )}
              <h3>排查时间线</h3>
              <ol className="nc-timeline">
                {timeline.map((row) => (
                  <li key={row.id}>
                    <strong>{observationLabels[row.kind] || row.kind}</strong>
                    <time>{time(row.received_at)}</time>
                    <small>
                      客户端报告：{time(row.reported_at)} · {row.profile}
                    </small>
                    <pre>{JSON.stringify(row.details, null, 2)}</pre>
                  </li>
                ))}
              </ol>
              {timelineBefore && (
                <AlertButton
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const line = await request({
                        action: "timeline",
                        event_id: detail.id,
                        before: timelineBefore,
                      });
                      if (
                        mounted.current &&
                        currentSelection.current === line.event_id
                      ) {
                        setTimeline((old) => [...old, ...line.observations]);
                        setTimelineBefore(line.before);
                      }
                    })
                  }
                >
                  更早的记录
                </AlertButton>
              )}
            </details>
          </div>
        ) : (
          <p className="nc-empty">正在读取系统消息…</p>
        )
      ) : (
        <>
          <div className="nc-search">
            {!nativePresentation && <Search size={16} aria-hidden />}
            {nativePresentation ? (
              <AlertSearch
                autoFocus={false}
                aria-label="搜索系统消息"
                placeholder="搜索系统消息"
                value={filters.q || ""}
                maxLength={120}
                onChange={(event) => setFilter("q", event.target.value)}
              />
            ) : (
              <AlertInput
                type="search"
                aria-label="搜索系统消息"
                placeholder="搜索系统消息"
                value={filters.q || ""}
                maxLength={120}
                onChange={(event) => setFilter("q", event.target.value)}
              />
            )}
            <AlertMenu
              label="筛选系统消息"
              icon={nativePresentation ? messageIcons.filter : undefined}
              items={[
                {
                  label: "全部消息",
                  checked: !filters.state && !filters.workspace,
                  run: () => {
                    setFilters({});
                    setBefore(null);
                    setPrevious([]);
                  },
                },
                {
                  label: "仅未读",
                  checked: filters.state === "unread",
                  run: () =>
                    setFilter(
                      "state",
                      filters.state === "unread" ? "" : "unread",
                    ),
                },
                {
                  label: "更多筛选",
                  checked: advanced,
                  run: () => setAdvanced((value) => !value),
                },
              ]}
            >
              <Filter size={18} aria-hidden />
            </AlertMenu>
          </div>
          {filters.state === "unread" && (
            <div className="nc-filter-status">
              仅未读
              <button
                type="button"
                className="nc-link"
                onClick={() => setFilter("state", "")}
              >
                清除
              </button>
            </div>
          )}
          {advanced && (
            <div className={"nc-filters" + scrollStyle}>
              <label>
                级别
                <AlertSelect
                  aria-label="系统消息级别"
                  value={filters.severity || ""}
                  onChange={(e) => setFilter("severity", e.target.value)}
                >
                  <option value="">全部</option>
                  {Object.entries(severityLabels).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </AlertSelect>
              </label>
              <label>
                来源
                <AlertSelect
                  aria-label="系统消息来源"
                  value={filters.source || ""}
                  onChange={(e) => setFilter("source", e.target.value)}
                >
                  <option value="">全部</option>
                  {Object.entries(sourceLabels)
                    .filter(([key]) => key !== "chart_alert")
                    .map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                </AlertSelect>
              </label>
              <label>
                品种
                <AlertInput
                  aria-label="系统消息品种"
                  value={filters.instrument || ""}
                  onChange={(e) => setFilter("instrument", e.target.value)}
                />
              </label>
              <label>
                工作区
                <AlertInput
                  aria-label="系统消息工作区"
                  value={filters.workspace || ""}
                  onChange={(e) => setFilter("workspace", e.target.value)}
                />
              </label>
              <label>
                起始时间
                <AlertInput
                  type="datetime-local"
                  aria-label="起始时间"
                  onChange={(e) =>
                    setFilter(
                      "since",
                      e.target.value
                        ? String(new Date(e.target.value).getTime())
                        : "",
                    )
                  }
                />
              </label>
              <label>
                截止时间
                <AlertInput
                  type="datetime-local"
                  aria-label="截止时间"
                  onChange={(e) =>
                    setFilter(
                      "until",
                      e.target.value
                        ? String(new Date(e.target.value).getTime())
                        : "",
                    )
                  }
                />
              </label>
            </div>
          )}
          <div ref={list} className={"nc-list" + scrollStyle} aria-busy={busy}>
            {!before &&
              pending.map((row) => (
                <article className="nc-row nc-pending" key={row.id}>
                  <SourceIcon row={row} />
                  <div className="nc-row-copy">
                    <strong>{row.title}</strong>
                    <span>{row.message}</span>
                    <small>
                      {row.local_status === "accepted"
                        ? "服务端已接收，等待投影"
                        : row.local_status === "rejected"
                          ? "服务端拒绝，本机证据保留"
                          : "仅本机待同步"}{" "}
                      · {time(row.occurred_at)}
                    </small>
                  </div>
                </article>
              ))}
            {rows.map((row, index) => (
              <div key={row.id}>
                {(!index || date(row) !== date(rows[index - 1])) && (
                  <div className="nc-day">{date(row)}</div>
                )}
                <button
                  type="button"
                  className={"nc-row " + (!row.viewed_at ? "nc-unread" : "")}
                  onClick={() => setSelection(row.id)}
                >
                  <span className={"nc-source nc-" + row.severity}>
                    <SourceIcon row={row} />
                    {!row.viewed_at && <i />}
                  </span>
                  <span className="nc-row-copy">
                    <span className="nc-row-meta">
                      <strong>{noticeInstrument(row)}</strong>
                      <time>
                        {new Date(row.occurred_at).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    </span>
                    <span>{row.title}</span>
                    <small>
                      {row.incident?.closed_at
                        ? "已恢复"
                        : sourceLabels[row.source_kind]}
                      {row.incident && row.incident.count > 1
                        ? ` · 累计 ${row.incident.count} 次`
                        : ""}
                      {row.backfill ? " · 历史记录" : ""}
                    </small>
                  </span>
                </button>
              </div>
            ))}
            {!rows.length && !pending.length && (
              <div className="nc-empty">
                <Bell size={28} aria-hidden />
                <p>{busy ? "正在读取系统消息…" : "没有符合条件的系统消息"}</p>
              </div>
            )}
            {nativePresentation && !!rows.length && (
              <div ref={sentinel} className="nc-load-status" role="status">
                {history.moreError ? (
                  <>
                    <span>暂时无法加载更早消息</span>
                    <AlertButton onClick={history.loadMore}>
                      重试加载
                    </AlertButton>
                  </>
                ) : history.loadingMore ? (
                  "正在加载更早消息…"
                ) : page?.before ? (
                  "向下滚动加载更早消息"
                ) : (
                  "已显示全部消息"
                )}
              </div>
            )}
          </div>
          {!nativePresentation &&
            page &&
            (previous.length > 0 || page.before) && (
              <div className="nc-pagination">
                <AlertButton
                  disabled={busy || !previous.length}
                  onClick={() => {
                    setBefore(previous[previous.length - 1]);
                    setPrevious((old) => old.slice(0, -1));
                  }}
                >
                  上一页
                </AlertButton>
                <small>第 {previous.length + 1} 页</small>
                <AlertButton
                  disabled={busy || !page.before}
                  onClick={() => {
                    setPrevious((old) => [...old, before]);
                    setBefore(page.before);
                  }}
                >
                  下一页
                </AlertButton>
              </div>
            )}
        </>
      )}
      <footer className="nc-footer">
        <span role="status">
          {state.status}
          {pending.length ? ` · ${pending.length} 条本机记录` : ""} · 保留 30 天
        </span>
        {!settings && !selection && (
          <AlertButton
            disabled={busy || !page || !state.unread}
            onClick={readAll}
          >
            全部标为已读
          </AlertButton>
        )}
      </footer>
    </section>
  );
}
export function NoticeBubble({
  notice,
  request,
  onOpen,
  onLocate,
}: {
  notice: Notice;
  request: NoticeTransport;
  onOpen: () => void | Promise<void>;
  onLocate?: () => void | Promise<void>;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    inside = useRef(false),
    hovered = useRef(false);
  const [error, setError] = useState("");
  const dismiss = () => {
    void request({ action: "dismiss" }).catch((error) =>
      setError(String(error)),
    );
  };
  const pause = () => {
    if (timer.current) clearTimeout(timer.current);
  };
  const resume = () => {
    pause();
    if (!inside.current && !hovered.current)
      timer.current = setTimeout(dismiss, 8000);
  };
  useEffect(() => {
    setError("");
    resume();
    return pause;
  }, [notice.id]);
  useEffect(() => {
    if (document.visibilityState === "visible")
      void request({ action: "rendered", event_id: notice.id }).catch((error) =>
        setError(String(error)),
      );
  }, [notice.id, request]);
  const open = async (action: () => void | Promise<void>) => {
    try {
      await action();
      dismiss();
    } catch (error) {
      setError(String(error));
    }
  };
  return (
    <aside
      className="nc-bubble"
      aria-label="即时通知"
      onMouseEnter={() => {
        hovered.current = true;
        pause();
      }}
      onMouseLeave={() => {
        hovered.current = false;
        resume();
      }}
      onFocus={() => {
        inside.current = true;
        pause();
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
          inside.current = false;
          resume();
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          dismiss();
        }
      }}
    >
      <div className="nc-bubble-heading">
        <SourceIcon row={notice} />
        <strong>
          {system(notice) ? "系统消息" : noticeInstrument(notice) || "交易告警"}
        </strong>
        <small>
          {String(
            notice.context.timeframe || sourceLabels[notice.source_kind] || "",
          )}
        </small>
        <button
          type="button"
          className="nc-icon"
          aria-label="关闭即时通知"
          onClick={dismiss}
        >
          <X size={16} aria-hidden />
        </button>
      </div>
      <div role="status" aria-live="polite" aria-atomic="true">
        <h3>{notice.title}</h3>
        <p>
          {system(notice)
            ? notice.message
            : [
                notice.message,
                notice.evidence.left != null
                  ? `${notice.evidence.unit === "price" ? "触发价" : notice.evidence.unit === "price_delta" ? "价差" : "指标值"} ${notice.evidence.left}`
                  : "",
                notice.evidence.threshold != null
                  ? `比较值 ${notice.evidence.threshold}`
                  : "",
              ]
                .filter(Boolean)
                .join(" · ")}
        </p>
      </div>
      {error && (
        <p className="nc-problem" role="alert">
          {error}
        </p>
      )}
      <div className="nc-bubble-actions">
        {onLocate && (
          <AlertButton primary onClick={() => void open(onLocate)}>
            查看图表
          </AlertButton>
        )}
        <button
          type="button"
          className="nc-link"
          onClick={() => void open(onOpen)}
        >
          {system(notice) ? "查看消息" : "告警记录"}
        </button>
        <small>
          {new Date(notice.occurred_at).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </small>
      </div>
    </aside>
  );
}
