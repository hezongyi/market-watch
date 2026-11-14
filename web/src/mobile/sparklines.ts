export type Sparkline = {
  ticker: string;
  revision: {
    history_version_id?: string;
    composite_revision_id?: string;
    input_revision?: number;
    cache_revision?: number;
  } | null;
  window_start: number;
  window_end: number;
  valid_until?: number;
  target_window_start?: number;
  target_window_end?: number;
  next_check_at?: number;
  identity_key?: string;
  stock_session?: boolean;
  display_state?: "current" | "closed" | "previous" | "historical" | "unknown" | "empty" | "unsupported";
  session?: { date: string; previous: boolean };
  session_open_price?: string | null;
  previous_close_price?: string | null;
  previous_close_at?: number | null;
  preparation_error?: string | null;
  timeframe: string | null;
  reference_times?: number[];
  points: { time: number; price: string; gap_before: boolean }[];
  status: "ready" | "partial" | "empty" | "unavailable";
  reason: string | null;
  last_data_at: number | null;
};
/** Display bounds may be a completed stock session; validity belongs to today. */
export function sparklineExpires(item: Sparkline) {
  return item.valid_until ?? item.window_end;
}

type SparkQuote = { s: string; v: Record<string, any>; snapshot?: { revision_id?: string } };
/** A display-only quote overlay. Source clocks, never HTTP receipt time, place
 * the tail; the original history and cached observations remain untouched. */
export function sparklineWithQuote(item: Sparkline, quote?: SparkQuote, now = Date.now()): Sparkline {
  const value = quote?.v;
  if (quote?.s !== "ok" || !value || value.fetch_status !== "ok" || value.session_conflict ||
      !item.points.length || item.ticker.startsWith("MWH:") || item.session?.previous || item.display_state === "closed" ||
      now < item.window_start || now >= item.window_end ||
      value.time_type === "fixed_history" || value.time_type === "source_d1" ||
      (quote.snapshot?.revision_id && quote.snapshot.revision_id !== item.revision?.composite_revision_id)) return item;
  const sourceMinute = value.time_type === "source_m1" || value.resolution === "M1" ||
    (value.time_type === "composite_snapshot" && ["source_m1", "candle_close_sample"].includes(value.observation_type));
  const time = Number.isFinite(value.quote_time) ? value.quote_time : sourceMinute ? value.data_start : undefined;
  const price = value.lp;
  if (!Number.isFinite(time) || !Number.isFinite(price) || time < item.window_start ||
      time >= item.window_end || time > now) return item;
  const last = item.points.at(-1);
  if (last && time < last.time) return item;
  if (last && time === last.time && Number(last.price) === price) return item;
  const step = ({ M1: 60_000, M5: 300_000, M15: 900_000, M30: 1_800_000, H1: 3_600_000 } as Record<string, number>)[item.timeframe || ""] || 60_000;
  const same = last?.time === time;
  const gap = last ? Math.floor((time - item.window_start) / step) - Math.floor((last.time - item.window_start) / step) > 1 : false;
  const point = { time, price: String(price), gap_before: same ? last!.gap_before : gap };
  return { ...item, points: [...(same ? item.points.slice(0, -1) : item.points), point], last_data_at: time };
}

/** Empty refreshes do not erase a still-valid, identity-matched curve. */
export function mergeSparkline(old: Sparkline | undefined, next: Sparkline, now = Date.now()): Sparkline {
  if (!next.points.length && next.status !== "unavailable" && next.display_state !== "unsupported" && next.preparation_error === undefined &&
      old?.preparation_error && old.ticker === next.ticker && old.identity_key === next.identity_key &&
      old.revision?.input_revision === next.revision?.input_revision &&
      old.revision?.composite_revision_id === next.revision?.composite_revision_id && sparklineExpires(old) > now)
    next = { ...next, preparation_error: old.preparation_error };
  if (!old?.points.length || next.points.length || next.status === "unavailable" || next.display_state === "unsupported" ||
      sparklineExpires(old) <= now || old.ticker !== next.ticker ||
      old.identity_key !== next.identity_key ||
      old.revision?.composite_revision_id !== next.revision?.composite_revision_id ||
      old.revision?.input_revision !== next.revision?.input_revision) return next;
  const previous = old.window_start !== (next.target_window_start ?? next.window_start);
  return { ...old, target_window_start: next.target_window_start, target_window_end: next.target_window_end,
    next_check_at: next.next_check_at, session: {date: old.session?.date || new Date(old.window_start).toISOString().slice(0,10), previous},
    display_state: previous ? old.display_state === "historical" ? "historical" : "previous" : old.display_state,
    reason: "本次读取为空，显示同一来源的有效缓存" };
}

