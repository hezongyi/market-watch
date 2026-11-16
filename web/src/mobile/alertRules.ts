import { api } from "../api";
import type { AlertRow } from "../advanced/chartAlerts";

/** Refresh the loaded span through real cursors, retaining the hook's mutation fence. */
export async function readRuleSpan(
  pages: number,
  signal?: AbortSignal,
  status?: string,
) {
  const items: AlertRow[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < pages; page++) {
    const value = await api<{ items: AlertRow[]; next_cursor: string | null }>(
      "/chart-alerts/page?" +
        new URLSearchParams({
          limit: "50",
          ...(status ? { status } : {}),
          ...(cursor ? { before: cursor } : {}),
        }),
      undefined,
      signal,
    );
    items.push(...value.items);
    cursor = value.next_cursor || undefined;
    if (!cursor) break;
  }
  return {
    items: [...new Map(items.map((row) => [row.id, row])).values()],
    hasMore: !!cursor,
  };
}
