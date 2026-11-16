import { logEvent } from "./logs";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../api";
import type { AlertEvent } from "../advanced/chartAlerts";
import AlertRecords from "./AlertRecords";
import {
  noticeInstrument,
  severityLabels,
  type Notice,
  type HistoryPage,
} from "../notifications/types";
import type { NoticeRuntime } from "../notifications/runtime";
import { readSnapshot, writeSnapshot, type Profile } from "./cache";
import MobileSheet from "./MobileSheet";
import { MobileOverlaysProvider } from "./WatchOverlays";
import { Button } from "./components/ui/button";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  TabsPanels,
} from "./components/ui/tabs";
export const stamp = (value: unknown) =>
  typeof value === "number" && value
    ? new Date(value).toLocaleString()
    : "尚无记录";

export default function RecordsSheet({
  open = true,
  profile,
  online,
  events,
  runtime,
  close,
  report,
  initialTab = "triggers",
}: {
  open?: boolean;
  initialTab?: string;
  profile: Profile;
  online: boolean;
  events: AlertEvent[];
  runtime: NoticeRuntime;
  close(): void;
  report(message: string): void;
}) {
  const [tab, setTab] = useState(initialTab);
  const [selected, setSelected] = useState<Notice>(),
    [timeline, setTimeline] = useState<any[]>([]);
  const [busy, setBusy] = useState(false),
    [retry, setRetry] = useState(0),
    [error, setError] = useState("");
  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);
  useEffect(() => {
    if (!open || !selected || !online) return;
    const controller = new AbortController();
    setTimeline([]);
    setError("");
    void api<any>(
      `/notification-center/events/${encodeURIComponent(selected.id)}/timeline`,
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setTimeline(value.observations || []);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(error));
          report(errorMessage(error));
        }
      });
    return () => controller.abort();
  }, [open, selected?.id, online]);
  async function confirmNotice(notice: Notice) {
    if (!online || busy) return;
    setBusy(true);
    try {
      await runtime.action({
        action: "observe",
        event_id: notice.id,
        kind: "handled",
        wait_for_sync: true,
      });
      setRetry((value) => value + 1);
      setSelected(undefined);
      logEvent({
        module: "告警",
        action: "标记已处理",
        object: notice.id,
        message: "服务器已记录已处理；手机实收仍需在设备核验",
        result: "success",
      });
    } catch (error) {
      setError(errorMessage(error));
      report(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mobile-controls mobile-records">
      <MobileOverlaysProvider>
        <MobileSheet
          open={open}
          title="事件记录"
          // Keep the tab bar in place across loading, empty and populated lists.
          fullHeight
          close={close}
          dismissible={!busy}
          onClosed={() => {
            setTab("triggers");
            setSelected(undefined);
            setError("");
            setTimeline([]);
          }}
        >
          <Tabs
            swipe
            className="mobile-record-tabs"
            value={tab}
            onValueChange={(value) => {
              setTab(String(value));
            }}
          >
            <TabsList aria-label="记录类型">
              <TabsTrigger value="triggers">触发</TabsTrigger>
              <TabsTrigger value="alerts" aria-label="异常 / 恢复">
                异常/恢复
              </TabsTrigger>
              <TabsTrigger value="system">系统</TabsTrigger>
            </TabsList>
            <TabsPanels>
              <TabsContent value="triggers">
                <AlertRecords
                  profile={profile}
                  online={online}
                  active={open && tab === "triggers"}
                  runtime={runtime}
                  fallback={events}
                />
              </TabsContent>
              {["alerts", "system"].map((kind) => (
                <TabsContent key={kind} value={kind}>
                  <HistoryRecords
                    key={JSON.stringify([kind, profile])}
                    tab={kind}
                    profile={profile}
                    online={online}
                    active={open && tab === kind}
                    retry={retry}
                    select={setSelected}
                  />
                </TabsContent>
              ))}
            </TabsPanels>
          </Tabs>
          <MobileSheet
            open={Boolean(selected)}
            dismissible={!busy}
            title={selected?.title || "记录详情"}
            close={() => setSelected(undefined)}
          >
            {error && <p role="alert">{error}</p>}
            {selected && (
              <>
                <p>{noticeInstrument(selected)}</p>
                <p>{selected.message}</p>
                <p>发生 {stamp(selected.occurred_at)}</p>
                <p>
                  {selected.handled_at
                    ? "已处理 " + stamp(selected.handled_at)
                    : "未处理"}
                </p>
                {selected.observation_status === "ended" && (
                  <p>页面观察已结束；未确认恢复。</p>
                )}
                {selected.incident && (
                  <p>
                    {selected.incident.closed_at
                      ? "已恢复 " + stamp(selected.incident.closed_at)
                      : "异常尚未确认恢复"}{" "}
                    · 累计 {selected.incident.count} 次
                  </p>
                )}
                {timeline.map((row) => (
                  <article className="mobile-status-card" key={row.id}>
                    <strong>
                      {(
                        {
                          viewed: "查看",
                          handled: "标记已处理",
                          received: "网页接收",
                          rendered: "页面展示",
                          sound_started: "网页声音开始",
                        } as Record<string, string>
                      )[row.kind] || row.kind}
                    </strong>
                    <p>
                      服务器记录 {stamp(row.received_at)} · 客户端报告{" "}
                      {stamp(row.reported_at)}
                    </p>
                  </article>
                ))}
                <Button
                  variant="outline"
                  disabled={!online || busy || Boolean(selected.handled_at)}
                  onClick={() => void confirmNotice(selected)}
                >
                  标记已处理
                </Button>
              </>
            )}
          </MobileSheet>
        </MobileSheet>
      </MobileOverlaysProvider>
    </div>
  );
}

function HistoryRecords({
  tab,
  profile,
  online,
  active,
  retry: externalRetry,
  select,
}: {
  tab: string;
  profile: Profile;
  online: boolean;
  active: boolean;
  retry: number;
  select(notice: Notice): void;
}) {
  const [history, setHistory] = useState<HistoryPage>(),
    [readAt, setReadAt] = useState<number>();
  const [before, setBefore] = useState<string>(),
    [error, setError] = useState("");
  const [localRetry, setRetry] = useState(0);
  const retry = externalRetry + localRetry;
  const cursor = useRef(before);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    if (cursor.current !== before) {
      setHistory(undefined);
      cursor.current = before;
    }
    setError("");
    const key = `records:${tab}:${before || ""}`;
    void (async () => {
      try {
        const cached = await readSnapshot<HistoryPage>(profile, key);
        if (controller.signal.aborted) return;
        if (cached) {
          setHistory(cached.value);
          setReadAt(cached.readAt);
        }
        if (!online) return;
        const params = new URLSearchParams({
          audience: tab === "system" ? "system" : "alerts",
        });
        if (before) params.set("before", before);
        const page = await api<HistoryPage>(
          "/notification-center/events?" + params,
          undefined,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setHistory(page);
        setReadAt(undefined);
        await writeSnapshot(profile, key, page);
      } catch (error) {
        if (!controller.signal.aborted) setError(errorMessage(error));
      }
    })();
    return () => controller.abort();
  }, [active, tab, before, online, retry, profile]);

  return (
    <>
      {!online && readAt && <p>当前离线</p>}
      {error && (
        <>
          <p role="alert">{error}</p>
          <Button
            variant="outline"
            onClick={() => setRetry((value) => value + 1)}
          >
            重试读取
          </Button>
        </>
      )}
      <>
        {!history && !error && (
          <p>{online ? "正在读取记录…" : "暂无本页缓存"}</p>
        )}
        {history && !history.events.length && <p>本页暂无记录。</p>}
        {history?.events.map((notice) => (
          <Button
            variant="outline"
            key={notice.id}
            className="mobile-series mobile-record-row"
            onClick={() => select(notice)}
          >
            <strong>{notice.title}</strong>
            <span>
              {noticeInstrument(notice)} ·{" "}
              {notice.handled_at ? "已处理" : "未处理"} ·{" "}
              {severityLabels[notice.severity] || notice.severity}
            </span>
            <span>{notice.message}</span>
            <span>{stamp(notice.occurred_at)}</span>
          </Button>
        ))}
        <Button
          variant="outline"
          disabled={!history?.before}
          onClick={() => setBefore(history!.before!)}
        >
          更早记录
        </Button>
        {before && (
          <Button variant="outline" onClick={() => setBefore(undefined)}>
            最新记录
          </Button>
        )}
      </>
    </>
  );
}