export function sparklineNeedsRecheck(item: Sparkline | undefined, quote: SparkQuote, now = Date.now()) {
  if (!item || item.display_state === "unsupported" || item.ticker.startsWith("MWH:") ||
      (!item.session?.previous && item.points.length) || quote.s !== "ok" || quote.v?.fetch_status !== "ok") return false;
  const at = quote.v.quote_time ?? quote.v.data_start;
  return Number.isFinite(at) && at <= now && at >= (item.target_window_start ?? item.window_start) &&
    at < (item.target_window_end ?? item.window_end);
}

const preparationKey = (item: Sparkline) => JSON.stringify([item.ticker, item.identity_key, item.target_window_start ?? item.window_start]);

type Request = (
  items: { ticker: string; composite_revision_id?: string }[],
  signal: AbortSignal,
) => Promise<{ as_of: number; items: Sparkline[] }>;
/** Each visible generation owns at most two bounded requests and rejects late replies. */
export function sparklineLoader(
  request: Request,
  receive: (items: Sparkline[]) => void,
  failure: (error: unknown) => void,
  history?: {
    prepared: Map<string, number>;
    request: (ticker: string, signal: AbortSignal) => Promise<{
      as_of: number; items: Sparkline[]; preparation: "ready" | "retry" | "unsupported";
    }>;
  },
) {
  let epoch = 0;
  const controllers = new Set<AbortController>();
  const historyControllers = new Set<AbortController>();
  const preparations = new Map<string, Promise<void>>();
  const historyQueue: { item: Sparkline; lifetime: number; resolve(): void; promise: Promise<void> }[] = [];
  let lifetime = 0, activeHistory = 0;
  const retryAttempts = new Map<string, number>();
  function cancelObservations() {
    ++epoch;
    for (const controller of controllers) controller.abort();
    controllers.clear();
  }
  function cancel() {
    cancelObservations();
    ++lifetime;
    for (const controller of historyControllers) controller.abort();
    historyControllers.clear();
    for (const task of historyQueue.splice(0)) task.resolve();
    preparations.clear();
  }
  function drainHistory() {
    while (history && activeHistory < 2 && historyQueue.length) {
      const task = historyQueue.shift()!, key = preparationKey(task.item);
      const controller = new AbortController();
      historyControllers.add(controller);
      ++activeHistory;
      void (async () => {
        try {
          const response = await history.request(task.item.ticker, controller.signal);
          if (task.lifetime !== lifetime || controller.signal.aborted) return;
          receive(response.items.filter(row => sparklineExpires(row) > response.as_of));
          for (const row of response.items) {
            const key = preparationKey(row);
            if (response.preparation === "unsupported") history.prepared.set(key, row.previous_close_price == null ? response.as_of + 900000 : Math.max(response.as_of + 900000, row.target_window_end ?? row.window_end));
            else if (response.preparation === "ready" && row.points.length && !row.session?.previous && row.display_state !== "unknown") {
              retryAttempts.delete(key);
              history.prepared.set(key, Math.max(response.as_of + 900000, row.target_window_end ?? row.window_end));
            } else {
              const attempt = (retryAttempts.get(key) || 0) + 1;
              retryAttempts.set(key, attempt);
              history.prepared.set(key, response.as_of + Math.min(900000, 60000 * 2 ** Math.min(attempt - 1, 4)));
            }
          }
        } catch (error) {
          if (task.lifetime === lifetime && !controller.signal.aborted) {
            history.prepared.set(key, Date.now() + 60000); failure(error);
          }
        } finally {
          historyControllers.delete(controller);
          if (preparations.get(key) === task.promise) preparations.delete(key);
          --activeHistory;
          task.resolve();
          drainHistory();
        }
      })();
    }
  }
  function prepare(item: Sparkline) {
    const key = preparationKey(item);
    const pending = preparations.get(key);
    if (pending) return pending;
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    preparations.set(key, promise);
    historyQueue.push({ item, lifetime, resolve, promise });
    drainHistory();
    return promise;
  }
  return {
    cancel,
    async load(items: { ticker: string; composite_revision_id?: string }[], observed?: () => void) {
      cancelObservations();
      const generation = epoch;
      const distinct = [
        ...new Map(items.map((item) => [JSON.stringify(item), item])).values(),
      ];
      const queue: (typeof distinct)[] = [];
      for (let i = 0; i < distinct.length; i += 20)
        queue.push(distinct.slice(i, i + 20));
      const pendingHistory: Sparkline[] = [];
      await Promise.all(
        [0, 1].map(async () => {
          while (generation === epoch && queue.length) {
            const batch = queue.shift()!;
            const controller = new AbortController();
            controllers.add(controller);
            try {
              const response = await request(batch, controller.signal);
              if (generation !== epoch || controller.signal.aborted) continue;
              // A cached HTTP reply can cross midnight; old windows cannot redraw.
              const current = response.items.filter(item => sparklineExpires(item) > response.as_of);
              receive(current);
              if (history) {
                for (const [key, end] of history.prepared)
                  if (end <= response.as_of) history.prepared.delete(key);
                pendingHistory.push(...current.filter(item => item.ticker.startsWith("MWP:") &&
                  (item.status === "partial" || item.status === "empty" || item.points.length > 0 && item.previous_close_price == null || item.stock_session && item.display_state === "unknown") &&
                  !history.prepared.has(preparationKey(item))));
              }
            } catch (error) {
              if (generation === epoch && !controller.signal.aborted)
                failure(error);
            } finally {
              controllers.delete(controller);
            }
          }
        }),
      );
      if (generation !== epoch) return;
      observed?.();
      // Preparations survive the next observation poll and share a two-request
      // queue. Explicit cancel() still ends everything when the page pauses.
      await Promise.all(pendingHistory.map(prepare));
    },
  };
}

