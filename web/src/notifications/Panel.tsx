import { useEffect, useRef, useState } from "react";
import type {
  HistoryPage,
  Notice,
  NoticeState,
  NoticeTransport,
} from "./types";
import { severityLabels, sourceLabels } from "./types";
import "./notifications.css";
const time = (value: number | null | undefined) =>
  value ? new Date(value).toLocaleString() : "未知";
const utc = (value: number | null | undefined) =>
  value ? new Date(value).toISOString() : "未知";
const observationLabels: Record<string, string> = {
  received: "网页收到",
  rendered: "网页可见渲染",
  viewed: "用户查看",
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
export function NoticePanel({
  state,
  request,
  eventId,
  onClose,
  onLocate,
  active = true,
}: {
  state: NoticeState;
  request: NoticeTransport;
  active?: boolean;
  eventId?: string;
  onClose: () => void;
  onLocate?: (notice: Notice) => void;
}) {
  const [page, setPage] = useState<HistoryPage | null>(null),
    [filters, setFilters] = useState<Record<string, string>>({});
  const [detail, setDetail] = useState<Notice | null>(null),
    [timeline, setTimeline] = useState<any[]>([]),
    [timelineBefore, setTimelineBefore] = useState<string | null>(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [before, setBefore] = useState<string | null>(null);
  const [previous, setPrevious] = useState<(string | null)[]>([]),
    [selection, setSelection] = useState(eventId || "");
  const chosen = useRef(selection);
  chosen.current = selection;
  const revision = useRef(0),
    mounted = useRef(true),
    closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      revision.current++;
    };
  }, []);
  useEffect(() => {
    if (eventId) setSelection(eventId);
  }, [eventId]);
  const filterKey = JSON.stringify(filters);
  useEffect(() => {
    const current = ++revision.current;
    setError("");
    setBusy(true);
    void request({ action: "history", filters, before })
      .then((result) => {
        if (mounted.current && revision.current === current) setPage(result);
      })
      .catch((error) => {
        if (mounted.current && revision.current === current)
          setError(String(error));
      })
      .finally(() => {
        if (mounted.current && revision.current === current) setBusy(false);
      });
  }, [request, filterKey, before, state.revision, active]);
  useEffect(() => {
    if (!selection || !active) {
      setDetail(null);
      return;
    }
    setDetail((old) => (old?.id === selection ? old : null));
    let alive = true;
    setError("");
    setBusy(true);
    void Promise.all([
      request({ action: "detail", event_id: selection }),
      request({ action: "timeline", event_id: selection }),
    ])
      .then(([row, line]) => {
        if (alive) {
          setDetail(row);
          setTimeline(line.observations);
          setTimelineBefore(line.before);
        }
      })
      .catch((error) => {
        if (alive) setError(String(error));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [request, selection, state.revision, active]);
  useEffect(() => {
    if (selection && active)
      void request({
        action: "observe",
        event_id: selection,
        kind: "viewed",
      }).catch((error) => setError(String(error)));
  }, [request, selection, active]);
  useEffect(() => {
    if (active) closeButton.current?.focus();
  }, [active]);
  const setFilter = (key: string, value: string) => {
    setFilters((old) => ({ ...old, [key]: value }));
    setBefore(null);
    setPrevious([]);
  };
  const act = async (action: string) => {
    if (!detail) return;
    setBusy(true);
    setError("");
    const selected = detail.id;
    try {
      await request({ action, event_id: selected, kind: "handled" });
      const [row, line] = await Promise.all([
        request({ action: "detail", event_id: detail.id }),
        request({ action: "timeline", event_id: detail.id }),
      ]);
      if (mounted.current && chosen.current === selected) {
        setDetail(row);
        setTimeline(line.observations);
        setTimelineBefore(line.before);
      }
    } catch (error) {
      if (mounted.current && chosen.current === selected)
        setError(String(error));
    } finally {
      if (mounted.current && chosen.current === selected) setBusy(false);
    }
  };
  return (
    <section
      className="nc-panel"
      aria-label="专业图表通知中心"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (selection) setSelection("");
          else onClose();
        }
      }}
    >
      <header className="nc-heading">
        <div>
          <h2>通知中心</h2>
          <small>专业图表 · {state.unread} 条未读</small>
        </div>
        <button
          ref={closeButton}
          type="button"
          onClick={onClose}
          aria-label="关闭通知中心"
        >
          ×
        </button>
      </header>
      <div className="nc-health" role="status">
        {state.status}
        {state.pending.length > 0 && ` · ${state.pending.length} 条本机记录`}
      </div>
      {state.gap && (
        <p className="nc-error" role="alert">
          {state.gap}
        </p>
      )}
      <div className="nc-sound">
        <label>
          <input
            type="checkbox"
            checked={state.enabled}
            onChange={(event) => {
              void request({
                action: "sound",
                enabled: event.target.checked,
              }).catch((error) => setError(String(error)));
            }}
          />
          网页声音
        </label>
        <span>
          {state.soundLimited
            ? "当前浏览器自动声音受限"
            : state.enabled
              ? state.unlocked
                ? "已解锁"
                : "待解锁"
              : "已关闭"}
        </span>
        {state.enabled && !state.unlocked && (
          <button
            type="button"
            onClick={() =>
              void request({ action: "unlock" }).catch((error) =>
                setError(String(error)),
              )
            }
          >
            解锁声音
          </button>
        )}
      </div>
      {error && (
        <p className="nc-error" role="alert">
          {error}
        </p>
      )}
      {selection && detail ? (
        <div className="nc-detail">
          <button type="button" onClick={() => setSelection("")}>
            返回通知列表
          </button>
          <p className={"nc-severity nc-" + detail.severity}>
            {severityLabels[detail.severity]} ·{" "}
            {sourceLabels[detail.source_kind] || detail.source_kind}
          </p>
          <h3>{detail.title}</h3>
          <p>{detail.message}</p>
          <dl>
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
            <dt>网页查看 / 处理</dt>
            <dd>
              {time(detail.viewed_at)} / {time(detail.handled_at)}
            </dd>
            <dt>事件 ID</dt>
            <dd className="nc-mono">{detail.id}</dd>
            <dt>事故 ID / 次数</dt>
            <dd className="nc-mono">
              {detail.incident_id} / {detail.incident?.count ?? "未知"}
            </dd>
            <dt>事故状态</dt>
            <dd>
              {detail.incident?.closed_at ? "已明确恢复" : "尚无明确恢复证据"}
            </dd>
            <dt>来源身份</dt>
            <dd className="nc-mono">
              {detail.source_kind} / {detail.source_id}
            </dd>
          </dl>
          <div className="nc-actions">
            <button
              disabled={busy || !!detail.handled_at}
              type="button"
              onClick={() => void act("observe")}
            >
              {detail.handled_at ? "已处理" : "标为已处理"}
            </button>
            {onLocate && detail.workspace && (
              <button type="button" onClick={() => onLocate(detail)}>
                定位图表
              </button>
            )}
            {detail.notification_id && (
              <button
                disabled={
                  busy || !!detail.channels?.["phone_state:"]?.stopped_at
                }
                type="button"
                onClick={() => void act("stop")}
              >
                停止此事件后续手机提醒
              </button>
            )}
          </div>
          {detail.notification_id && (
            <p className="nc-muted">
              查看和处理不会停止手机提醒；停止不能撤回已在途的发送。
            </p>
          )}
          <details>
            <summary>当时上下文与证据</summary>
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
          </details>
          <h3>渠道与排查时间线</h3>
          <p className="nc-muted">
            网页渲染不代表人已看见；声音开始不代表已听见；服务接受不代表设备收到。
          </p>
          {!timeline.length && (
            <p className="nc-muted">尚无可用观察；未知状态不会补造。</p>
          )}
          <ol className="nc-timeline">
            {timeline.map((row) => (
              <li key={row.id}>
                <strong>{observationLabels[row.kind] || row.kind}</strong>
                <time>{time(row.received_at)}</time>
                <small>
                  客户端报告：{time(row.reported_at)} · 观察主体：{row.profile}
                </small>
                <pre>{JSON.stringify(row.details, null, 2)}</pre>
              </li>
            ))}
          </ol>
          {timelineBefore && (
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const line = await request({
                    action: "timeline",
                    event_id: detail.id,
                    before: timelineBefore,
                  });
                  if (mounted.current && chosen.current === line.event_id) {
                    setTimeline((old) => [...old, ...line.observations]);
                    setTimelineBefore(line.before);
                  }
                } catch (error) {
                  setError(String(error));
                } finally {
                  setBusy(false);
                }
              }}
            >
              更早的渠道记录
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="nc-filters">
            <label>
              关键词
              <input
                type="search"
                value={filters.q || ""}
                maxLength={120}
                onChange={(event) => setFilter("q", event.target.value)}
              />
            </label>
            <label>
              状态
              <select
                value={filters.state || ""}
                onChange={(event) => setFilter("state", event.target.value)}
              >
                <option value="">全部</option>
                <option value="unread">未读</option>
                <option value="unhandled">未处理</option>
                <option value="handled">已处理</option>
              </select>
            </label>
            <label>
              级别
              <select
                value={filters.severity || ""}
                onChange={(event) => setFilter("severity", event.target.value)}
              >
                <option value="">全部</option>
                {Object.entries(severityLabels).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              来源
              <select
                value={filters.source || ""}
                onChange={(event) => setFilter("source", event.target.value)}
              >
                <option value="">全部</option>
                {Object.entries(sourceLabels).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <details>
              <summary>更多筛选</summary>
              <label>
                类型
                <select
                  value={filters.kind || ""}
                  onChange={(event) => setFilter("kind", event.target.value)}
                >
                  <option value="">全部</option>
                  <option value="alert">业务告警</option>
                  <option value="failure">故障</option>
                </select>
              </label>
              <label>
                品种
                <input
                  value={filters.instrument || ""}
                  onChange={(event) =>
                    setFilter("instrument", event.target.value)
                  }
                />
              </label>
              <label>
                工作区
                <input
                  value={filters.workspace || ""}
                  onChange={(event) =>
                    setFilter("workspace", event.target.value)
                  }
                />
              </label>
              <label>
                起始时间
                <input
                  type="datetime-local"
                  onChange={(event) =>
                    setFilter(
                      "since",
                      event.target.value
                        ? String(new Date(event.target.value).getTime())
                        : "",
                    )
                  }
                />
              </label>
              <label>
                截止时间
                <input
                  type="datetime-local"
                  onChange={(event) =>
                    setFilter(
                      "until",
                      event.target.value
                        ? String(new Date(event.target.value).getTime())
                        : "",
                    )
                  }
                />
              </label>
            </details>
          </div>
          <div className="nc-list" aria-busy={busy}>
            {!before &&
              state.pending.map((row) => (
                <article className="nc-row nc-pending" key={row.id}>
                  <strong>{row.title}</strong>
                  <p>{row.message}</p>
                  <small>
                    {row.local_status === "accepted"
                      ? "服务端已接收，等待投影"
                      : "仅本机待同步"}{" "}
                    · {time(row.occurred_at)}
                  </small>
                </article>
              ))}
            {page?.events.map((row) => (
              <button
                type="button"
                className={"nc-row " + (!row.viewed_at ? "nc-unread" : "")}
                key={row.id}
                onClick={() => setSelection(row.id)}
              >
                <span className={"nc-severity nc-" + row.severity}>
                  {severityLabels[row.severity]} ·{" "}
                  {sourceLabels[row.source_kind] || row.source_kind}
                </span>
                <strong>{row.title}</strong>
                <span>{row.instrument || row.workspace || row.message}</span>
                <small>
                  {time(row.occurred_at)}
                  {row.incident && row.incident.count > 1
                    ? ` · 同事故 ${row.incident.count} 次`
                    : ""}
                  {row.backfill ? " · 历史回填" : ""}
                </small>
              </button>
            ))}
            {page && !page.events.length && !state.pending.length && (
              <p className="nc-empty">
                {busy ? "正在读取通知…" : "此筛选下暂无通知"}
              </p>
            )}
          </div>
          <footer className="nc-pagination">
            <button
              type="button"
              disabled={busy || !previous.length}
              onClick={() => {
                setBefore(previous[previous.length - 1]);
                setPrevious((old) => old.slice(0, -1));
              }}
            >
              上一页
            </button>
            <small>保留 30 天 · 本页 {page?.events.length || 0} 条</small>
            <button
              type="button"
              disabled={busy || !page?.before}
              onClick={() => {
                setPrevious((old) => [...old, before]);
                setBefore(page!.before);
              }}
            >
              下一页
            </button>
          </footer>
        </>
      )}
    </section>
  );
}
export function NoticeBubble({
  notice,
  request,
  onOpen,
}: {
  notice: Notice;
  request: NoticeTransport;
  onOpen: () => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismiss = () => {
    void request({ action: "dismiss" });
  };
  const pause = () => {
    if (timer.current) clearTimeout(timer.current);
  };
  const resume = () => {
    pause();
    timer.current = setTimeout(
      dismiss,
      notice.severity === "info" ? 3000 : 8000,
    );
  };
  useEffect(() => {
    resume();
    return pause;
  }, [notice.id]);
  useEffect(() => {
    if (document.visibilityState === "visible")
      void request({ action: "rendered", event_id: notice.id });
  }, [notice.id, request]);
  return (
    <aside
      className="nc-bubble"
      aria-label="最新图表通知"
      onMouseEnter={pause}
      onMouseLeave={resume}
      onFocus={pause}
      onBlur={resume}
    >
      <div role="status" aria-live="polite" aria-atomic="true">
        <strong>{notice.title}</strong>
        <p>{notice.message}</p>
      </div>
      <button type="button" onClick={onOpen}>
        查看详情
      </button>
      <button type="button" aria-label="关闭即时通知" onClick={dismiss}>
        ×
      </button>
    </aside>
  );
}
