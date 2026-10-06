import { useCallback, useEffect, useRef, useState } from "react";
import { api, date } from "../api";
import { ChartAlertDialog } from "./ChartAlertDialog";
import {
  deliveryNames,
  freshDraft,
  healthNames,
  statuses,
  type AlertConfig,
  type AlertContext,
  type AlertEvent,
  type AlertRow,
} from "./chartAlerts";
import "./chart-alerts.css";

type Draft = {
  config: AlertConfig;
  requestId: string;
  editing: { id: string; version: number } | null;
};
export function ChartAlertsPanel({
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
}: {
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
}) {
  const draftKey = "mw-chart-alert-draft:" + workspaceId;
  const [rows, setRows] = useState<AlertRow[]>([]),
    [events, setEvents] = useState<AlertEvent[]>([]);
  const [tab, setTab] = useState("alerts"),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState(""),
    [currentOnly, setCurrentOnly] = useState(false);
  const [error, setError] = useState(""),
    [feedback, setFeedback] = useState(""),
    [busy, setBusy] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false),
    [draft, setDraft] = useState<Draft | null>(() => {
      try {
        const value = JSON.parse(localStorage.getItem(draftKey) || "null");
        return value?.config?.instrument && value?.requestId ? value : null;
      } catch {
        return null;
      }
    });
  const mounted = useRef(true),
    refreshing = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const [nextRows, nextEvents] = await Promise.all([
        api<AlertRow[]>("/chart-alerts"),
        api<AlertEvent[]>("/chart-alerts/events"),
      ]);
      if (mounted.current) {
        setRows(nextRows);
        setEvents(nextEvents);
        onRows(nextRows);
        setError("");
      }
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      refreshing.current = false;
    }
  }, [workspaceId]);
  useEffect(() => {
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
    });
    setFormOpen(true);
  }, [context?.request_id]);
  useEffect(() => {
    try {
      if (draft) localStorage.setItem(draftKey, JSON.stringify(draft));
      else localStorage.removeItem(draftKey);
    } catch {
      setError("本地草稿保存失败，请保留此表单后重试");
    }
  }, [draft, draftKey]);
  async function action(row: AlertRow, action: string) {
    setBusy(row.id);
    setError("");
    try {
      const saved = await api<AlertRow>(`/chart-alerts/${row.id}/lifecycle`, {
        version: row.version,
        action,
      });
      if (mounted.current) {
        setFeedback(`${saved.name}：${statuses[saved.status]}`);
        await refresh();
      }
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }
  async function ack(event: AlertEvent) {
    setBusy(event.id);
    try {
      await api(`/notifications/${event.notification_id}/ack`, {});
      if (mounted.current) await refresh();
    } catch (e) {
      if (mounted.current) setError(String(e));
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
        : structuredClone(row.config),
      requestId: crypto.randomUUID(),
      editing: copy ? null : { id: row.id, version: row.version },
    });
    setFormOpen(true);
  }
  const visible = rows.filter(
    (row) =>
      (!search ||
        (row.name + row.condition_summary + row.config.instrument)
          .toLowerCase()
          .includes(search.toLowerCase())) &&
      (!status || row.status === status) &&
      (!currentOnly || row.config.instrument === context?.instrument),
  );
  const filteredEvents = events.filter(
    (event) =>
      (!search ||
        (event.message + event.evidence.config.instrument)
          .toLowerCase()
          .includes(search.toLowerCase())) &&
      (!currentOnly ||
        event.evidence.config.instrument === context?.instrument),
  );
  return (
    <>
      {open && (
        <aside
          className="chart-alert-panel"
          data-theme={theme}
          aria-label="告警与日志"
        >
          <header>
            <h2>告警</h2>
            <button type="button" onClick={onClose} aria-label="关闭告警面板">
              关闭
            </button>
          </header>
          <div
            className="alert-panel-tabs"
            role="tablist"
            aria-label="告警面板标签"
          >
            <button
              role="tab"
              aria-selected={tab === "alerts"}
              aria-controls="chart-alert-list"
              onClick={() => setTab("alerts")}
            >
              告警 ({rows.length})
            </button>
            <button
              role="tab"
              aria-selected={tab === "events"}
              aria-controls="chart-alert-events"
              onClick={() => setTab("events")}
            >
              日志 ({events.length})
            </button>
          </div>
          <div className="alert-panel-filters">
            <label>
              搜索
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="名称、条件或品种"
              />
            </label>
            <label className="alert-check">
              <input
                type="checkbox"
                checked={currentOnly}
                disabled={!context}
                onChange={(e) => setCurrentOnly(e.target.checked)}
              />
              发起图表品种{context ? ` · ${context.instrument}` : ""}
            </label>
            {tab === "alerts" && (
              <label>
                运行状态
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  <option value="">全部</option>
                  {Object.entries(statuses)
                    .filter(([s]) => s !== "archived")
                    .map(([s, label]) => (
                      <option key={s} value={s}>
                        {label}
                      </option>
                    ))}
                </select>
              </label>
            )}
          </div>
          {feedback && (
            <p className="alert-feedback" role="status">
              {feedback}
            </p>
          )}
          {error && (
            <p className="alert-error" role="alert">
              {error}
            </p>
          )}
          {tab === "alerts" ? (
            <div
              id="chart-alert-list"
              role="tabpanel"
              className="alert-panel-content"
            >
              <div className="alert-inline-actions">
                <button disabled={readonly} onClick={onRequest}>
                  创建告警
                </button>
                {draft && (
                  <button disabled={readonly} onClick={() => setFormOpen(true)}>
                    恢复草稿
                  </button>
                )}
              </div>
              {!visible.length && <p>没有符合筛选条件的告警。</p>}
              {visible.map((row) => (
                <article key={row.id} className="chart-alert-card">
                  <h3>{row.name}</h3>
                  <p>{row.condition_summary}</p>
                  <p>
                    {row.config.instrument} · {row.config.source} ·{" "}
                    {row.config.timeframe} ·{" "}
                    {row.config.mode === "close" ? "收盘" : "盘中抽样"}
                  </p>
                  <p>
                    <strong>{statuses[row.status]}</strong> · 已触发 {row.count}{" "}
                    / {row.max_triggers} 次
                  </p>
                  <p className={`alert-health alert-health-${row.health}`}>
                    {healthNames[row.health]}
                    {row.health_reason ? `：${row.health_reason}` : ""}
                  </p>
                  {associationNotices[row.id] && (
                    <p className="alert-error">{associationNotices[row.id]}</p>
                  )}
                  <p>
                    版本 {row.version} · 生效 {date(row.effective_at)}
                  </p>
                  {events.find((event) => event.alert_id === row.id) && (
                    <p>
                      最近触发{" "}
                      {date(
                        events.find((event) => event.alert_id === row.id)!
                          .occurred_at,
                      )}
                    </p>
                  )}
                  <div className="alert-inline-actions">
                    <button onClick={() => onLocate(row)}>定位图表</button>
                    <button
                      disabled={readonly || busy === row.id}
                      onClick={() => edit(row)}
                    >
                      编辑
                    </button>
                    <button disabled={readonly} onClick={() => edit(row, true)}>
                      复制为草稿
                    </button>
                    {row.config.association?.object_kind === "drawing" &&
                      associationNotices[row.id] && (
                        <>
                          <button
                            disabled={readonly}
                            onClick={() => onDrawingAction(row, "retry")}
                          >
                            重试画线提交
                          </button>
                          <button
                            disabled={readonly}
                            onClick={() => onDrawingAction(row, "restore")}
                          >
                            恢复后台画线
                          </button>
                        </>
                      )}
                    {row.status === "active" && (
                      <button
                        disabled={readonly || busy === row.id}
                        onClick={() => action(row, "pause")}
                      >
                        暂停
                      </button>
                    )}
                    {row.status === "paused" && (
                      <button
                        disabled={readonly || busy === row.id}
                        onClick={() => action(row, "resume")}
                      >
                        恢复
                      </button>
                    )}
                    {row.status === "completed" && (
                      <button
                        disabled={readonly || busy === row.id}
                        onClick={() => action(row, "restart")}
                      >
                        重新启用（新一轮）
                      </button>
                    )}
                    {row.status === "active" && row.health === "blocked" && (
                      <button
                        disabled={readonly || busy === row.id}
                        onClick={() => action(row, "rebaseline")}
                      >
                        核对后重建基准（保留次数）
                      </button>
                    )}
                    <button
                      disabled={readonly || busy === row.id}
                      onClick={() => action(row, "archive")}
                    >
                      删除
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div
              id="chart-alert-events"
              role="tabpanel"
              className="alert-panel-content"
            >
              {!filteredEvents.length && <p>尚无触发事件。</p>}
              {filteredEvents.map((event) => (
                <article key={event.id} className="chart-alert-card">
                  <h3>{event.evidence.config.name}</h3>
                  <p>
                    事件时间 {date(event.occurred_at)}
                    {event.evidence.late ? " · 迟到事件" : ""}
                  </p>
                  <p>检测时间 {date(event.detected_at)}</p>
                  <p>
                    实际值 {event.evidence.left} · 比较值 {event.threshold} ·
                    市场价格 {event.price}
                  </p>
                  <p>
                    规则版本 {event.evidence.rule_version} · 第{" "}
                    {event.evidence.ordinal} 次
                  </p>
                  <p>
                    {event.ack_at
                      ? "已确认"
                      : event.delivery_status === "web_only"
                        ? "仅网页"
                        : event.delivery_status === "blocked"
                          ? "投递受阻"
                          : deliveryNames[event.notification_status] ||
                            deliveryNames[event.delivery_status] ||
                            event.notification_status}
                  </p>
                  <details>
                    <summary>查看消息和当时证据</summary>
                    <p className="alert-message-text">{event.message}</p>
                    <pre>
                      {JSON.stringify(event.evidence.observation, null, 2)}
                    </pre>
                  </details>
                  <div className="alert-inline-actions">
                    <button
                      disabled={!rows.some((row) => row.id === event.alert_id)}
                      onClick={() => {
                        const row = rows.find(
                          (row) => row.id === event.alert_id,
                        );
                        if (row) onLocate(row, event);
                      }}
                    >
                      定位触发位置
                    </button>
                    <button
                      disabled={!!event.ack_at || busy === event.id}
                      onClick={() => ack(event)}
                    >
                      {event.ack_at ? "已确认" : "确认此事件"}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </aside>
      )}
      {formOpen && draft && (
        <ChartAlertDialog
          key={draft.requestId}
          initial={draft.config}
          requestId={draft.requestId}
          editing={draft.editing}
          theme={theme}
          onDraft={(config) =>
            setDraft((previous) => (previous ? { ...previous, config } : null))
          }
          onClose={() => setFormOpen(false)}
          onSaved={(row) => {
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
