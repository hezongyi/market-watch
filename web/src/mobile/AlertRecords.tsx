import { useContext, useEffect, useRef, useState } from "react";
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
import { alertChartTarget, EventChartNavigation } from "./alertChartTarget";
import { stamp } from "./alertTime";

export default function AlertRecords({
  profile,
  online,
  active,
  runtime,
  alertId,
  fallback = [],
  pullToRefresh = false,
  targetEvent,
}: {
  profile: Profile;
  online: boolean;
  active: boolean;
  runtime: NoticeRuntime;
  alertId?: string;
  fallback?: AlertEvent[];
  pullToRefresh?: boolean;
  targetEvent?: string;
}) {
  const eventChart = useContext(EventChartNavigation);
  const pendingChart = useRef<AlertEvent | undefined>(undefined);
  const navigating = useRef(false);
  const overlayActive = useOverlayActive();
  active = active && overlayActive;
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all");
  const [selection, setSelection] = useState<AlertEvent>(),
    [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [detailReadError, setDetailReadError] = useState("");
  useEffect(()=>{const abandon=()=>{navigating.current=false;pendingChart.current=undefined;setOpened(false);setSelection(undefined);};addEventListener("mw-event-chart-abandon",abandon);return()=>removeEventListener("mw-event-chart-abandon",abandon);},[]);
  const [confirmed, setConfirmed] = useState<Record<string, AlertEvent>>({});
  const flight = useRef(false);
  const entered = useRef<string | undefined>(undefined);
  const [entryError, setEntryError] = useState("");
  const [entryRetry, setEntryRetry] = useState(0);
  useEffect(() => {
    if (!targetEvent || entered.current === targetEvent || !active || !online) return;
    const controller = new AbortController();
    void api<AlertEvent>(`/chart-alerts/events/${encodeURIComponent(targetEvent)}`, undefined,
      AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]))
      .then(event => {
        if (controller.signal.aborted) return;
        entered.current = targetEvent;
        setSelection(event);
        setOpened(true);
        setEntryError("");
      }).catch(error => {
        if (!controller.signal.aborted) { entered.current = targetEvent; setEntryError(errorMessage(error)); }
      });
    return () => controller.abort();
  }, [targetEvent, active, online, entryRetry]);
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
  // Refresh a detail independently of the historical page and never apply a
  // read started before a write while that write is being confirmed.
  useEffect(() => {
    if (!opened || !selection || !active || !online || busy) return;
    const controller = new AbortController();
    const read = async () => {
      if (document.hidden) return;
      try {
        const latest = await api<AlertEvent>(
          `/chart-alerts/events/${encodeURIComponent(selection.id)}`,
          undefined,
          AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        );
        if (!controller.signal.aborted && !flight.current) {
          result.update((item) => (item.id === latest.id ? latest : item));
          setSelection(latest);
          setDetailReadError("");
        }
      } catch (error) {
        if (!controller.signal.aborted) setDetailReadError(errorMessage(error));
      }
    };
    void read();
    const timer = setInterval(() => void read(), 15000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [opened, selection?.id, active, online, busy]);
  async function readCurrent(event: AlertEvent) {
    const latest = await api<AlertEvent>(
      `/chart-alerts/events/${encodeURIComponent(event.id)}`,
      undefined,
      AbortSignal.timeout(10000),
    );
    result.update((item) => (item.id === latest.id ? latest : item));
    setConfirmed((old) => ({ ...old, [event.id]: latest }));
    setSelection(latest);
    setDetailReadError("");
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
          AbortSignal.timeout(10000),
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
      const confirmed = await readCurrent(event);
      if (!eventHandled(confirmed))
        throw Error("服务器尚未确认全部处理结果，请重试未完成的步骤。");
      result.refresh();
      logEvent({
        module: "告警",
        action: "处理本次提醒",
        object: event.id,
        message: "已回读确认本次提醒处理完成；规则启停状态不变",
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
  async function retryDelivery(event: AlertEvent) {
    if (flight.current || !online || !event.notification_id) return;
    flight.current = true;
    setBusy(true);
    setError("");
    try {
      await api(
        `/notifications/${encodeURIComponent(event.notification_id)}/retry`,
        {},
        AbortSignal.timeout(10000),
      );
      await readCurrent(event);
      logEvent({
        module: "告警",
        action: "重试推送",
        object: event.id,
        message: "已提交重试；实际投递状态由服务器更新",
        result: "success",
      });
    } catch (error) {
      setError(errorMessage(error));
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
      error={entryError || result.error}
      retry={entryError ? () => { entered.current = undefined; setEntryError(""); setEntryRetry(value => value + 1); } : result.retry}
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
            setDetailReadError("");
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
            {eventPresentation(event).summary || eventPresentation(event).name}
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
    <div
      className="alert-records-content"
      data-pull-refresh={pullToRefresh || undefined}
    >
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
      ) : (
        list
      )}
      <MobileSheet
        title="触发详情"
        open={opened}
        close={() => setOpened(false)}
        dismissible={!busy}
        onClosed={() => {
          if (pendingChart.current) {
            const event = pendingChart.current; pendingChart.current = undefined; navigating.current = true;
            eventChart.open(event, () => { navigating.current = false; setSelection(event); setOpened(true); });
            return;
          }
          if (navigating.current) return;
          setSelection(undefined);
          setError("");
          setDetailReadError("");
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
                  {selected.device_received_at
                    ? "设备已接收"
                    : deliveryNames[selected.delivery_status] ||
                      selected.delivery_status}
                </dd>
              </div>
            </dl>
            <EventChartButton event={selected} online={online} disabled={busy} open={() => { pendingChart.current = selected; setOpened(false); }} />
            {selected.message && (
              <p className="alert-muted">{selected.message}</p>
            )}
            {(error || detailReadError) && (
              <p role="alert" className="mobile-inline-error">
                {error || detailReadError}
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
                  停止本次提醒，不改变规则启停状态。
                </p>
              )}
            {selected.delivery_status === "blocked" &&
              !selected.ack_at &&
              selected.notification_id && (
                <>
                  <p className="alert-muted">
                    推送认证失败。修正通知设置后，可重试本次投递。
                  </p>
                  <Button
                    variant="outline"
                    disabled={!online || busy}
                    onClick={() => void retryDelivery(selected)}
                  >
                    重试推送
                  </Button>
                </>
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
                  <dd>
                    {selected.device_received_at
                      ? stamp(selected.device_received_at)
                      : "尚无设备回执"}
                  </dd>
                </div>
                <div>
                  <dt>投递尝试</dt>
                  <dd>
                    {selected.delivery_attempts ?? 0} 次
                    {selected.next_delivery_at
                      ? ` · 下次 ${stamp(selected.next_delivery_at)}`
                      : ""}
                  </dd>
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

function EventChartButton({event,online,disabled,open}:{event:AlertEvent;online:boolean;disabled:boolean;open():void}) {
  let reason = online ? "" : "联网后可查看触发位置";
  try { alertChartTarget(event,0); } catch(error) { reason=errorMessage(error); }
  return <><Button variant="outline" disabled={disabled || Boolean(reason)} onClick={open}>查看触发位置</Button>{reason && <p className="alert-muted">{reason}</p>}</>;
}
