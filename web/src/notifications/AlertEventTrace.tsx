import { useEffect, useState } from "react";
import { AlertButton } from "../advanced/NativeAlertControls";
import type { Notice, NoticeTransport } from "./types";

/** Trading delivery facts belong in the existing alert log, never the system center. */
export function AlertEventTrace({
  signalId,
  request,
}: {
  signalId: string;
  request: NoticeTransport;
}) {
  const [opened, setOpened] = useState(false),
    [row, setRow] = useState<Notice | null>(null),
    [error, setError] = useState("");
  const [observations, setObservations] = useState<any[]>([]),
    [before, setBefore] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!opened) return;
    let alive = true;
    setError("");
    setBusy(true);
    void request({ action: "resolve-alert", event_id: signalId })
      .then(async (resolved) => {
        if (!resolved.event_id) throw Error("该事件的网页记录尚不可用");
        const [detail, line] = await Promise.all([
          request({ action: "detail", event_id: resolved.event_id }),
          request({ action: "timeline", event_id: resolved.event_id }),
        ]);
        if (!alive) return;
        setRow(detail);
        setObservations(line.observations);
        setBefore(line.before);
        await request({
          action: "observe",
          event_id: detail.id,
          kind: "viewed",
        });
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
  }, [opened, signalId, request]);
  return (
    <details onToggle={(event) => setOpened(event.currentTarget.open)}>
      <summary>网页与投递记录</summary>
      {busy && <p role="status">正在读取…</p>}
      {error && (
        <p className="alert-error" role="alert">
          {error}
        </p>
      )}
      {row && (
        <>
          <p>
            网页已读：
            {row.viewed_at
              ? new Date(row.viewed_at).toLocaleString()
              : "本次已查看，等待同步"}
          </p>
          <p>网页渲染、声音开始、服务接受与设备收到分别记录。</p>
          <pre>
            {JSON.stringify(
              { channels: row.channels || {}, observations },
              null,
              2,
            )}
          </pre>
          {before && (
            <AlertButton
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void request({ action: "timeline", event_id: row.id, before })
                  .then((line) => {
                    setObservations((old) => [...old, ...line.observations]);
                    setBefore(line.before);
                  })
                  .catch((error) => setError(String(error)))
                  .finally(() => setBusy(false));
              }}
            >
              更早的投递记录
            </AlertButton>
          )}
        </>
      )}
    </details>
  );
}