/** Screen-space simplification (0.7 SVG units), separately for every data segment.
 * Anchor endpoints and absolute extrema; discard only visually redundant bends.
 * Coordinates always refer to actual observations, never interpolated prices. */
function visualPoints(points: [number, number][]) {
  if (points.length < 3) return points;
  let low = 0, high = 0;
  points.forEach((point, i) => {
    if (point[1] < points[low][1]) low = i;
    if (point[1] > points[high][1]) high = i;
  });
  const keep = new Set([0, low, high, points.length - 1]);
  const anchors = [...keep].sort((a, b) => a - b);
  const pending = anchors.slice(1).map((end, i) => [anchors[i], end]);
  while (pending.length) {
    const [start, end] = pending.pop()!;
    const [x, y] = points[start];
    const dx = points[end][0] - x, dy = points[end][1] - y;
    const lengthSquared = dx * dx + dy * dy;
    let farthest = -1, maximum = 0.7 ** 2;
    for (let i = start + 1; i < end; i++) {
      const px = points[i][0] - x, py = points[i][1] - y;
      const t = lengthSquared ? Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSquared)) : 0;
      const distance = (px - t * dx) ** 2 + (py - t * dy) ** 2;
      if (distance > maximum) { maximum = distance; farthest = i; }
    }
    if (farthest !== -1) {
      keep.add(farthest);
      pending.push([start, farthest], [farthest, end]);
    }
  }
  return [...keep].sort((a, b) => a - b).map(index => points[index]);
}

