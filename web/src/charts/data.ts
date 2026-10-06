import { api } from "../api";
import type { Panel, ChartData } from "./types";
const pending = new Map<string, Promise<ChartData>>();
const cache = new Map<string, { at: number; data: ChartData }>();
const client = `cw-${crypto.randomUUID()}`;
export function chartData(
  panel: Panel,
  before?: number,
  limit = 500,
): Promise<ChartData> {
  const query = {
    client,
    instrument: panel.instrument,
    timeframe: panel.timeframe,
    indicators: panel.indicators.map(({ name, version, params }) => ({
      name,
      version,
      params,
    })),
    before,
    limit,
  };
  const withIds = (data: ChartData): ChartData => ({
    ...data,
    indicators: data.indicators.map((result, i) => ({
      ...result,
      id: panel.indicators[i].id,
    })),
  });
  const key = JSON.stringify(query),
    saved = cache.get(key);
  if (saved && Date.now() - saved.at < 8000)
    return Promise.resolve(withIds(saved.data));
  const running = pending.get(key);
  if (running) return running.then(withIds);
  const request = api<ChartData>("/charts/data", query)
    .then((data) => {
      cache.set(key, { at: Date.now(), data });
      if (cache.size > 40) cache.delete(cache.keys().next().value!);
      return data;
    })
    .finally(() => pending.delete(key));
  pending.set(key, request);
  return request.then(withIds);
}
