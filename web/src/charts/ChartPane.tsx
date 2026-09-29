import { useEffect, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  AreaSeries,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import {
  createLineToolsPlugin,
  registerLinesPlugin,
  LineToolRectangle,
  registerFibRetracementPlugin,
  registerTextPlugin,
  registerParallelChannelPlugin,
  registerLongShortPositionPlugin,
  type DrawingPlugin,
} from "./vendor/line-tools";
import { chartData } from "./data";
import type { ChartData, Drawing, Panel } from "./types";
import type { Bar } from "../api";
export type Handle = {
  range: (r: { from: number; to: number }) => void;
  cross: (time: number | null, price?: number) => void;
  draw: (type: string, options?: object) => void;
  cancel: () => void;
  refresh: () => void;
  export: () => Drawing[];
  viewRange: () => { from: number; to: number } | null;
};
type Props = {
  panel: Panel;
  drawings: Drawing[];
  readonly: boolean;
  active: boolean;
  onActivate: () => void;
  onDrawings: (d: Drawing[]) => void;
  onSelect: (d: Drawing | null) => void;
  onRange: (r: { from: number; to: number }) => void;
  onCross: (time: number | null, price?: number) => void;
  onReady: (handle: Handle | null) => void;
  onLoaded: () => void;
};
const counts: Record<string, number> = {
  HorizontalLine: 1,
  TrendLine: 2,
  Ray: 2,
  Rectangle: 2,
  FibRetracement: 2,
  Text: 1,
  ParallelChannel: 3,
  LongShortPosition: 3,
};
const colors = ["#2962ff", "#f59e0b", "#a855f7", "#089981"];
function zoned(time: number, zone: string, month = false) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    ...(month
      ? {}
      : { day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }),
  }).format(new Date(time * 1000 + (month ? 86400000 : 0)));
}
function tickLabel(time: number, zone: string, type: number, month: boolean) {
  if (month) return zoned(time, zone, true);
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: zone,
    ...(type >= 3
      ? { hour: "2-digit", minute: "2-digit", hour12: false }
      : type === 0
        ? { year: "numeric" }
        : { month: "2-digit", day: "2-digit" }),
  }).format(new Date(time * 1000));
}
export default function ChartPane(props: Props) {
  const root = useRef<HTMLDivElement>(null),
    current = useRef(props);
  current.current = props;
  const live = useRef<{
    chart: IChartApi;
    plugin: DrawingPlugin;
    applyDraw: (d: Drawing[]) => void;
    cancel: () => void;
    indicators: () => void;
  } | null>(null);
  const [status, setStatus] = useState("正在加载行情…"),
    [error, setError] = useState(""),
    [projectionNotice, setProjectionNotice] = useState(""),
    [empty, setEmpty] = useState(false);
  useEffect(() => {
    let disposed = false,
      busy = false,
      loading = false,
      drawing = false,
      applying = false,
      initial = true,
      hasMore = true;
    let suppressUntil = 0,
      gestureUntil = 0;
    let data: ChartData | null = null,
      rows: Bar[] = [],
      future: ChartData["future"] = [],
      grid: { time: number }[] = [],
      wantRange: { from: number; to: number } | null = null;
    let indicatorSeries: ISeriesApi<any>[] = [],
      indicatorKey = "";
    const el = root.current!;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: "#ffffff" },
        textColor: "#787b86",
        fontFamily: "Arial, system-ui",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#f0f3fa" },
        horzLines: { color: "#f0f3fa" },
      },
      rightPriceScale: { borderColor: "#e0e3eb", minimumWidth: 72 },
      timeScale: {
        borderColor: "#e0e3eb",
        timeVisible: true,
        rightOffset: 8,
        secondsVisible: false,
      },
      crosshair: { mode: CrosshairMode.Normal },
      handleScroll: true,
      handleScale: true,
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#089981",
      downColor: "#f23645",
      wickUpColor: "#089981",
      wickDownColor: "#f23645",
      borderVisible: false,
    });
    // Geometry reads an explicit server calendar grid, including price-less future coordinates.
    // The actual candlestick series still contains no fabricated OHLC values.
    const geometrySeries = new Proxy(series, {
      get(target, key) {
        if (key === "dataByIndex")
          return (index: number, direction = 0) => {
            const i =
              direction === -1
                ? Math.min(grid.length - 1, Math.floor(index))
                : direction === 1
                  ? Math.max(0, Math.ceil(index))
                  : Math.round(index);
            return grid[i];
          };
        const value = (target as any)[key];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const plugin = createLineToolsPlugin(chart, geometrySeries);
    registerLinesPlugin(plugin);
    plugin.registerLineTool("Rectangle", LineToolRectangle);
    registerFibRetracementPlugin(plugin);
    registerTextPlugin(plugin);
    registerParallelChannelPlugin(plugin);
    registerLongShortPositionPlugin(plugin);
    plugin.setLocked(current.current.readonly);
    const exported = () => JSON.parse(plugin.exportLineTools()) as Drawing[];
    function applyDraw(objects: Drawing[]) {
      applying = true;
      plugin.removeAllLineTools();
      plugin.importLineTools(JSON.stringify(objects));
      plugin.setLocked(current.current.readonly);
      applying = false;
    }
    function cancel() {
      drawing = false;
      applyDraw(current.current.drawings);
      chart.applyOptions({ handleScroll: true, handleScale: true });
    }
    function changed() {
      if (applying || current.current.readonly) return;
      const all = exported();
      if (all.some((x) => x.points.length < counts[x.toolType])) return;
      const min = grid[0]?.time,
        max = grid.at(-1)?.time ?? Infinity;
      const bad = all.some((x) =>
        x.points.some(
          (p) =>
            !Number.isFinite(p.timestamp) ||
            !Number.isFinite(p.price) ||
            p.price <= 0 ||
            ((p.timestamp < min || p.timestamp > max) &&
              !current.current.drawings
                .find((d) => d.id === x.id)
                ?.points.some(
                  (old) =>
                    old.timestamp === p.timestamp && old.price === p.price,
                )),
        ),
      );
      if (bad) {
        setError("锚点超出已加载历史或日历投影范围，请加载历史后再绘制");
        cancel();
        return;
      }
      drawing = false;
      chart.applyOptions({ handleScroll: true, handleScale: true });
      current.current.onDrawings(all);
      const selected = JSON.parse(plugin.getSelectedLineTools()) as Drawing[];
      current.current.onSelect(selected[0] ?? null);
    }
    plugin.subscribeLineToolsAfterEdit(changed);
    plugin.subscribeLineToolsSingleClick(() => {
      const selected = JSON.parse(plugin.getSelectedLineTools()) as Drawing[];
      current.current.onSelect(selected[0] ?? null);
    });
    plugin.subscribeLineToolsDoubleClick(() => {
      const selected = JSON.parse(plugin.getSelectedLineTools()) as Drawing[];
      current.current.onSelect(selected[0] ?? null);
    });
    function renderIndicators() {
      if (!data) return;
      const key = JSON.stringify(current.current.panel.indicators);
      if (key !== indicatorKey) {
        indicatorSeries.forEach((s) => chart.removeSeries(s));
        indicatorSeries = [];
        indicatorKey = key;
      }
      let index = 0,
        pane = 1;
      for (const result of data.indicators) {
        const spec = current.current.panel.indicators.find(
          (i) => i.id === result.id,
        );
        const target = result.pane === "main" ? 0 : pane++;
        for (const [j, line] of result.series.entries()) {
          let s = indicatorSeries[index];
          if (!s) {
            s = chart.addSeries(
              line.type === "histogram"
                ? HistogramSeries
                : line.type === "area"
                  ? AreaSeries
                  : LineSeries,
              {
                color:
                  j === 0
                    ? spec?.color || colors[0]
                    : colors[j % colors.length],
                lineWidth: 2,
                priceLineVisible: false,
                lastValueVisible: target !== 0,
                title:
                  line.key === "value"
                    ? result.name
                    : `${result.name} ${line.key}`,
              },
              target,
            );
            indicatorSeries.push(s);
            for (const level of result.levels)
              s.createPriceLine({
                price: level,
                color: "#b2b5be",
                lineWidth: 1,
                lineStyle: 2,
                axisLabelVisible: false,
                title: "",
              });
          }
          s.setData(
            line.values.map((v) =>
              v.value === null
                ? { time: v.time / 1000 }
                : {
                    time: v.time / 1000,
                    value: v.value,
                    color:
                      line.type === "histogram"
                        ? v.value >= 0
                          ? "#089981"
                          : "#f23645"
                        : undefined,
                  },
            ),
          );
          index++;
        }
      }
    }
    function render(preserve = true) {
      if (!data) return;
      busy = true;
      suppressUntil = performance.now() + 180;
      const prior = preserve ? chart.timeScale().getVisibleRange() : null;
      rows.sort((a, b) => a.start - b.start);
      future = data.future.filter((f) => f.start > (rows.at(-1)?.start ?? 0));
      grid = [
        ...rows.map((b) => ({ time: b.start / 1000 })),
        ...future.map((b) => ({ time: b.start / 1000 })),
      ];
      const zone =
        current.current.panel.timezone === "native"
          ? data.calendar === "ny17"
            ? "America/New_York"
            : "UTC"
          : current.current.panel.timezone;
      chart.applyOptions({
        localization: {
          timeFormatter: (t: any) =>
            zoned(Number(t), zone, current.current.panel.timeframe === "MN"),
        },
        timeScale: {
          tickMarkFormatter: (t: any, type: number) =>
            tickLabel(
              Number(t),
              zone,
              type,
              current.current.panel.timeframe === "MN",
            ),
        },
      });
      series.applyOptions({
        priceFormat: {
          type: "price",
          precision: data.precision,
          minMove: 10 ** -data.precision,
        },
      });
      series.setData([
        ...rows.map((b) => ({
          time: (b.start / 1000) as UTCTimestamp,
          open: +b.open,
          high: +b.high,
          low: +b.low,
          close: +b.close,
          ...(!b.complete ? { color: "#b2b5be", wickColor: "#b2b5be" } : {}),
        })),
        ...future.map((b) => ({ time: (b.start / 1000) as UTCTimestamp })),
      ]);
      renderIndicators();
      chart.panes()[0]?.setStretchFactor(4);
      if (rows.length) {
        if (wantRange) {
          const r = wantRange;
          wantRange = null;
          setRange(r);
        } else if (
          initial &&
          current.current.panel.range &&
          !current.current.panel.follow
        )
          setRange(current.current.panel.range);
        else if (initial || current.current.panel.follow) {
          chart.timeScale().setVisibleLogicalRange({
            from: Math.max(0, rows.length - 90),
            to: rows.length + 6,
          });
        } else if (prior) chart.timeScale().setVisibleRange(prior);
      }
      initial = false;
      busy = false;
      setEmpty(!rows.length);
      setProjectionNotice(
        current.current.drawings.some((d) =>
          d.points.some(
            (p) =>
              p.timestamp < (grid[0]?.time ?? Infinity) ||
              p.timestamp > (grid.at(-1)?.time ?? 0),
          ),
        )
          ? "部分画线锚点超出已加载范围，加载对应历史后显示；未来坐标限日历投影范围"
          : "",
      );
      setStatus(
        rows.length
          ? `${data.basis.toUpperCase()} · 截至 ${zoned(rows.at(-1)!.end / 1000, zone)} · ${zone}${rows.at(-1)!.complete ? "" : " · 灰色：未完成/缺失"}${data.bounded_history ? " · 历史达到10万根上限" : ""}`
          : "当前没有历史数据，请在历史数据页导入",
      );
    }
    function merge(next: ChartData, older: boolean) {
      if (!data) {
        data = next;
        rows = next.bars;
        return;
      }
      const map = new Map(rows.map((b) => [b.start, b]));
      next.bars.forEach((b) => map.set(b.start, b));
      rows = [...map.values()];
      const results = next.indicators.map((n) => {
        const old = data!.indicators.find((i) => i.id === n.id);
        return {
          ...n,
          series: n.series.map((s) => {
            const v = new Map(
              old?.series
                .find((o) => o.key === s.key)
                ?.values.map((v) => [v.time, v]) || [],
            );
            s.values.forEach((p) => v.set(p.time, p));
            return {
              ...s,
              values: [...v.values()].sort((a, b) => a.time - b.time),
            };
          }),
        };
      });
      data = { ...next, indicators: results };
      if (!older && next.origin !== null && rows[0]?.start < next.origin)
        rows = rows.filter((r) => r.start >= next.origin!);
    }
    async function load(older = false) {
      if (loading || disposed) return;
      loading = true;
      const requestPanel = current.current.panel;
      try {
        const next = await chartData(
          requestPanel,
          older ? rows[0]?.start : undefined,
          older ? 1000 : Math.min(2000, Math.max(500, rows.length)),
        );
        if (disposed) return;
        if (
          !older &&
          data &&
          data.history_revision !== next.history_revision &&
          rows[0]?.start < (next.bars[0]?.start ?? 0)
        ) {
          // Revalidate the loaded historical pages after repairs/backfill. Never retain
          // stale recursive values or bars removed from the corrected source.
          const firstLoaded = rows[0].start;
          data = null;
          rows = [];
          merge(next, false);
          let page = next;
          while (page.has_more && page.bars[0]?.start > firstLoaded) {
            page = await chartData(requestPanel, page.bars[0].start, 2000);
            if (disposed) return;
            if (page.history_revision !== next.history_revision) {
              data = null;
              rows = [];
              throw new Error("历史正在修订，将自动重新加载");
            }
            merge(page, true);
          }
          hasMore = page.has_more;
        } else {
          merge(next, older);
          if (older || initial) hasMore = next.has_more;
        }
        render();
        current.current.onLoaded();
        if (initial) applyDraw(current.current.drawings);
        setError("");
      } catch (e) {
        if (!disposed) setError(String(e));
      } finally {
        loading = false;
        if (
          !disposed &&
          JSON.stringify(requestPanel.indicators) !==
            JSON.stringify(current.current.panel.indicators)
        )
          void load();
        else if (
          !disposed &&
          wantRange &&
          hasMore &&
          wantRange.from < (rows[0]?.start ?? 0) / 1000
        )
          void load(true);
      }
    }
    function setRange(r: { from: number; to: number }) {
      if (!rows.length) return;
      suppressUntil = performance.now() + 180;
      const low = rows[0].start / 1000,
        high = grid.at(-1)!.time;
      if (r.from < low && hasMore) {
        wantRange = r;
        if (!loading) void load(true);
      }
      busy = true;
      const from = Math.max(low, r.from),
        to = Math.min(high, r.to);
      if (to > from)
        chart.timeScale().setVisibleRange({
          from: from as UTCTimestamp,
          to: to as UTCTimestamp,
        });
      busy = false;
    }
    const handle: Handle = {
      range: setRange,
      cross: (time, price) => {
        if (time === null) {
          chart.clearCrosshairPosition();
          return;
        }
        const bar = rows.find(
          (b) => b.start / 1000 <= time && time < b.end / 1000,
        );
        if (!bar) {
          chart.clearCrosshairPosition();
          return;
        }
        busy = true;
        chart.setCrosshairPosition(
          price ?? +bar.close,
          (bar.start / 1000) as UTCTimestamp,
          series,
        );
        busy = false;
      },
      draw: (type, options = {}) => {
        if (current.current.readonly) return;
        cancel();
        setError("");
        drawing = true;
        chart.applyOptions({ handleScroll: false, handleScale: false });
        plugin.addLineTool(type, [], options);
      },
      cancel,
      refresh: () => void load(),
      export: exported,
      viewRange: () => {
        const r = chart.timeScale().getVisibleRange();
        return rows.length && r
          ? { from: Number(r.from), to: Number(r.to) }
          : null;
      },
    };
    live.current = {
      chart,
      plugin,
      applyDraw,
      cancel,
      indicators: () => {
        indicatorKey = "";
        void load();
      },
    };
    current.current.onReady(handle);
    chart.timeScale().subscribeVisibleTimeRangeChange((r) => {
      if (
        busy ||
        drawing ||
        !r ||
        performance.now() < suppressUntil ||
        performance.now() > gestureUntil
      )
        return;
      if (!current.current.readonly)
        current.current.onRange({ from: Number(r.from), to: Number(r.to) });
      const first = rows[0]?.start / 1000;
      if (first && Number(r.from) <= first && hasMore) void load(true);
    });
    chart.subscribeCrosshairMove((e) => {
      if (busy) return;
      const bar = rows.find((b) => b.start / 1000 === Number(e.time));
      current.current.onCross(
        bar ? Number(e.time) : null,
        e.point
          ? (series.coordinateToPrice(e.point.y) ?? undefined)
          : undefined,
      );
    });
    const clicked = () => {
      gestureUntil = performance.now() + 2000;
      current.current.onActivate();
    };
    const wheel = () => {
      gestureUntil = performance.now() + 1000;
    };
    const move = (e: PointerEvent) => {
      if (e.buttons) gestureUntil = performance.now() + 1000;
    };
    el.addEventListener("pointerdown", clicked);
    el.addEventListener("wheel", wheel, { passive: true });
    el.addEventListener("pointermove", move);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    el.addEventListener("keydown", key);
    void load().then(() => {
      if (!disposed) applyDraw(current.current.drawings);
    });
    const timer = setInterval(() => {
      if (!document.hidden && !drawing) void load();
    }, 15000);
    return () => {
      disposed = true;
      clearInterval(timer);
      el.removeEventListener("pointerdown", clicked);
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("keydown", key);
      current.current.onReady(null);
      live.current = null;
      plugin.destroy();
      chart.remove();
    };
  }, [props.panel.id, props.panel.instrument, props.panel.timeframe]);
  useEffect(() => {
    const l = live.current;
    if (
      l &&
      JSON.stringify(JSON.parse(l.plugin.exportLineTools())) !==
        JSON.stringify(props.drawings)
    )
      l.applyDraw(props.drawings);
  }, [JSON.stringify(props.drawings)]);
  useEffect(() => {
    live.current?.indicators();
  }, [JSON.stringify(props.panel.indicators)]);
  useEffect(() => {
    const l = live.current;
    if (l) {
      l.plugin.setLocked(props.readonly);
      const zone =
        props.panel.timezone === "native"
          ? props.panel.instrument === "BTCUSDT"
            ? "UTC"
            : "America/New_York"
          : props.panel.timezone;
      l.chart.applyOptions({
        localization: {
          timeFormatter: (t: any) =>
            zoned(Number(t), zone, props.panel.timeframe === "MN"),
        },
        timeScale: {
          tickMarkFormatter: (t: any, type: number) =>
            tickLabel(Number(t), zone, type, props.panel.timeframe === "MN"),
        },
      });
    }
  }, [props.panel.timezone, props.readonly]);
  return (
    <>
      <div
        className="cw-canvas"
        ref={root}
        tabIndex={0}
        aria-label={`${props.panel.instrument} ${props.panel.timeframe} K线图`}
      />
      {empty && <div className="cw-empty">暂无行情 · 可先在历史数据页导入</div>}
      <div className="cw-data-status">{status}</div>
      {projectionNotice && (
        <div className="cw-projection-notice">{projectionNotice}</div>
      )}
      {error && (
        <div className="cw-chart-error" role="alert">
          {error}
        </div>
      )}
    </>
  );
}
