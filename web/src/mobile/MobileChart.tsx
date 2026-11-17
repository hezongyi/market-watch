import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { RefreshCw, CircleAlert, CandlestickChart, X } from "lucide-react";
import { Button } from "./components/ui/button";
import { Skeleton } from "./components/ui/skeleton";
import { HeaderIconButton } from "./components/HeaderIconButton";
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
import { chartSymbolKey, sameChartSymbol } from "./chartIdentity";
import { chartTiming } from "./chartTimings";
import { mobileChartHistory } from "./chartHistory";
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
    target?: { symbol: string; resolution: string; token: number };
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
    target,
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
  const needsMarketRecovery = useRef(false);
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
  const [cachePending, setCachePending] = useState(false);
  const cacheStates = useRef(new Map<string, {state:string;error?:string}>());
  const cacheKey = (symbol:string,resolution:string) => JSON.stringify([chartSymbolKey(symbol),resolution]);
  const [historyFailure, setHistoryFailure] = useState<{
    epoch: number;
    index: number;
    symbol: string;
    resolution: string;
    error: string;
    source?: "cache";
  } | null>(null);
  const dismissedHistory = useRef("");
  const loggedHistory = useRef("");
  const failureKey = (value: {epoch:number;symbol:string;resolution:string;error:string}) =>
    JSON.stringify([value.epoch,chartSymbolKey(value.symbol),value.resolution,value.error]);
  const historyBusy = historyLoads > 0;
  useEffect(() => {
    if (!historyBusy) {
      setHistoryPending(false);
      return;
    }
    const timer = setTimeout(() => setHistoryPending(true), 900);
    return () => clearTimeout(timer);
  }, [historyBusy]);
  const [ready, setReady] = useState(false);
  const [shellReady, setShellReady] = useState(false);
  const [toolbarHeight, setToolbarHeight] = useState(38);
  const [savePending, setSavePending] = useState(false);
  const displayTarget = useRef({symbol, resolution:"60", theme});
  const [operationError, setOperationError] = useState("");
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
    let adapterReady = false;
    let timing = chartTiming(profile, symbol, "60"), hasDisplayTarget = false;
    const mark = (phase: string) => { if (!stopped) timing.mark(phase); };
    const history = mobileChartHistory(profile, (query, error) => {
      if (!stopped) void chart.current?.update({type:"mobile-history-refreshed",
        instrument:query.instrument,series_kind:query.series_kind,timeframe:query.timeframe,
        ...(error ? {error:errorMessage(error)} : {})});
    });
    const local = Promise.all([
      readSnapshot<ChartDocument>(profile, "chart").catch(() => {
        if (!stopped) callbacks.current.report("本机图表设置无法读取，当前使用不会自动记住");
        return undefined;
      }),
      readSnapshot<Record<string, string>>(profile, "chart-settings").catch(() => undefined),
      history.load(),
    ]);
    void dropSnapshot(profile, "chart-previews").catch(() => {});
    // Configuration and local state begin before the licensed scripts load.
    const configuration = preparation.config();
    void configuration.then(() => mark("配置"), () => {});
    void local.then(([saved]) => {
      if (stopped) return;
      mark("本机设置");
      const document = saved?.value;
      displayTarget.current = {symbol:selection.current.target,
        resolution:document?.interval || "60", theme:callbacks.current.theme};
      timing.target(displayTarget.current.symbol, displayTarget.current.resolution);
      if (visibility.current) preparation.foreground(displayTarget.current.symbol, timeframes[displayTarget.current.resolution]);
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
            if (message.failures.length) { timing.mark("行情失败"); timing.finish("failed"); }
            const failure = message.failures.find((item: any) =>
              sameChartSymbol(item.symbol, displayTarget.current.symbol) &&
              item.resolution === displayTarget.current.resolution);
            const next = failure ? { ...failure, epoch: message.epoch } : null;
            if (next) {
              const key = failureKey(next);
              if (key !== loggedHistory.current) {callbacks.current.report(next.error);loggedHistory.current=key;}
              setHistoryFailure(key === dismissedHistory.current ? null : next);
            } else {
              const cached = cacheStates.current.get(cacheKey(displayTarget.current.symbol,displayTarget.current.resolution));
              if(cached?.state !== "error") {
                dismissedHistory.current="";loggedHistory.current="";
                setHistoryFailure(previous => previous?.source === "cache" && cached?.state === "pending" ? previous : null);
              }
            }
          } else if (
            message.epoch === nativeLoadEpoch.current &&
            ["native-load-start", "native-load-end"].includes(message.type)
          ) {
            if (message.type === "native-load-start") {
              mark("行情请求");
              pendingHistory.add(message.id);
            } else {
              pendingHistory.delete(message.id);
              if (!pendingHistory.size) mark("行情返回");
            }
            setHistoryLoads(pendingHistory.size);
          } else if (message.type === "ready") {
            mark("图表就绪");
            adapterReady = true;
            setReady(true);
            if (needsMarketRecovery.current && visibility.current) {
              needsMarketRecovery.current = false;
              updateChart({ type: "mobile-market-resume" });
            }
          } else if (message.type === "mobile-shell-ready") {
            mark("工具栏");
            setShellReady(true);
            if (Number.isFinite(message.height) && message.height > 0) setToolbarHeight(message.height);
          } else if (message.type === "mobile-display-pending") {
            if (hasDisplayTarget) {
              timing.finish("superseded");
              timing = chartTiming(profile, message.symbol, message.resolution);
            } else timing.target(message.symbol, message.resolution);
            hasDisplayTarget = true;
            displayTarget.current = {symbol:message.symbol, resolution:message.resolution, theme:message.theme};
            preparation.foreground(message.symbol, timeframes[message.resolution]);
            const cached=cacheStates.current.get(cacheKey(message.symbol,message.resolution));
            setCachePending(cached?.state === "pending");
            if(cached?.state === "error") {
              const next={epoch:nativeLoadEpoch.current,index:0,symbol:message.symbol,
                resolution:message.resolution,error:cached.error || "行情同步未完成",source:"cache" as const};
              setHistoryFailure(failureKey(next) === dismissedHistory.current ? null : next);
            }
          } else if (message.type === "mobile-display-ready") {
            if (sameChartSymbol(message.symbol, displayTarget.current.symbol) && message.resolution === displayTarget.current.resolution && message.theme === callbacks.current.theme) {
              mark("画面可用"); timing.finish("ready");
            }
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
          } else if (message.type === "mobile-saved") {
            setOperationError("");
          } else if (message.type === "mobile-cache-state") {
            cacheStates.current.set(cacheKey(message.symbol,message.resolution),{state:message.state,error:message.error});
            if (sameChartSymbol(message.symbol, displayTarget.current.symbol) &&
                message.resolution === displayTarget.current.resolution) {
              setCachePending(message.state === "pending");
              if (message.state === "error") {
                const next={epoch:nativeLoadEpoch.current,index:0,symbol:message.symbol,
                  resolution:message.resolution,error:message.error || "行情同步未完成",source:"cache" as const};
                const key=failureKey(next);
                setHistoryFailure(key === dismissedHistory.current ? null : next);
                if(key !== loggedHistory.current) {callbacks.current.report(next.error);loggedHistory.current=key;}
              } else if (message.state === "ready") {
                dismissedHistory.current="";loggedHistory.current="";setHistoryFailure(null);
              }
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
          } else if (message.type === "error") {
            // Routine runtime feedback belongs in the log. A failed local save
            // is actionable here and must not silently lose the user's edits.
            if (String(message.error).includes("本次图表设置未记住"))
              setOperationError(errorMessage(message.error));
            callbacks.current.report(message.error);
          }
        };
        void handle().catch((error) => {
          if (!stopped) {
            if (message.type === "loaded") { timing.mark("初始化失败"); timing.finish("failed"); setFailure(errorMessage(error)); }
            else callbacks.current.report(errorMessage(error));
          }
        });
      },
      market: (kind, query, context, source) => {
        if (visibility.current && kind === "data") preparation.foreground(selection.current.target, query.timeframe);
        if (visibility.current && kind === "market" && query.op === "resolve") preparation.foreground(selection.current.target);
        if (kind === "data")
          return history.read(query, () => market.data(query, source, context));
        if (kind === "market")
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
    let opened = false, connected = false;
    const stopObserving = connection.observe(state => {
      if (state.state !== "open") { connected = false; return; }
      if (connected) return;
      connected = true;
      if (opened) {
        needsMarketRecovery.current = true;
        if (visibility.current && adapterReady) {
          needsMarketRecovery.current = false;
          updateChart({ type: "mobile-market-resume" });
        }
      }
      opened = true;
    });
    const manifestPath = document.querySelector<HTMLMetaElement>(
      'meta[name="mw-chart-manifest"]',
    )?.content;
    setFailure("");
    setOperationError("");
    setHistoryFailure(null);
    setCachePending(false);
    cacheStates.current.clear();
    setReady(false);
    setShellReady(false);
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
        mark("资源");
        value.start();
      })
      .catch((error) => {
        if (!stopped) { timing.mark("资源失败"); timing.finish("failed"); setFailure(errorMessage(error)); }
      });
    return () => {
      timing.finish("superseded");
      stopped = true;
      history.dispose();
      leaveResult.current?.(false);
      leaveResult.current = undefined;
      setConfirmLeave(false);
      unsubscribeCapacity();
      stopObserving();
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
  const appliedTarget = useRef(0);
  const initial = useRef("");
  useEffect(() => {
    if (!ready) return;
    const requested = target?.symbol === symbol && appliedTarget.current !== target.token ? target : undefined;
    if (sameChartSymbol(initial.current, symbol) && !requested) return;
    initial.current = symbol;
    if (requested) appliedTarget.current = requested.token;
    void chart.current?.update({
      type: "mobile-command",
      action: "symbol",
      symbol,
      ...(requested ? { resolution: requested.resolution } : {}),
    });
  }, [symbol, ready, target]);
  useEffect(() => {
    if (!visible && ready)
      void chart.current?.update({ type: "mobile-command", action: "leave" });
    if (visible) preparation.foreground(symbol);
    if (visible) dispatchEvent(new Event("resize"));
    if (visible && ready && needsMarketRecovery.current) {
      needsMarketRecovery.current = false;
      void chart.current?.update({ type: "mobile-market-resume" });
    }
  }, [visible, ready, preparation, symbol]);
  useEffect(() => {
    if (ready)
      void chart.current?.update({
        type: "theme",
        theme: theme === "light" ? "Light" : "Dark",
      });
  }, [theme, ready]);
  const retrySave = async () => {
    setSavePending(true);
    try { await flush(); setOperationError(""); }
    catch (error) { callbacks.current.report(errorMessage(error)); }
    finally { setSavePending(false); }
  };
  return (
    <section
      className="mobile-chart mobile-controls"
      hidden={!visible}
      aria-label="图表"
    >
      <MobileOverlaysProvider>
        <h1 className="sr-only">图表</h1>
        <div className="chart-workspace" style={{"--chart-toolbar-height":`${toolbarHeight}px`} as React.CSSProperties} aria-busy={!ready && !failure}>
          <div className="mobile-chart-canvas" ref={root} />
          {operationError && ready && !historyFailure && (
            <Alert className="chart-operation-error chart-history-failure" role="status">
              <CircleAlert aria-hidden="true" />
              <div className="chart-history-failure-copy">
                <AlertTitle>设置尚未保存到本机</AlertTitle>
                <AlertDescription>当前修改仍在，请重试保存。</AlertDescription>
              </div>
              <HeaderIconButton icon={RefreshCw} label={savePending ? "正在保存" : "重试保存"}
                disabled={savePending} onClick={() => void retrySave()} />
              <HeaderIconButton icon={X} label="关闭保存提示" onClick={() => setOperationError("")} />
            </Alert>
          )}
          {ready && !failure && historyFailure && (
            <Alert className="chart-history-failure" role="status">
              <CircleAlert aria-hidden="true" />
              <div className="chart-history-failure-copy">
                <AlertTitle>行情读取失败</AlertTitle>
                <AlertDescription>{errorMessage(historyFailure.error).replace(/^(?:Error:\s*)+/, "")}</AlertDescription>
              </div>
              <HeaderIconButton
                icon={RefreshCw}
                label={historyLoads > 0 ? "正在重试行情" : "重试行情"}
                disabled={historyLoads > 0}
                onClick={() => void chart.current?.update({
                  type: "retry-chart-history",
                  epoch: historyFailure.epoch,
                  index: historyFailure.index,
                  symbol: historyFailure.symbol,
                  resolution: historyFailure.resolution,
                })}
              />
              <HeaderIconButton icon={X} label="关闭行情提示" onClick={() => {
                dismissedHistory.current=failureKey(historyFailure);setHistoryFailure(null);
              }} />
            </Alert>
          )}
          {shellReady && !failure && (historyPending || cachePending) && !historyFailure && (
            <div className="chart-history-progress" role="status">
              <span className="chart-status-dot" aria-hidden="true" />{cachePending ? "正在同步行情" : "正在更新行情"}
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
          {!shellReady && !failure && (
            <div className="chart-state-cover chart-loading" role="status" aria-label="准备图表">
              <div className="chart-loading-toolbar" aria-hidden="true">
                <Skeleton /><Skeleton /><Skeleton /><Skeleton />
              </div>
              <div className="chart-loading-content">
                <CandlestickChart aria-hidden="true" />
                <p>正在载入图表</p>
                <span>已有设置将自动恢复</span>
              </div>
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
