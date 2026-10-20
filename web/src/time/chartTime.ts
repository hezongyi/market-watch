/** Display/input rules only. All values crossing the API remain Unix milliseconds. */
export function validTimeZone(zone: string): string | null {
  try {
    return new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions()
      .timeZone;
  } catch {
    return null;
  }
}
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string) {
  let value = formatters.get(zone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    if (formatters.size > 64) formatters.clear();
    formatters.set(zone, value);
  }
  return value;
}
function parts(stamp: number, zone: string) {
  return Object.fromEntries(
    formatter(zone)
      .formatToParts(stamp)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value]),
  );
}
export function dayKey(stamp: number, zone: string) {
  const p = parts(stamp, zone);
  return `${p.year}-${p.month}-${p.day}`;
}
export function clockTime(stamp: number, zone: string, seconds = true) {
  const p = parts(stamp, zone);
  return `${p.hour}:${p.minute}${seconds ? ":" + p.second : ""}`;
}
export function offsetLabel(stamp: number, zone: string) {
  const label =
    new Intl.DateTimeFormat("en", {
      timeZone: zone,
      timeZoneName: "longOffset",
    })
      .formatToParts(stamp)
      .find((p) => p.type === "timeZoneName")?.value || "GMT";
  const offset = /^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(label);
  if (!offset) return "UTC+0";
  const [, sign, hours, minutes, seconds] = offset;
  if (+hours === 0 && +minutes === 0 && !Number(seconds)) return "UTC+0";
  return `UTC${sign}${Number(hours)}${+minutes || Number(seconds) ? ":" + minutes : ""}${Number(seconds) ? ":" + seconds : ""}`;
}
export function formatTimestamp(
  stamp: number | null | undefined,
  zone: string,
) {
  return stamp == null || !Number.isFinite(stamp)
    ? "未知"
    : `${dayKey(stamp, zone)} ${clockTime(stamp, zone)} ${offsetLabel(stamp, zone)}`;
}
export function dateTimeInput(stamp: number | null, zone: string) {
  if (stamp == null) return "";
  const ms = ((stamp % 1000) + 1000) % 1000;
  return `${dayKey(stamp, zone)}T${clockTime(stamp, zone)}${ms ? "." + String(ms).padStart(3, "0") : ""}`;
}
/** The server's delivery text contains an immutable UTC ISO event line. Render
 * that generated line in the chart zone without changing the stored message. */
export function formatAlertMessage(
  message: string,
  stamp: number,
  zone: string,
) {
  return message.replace(
    /^发生时间 \d{4}-\d{2}-\d{2}T\S+(?= \/ 检测延迟 )/m,
    `发生时间 ${formatTimestamp(stamp, zone)}`,
  );
}
function wallStamp(text: string): number | null {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/.exec(
      text,
    );
  if (!m) return null;
  const [y, month, d, h, min, sec] = m.slice(1, 7).map((v) => Number(v || 0));
  const value = Date.UTC(
    y,
    month - 1,
    d,
    h,
    min,
    sec,
    Number((m[7] || "").padEnd(3, "0")),
  );
  const date = new Date(value);
  if (
    y < 1000 ||
    month < 1 ||
    month > 12 ||
    d < 1 ||
    h > 23 ||
    min > 59 ||
    sec > 59 ||
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== d
  )
    return null;
  return value;
}
function offsetAt(stamp: number, zone: string) {
  const p = parts(stamp, zone);
  return (
    Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) -
    Math.floor(stamp / 1000) * 1000
  );
}
/** Zero candidates = invalid/gap; two candidates = DST fold. Never guess browser zone. */
export function wallTimeCandidates(text: string, zone: string): number[] {
  const wall = wallStamp(text);
  if (wall == null) return [];
  const offsets = new Set<number>();
  // Covers both sides of a DST transition, including non-hour offsets/date-line changes.
  for (let hours = -36; hours <= 36; hours += 6)
    offsets.add(offsetAt(wall + hours * 3600000, zone));
  return [...new Set([...offsets].map((offset) => wall - offset))]
    .filter((stamp) => stamp + offsetAt(stamp, zone) === wall)
    .sort((a, b) => a - b);
}
/** Whole-day boundaries use local midnight, never a fixed 24 hours. */
export function dayBounds(
  day: string,
  zone: string,
): { since: number; until: number } {
  const wall = wallStamp(day);
  if (wall == null || day.length !== 10) throw Error("日期无效");
  const next = new Date(wall + 86400000).toISOString().slice(0, 10);
  const start = wallTimeCandidates(day, zone),
    end = wallTimeCandidates(next, zone);
  if (!start.length || !end.length)
    throw Error("该时区的日期边界不存在，请使用明确的起止时间");
  return { since: start[0], until: end[0] };
}
