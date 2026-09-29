import type { Bar } from "../api";
import type { Drawing } from "./vendor/line-tools";
export type { Drawing };
export type IndicatorSpec = {
  id: string;
  name: string;
  version: string;
  params: Record<string, number>;
  color?: string;
};
export type Panel = {
  id: string;
  instrument: string;
  timeframe: string;
  timezone: string;
  indicators: IndicatorSpec[];
  range?: { from: number; to: number };
  follow: boolean;
};
export type Layout = "1" | "2h" | "2v" | "3top" | "3bottom" | "4";
export type Document = {
  schemaVersion: 1;
  layout: Layout;
  sync: boolean;
  panels: Panel[];
  drawings: Record<string, Drawing[]>;
  splitX?: number;
  splitY?: number;
};
export type Workspace = {
  id: string;
  name: string;
  revision: number;
  document: Document;
  updated_at: number;
};
export type IndicatorResult = {
  id: string;
  name: string;
  params: Record<string, number>;
  pane: string;
  levels: number[];
  series: {
    key: string;
    type: "line" | "histogram" | "area";
    values: { time: number; value: number | null }[];
  }[];
};
export type ChartData = {
  history_revision: string;
  bars: Bar[];
  future: { start: number; end: number }[];
  indicators: IndicatorResult[];
  has_more: boolean;
  origin: number | null;
  bounded_history: boolean;
  basis: string;
  calendar: string;
  precision: number;
  as_of: number;
};
export type Catalog = {
  frames: string[];
  indicators: Record<
    string,
    {
      label: string;
      pane: string;
      params: Record<string, number>;
      levels?: number[];
    }
  >;
};
export const frames = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN"];
export const layouts: Record<Layout, { label: string; count: number }> = {
  "1": { label: "单图", count: 1 },
  "2h": { label: "左右双图", count: 2 },
  "2v": { label: "上下双图", count: 2 },
  "3top": { label: "上单下双", count: 3 },
  "3bottom": { label: "上双下单", count: 3 },
  "4": { label: "四宫格", count: 4 },
};
export const drawingTools = [
  ["HorizontalLine", "水平线"],
  ["TrendLine", "趋势线"],
  ["Ray", "射线"],
  ["Rectangle", "矩形区域"],
  ["FibRetracement", "斐波那契回撤"],
  ["Text", "文字"],
  ["ParallelChannel", "平行通道"],
  ["LongShortPosition", "多空盈亏比"],
];
export const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
