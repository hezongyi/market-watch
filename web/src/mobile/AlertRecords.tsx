import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../api";
import {
  deliveryNames,
  eventPresentation,
  type AlertEvent,
} from "../advanced/chartAlerts";
import type { NoticeRuntime } from "../notifications/runtime";
import type { Profile } from "./cache";
import { useSymbolSearch } from "./useSymbolSearch";
import { useOverlayActive } from "./WatchOverlays";
import { SymbolSearchPanel } from "./SymbolSearch";
import { Button } from "./components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group";
import { DataEmpty } from "./DataStates";
import { DataMore } from "./DataFormParts";
import MobileSheet from "./MobileSheet";
import AlertListRefresh from "./AlertListRefresh";
import SymbolInfo from "./SymbolInfo";
import { eventIdentity, eventHandled } from "./alertView";
import { logEvent, logFailure } from "./logs";
import { stamp } from "./alertTime";

export default function AlertRecords({
  profile,
  online,
  active,
  runtime,
  alertId,
  fallback = [],
  pullToRefresh = false,
}: {
  profile: Profile;
  online: boolean;
  active: boolean;
  runtime: NoticeRuntime;
  alertId?: string;
  fallback?: AlertEvent[];
  pullToRefresh?: boolean;
}) {
  const overlayActive = useOverlayActive();
  active = active && overlayActive;
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all");
  const [selection, setSelection] = useState<AlertEvent>(),
    [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState<Record<string, AlertEvent>>({});
  const flight = useRef(false);
  const result = useSymbolSearch<AlertEvent>({
    profile,
    active,
    online,
    queryKey: "alert-events:" + (alertId || "all"),
    identity: (event) => event.id,
    fetchPage: async (cursor, signal) => {
      const value = await api<{
        items: AlertEvent[];
        next_cursor: string | null;
      }>(
        "/chart-alerts/events/page?" +
          new URLSearchParams({
            limit: "30",
            ...(alertId ? { alert_id: alertId } : {}),
            ...(cursor ? { before: cursor } : {}),
          }),
        undefined,
        signal,
      );
      return { items: value.items, next: value.next_cursor || undefined };
    },
  });
  const latestRefresh = useRef(result.refresh);
  latestRefresh.current = result.refresh;
  useEffect(() => {
    if (!active || !online) return;
    const refresh = () => {
      if (!document.hidden) latestRefresh.current();
    };
    refresh();
    const timer = setInterval(refresh, 15000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [active, online, alertId]);
  const events = (result.loaded ? result.items : fallback).map((event) => {
    const saved = confirmed[event.id];
    // Confirmation timestamps are monotonic; an older in-flight page cannot undo them.
    return saved
      ? {
          ...event,
          ack_at: saved.ack_at || event.ack_at,
          notice:
            event.notice && saved.notice
              ? {
                  ...event.notice,
                  handled_at:
                    saved.notice.handled_at || event.notice.handled_at,
                }
              : event.notice,
        }
      : event;
  });
  const selected =
    selection &&
    (events.find((event) => event.id === selection.id) ||
      confirmed[selection.id] ||
      selection);
  async function readCurrent(event: AlertEvent) {
    const latest = await api<AlertEvent>(
      `/chart-alerts/events/${encodeURIComponent(event.id)}`,
    );
    setConfirmed((old) => ({ ...old, [event.id]: latest }));
    setSelection(latest);
    return latest;
  }
  async function handle(event: AlertEvent) {
    if (flight.current || !online) return;
    flight.current = true;
    setBusy(true);
    setError("");
    let stopped = Boolean(event.ack_at);
    try {
      const latest = await readCurrent(event);
      if (latest.notification_id && !latest.ack_at) {
        await api(
          `/notifications/${encodeURIComponent(latest.notification_id)}/ack`,
          {},
        );
        stopped = true;
      }
      if (latest.notice && !latest.notice.handled_at)
        await runtime.action({
          action: "observe",
          event_id: latest.notice.id,
          kind: "handled",
          wait_for_sync: true,
        });
      await readCurrent(event);
      result.refresh();
      logEvent({
        module: "告警",
        action: "处理本次提醒",
        object: event.id,
        message: "已回读处理状态；规则继续按条件执行",
        result: "success",
      });
    } catch (error) {
      setError(
        (stopped && event.notice
          ? "本次提醒已停止；处理状态需核查："
          : "未完成：") + errorMessage(error),
      );
      logFailure("告警", "处理本次提醒", error, event.id);
      await readCurrent(event).catch(() => {});
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }
  const filtered = events.filter(
    (event) =>
      (filter === "all" || !eventHandled(event)) &&
      query
        .toLocaleLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .every((token) => eventPresentation(event).search.includes(token)),
  );
  const list = (
      <SymbolSearchPanel
        query={query}
        onQuery={setQuery}
        label="搜索触发记录"
        placeholder="品种、条件或规则名称"
        active={active}
        online={online}
        loading={result.loading}
        loaded={result.loaded || !!fallback.length}
        error={result.error}
        retry={result.retry}
        hasNext={!!result.next}
        loadNext={result.loadNext}
        filters={
          <ToggleGroup
            className="alert-filters"
            aria-label="记录状态"
            value={[filter]}
            onValueChange={(value) => {
              if (value.length) setFilter(String(value[0]));
            }}
          >
            <ToggleGroupItem value="all">全部</ToggleGroupItem>
            <ToggleGroupItem value="unhandled">未处理</ToggleGroupItem>
          </ToggleGroup>
        }
      >
        {!filtered.length && !result.loading && (
          <DataEmpty
            title={filter === "unhandled" ? "暂无未处理记录" : "暂无触发记录"}
          >
            {result.next
              ? "继续上滑读取更早记录。"
              : "满足条件后，记录会显示在这里。"}
          </DataEmpty>
        )}
        {filtered.map((event) => (
          <Button
            key={event.id}
            variant="plain"
            className="alert-event-row"
            onClick={() => {
              setSelection(event);
              setError("");
              setOpened(true);
            }}
          >
            <div className="alert-event-top">
              <span className="alert-event-instrument">
                <strong>{eventIdentity(event).code}</strong>
                <small>
                  {[eventIdentity(event).name, eventIdentity(event).source]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
              </span>
              <span
                className="alert-event-handled"
                data-unhandled={!eventHandled(event) || undefined}
              >
                {eventHandled(event)
                  ? event.notice
                    ? "已处理"
                    : "已确认"
                  : "未处理"}
              </span>
            </div>
            <strong className="alert-event-condition">
              {eventPresentation(event).summary ||
                eventPresentation(event).name}
            </strong>
            <div className="alert-event-bottom">
              <time>{stamp(event.occurred_at)}</time>
              <span>触发价 {event.price}</span>
            </div>
          </Button>
        ))}
      </SymbolSearchPanel>
  );
  return (
    <div className="alert-records-content" data-pull-refresh={pullToRefresh || undefined}>
      {pullToRefresh ? (
        <AlertListRefresh
          active={active && !opened}
          online={online}
          loading={result.loading}
          resetKey={filter + ":" + query}
          refresh={result.refresh}
        >
          {list}
        </AlertListRefresh>
      ) : list}
      <MobileSheet
        title="触发详情"
        open={opened}
        close={() => setOpened(false)}
        dismissible={!busy}
        onClosed={() => {
          setSelection(undefined);
          setError("");
        }}
      >
        {selected && (
          <div className="alert-detail">
            <SymbolInfo {...eventIdentity(selected)} />
            <h3 className="alert-condition-title">
              {eventPresentation(selected).summary}
            </h3>
            <dl className="alert-facts">
              <div>
                <dt>触发价格</dt>
                <dd>{selected.price}</dd>
              </div>
              <div>
                <dt>目标</dt>
                <dd>{selected.threshold}</dd>
              </div>
              <div>
                <dt>发生时间</dt>
                <dd>{stamp(selected.occurred_at)}</dd>
              </div>
              <div>
                <dt>处理</dt>
                <dd>
                  {eventHandled(selected)
                    ? selected.notice
                      ? "已处理"
                      : "已确认"
                    : "未处理"}
                </dd>
              </div>
              <div>
                <dt>推送</dt>
                <dd>
                  {deliveryNames[selected.delivery_status] ||
                    selected.delivery_status}
                </dd>
              </div>
            </dl>
            {selected.message && (
              <p className="alert-muted">{selected.message}</p>
            )}
            {error && (
              <p role="alert" className="mobile-inline-error">
                {error}
              </p>
            )}
            {!eventHandled(selected) &&
              (selected.notification_id || selected.notice) && (
                <Button
                  disabled={!online || busy}
                  onClick={() => void handle(selected)}
                >
                  {busy ? "正在处理…" : "处理本次提醒"}
                </Button>
              )}
            {!eventHandled(selected) &&
              (selected.notification_id || selected.notice) && (
                <p className="alert-muted">
                  停止本次提醒，规则继续执行。
                </p>
              )}
            <DataMore title="投递与判定详情">
              <dl className="alert-facts">
                <div>
                  <dt>检测时间</dt>
                  <dd>{stamp(selected.detected_at)}</dd>
                </div>
                <div>
                  <dt>投递状态</dt>
                  <dd>
                    {deliveryNames[selected.notification_status] ||
                      selected.notification_status}
                  </dd>
                </div>
                <div>
                  <dt>手机实收</dt>
                  <dd>未核验</dd>
                </div>
                <div>
                  <dt>停止提醒</dt>
                  <dd>
                    {selected.ack_at ? stamp(selected.ack_at) : "尚未确认"}
                  </dd>
                </div>
                <div>
                  <dt>规则版本</dt>
                  <dd>{selected.evidence?.rule_version}</dd>
                </div>
                <div>
                  <dt>本轮次数</dt>
                  <dd>{selected.evidence?.ordinal}</dd>
                </div>
                {selected.evidence?.late && (
                  <div>
                    <dt>迟到触发</dt>
                    <dd>是</dd>
                  </div>
                )}
              </dl>
              <p className="alert-muted">
                推送服务接受不代表手机实收。此处条件来自触发当时的快照。
              </p>
            </DataMore>
          </div>
        )}
      </MobileSheet>
    </div>
  );
}
