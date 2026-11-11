import { useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import {
  deliveryNames,
  eventPresentation,
  type AlertEvent,
} from "../advanced/chartAlerts";
import {
  noticeInstrument,
  severityLabels,
  type Notice,
  type HistoryPage,
} from "../notifications/types";
import type { NoticeRuntime } from "../notifications/runtime";
import { readSnapshot, writeSnapshot, type Profile } from "./cache";
import MobileSheet from "./MobileSheet";
export const stamp = (value: unknown) =>
  typeof value === "number" && value
    ? new Date(value).toLocaleString()
    : "尚无记录";

export default function RecordsSheet({
  profile,
  online,
  events,
  runtime,
  close,
  report,
}: {
  profile: Profile;
  online: boolean;
  events: AlertEvent[];
  runtime: NoticeRuntime;
  close(): void;
  report(message: string): void;
}) {
  const [tab, setTab] = useState("triggers"),
    [history, setHistory] = useState<HistoryPage>(),
    [readAt, setReadAt] = useState<number>();
  const [before, setBefore] = useState<string>(),
    [selected, setSelected] = useState<Notice>(),
    [timeline, setTimeline] = useState<any[]>([]);
  const [busy, setBusy] = useState(false),
    [retry, setRetry] = useState(0),
    [error, setError] = useState("");
  useEffect(() => {
    if (tab === "triggers") return;
    const controller = new AbortController();
    setHistory(undefined);
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
  }, [tab, before, online, retry]);
  useEffect(() => {
    if (!selected || !online) return;
    const controller = new AbortController();
    setTimeline([]);
    void api<any>(
      `/notification-center/events/${encodeURIComponent(selected.id)}/timeline`,
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setTimeline(value.observations || []);
      })
      .catch((error) => {
        if (!controller.signal.aborted) report(errorMessage(error));
      });
    return () => controller.abort();
  }, [selected?.id, online]);
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
      report("服务器已记录已处理；手机实收仍需在设备核验");
    } catch (error) {
      report(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <MobileSheet title="事件记录" close={close}>
      <div className="mobile-tabs">
        {[
          ["triggers", "触发"],
          ["alerts", "异常 / 恢复"],
          ["system", "系统"],
        ].map(([key, title]) => (
          <button
            key={key}
            aria-pressed={tab === key}
            onClick={() => {
              setTab(key);
              setBefore(undefined);
            }}
          >
            {title}
          </button>
        ))}
      </div>
      {readAt && tab !== "triggers" && <p>上次读取 {stamp(readAt)}</p>}
      {error && (
        <>
          <p role="alert">{error}</p>
          <button onClick={() => setRetry((value) => value + 1)}>
            重试读取
          </button>
        </>
      )}
      {tab === "triggers" ? (
        <>
          {!events.length && <p>暂无已读取的触发记录。</p>}
          {events.map((event) => (
            <article key={event.id} className="mobile-status-card">
              <strong>
                {eventPresentation(event).name || event.display_label}
              </strong>
              <p>{eventPresentation(event).summary}</p>
              <p>
                触发价格 {event.price} · 目标 {event.threshold}
              </p>
              <p>
                触发 {stamp(event.occurred_at)}
                <br />
                检测 {stamp(event.detected_at)}
              </p>
              <p>
                {deliveryNames[event.delivery_status] || event.delivery_status}{" "}
                ·{" "}
                {deliveryNames[event.notification_status] ||
                  event.notification_status}
              </p>
              <p>
                {event.ack_at
                  ? "用户已确认 " + stamp(event.ack_at)
                  : "用户尚未确认"}{" "}
                · 手机送达未知
              </p>
              {event.message && <p>{event.message}</p>}
              {event.notice && (
                <button
                  disabled={!online || busy || Boolean(event.notice.handled_at)}
                  onClick={() =>
                    void confirmNotice({ id: event.notice!.id } as Notice)
                  }
                >
                  标记已处理
                </button>
              )}
              {!event.ack_at && event.notification_id && (
                <button
                  disabled={!online || busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api(
                        `/notifications/${encodeURIComponent(event.notification_id)}/ack`,
                        {},
                      );
                      report("用户确认已提交；下次读取后更新记录");
                    } catch (error) {
                      report(errorMessage(error));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  确认并停止本次提醒
                </button>
              )}
            </article>
          ))}
        </>
      ) : (
        <>
          {!history && !error && (
            <p>{online ? "正在读取记录…" : "暂无本页缓存"}</p>
          )}
          {history && !history.events.length && <p>本页暂无记录。</p>}
          {history?.events.map((notice) => (
            <button
              key={notice.id}
              className="mobile-series"
              onClick={() => setSelected(notice)}
            >
              <strong>{notice.title}</strong>
              <span>
                {noticeInstrument(notice)} ·{" "}
                {notice.handled_at ? "已处理" : "未处理"} ·{" "}
                {severityLabels[notice.severity] || notice.severity}
              </span>
              <span>{notice.message}</span>
              <span>{stamp(notice.occurred_at)}</span>
            </button>
          ))}
          <button
            disabled={!history?.before}
            onClick={() => setBefore(history!.before!)}
          >
            更早记录
          </button>
          {before && (
            <button onClick={() => setBefore(undefined)}>最新记录</button>
          )}
        </>
      )}
      {selected && (
        <MobileSheet
          title={selected.title}
          close={() => setSelected(undefined)}
        >
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
          <button
            disabled={!online || busy || Boolean(selected.handled_at)}
            onClick={() => void confirmNotice(selected)}
          >
            标记已处理
          </button>
        </MobileSheet>
      )}
    </MobileSheet>
  );
}
