import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { RefreshCw, CircleAlert } from "lucide-react";
import { Button } from "./components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "./components/ui/alert";
import { MobileOverlaysProvider, MobileConfirm } from "./WatchOverlays";
import { api, errorMessage } from "../api";
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
import type { MobileChartPreparation } from "./chartPreparation";
import { chartPreviews, type ChartPreview } from "./chartPreview";
import { sameChartSymbol } from "./chartIdentity";
const timeframes: Record<string, string> = {"1":"M1","5":"M5","15":"M15","30":"M30","60":"H1","240":"H4","1D":"D1","1W":"W1","1M":"MN"};

export type MobileChartHandle = {
  flush(): Promise<void>;
  back(): Promise<boolean>;
  canLeave(): Promise<boolean>;
};
export default forwardRef<
  MobileChartHandle,
  {
    profile: Profile;
    connection: MobileMarket;
    symbol: string;
    theme: "dark" | "light";
    rememberSymbol(ticker: string): void;
    visible: boolean;
    report(message: string): void;
    preparation: MobileChartPreparation;
  }
>(function MobileChart(
  {
    profile,
    connection,
    symbol,
    theme,
    rememberSymbol,
    visible,
    report,
    preparation,
  },
  ref,
) {
  const root = useRef<HTMLDivElement>(null),
    chart = useRef<ChartAdapter | null>(null);
  const callbacks = useRef({ report, theme, rememberSymbol });
  callbacks.current = { report, theme, rememberSymbol };
  const visibility = useRef(visible); visibility.current = visible;
  const selection = useRef({ prop: symbol, target: symbol, settled: false });
  if (selection.current.prop !== symbol) {
    selection.current.prop = symbol;
    if (!sameChartSymbol(selection.current.target, symbol)) {
      selection.current.target = symbol;
      selection.current.settled = false;
    }
  }
  const [confirmLeave, setConfirmLeave] = useState(false);
  const leaveResult = useRef<((value: boolean) => void) | undefined>(undefined);
  const finishConfirmation = (accepted: boolean) => {
    setConfirmLeave(false);
    const resolve = leaveResult.current;
    leaveResult.current = undefined;
    // Human decision time is not a failed chart command.
    for (const [request, pending] of flushes.current) {
      pending.timer = setTimeout(() => {
        flushes.current.delete(request);
        pending.reject(Error("图表操作未完成，请重试"));
      }, 5000);
    }
    resolve?.(accepted);
  };
  const [historyLoads, setHistoryLoads] = useState(0);
  const [historyPending, setHistoryPending] = useState(false);
  const [historyFailure, setHistoryFailure] = useState<{
    epoch: number;
    index: number;
    symbol: string;
    resolution: string;
    error: string;
  } | null>(null);
  useEffect(() => {
    if (!historyLoads) {
      setHistoryPending(false);
      return;
    }
    const timer = setTimeout(() => setHistoryPending(true), 900);
    return () => clearTimeout(timer);
  }, [historyLoads]);
  const [ready, setReady] = useState(false);
  const [displayReady, setDisplayReady] = useState(false);
  const [preview, setPreview] = useState<ChartPreview>();
  const [shellReady, setShellReady] = useState(false);
  const displayTarget = useRef({symbol, resolution:"60", theme});
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
    const previews = chartPreviews(profile);
    const local = Promise.all([
      readSnapshot<ChartDocument>(profile, "chart").catch(() => {
        if (!stopped) callbacks.current.report("本机图表设置无法读取，当前使用不会自动记住");
        return undefined;
      }),
      readSnapshot<Record<string, string>>(profile, "chart-settings").catch(() => undefined),
      previews.load(),
    ]);
    // Configuration and local state begin before the licensed scripts load.
    const configuration = preparation.config();
    void configuration.catch(() => {});
    void local.then(([saved]) => {
      if (stopped) return;
      const document = saved?.value;
      displayTarget.current = {symbol:selection.current.target,
        resolution:document?.interval || "60", theme:callbacks.current.theme};
      if (visibility.current) preparation.foreground(displayTarget.current.symbol, timeframes[displayTarget.current.resolution]);
      setPreview(document && validChartDocument(document)
        ? previews.find(displayTarget.current, JSON.stringify({...document, theme:callbacks.current.theme === "light" ? "Light" : "Dark"}))
        : undefined);
    });
    const pendingHistory = new Set<string>();
    setHistoryLoads(0);
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
      startupPreparation: preparation.startup,
    });
    let settings: Record<string, string> = {};
    let writes = Promise.resolve();
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
        });
      writes = task;
      await task;
    };
    const unavailable = async () => {
      throw Error("此操作请在对应手机页面完成");
    };
    const application: ChartApplication = {
      observe(message, source) {
        if (stopped || source !== chart.current) return;
        const handle = async () => {
          if (message.type === "loaded") {
            const [[catalog, capabilities], [saved, preferences]] = await Promise.all([configuration, local]);
            if (stopped) return;
            historyCapabilities.current = capabilities;
            let document = saved?.value;
            if (document && !validChartDocument(document)) {
              await dropSnapshot(profile, "chart");
              document = undefined;
              await dropSnapshot(profile, "chart-settings");
              callbacks.current.report("本机图表设置不兼容，已重置手机图表");
            } else settings = preferences?.value || {};
            const chartTheme =
              callbacks.current.theme === "light" ? "Light" : "Dark";
            await source.update({
              type: "init",
              mode: "mobile",
              mobile_client: connection.client,
              readonly: false,
              workspace: null,
              document: {
                ...(document || {
                  engine: "tv31",
                  schemaVersion: 1,
                  symbol,
                  interval: "60",
                }),
                symbol: selection.current.target,
                theme: chartTheme,
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
            pendingHistory.clear();
            setHistoryLoads(0);
            setHistoryFailure(null);
          } else if (message.type === "chart-history-failures" &&
            message.epoch === nativeLoadEpoch.current) {
            setHistoryFailure(message.failures[0]
              ? { ...message.failures[0], epoch: message.epoch } : null);
          } else if (
            message.epoch === nativeLoadEpoch.current &&
            ["native-load-start", "native-load-end"].includes(message.type)
          ) {
            if (message.type === "native-load-start")
              pendingHistory.add(message.id);
            else pendingHistory.delete(message.id);
            setHistoryLoads(pendingHistory.size);
          } else if (message.type === "ready") {
            setReady(true);
          } else if (message.type === "mobile-shell-ready") {
            setShellReady(true);
          } else if (message.type === "mobile-display-pending") {
            displayTarget.current = {symbol:message.symbol, resolution:message.resolution, theme:message.theme};
            preparation.foreground(message.symbol, timeframes[message.resolution]);
            setPreview(previews.find(displayTarget.current));
            setDisplayReady(false);
          } else if (message.type === "mobile-display-ready") {
            if (sameChartSymbol(message.symbol, displayTarget.current.symbol) && message.resolution === displayTarget.current.resolution)
              setDisplayReady(true);
          } else if (message.type === "mobile-preview") {
            previews.put(message as ChartUpdate & ChartPreview);
          } else if (message.type === "mobile-preview-invalidated") {
            previews.clear();setPreview(undefined);
          } else if (message.type === "mobile-series") {
            setHistoryFailure(previous => previous &&
              sameChartSymbol(previous.symbol, message.symbol) && previous.resolution === message.resolution
                ? previous : null);
            if (sameChartSymbol(message.symbol, selection.current.target)) {
              selection.current.settled = true;
              initial.current = message.symbol;
            } else if (selection.current.settled) {
              selection.current.target = message.symbol;
              initial.current = message.symbol;
              callbacks.current.rememberSymbol(message.symbol);
            }
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
            if (message.type === "loaded") setFailure(errorMessage(error));
            else callbacks.current.report(errorMessage(error));
          }
        });
      },
      market: (kind, query, context, source) => {
        if (visibility.current && kind === "data") preparation.foreground(selection.current.target, query.timeframe);
        if (visibility.current && kind === "market" && query.op === "resolve") preparation.foreground(selection.current.target);
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
      session: (kind, query) => {
        if (kind !== "confirm-leave") return localSettings(kind, query);
        if (leaveResult.current) return Promise.resolve(false);
        for (const pending of flushes.current.values())
          clearTimeout(pending.timer);
        setConfirmLeave(true);
        return new Promise<boolean>((resolve) => {
          leaveResult.current = resolve;
        });
      },
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
    setHistoryFailure(null);
    setReady(false);
    setShellReady(false);
    setPreview(undefined);
    setDisplayReady(false);
    initial.current = "";
    selection.current.settled = false;
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
        if (!stopped) setFailure(errorMessage(error));
      });
    return () => {
      stopped = true;
      leaveResult.current?.(false);
      leaveResult.current = undefined;
      setConfirmLeave(false);
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
  }, [profile.origin, profile.subject, connection, preparation, retry]);
  const initial = useRef("");
  useEffect(() => {
    if (sameChartSymbol(initial.current, symbol) || !ready) return;
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
    if (visible) preparation.foreground(symbol);
    if (visible) dispatchEvent(new Event("resize"));
  }, [visible, ready, preparation, symbol]);
  useEffect(() => {
    if (ready)
      void chart.current?.update({
        type: "theme",
        theme: theme === "light" ? "Light" : "Dark",
      });
  }, [theme, ready]);
  return (
    <section
      className="mobile-chart mobile-controls"
      hidden={!visible}
      aria-label="图表"
    >
      <MobileOverlaysProvider>
        <h1 className="sr-only">图表</h1>
        <div className="chart-workspace" aria-busy={!ready && !failure}>
          <div className="mobile-chart-canvas" ref={root} />
          {preview?.image && !displayReady && sameChartSymbol(preview.symbol, symbol) && preview.theme === theme && (
            <div className="chart-preview" style={{top:shellReady ? preview.top : 0,bottom:preview.bottom}}
              aria-label={`上次图表，${new Date(preview.at).toLocaleString()}`}>
              <img src={preview.image} alt="" />
              <span>上次数据 {new Date(preview.at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})} · {failure || historyFailure ? "更新失败" : "更新中"}</span>
            </div>
          )}
          {ready && !failure && historyFailure && (
            <Alert className="chart-history-failure">
              <CircleAlert aria-hidden="true" />
              <AlertTitle>行情暂时无法读取</AlertTitle>
              <AlertDescription>{errorMessage(historyFailure.error).replace(/^(?:Error:\s*)+/, "")}</AlertDescription>
              <Button
                variant="outline"
                disabled={historyLoads > 0}
                onClick={() => void chart.current?.update({
                  type: "retry-chart-history",
                  epoch: historyFailure.epoch,
                  index: historyFailure.index,
                  symbol: historyFailure.symbol,
                  resolution: historyFailure.resolution,
                })}
              >
                <RefreshCw data-icon="inline-start" aria-hidden="true" />
                {historyLoads > 0 ? "正在重试…" : "重试行情"}
              </Button>
            </Alert>
          )}
          {shellReady && !failure && historyPending && !historyFailure &&
            !(preview && sameChartSymbol(preview.symbol, symbol) && preview.theme === theme && !displayReady) && (
            <div className="chart-history-progress" role="status">
              更新中
            </div>
          )}
          {failure && (
            <div className="chart-state-cover">
              <Alert className="chart-failure">
                <CircleAlert aria-hidden="true" />
                <AlertTitle>图表暂时无法加载</AlertTitle>
                <AlertDescription>{errorMessage(failure)}</AlertDescription>
                <Button
                  variant="outline"
                  onClick={() => setRetry((value) => value + 1)}
                >
                  <RefreshCw data-icon="inline-start" aria-hidden="true" />
                  重新加载图表
                </Button>
              </Alert>
            </div>
          )}
          {!shellReady && !failure && !preview && (
            <div
              className="chart-state-cover chart-loading"
              role="status"
              aria-label="准备图表"
            >
              <p>准备图表</p>
            </div>
          )}
        </div>
        {confirmLeave && (
          <MobileConfirm
            title="放弃未应用的参数？"
            description="图表参数尚未应用。继续编辑可保留当前输入，放弃后恢复已应用的设置。"
            actionLabel="放弃修改"
            cancelLabel="继续编辑"
            destructive
            onAccept={() => finishConfirmation(true)}
            onClose={() => finishConfirmation(false)}
          />
        )}
      </MobileOverlaysProvider>
    </section>
  );
});
