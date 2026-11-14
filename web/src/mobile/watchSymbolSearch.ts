import { api } from "../api";
import type { Dataset } from "../market-data/types";
import { datasetRow, rowKey, type MarketRow } from "./dataMarkets";

type Position = { native: { offset: number; cursor?: string } | null; managed: number | null };

/** Two independent directories, one append-only result list and page chain. */
export async function watchSymbolPage(query: string, cursor: string | undefined, signal: AbortSignal) {
  const position: Position = cursor ? JSON.parse(cursor) : { native: { offset: 0 }, managed: 1 };
  const [native, managed] = await Promise.all([
    position.native ? api<{ items: MarketRow[]; has_more?: boolean; next_offset?: number | null; next_cursor?: string | null }>(
      "/market-data/series/page?" + new URLSearchParams({ query, kind: "provider", include_total: "false", page_size: "25",
        offset: String(position.native.offset), ...(position.native.cursor ? { cursor: position.native.cursor } : {}) }), undefined, signal,
    ) : undefined,
    position.managed ? api<{ items: Dataset[]; total: number }>(
      "/market-data/center/dataset-summaries?" + new URLSearchParams({ query, page_size: "25", page: String(position.managed) }), undefined, signal,
    ) : undefined,
  ]);
  const next: Position = {
    native: native && native.has_more !== false && (native.next_cursor || native.next_offset != null)
      ? { offset: native.next_offset ?? position.native!.offset + 25, cursor: native.next_cursor || undefined } : null,
    managed: managed && position.managed! * 25 < managed.total ? position.managed! + 1 : null,
  };
  const items = [...(native?.items || []), ...(managed?.items.map(datasetRow) || [])].sort((a, b) =>
    (a.display_symbol || a.symbol || "").localeCompare(b.display_symbol || b.symbol || "") ||
    Number(!!b.managed) - Number(!!a.managed) || (a.source || "").localeCompare(b.source || "") || rowKey(a).localeCompare(rowKey(b)));
  return { items, next: next.native || next.managed ? JSON.stringify(next) : undefined };
}
