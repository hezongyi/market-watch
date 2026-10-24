import { useContext, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Bell,
  ChevronLeft,
  MoreHorizontal,
  Wifi,
} from "lucide-react";
import {
  AlertButton,
  AlertCheckbox,
  AlertSelect,
  AlertSearch,
  AlertIconButton,
  NativeScrollClass,
  NativeControl,
} from "../advanced/NativeAlertControls";
import { AlertMenu } from "../advanced/AlertMenu";
import type { Notice, NoticeState, NoticeTransport } from "./types";
import { severityLabels, sourceLabels, noticeInstrument } from "./types";
import "./notifications.css";
import { SystemOccurrences } from "./SystemOccurrences";
import { messageIcons } from "./icons";
import { useSystemHistory, type SystemHistoryCache } from "./useSystemHistory";
import { NoticeTimestamp } from "./Timestamp";
import { systemPopupDurations, systemPopupSeconds } from "./preferences";
import { useChartTime } from "../time/ChartTimeContext";
import { formatTimestamp, dayKey } from "../time/chartTime";
import {
  newestFirst,
  matchesSystemFilters,
  systemListFilters,
  type SystemFilters,
} from "./systemMessages";
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
  historyCache,
}: {
  state: NoticeState;
  request: NoticeTransport;
  active?: boolean;
  historyCache?: SystemHistoryCache;
  eventId?: string;
  onClose: () => void;
  onLocate?: (notice: Notice) => void | Promise<void>;
}) {
  const { zone } = useChartTime();
  const time = (value: number | null | undefined) =>
    formatTimestamp(value, zone);
  const [debugOpen, setDebugOpen] = useState(false);
  const [filters, setFilters] = useState<SystemFilters>(
    historyCache?.filters || {},
  );
  const [selection, setSelection] = useState(eventId || ""),
    [settings, setSettings] = useState(false),
    [searchOpen, setSearchOpen] = useState(false);
  const [detail, setDetail] = useState<Notice | null>(null),
    [timeline, setTimeline] = useState<any[]>([]),
    [timelineBefore, setTimelineBefore] = useState<string | null>(null);
  const [error, setError] = useState(""),
    [working, setBusy] = useState(false);
  const currentSelection = useRef(selection),
    mounted = useRef(true);
  const list = useRef<HTMLDivElement>(null),
    sentinel = useRef<HTMLDivElement>(null);
  const scrollClass = useContext(NativeScrollClass);
  const filterKey = JSON.stringify(filters);
  const history = useSystemHistory({
    request,
    filters,
    epoch: state.epoch,
    revision: state.revision,
    enabled: active && !settings,
    historyCache,
  });
  const page = history.page;
  const busy = working || history.loading || history.loadingMore;
  const problem = error || history.error;
  const scrollStyle = scrollClass ? " " + scrollClass : "";
  currentSelection.current = selection;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setSelection(eventId || "");
    setSettings(false);
  }, [eventId]);
  useEffect(() => {
    if (historyCache) historyCache.filters = filters;
    if (list.current) list.current.scrollTop = history.scrollTop;
  }, [filterKey, state.epoch, selection, settings]);
  useEffect(() => {
    if (
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
  const setFilter = (key: keyof SystemFilters, value: string) => {
    setFilters((old) => systemListFilters({ ...old, [key]: value }));
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
    pending = state.pending
      .filter((row) => matchesSystemFilters(row, filters))
      .sort((a, b) =>
        filters.sort === "oldest" ? -newestFirst(a, b) : newestFirst(a, b),
      );
  const filterSummary = [
    filters.state === "unread" ? "未读" : "",
    filters.severity ? severityLabels[filters.severity] : "",
    filters.source ? sourceLabels[filters.source] : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const closeSearch = () => {
    setSearchOpen(false);
    setFilter("q", "");
  };
  const date = (row: Notice) => dayKey(row.occurred_at, zone);
  return (
    <section
      className="nc-panel nc-native-panel"
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
              <AlertIconButton
                icon={messageIcons.settings}
                label="系统消息设置"
                onClick={() => setSettings(true)}
              />
            </>
          )}
          <AlertIconButton
            icon={messageIcons.close}
            label="关闭系统消息"
            onClick={onClose}
          />
        </div>
      </header>
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
            首次异常或严重程度升级时，使用右下角浮窗。重复异常合并计数；普通状态变化只保留记录，恢复后更新原记录。
          </p>
          <label className="nc-popup-duration">
            浮窗显示时长
            <AlertSelect
              aria-label="浮窗显示时长"
              disabled={working}
              value={systemPopupSeconds(state.systemPopupSeconds)}
              onChange={(event) =>
                void run(() =>
                  request({
                    action: "system-popup-seconds",
                    seconds: Number(event.target.value),
                  }),
                )
              }
            >
              {systemPopupDurations.map((seconds) => (
                <option key={seconds} value={seconds}>
                  {seconds} 秒
                </option>
              ))}
            </AlertSelect>
          </label>
          <p className="nc-muted">
            用于下一条系统消息；鼠标悬停或键盘焦点停留时暂停关闭。交易告警须点击“确定”。
          </p>
          <h3>交易告警</h3>
          <p className="nc-muted">
            在右侧告警模块中查询和管理，触发时共用右下角的即时浮窗。此处的开关只控制系统消息。
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
                  : detail.observation_status === "ended"
                    ? "观察已结束，未确认恢复"
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
                <dd>{time(detail.occurred_at)}</dd>
                <dt>服务端记录</dt>
                <dd>{time(detail.recorded_at)}</dd>
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
          <div className="nc-message-toolbar">
            <AlertIconButton
              icon={messageIcons.search}
              label="搜索系统消息"
              expanded={searchOpen}
              onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
            />
            <AlertMenu
              label="系统消息排序"
              icon={messageIcons.sort}
              items={[
                {
                  label: "最新消息在前",
                  checked: filters.sort !== "oldest",
                  run: () => setFilter("sort", ""),
                },
                {
                  label: "最早消息在前",
                  checked: filters.sort === "oldest",
                  run: () => setFilter("sort", "oldest"),
                },
              ]}
            />
            <AlertMenu
              label="筛选系统消息"
              icon={messageIcons.more}
              items={[
                {
                  label: "全部",
                  checked: !filters.state,
                  run: () => setFilter("state", ""),
                },
                {
                  label: "未读",
                  checked: filters.state === "unread",
                  run: () => setFilter("state", "unread"),
                },
                {
                  label: "全部级别",
                  divider: true,
                  checked: !filters.severity,
                  run: () => setFilter("severity", ""),
                },
                ...Object.entries(severityLabels).map(([value, label]) => ({
                  label,
                  checked: filters.severity === value,
                  run: () => setFilter("severity", value),
                })),
                {
                  label: "全部来源",
                  divider: true,
                  checked: !filters.source,
                  run: () => setFilter("source", ""),
                },
                ...Object.entries(sourceLabels)
                  .filter(([value]) => value !== "chart_alert")
                  .map(([value, label]) => ({
                    label,
                    checked: filters.source === value,
                    run: () => setFilter("source", value),
                  })),
              ]}
            />
          </div>
          {searchOpen && (
            <div className="nc-search">
              <AlertSearch
                autoFocus={false}
                maxLength={120}
                aria-label="搜索系统消息内容"
                placeholder="搜索系统消息"
                value={filters.q || ""}
                onChange={(event) => setFilter("q", event.target.value)}
              />
              <AlertIconButton
                icon={messageIcons.close}
                label="关闭搜索"
                onClick={closeSearch}
              />
            </div>
          )}
          {filterSummary && (
            <div className="nc-filter-status">
              <span>{filterSummary}</span>
              <button
                type="button"
                className="nc-link"
                onClick={() =>
                  setFilters((old) =>
                    systemListFilters({ q: old.q || "", sort: old.sort || "" }),
                  )
                }
              >
                清除筛选
              </button>
            </div>
          )}
          <div
            ref={list}
            className={"nc-list" + scrollStyle}
            aria-busy={busy}
            onScroll={(event) =>
              history.saveScroll(event.currentTarget.scrollTop)
            }
          >
            {pending.length > 0 && (
              <div className="nc-section-label">
                本机记录 · {pending.length} 条 · 等待同步
              </div>
            )}
            {pending.map((row) => (
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
                  </small>
                </div>
                <NoticeTimestamp stamp={row.occurred_at} />
              </article>
            ))}
            {pending.length > 0 && rows.length > 0 && (
              <div className="nc-section-label">历史消息</div>
            )}
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
                    </span>
                    <span>{row.title}</span>
                    <small>
                      {row.incident?.closed_at
                        ? "已恢复"
                        : row.observation_status === "ended"
                          ? "观察已结束，未确认恢复"
                          : sourceLabels[row.source_kind]}
                      {row.incident && row.incident.count > 1
                        ? ` · 累计 ${row.incident.count} 次`
                        : ""}
                      {row.backfill ? " · 历史记录" : ""}
                    </small>
                  </span>
                  <NoticeTimestamp stamp={row.occurred_at} />
                </button>
              </div>
            ))}
            {!rows.length && !pending.length && busy && (
              <div
                className="nc-history-placeholder"
                role="status"
                aria-label="正在读取系统消息"
              >
                <p>正在读取系统消息…</p>
                {[0, 1, 2].map((index) => (
                  <div key={index} className="nc-row" aria-hidden="true">
                    <span className="nc-placeholder-icon" />
                    <span className="nc-row-copy">
                      <span />
                      <span />
                    </span>
                  </div>
                ))}
              </div>
            )}
            {!rows.length && !pending.length && !busy && (
              <div className="nc-empty">
                <Bell size={28} aria-hidden />
                <p>
                  {history.error
                    ? "系统消息读取失败，请重试"
                    : "没有符合条件的系统消息"}
                </p>
              </div>
            )}
            {!!rows.length && (
              <div ref={sentinel} className="nc-load-status" role="status">
                {history.moreError ? (
                  <>
                    <span>暂时无法加载更多消息</span>
                    <AlertButton onClick={history.loadMore}>
                      重试加载
                    </AlertButton>
                  </>
                ) : history.loadingMore ? (
                  "正在加载更多消息…"
                ) : page?.before ? (
                  filters.sort === "oldest" ? (
                    "向下滚动加载更新消息"
                  ) : (
                    "向下滚动加载更早消息"
                  )
                ) : (
                  "已显示全部消息"
                )}
              </div>
            )}
          </div>
        </>
      )}
      {problem && <p className="nc-problem" role="alert">{problem}</p>}
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
  pending = 0,
  popupSeconds = 3,
  active = true,
}: {
  notice: Notice;
  pending?: number;
  popupSeconds?: number;
  active?: boolean;
  request: NoticeTransport;
  onOpen: () => void | Promise<void>;
  onLocate?: () => void | Promise<void>;
}) {
  const duration = useRef(systemPopupSeconds(popupSeconds) * 1000);
  const trading = !system(notice);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    inside = useRef(false),
    hovered = useRef(false);
  const [error, setError] = useState("");
  const dismiss = () => {
    void request({ action: "dismiss", event_id: notice.id }).catch((error) =>
      setError(String(error)),
    );
  };
  const pause = () => {
    if (timer.current) clearTimeout(timer.current);
  };
  const resume = () => {
    pause();
    if (active && !trading && !inside.current && !hovered.current)
      timer.current = setTimeout(dismiss, duration.current);
  };
  useEffect(() => {
    setError("");
    resume();
    return pause;
  }, [notice.id, active]);
  useEffect(() => {
    if (active && document.visibilityState === "visible")
      void request({ action: "rendered", event_id: notice.id }).catch((error) =>
        setError(String(error)),
      );
  }, [notice.id, request, active]);
  const open = async (action: () => void | Promise<void>) => {
    try {
      await action();
      if (!trading) dismiss();
    } catch (error) {
      setError(String(error));
    }
  };
  const confirm = async () => {
    try {
      await request({ action: "confirm-alert", event_id: notice.id });
    } catch (error) {
      setError(String(error));
    }
  };
  return (
    <aside
      className="nc-bubble nc-native-bubble"
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
        if (event.key === "Escape" && !trading) {
          event.stopPropagation();
          dismiss();
        }
      }}
    >
      <div className="nc-bubble-heading">
        <span
          className="nc-bubble-symbol"
          aria-hidden
          dangerouslySetInnerHTML={{
            __html: trading ? messageIcons.trade : messageIcons.bell,
          }}
        />
        <strong>{system(notice) ? "系统消息" : "交易告警"}</strong>
        {!trading && (
          <span className="nc-instant-close">
            <AlertIconButton
              icon={messageIcons.close}
              label="关闭即时通知"
              onClick={dismiss}
            />
          </span>
        )}
      </div>
      <div role="status" aria-live="polite" aria-atomic="true">
        <h3>{notice.title}</h3>
        {system(notice) && notice.instrument && <p>{noticeInstrument(notice)}</p>}
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
      {trading && pending > 0 && (
        <p className="nc-pending" role="status">
          另有 {pending} 条交易告警待确认
        </p>
      )}
      <div className="nc-bubble-time">
        <NoticeTimestamp stamp={notice.occurred_at} />
      </div>
      {trading && (
        <div className="nc-bubble-actions">
          {trading && onLocate && (
            <button
              type="button"
              className="nc-link"
              onClick={() => void open(onLocate)}
            >
              查看图表
            </button>
          )}
          {trading && (
            <button
              type="button"
              className="nc-link"
              onClick={() => void open(onOpen)}
            >
              告警记录
            </button>
          )}
          <NativeControl
            kind="button"
            properties={{
              type: "button",
              size: "m",
              appearance: "default",
              intent: "primary",
              onClick: () => void confirm(),
              children: "确定",
            }}
          />
        </div>
      )}
    </aside>
  );
}
