import { api } from "../api";
import type { Dataset } from "../market-data/types";
import type { Continuation } from "../market-data/DatasetContinuation";

export type MarketRow = {
  ticker: string;
  id?: string;
  symbol?: string;
  display_symbol?: string;
  description?: string;
  series_kind?: string;
  source?: string;
  dataset_id?: string;
  managed?: boolean;
  [key: string]: any;
};

export const rowKey = (row: MarketRow) =>
  row.managed ? `dataset:${row.dataset_id}` : row.ticker;

export function datasetRow(dataset: Dataset): MarketRow {
  const frame = dataset.usable_timeframes[0];
  const version = dataset.periods.find(
    (period) => period.timeframe === frame,
  )?.available_version_id;
  return {
    ...dataset,
    managed: true,
    dataset_id: dataset.id,
    ticker: version && !dataset.continuation?.enabled ? `MWH:${version}` : "",
    series_kind: "managed",
    symbol: dataset.logical_symbol,
    source: dataset.identity.source,
    basis: dataset.identity.basis,
    frames: dataset.usable_timeframes,
    start: dataset.available_start,
    end: dataset.available_end,
    latest_at: dataset.available_end,
  };
}

// Resolve only on explicit use. A list of datasets must not fetch every
// continuation, nor mistake an arbitrary saved configuration for its default.
export async function loadManaged(
  row: MarketRow,
  signal?: AbortSignal,
): Promise<MarketRow> {
  const id = encodeURIComponent(row.dataset_id!);
  const [dataset, continuation] = await Promise.all([
    api<Dataset>(`/market-data/center/datasets/${id}`, undefined, signal),
    api<Continuation>(
      `/market-data/datasets/${id}/continuation`,
      undefined,
      signal,
    ),
  ]);
  const current = datasetRow(dataset);
  let selectionError = "";
  if (continuation.enabled) {
    if (
      !continuation.ready_to_enable ||
      !continuation.composite ||
      continuation.composite.preparation.status !== "queried"
    ) {
      current.ticker = "";
      selectionError =
        continuation.reason ||
        "实时接续准备中，可在固定历史版本中查看已发布数据";
    } else {
      current.ticker = `MWC:${continuation.composite.id}`;
    }
  } else if (!current.ticker) {
    selectionError = "尚无可用的已发布数据，请在桌面完成数据准备";
  }
  return { ...current, continuation, selectionError };
}

export async function actionableRow(row: MarketRow) {
  const current = row.managed ? await loadManaged(row) : row;
  if (!current.ticker) throw Error(current.selectionError || "行情尚未就绪");
  return current;
}

export function marketType(row: MarketRow) {
  return row.managed ||
    (row.series_kind !== "provider" && !row.ticker.startsWith("MWP:"))
    ? "自建"
    : "原生";
}

export const continuationLabel = (status: string) =>
  (
    ({
      enabled: "已开启",
      disabled: "未开启",
      preparing: "准备中",
      receiving: "运行中",
      recovering: "恢复中",
      inactive: "等待实时来源",
      market_closed: "闭市",
      attention: "需处理",
      account_changed: "账户已变化",
      unauthorized: "认证异常",
      provider_maintenance: "来源维护中",
    }) as Record<string, string>
  )[status] || "状态待确认";
