import { useEffect, useRef } from "react";
import {
  createChart,
  CandlestickSeries,
  ColorType,
  createSeriesMarkers,
  type UTCTimestamp,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
} from "lightweight-charts";
import type { Bar } from "./api";

export default function Chart({
  bars,
  precision = 5,
  markers = [],
  levels = [],
}: {
  bars: Bar[];
  precision?: number;
  markers?: { occurred_at: number; direction: string }[];
  levels?: {price:number;title:string}[];
}) {
  const root = useRef<HTMLDivElement>(null);
  const live = useRef<{chart:IChartApi;series:ISeriesApi<'Candlestick'>;markers:ISeriesMarkersPluginApi<Time>;fitted:boolean}|null>(null);
  useEffect(() => {
    if (!root.current || !bars.length) return;
    const chart = createChart(root.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#ffffff" },
        textColor: "#58655c",
        fontFamily: "system-ui",
      },
      grid: {
        vertLines: { color: "#f1f3ee" },
        horzLines: { color: "#f1f3ee" },
      },
      rightPriceScale: { borderColor: "#e4e9e2" },
      timeScale: { borderColor: "#e4e9e2", timeVisible: true },
      localization: { locale: "zh-CN" },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#267a60",
      downColor: "#bb6549",
      borderVisible: false,
      wickUpColor: "#267a60",
      wickDownColor: "#bb6549",
      priceFormat: { type: "price", precision, minMove: 10 ** -precision },
    });
    live.current={chart,series,markers:createSeriesMarkers(series,[]),fitted:false};
    return ()=>{live.current=null;chart.remove()};
  }, [bars.length>0,precision]);
  useEffect(()=>{
    if(!live.current)return;
    const {chart,series,markers:markerApi}=live.current;
    series.setData(
      bars.map((b) => ({
        time: (b.start / 1000) as UTCTimestamp,
        open: +b.open,
        high: +b.high,
        low: +b.low,
        close: +b.close,
      })),
    );
    markerApi.setMarkers(
      markers.flatMap((m) => {
        const b = bars.find((b) => b.end === m.occurred_at);
        return b
          ? [
              {
                time: (b.start / 1000) as UTCTimestamp,
                position:
                  m.direction === "buy"
                    ? ("belowBar" as const)
                    : ("aboveBar" as const),
                color: "#a06a1a",
                shape:
                  m.direction === "buy"
                    ? ("arrowUp" as const)
                    : ("arrowDown" as const),
                text: m.direction === "buy" ? "买入信号" : "卖出信号",
              },
            ]
          : [];
      }),
    );
    if(!live.current.fitted){chart.timeScale().fitContent();live.current.fitted=true;}
  }, [bars, precision, markers]);
  useEffect(()=>{
    if(!live.current)return;
    const series=live.current.series;
    const lines=levels.map(l=>series.createPriceLine({price:l.price,title:l.title,color:'#9a763c',lineWidth:1,lineStyle:2,axisLabelVisible:true}));
    return()=>{if(live.current?.series===series)for(const line of lines)series.removePriceLine(line)};
  },[levels,bars.length>0,precision]);
  return (
    <div className="chart-wrap">
      {bars.length ? (
        <>
          <div
            className="chart"
            ref={root}
            role="img"
            aria-label={`K 线图，共 ${bars.length} 根；时间轴为 UTC`}
          />
          <details className="chart-data">
            <summary>查看 K 线数据表（UTC 时间）</summary>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>开</th>
                    <th>高</th>
                    <th>低</th>
                    <th>收</th>
                    <th>完整性</th>
                  </tr>
                </thead>
                <tbody>
                  {bars.slice(-50).map((b) => (
                    <tr key={b.start}>
                      <td>{new Date(b.start).toISOString()}</td>
                      <td>{b.open}</td>
                      <td>{b.high}</td>
                      <td>{b.low}</td>
                      <td>{b.close}</td>
                      <td>{b.complete ? "完整" : "未完成"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      ) : (
        <div className="empty chart-empty">
          <span className="empty-cross">＋</span>
          <h3>等待行情连接</h3>
          <p>接入并补齐历史数据后，这里会显示真实 K 线。</p>
          <small>不会以模拟数据替代实时行情</small>
        </div>
      )}
    </div>
  );
}
