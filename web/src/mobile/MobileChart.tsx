import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { BellPlus, Crosshair, ChartNoAxesCombined } from "lucide-react";
import { api } from "../api";
import { marketRuntime } from "../runtime/market";
import {
  mountChart,
  type ChartAdapter,
  type ChartApplication,
  type ChartUpdate,
} from "../runtime/chart";
import type { MobileMarket } from "./market";
import {
  subscribeHistoryLoadCapacity,
  type HistoryCapabilities,
} from "../advanced/nativeHistoryLoads";
import {
  dropSnapshot,
  readSnapshot,
  validChartDocument,
  writeSnapshot,
  type ChartDocument,
  type Profile,
} from "./cache";

export type MobileChartHandle = {
  flush(): Promise<void>;
  back(): Promise<boolean>;
  canLeave(): Promise<boolean>;
};
const intervals: Record<string, string> = {
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
export default forwardRef<
  MobileChartHandle,
  {
    profile: Profile;
    connection: MobileMarket;
    symbol: string;
    visible: boolean;
    report(message: string): void;
    dirty(value: boolean): void;
    createAlert(): void;
  }
>(function MobileChart(
  { profile, connection, symbol, visible, report, dirty, createAlert },
  ref,
) {
  const root = useRef<HTMLDivElement>(null),
    chart = useRef<ChartAdapter | null>(null);
  const callbacks = useRef({ report, dirty });
  callbacks.current = { report, dirty };
  const [ready, setReady] = useState(false),
    [crosshair, setCrosshair] = useState(false);
  const [resolution, setResolution] = useState("60"),
    [supported, setSupported] = useState(Object.keys(intervals));
  const [failure, setFailure] = useState(""),
    [retry, setRetry] = useState(0);
  const flushes = useRef(
    new Map<
      string,
      {
        resolve(value?: boolean): void;
        reject(error: Error): void;
        timer: ReturnType<typeof setTimeout>;
      }
    >(),
  );
  const command = async (action: string): Promise<boolean | undefined> => {
    if (!chart.current || !ready) return false;
    const request = crypto.randomUUID();
    return new Promise<boolean | undefined>((resolve, reject) => {
      const timer = setTimeout(() => {
        flushes.current.delete(request);
        reject(Error("图表设置尚未完成本机写入"));
      }, 5000);
      flushes.current.set(request, { resolve, reject, timer });
      void chart.current!.update({ type: "mobile-command", action, request });
    });
  };
  const flush = async () => {
    await command("flush");
  };
  useImperativeHandle(ref, () => ({
    flush,
    back: async () => Boolean(await command("back")),
    canLeave: async () => !(await command("can-leave")),
  }));
  useEffect(() => {
    let stopped = false,
      instance: ChartAdapter | undefined;
    const marketRequests = new Map<
      ChartAdapter,
      Map<number, AbortController>
    >();
    const inflight = { current: 0 },
      historyCapabilities = { current: null as HistoryCapabilities | null };
    const nativeLoadEpoch = { current: 0 },
      current = { current: null };
    const setNativeLoads = (_next: unknown) => {};
    const updateChart = (value: ChartUpdate) => {
      if (!stopped) void chart.current?.update(value);
    };
    const owned = new Map<string, any>();
    const market = marketRuntime({
      api,
      marketRequests,
      inflight,
      historyCapabilities,
      current,
      nativeLoadEpoch,
      chart,
      setNativeLoads,
      compositeEstablished: (id) => {
        void connection.established(id);
      },
      updateChart,
    });
    let settings: Record<string, string> = {};
    let writes = Promise.resolve();
    let layoutDirty = false,
      settingsDirty = false;
    const localSettings = async (_kind: string, query: any) => {
      if (query.op === "read")
        return Object.entries(settings).map(([name, value]) => ({
          kind: "setting",
          name,
          tool: "",
          content: { value },
        }));
      if (
        !["save", "delete"].includes(query.op) ||
        typeof query.args?.name !== "string"
      )
        throw Error("手机设置操作不允许");
      const task = writes
        .catch(() => {})
        .then(async () => {
          const next = { ...settings };
          if (query.op === "delete") delete next[query.args.name];
          else next[query.args.name] = query.args.value;
          await writeSnapshot(profile, "chart-settings", next);
          settings = next;
          settingsDirty = false;
          callbacks.current.dirty(layoutDirty);
        });
      writes = task;
      try {
        await task;
      } catch (error) {
        settingsDirty = true;
        callbacks.current.dirty(true);
        throw error;
      }
    };
    const unavailable = async () => {
      throw Error("此操作请在对应手机页面完成");
    };
    const application: ChartApplication = {
      observe(message, source) {
        if (stopped || source !== chart.current) return;
        const handle = async () => {
          if (message.type === "loaded") {
            const [catalog, capabilities, saved, preferences] =
              await Promise.all([
                api("/advanced-charts/catalog"),
                api<HistoryCapabilities>("/charts/history-capabilities"),
                readSnapshot<ChartDocument>(profile, "chart").catch(() => {
                  callbacks.current.report(
                    "本机图表设置无法读取，当前使用不会自动记住",
                  );
                  return undefined;
                }),
                readSnapshot<Record<string, string>>(
                  profile,
                  "chart-settings",
                ).catch(() => undefined),
              ]);
            if (stopped) return;
            historyCapabilities.current = capabilities;
            let document = saved?.value;
            if (document && !validChartDocument(document)) {
              await dropSnapshot(profile, "chart");
              document = undefined;
              await dropSnapshot(profile, "chart-settings");
              callbacks.current.report("本机图表设置不兼容，已重置手机图表");
            } else settings = preferences?.value || {};
            await source.update({
              type: "init",
              mode: "mobile",
              mobile_client: connection.client,
              readonly: false,
              workspace: null,
              document: document || {
                engine: "tv31",
                schemaVersion: 1,
                symbol,
                interval: "60",
              },
              catalog,
              history_capabilities: capabilities,
              preferences: await localSettings("preferences", { op: "read" }),
            });
          } else if (message.type === "market-subscribe") {
            owned.set(message.args.listener, message.args);
            await connection.subscribe(message.args, (event) =>
              updateChart({ type: "market-event", event }),
            );
          } else if (message.type === "market-unsubscribe") {
            owned.delete(message.args.listener);
            await connection.unsubscribe(message.args);
          } else if (message.type === "market-accept")
            await connection.accept(message.args);
          else if (message.type === "native-load-reset") {
            nativeLoadEpoch.current = message.epoch;
          } else if (message.type === "ready") {
            setReady(true);
          } else if (message.type === "workspace-dirty") {
            layoutDirty = true;
            callbacks.current.dirty(true);
          } else if (message.type === "mobile-saved") {
            layoutDirty = false;
            callbacks.current.dirty(settingsDirty);
          } else if (message.type === "mobile-crosshair")
            setCrosshair(message.enabled);
          else if (message.type === "mobile-series") {
            setResolution(message.resolution);
            setSupported(
              message.resolutions.filter((value: string) =>
                Object.hasOwn(intervals, value),
              ),
            );
          } else if (message.type === "mobile-flushed") {
            const pending = flushes.current.get(message.request);
            if (pending) {
              clearTimeout(pending.timer);
              flushes.current.delete(message.request);
              try {
                await writes;
                message.error
                  ? pending.reject(Error(message.error))
                  : pending.resolve(message.consumed);
              } catch (error) {
                pending.reject(
                  error instanceof Error ? error : Error(String(error)),
                );
              }
            }
          } else if (message.type === "error")
            callbacks.current.report(message.error);
        };
        void handle().catch((error) => {
          if (!stopped) {
            setFailure(String(error));
            callbacks.current.report(String(error));
          }
        });
      },
      market: (kind, query, context, source) => {
        if (kind === "data" || kind === "market")
          return market[kind](query, source, context);
        return api(
          "/charts/indicator-demands/" +
            (kind === "indicator-demand-update" ? "update" : "release"),
          query,
        );
      },
      workspace: async (_kind, query) => {
        if (stopped || query.op !== "save" || !validChartDocument(query.args))
          throw Error("手机只保存本机单图设置");
        await writeSnapshot(profile, "chart", query.args);
      },
      session: (kind, query) =>
        kind === "confirm-leave"
          ? Promise.resolve(
              window.confirm("放弃尚未应用的图表参数？取消可继续编辑。"),
            )
          : localSettings(kind, query),
      alerts: unavailable,
      notifications: unavailable,
      dataCenter: unavailable,
      cancel: (id, source) => marketRequests.get(source)?.get(id)?.abort(),
    };
    const unsubscribeCapacity = subscribeHistoryLoadCapacity((available) =>
      updateChart({ type: "history-load-capacity", available }),
    );
    const manifestPath = document.querySelector<HTMLMetaElement>(
      'meta[name="mw-chart-manifest"]',
    )?.content;
    setFailure("");
    setReady(false);
    void mountChart(root.current!, application, manifestPath)
      .then((value) => {
        if (stopped) {
          value.dispose();
          return;
        }
        instance = value;
        chart.current = value;
        value.start();
      })
      .catch((error) => {
        if (!stopped) setFailure(String(error));
      });
    return () => {
      stopped = true;
      unsubscribeCapacity();
      instance?.dispose();
      if (chart.current === instance) chart.current = null;
      for (const args of owned.values())
        void connection.unsubscribe(args).catch(() => {});
      for (const requests of marketRequests.values())
        for (const request of requests.values()) request.abort();
      for (const pending of flushes.current.values()) {
        clearTimeout(pending.timer);
        pending.reject(Error("图表已关闭"));
      }
      flushes.current.clear();
    };
    // Keep a single widget; subsequent symbol changes use the native API below.
  }, [profile.origin, profile.subject, connection, retry]);
  const initial = useRef("");
  useEffect(() => {
    if (initial.current === symbol || !ready) return;
    initial.current = symbol;
    void chart.current?.update({
      type: "mobile-command",
      action: "symbol",
      symbol,
    });
  }, [symbol, ready]);
  useEffect(() => {
    if (!visible && ready)
      void chart.current?.update({ type: "mobile-command", action: "leave" });
    if (visible) dispatchEvent(new Event("resize"));
  }, [visible, ready]);
  return (
    <section className="mobile-chart" hidden={!visible}>
      <header className="mobile-chart-tools">
        <label className="mobile-frame-label">
          <span className="sr-only">图表周期</span>
          <select
            aria-label="图表周期"
            value={resolution}
            disabled={!ready}
            onChange={(e) =>
              void chart.current?.update({
                type: "mobile-command",
                action: "resolution",
                resolution: e.target.value,
              })
            }
          >
            {supported.map((value) => (
              <option key={value} value={value}>
                {intervals[value]}
              </option>
            ))}
          </select>
        </label>
        <div>
          <button
            aria-label="十字线"
            aria-pressed={crosshair}
            disabled={!ready}
            onClick={() =>
              void chart.current?.update({
                type: "mobile-command",
                action: "crosshair",
                enabled: !crosshair,
              })
            }
          >
            <Crosshair aria-hidden="true" />
          </button>
          <button
            aria-label="指标"
            disabled={!ready}
            onClick={() =>
              void chart.current?.update({
                type: "mobile-command",
                action: "indicators",
              })
            }
          >
            <ChartNoAxesCombined aria-hidden="true" />
          </button>
          <button
            aria-label="价格告警"
            disabled={!ready || !symbol.startsWith("MWC:")}
            title={
              symbol.startsWith("MWC:")
                ? "创建当前组合的价格告警"
                : "仅组合行情支持新建价格告警"
            }
            onClick={() =>
              void command("can-leave")
                .then((value) => {
                  if (!value) createAlert();
                })
                .catch((error) => report(String(error)))
            }
          >
            <BellPlus aria-hidden="true" />
          </button>
        </div>
      </header>
      {failure && (
        <p role="alert">
          {failure}
          <button onClick={() => setRetry((value) => value + 1)}>
            重新加载图表
          </button>
        </p>
      )}
      {!ready && !failure && <p role="status">正在加载专业图表…</p>}
      <div className="mobile-chart-canvas" ref={root} />
    </section>
  );
});
