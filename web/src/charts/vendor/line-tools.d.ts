export type Drawing = {
  id: string;
  toolType: string;
  points: { timestamp: number; price: number }[];
  options: Record<string, any>;
};
export interface DrawingPlugin {
  registerLineTool(name: string, cls: unknown): void;
  addLineTool(
    name: string,
    points?: { timestamp: number; price: number }[],
    options?: object,
  ): unknown;
  exportLineTools(): string;
  importLineTools(json: string): void;
  getSelectedLineTools(): string;
  removeSelectedLineTools(): void;
  removeLineToolsById(ids: string[]): void;
  removeAllLineTools(): void;
  applyLineToolOptions(data: unknown): void;
  subscribeLineToolsAfterEdit(fn: (event: any) => void): void;
  subscribeLineToolsSingleClick(fn: (event: any) => void): void;
  subscribeLineToolsDoubleClick(fn: (event: any) => void): void;
  setLocked(value: boolean): void;
  setMagnetThreshold(value: number): void;
  destroy(): void;
}
export function createLineToolsPlugin(chart: any, series: any): DrawingPlugin;
export function registerLinesPlugin(plugin: DrawingPlugin): void;
export const LineToolRectangle: unknown;
export function registerFibRetracementPlugin(plugin: DrawingPlugin): void;
export function registerTextPlugin(plugin: DrawingPlugin): void;
export function registerParallelChannelPlugin(plugin: DrawingPlugin): void;
export function registerLongShortPositionPlugin(plugin: DrawingPlugin): void;