const CURRENCIES = new Set(["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "NOK", "SEK", "SGD", "HKD"]);

/** Minimum total price range per instrument class, expressed as a fraction of price. */
export function sparklineMinimumRange(instrument?: string) {
  const symbol = instrument?.toUpperCase().replace(/[^A-Z]/g, "") || "";
  if (/^(BTC|ETH|SOL|BNB|XRP|DOGE|LTC|ADA)(USD|USDT|USDC)?$/.test(symbol)) return 0.02;
  if (/^(XAU|XAG)(USD|EUR|GBP)?$/.test(symbol)) return 0.005;
  if (symbol.length === 6 && CURRENCIES.has(symbol.slice(0, 3)) && CURRENCIES.has(symbol.slice(3))) return 0.002;
  return 0.01;
}

/** Scale to the observed session range, with a class-specific floor so the
 * opening noise does not fill the chart. Reference price follows the same axis. */
export function sparklineScale(item: Sparkline, height = 48, previousClose?: number, instrument?: string) {
  const prices = sparklineDisplayPoints(item).map(point => Number(point.price)).filter(Number.isFinite);
  const reference = typeof previousClose === "number" && Number.isFinite(previousClose)
    ? previousClose : undefined;
  const low = prices.length ? Math.min(...prices) : reference ?? 0;
  const high = prices.length ? Math.max(...prices) : reference ?? 0;
  const center = (low + high) / 2;
  const minimum = Math.abs(reference ?? center) * sparklineMinimumRange(instrument);
  const span = Math.max(high - low, minimum, 1e-8);
  const padding = span * 0.1;
  const domainLow = center - span / 2 - padding;
  const domainHigh = center + span / 2 + padding;
  const y = (price: number) => height - 4 - (price - domainLow) / (domainHigh - domainLow) * (height - 8);
  const referencePosition = reference === undefined ? undefined : y(reference);
  const referenceOutside = referencePosition !== undefined && (referencePosition < 4 || referencePosition > height - 4);
  const referenceY = referencePosition === undefined ? undefined : Math.max(4, Math.min(height - 4, referencePosition));
  return { y, referenceY, referenceOutside };
}

/** Reduce M1 observations only for display, retaining the latest point in each
 * five-minute bucket and keeping each gap-separated segment independent. */
export function sparklineDisplayPoints(item: Sparkline) {
  if (item.timeframe !== "M1" || item.points.length < 2) return item.points;
  const interval = 5 * 60_000;
  const sampled: Sparkline["points"] = [];
  let bucket: number | undefined;
  let latest: Sparkline["points"][number] | undefined;
  const flush = () => {
    if (latest) sampled.push(latest);
    latest = undefined;
    bucket = undefined;
  };
  for (const point of item.points) {
    if (point.gap_before) flush();
    const nextBucket = Math.floor((point.time - item.window_start) / interval);
    if (bucket !== undefined && nextBucket !== bucket) flush();
    bucket = nextBucket;
    latest = latest?.gap_before ? { ...point, gap_before: true } : point;
  }
  flush();
  return sampled;
}

/** Width is the rendered CSS width. Fixed time coordinates and separate paths
 * on every gap remain unchanged; only redundant display points are removed. */
export function sparklinePaths(item: Sparkline, width = 200, height = 48, previousClose?: number, instrument?: string) {
  const pointsToDraw = sparklineDisplayPoints(item);
  const prices = pointsToDraw.map((point) => Number(point.price));
  if (!prices.length || prices.some((price) => !Number.isFinite(price)))
    return [];
  const scale = sparklineScale(item, height, previousClose, instrument);
  const paths: { line: string; area: string; end: [number, number] }[] = [];
  let points: [number, number][] = [];
  const finish = () => {
    if (!points.length) return;
    let line = visualPoints(points)
      .map(
        ([x, y], index) =>
          `${index ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`,
      )
      .join(" ");
    // A single observation remains visible as a round stroke cap.
    if (points.length === 1) line += ` L${points[0][0].toFixed(2)},${points[0][1].toFixed(2)}`;
    const end = points.at(-1)!;
    paths.push({
      line,
      area: `${line} L${end[0]},${height} L${points[0][0]},${height} Z`,
      end,
    });
    points = [];
  };
  pointsToDraw.forEach((point, index) => {
    if (point.gap_before) finish();
    const x =
      ((point.time - item.window_start) /
        (item.window_end - item.window_start)) *
      width;
    const y = scale.y(prices[index]);
    points.push([x, y]);
  });
  finish();
  return paths;
}
