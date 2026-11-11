export type Sparkline = {
  ticker: string;
  revision: {
    composite_revision_id?: string;
    input_revision?: number;
    cache_revision?: number;
  } | null;
  window_start: number;
  window_end: number;
  timeframe: string | null;
  reference_times?: number[];
  points: { time: number; price: string; gap_before: boolean }[];
  status: "ready" | "partial" | "empty" | "unavailable";
  reason: string | null;
  last_data_at: number | null;
};
type Request = (
  items: { ticker: string; composite_revision_id?: string }[],
  signal: AbortSignal,
) => Promise<{ as_of: number; items: Sparkline[] }>;
/** Each visible generation owns at most two bounded requests and rejects late replies. */
export function sparklineLoader(
  request: Request,
  receive: (items: Sparkline[]) => void,
  failure: (error: unknown) => void,
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
    async load(items: { ticker: string; composite_revision_id?: string }[]) {
      cancel();
      const generation = epoch;
      const distinct = [
        ...new Map(items.map((item) => [JSON.stringify(item), item])).values(),
      ];
      const queue: (typeof distinct)[] = [];
      for (let i = 0; i < distinct.length; i += 20)
        queue.push(distinct.slice(i, i + 20));
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
              receive(
                response.items.filter(
                  (item) => item.window_end > response.as_of,
                ),
              );
            } catch (error) {
              if (generation === epoch && !controller.signal.aborted)
                failure(error);
            } finally {
              controllers.delete(controller);
            }
          }
        }),
      );
    },
  };
}

/** Fixed time coordinates and separate paths on every gap; no compression/fill-in. */
export function sparklinePaths(item: Sparkline, width = 200, height = 48) {
  const prices = item.points.map((point) => Number(point.price));
  if (!prices.length || prices.some((price) => !Number.isFinite(price)))
    return [];
  const low = Math.min(...prices),
    high = Math.max(...prices),
    span = high - low || Math.abs(high) * 0.001 || 1;
  const paths: { line: string; area: string; end: [number, number] }[] = [];
  let points: [number, number][] = [];
  const finish = () => {
    if (!points.length) return;
    const line = points
      .map(
        ([x, y], index) =>
          `${index ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`,
      )
      .join(" ");
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
    const y = 4 + ((high - prices[index]) / span) * (height - 8);
    points.push([x, y]);
  });
  finish();
  return paths;
}
