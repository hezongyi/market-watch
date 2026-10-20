import { useChartTime } from "../time/ChartTimeContext";
import { formatTimestamp } from "../time/chartTime";
import { useEffect, useState } from "react";
import { AlertButton } from "../advanced/NativeAlertControls";
import type { HistoryPage, NoticeTransport } from "./types";

export function SystemOccurrences({
  incident,
  request,
}: {
  incident: string;
  request: NoticeTransport;
}) {
  const { zone } = useChartTime();
  const [page, setPage] = useState<HistoryPage | null>(null),
    [before, setBefore] = useState<string | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setError("");
    void request({
      action: "history",
      filters: { incident, grouped: "false" },
      before,
    })
      .then((page) => {
        if (alive) setPage(page);
      })
      .catch((error) => {
        if (alive) setError(String(error));
      });
    return () => {
      alive = false;
    };
  }, [incident, request, before]);
  return (
    <div className="nc-occurrences">
      <h3>本次异常的发生记录</h3>
      {error && <p role="alert">{error}</p>}
      {page?.events.map((row) => (
        <details key={row.id}>
          <summary>
            {formatTimestamp(row.occurred_at, zone)} · {row.title}
          </summary>
          <pre>
            {JSON.stringify(
              {
                id: row.id,
                source_id: row.source_id,
                context: row.context,
                evidence: row.evidence,
              },
              null,
              2,
            )}
          </pre>
        </details>
      ))}
      {page?.before && (
        <AlertButton onClick={() => setBefore(page.before)}>
          更早的发生记录
        </AlertButton>
      )}
    </div>
  );
}
