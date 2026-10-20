/** Presentation adapter. Reception, persistence and sound remain in the parent. */
import { attachNativeSystemMessages } from "./NativeSystemMessages";
import { attachNativeInstantNotice } from "./NativeInstantNotice";
import type { Notice, NoticeState, NoticeTransport } from "./types";
type Scope = { workspace_id: string; session: string; epoch: number };
type Options = {
  widget: any;
  scope: Scope;
  request: NoticeTransport;
  state: NoticeState;
  panelChanged: (open: boolean, event?: string) => void;
  report: (error: unknown) => void;
  locate: (notice: Notice) => void | Promise<void>;
  alert: (signalId: string) => void;
};
async function attach({
  widget,
  scope,
  request,
  state,
  panelChanged,
  report,
  locate,
  alert,
}: Options) {
  let disposed = false;
  let center: Awaited<ReturnType<typeof attachNativeSystemMessages>>;
  const close = (_restore = false) => center?.close(_restore);
  async function locateSource(notice: Notice) {
    if (
      notice.workspace !== scope.workspace_id ||
      notice.source_kind === "chart_alert"
    ) {
      await locate(notice);
      return;
    }
    const context = notice.context;
    const closeSource = () => {
      close(false);
    };
    if (
      ["workspace", "preferences", "chart_shell"].includes(notice.source_kind)
    ) {
      closeSource();
      return;
    }
    if (
      ["data_center", "capacity"].includes(notice.source_kind) ||
      context.consumer === "quotes" ||
      context.timeframe === "quotes"
    ) {
      await locate(notice);
      closeSource();
      return;
    }
    let index = context.chart_index;
    const frameNames: Record<string, string> = {
      "1": "M1",
      "5": "M5",
      "15": "M15",
      "30": "M30",
      "60": "H1",
      "240": "H4",
      "1D": "D1",
      "1W": "W1",
      "1M": "MN",
    };
    const matches = (chart: any) => {
      const symbol = chart.symbol(),
        identity = (globalThis as any).MWSeries?.decode(symbol),
        resolution = String(chart.resolution());
      return (
        context.instrument &&
        context.timeframe &&
        (context.instrument === symbol ||
          context.instrument === identity?.symbol) &&
        (context.timeframe === resolution ||
          context.timeframe === frameNames[resolution])
      );
    };
    const serverHistory =
      notice.id.startsWith("t:") &&
      notice.source_kind === "history" &&
      context.epoch == null;
    if (
      serverHistory ||
      (context.epoch === scope.epoch && !Number.isSafeInteger(index))
    ) {
      const candidates = Array.from(
        { length: widget.chartsCount() },
        (_, i) => i,
      ).filter((i) => matches(widget.chart(i)));
      if (candidates.length !== 1)
        throw Error("无法唯一确认来源图格，请核查当前品种和周期");
      index = candidates[0];
    }
    if (
      (!serverHistory && context.epoch !== scope.epoch) ||
      !Number.isSafeInteger(index) ||
      Number(index) < 0 ||
      Number(index) >= widget.chartsCount()
    )
      throw Error("来源图格上下文已改变，请在当前工作区核查后操作");
    const chart = widget.chart(index);
    const symbol = chart.symbol();
    const identity = (globalThis as any).MWSeries?.decode(symbol);
    const resolution = String(chart.resolution());
    if (
      (context.instrument &&
        context.instrument !== symbol &&
        context.instrument !== identity?.symbol) ||
      (context.timeframe &&
        context.timeframe !== resolution &&
        context.timeframe !== frameNames[resolution])
    )
      throw Error("来源图格的品种或周期已改变，未操作当前图表");
    widget.setActiveChart(index);
    close(false);
  }

  async function open(eventId?: string) {
    if (eventId) {
      try {
        const row: Notice = await request({
          action: "detail",
          event_id: eventId,
        });
        if (disposed) return;
        if (row.source_kind === "chart_alert") {
          close(false);
          alert(row.source_id);
          return;
        }
      } catch {
        if (disposed) return; /* The center reports readable detail failures. */
      }
    }
    if (!disposed) center.open(eventId);
  }
  center = await attachNativeSystemMessages({
    widget,
    state,
    request,
    onLocate: locateSource,
    report,
    onOpenChanged: panelChanged,
  });
  let instant: Awaited<ReturnType<typeof attachNativeInstantNotice>>;
  try {
    instant = await attachNativeInstantNotice({
      widget,
      state,
      request,
      report,
      onLocate: locateSource,
      onOpen: (notice) => {
        if (notice.source_kind === "chart_alert") {
          close(false);
          alert(notice.source_id);
        } else return open(notice.local_status ? undefined : notice.id);
      },
    });
  } catch (error) {
    center.destroy();
    throw error;
  }
  return {
    scope,
    open,
    update(next: NoticeState) {
      if (!disposed) {
        center.update(next);
        instant.update(next);
      }
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      instant.destroy();
      center.destroy();
    },
  };
}
declare global {
  var MWNativeNotifications: { attach: typeof attach };
}
globalThis.MWNativeNotifications = { attach };
