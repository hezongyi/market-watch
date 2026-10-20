import type { Notice } from "./types";

/** Stable newest-first order, independent of severity or IndexedDB key order. */
export const newestFirst = (
  a: Pick<Notice, "occurred_at" | "id">,
  b: Pick<Notice, "occurred_at" | "id">,
) => b.occurred_at - a.occurred_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** Only controls still offered by the system-message list may restrict its query. */
export type SystemFilters = Partial<
  Record<"q" | "state" | "severity" | "source" | "sort", string>
>;
export function systemListFilters(
  filters: Record<string, string>,
): SystemFilters {
  return Object.fromEntries(
    ["q", "state", "severity", "source", "sort"]
      .filter((key) => filters[key])
      .map((key) => [key, filters[key]]),
  );
}
export function matchesSystemFilters(row: Notice, filters: SystemFilters) {
  return (
    row.source_kind !== "chart_alert" &&
    (!filters.severity || row.severity === filters.severity) &&
    (!filters.source || row.source_kind === filters.source) &&
    (filters.state !== "unread" || !row.viewed_at) &&
    (!filters.q ||
      JSON.stringify([row.title, row.message, row.context, row.evidence])
        .toLowerCase()
        .includes(filters.q.toLowerCase()))
  );
}
