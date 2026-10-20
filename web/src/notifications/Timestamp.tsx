import { useChartTime } from "../time/ChartTimeContext";
import {
  clockTime,
  dayKey,
  formatTimestamp,
  offsetLabel,
} from "../time/chartTime";

/** All three fields describe the same instant in the active chart's zone. */
export function NoticeTimestamp({ stamp }: { stamp: number }) {
  const { zone } = useChartTime();
  return (
    <time
      className="nc-timestamp"
      dateTime={new Date(stamp).toISOString()}
      aria-label={formatTimestamp(stamp, zone)}
    >
      <span className="nc-timestamp-date">{dayKey(stamp, zone)}</span>
      <span className="nc-timestamp-clock">{clockTime(stamp, zone)}</span>
      <span className="nc-timestamp-offset">{offsetLabel(stamp, zone)}</span>
    </time>
  );
}
