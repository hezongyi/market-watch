export type Sparkline = {
  ticker: string;
  revision: {
    composite_revision_id?: string;
    input_revision?: number;
    cache_revision?: number;
  } | null;
  window_start: number;
  window_end: number;
  valid_until?: number;
  session?: { date: string; previous: boolean };
  session_open_price?: string | null;
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
  function cancel() {
    ++epoch;
    for (const controller of controllers) controller.abort();
    controllers.clear();
  }
  return {
    cancel,
    async load(items: { ticker: string; composite_revision_id?: string }[], observed?: () => void) {
      cancel();
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
                  (item.status === "partial" || item.status === "empty") &&
                  !history.prepared.has(item.ticker + ":" + item.window_start)));
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
      // History continues after visible refresh completes; at most two requests run at once.
      await Promise.all([0, 1].map(async () => {
        while (history && generation === epoch && pendingHistory.length) {
          const item = pendingHistory.shift()!;
          const controller = new AbortController();
          controllers.add(controller);
          try {
            const response = await history.request(item.ticker, controller.signal);
            if (generation !== epoch || controller.signal.aborted) continue;
            receive(response.items.filter(row => sparklineExpires(row) > response.as_of));
            if (response.preparation !== "retry")
              for (const row of response.items)
                if (!row.session || (!row.session.previous && row.points.length))
                  history.prepared.set(row.ticker + ":" + row.window_start, sparklineExpires(row));
          } catch (error) {
            if (generation === epoch && !controller.signal.aborted) failure(error);
          } finally {
            controllers.delete(controller);
          }
        }
      }));
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
  const prices = item.points.map(point => Number(point.price)).filter(Number.isFinite);
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

/** Width is the rendered CSS width. Fixed time coordinates and separate paths
 * on every gap remain unchanged; only redundant display points are removed. */
export function sparklinePaths(item: Sparkline, width = 200, height = 48, previousClose?: number, instrument?: string) {
  const prices = item.points.map((point) => Number(point.price));
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
  item.points.forEach((point, index) => {
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
