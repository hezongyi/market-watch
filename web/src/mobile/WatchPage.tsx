import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Folder,
  Layers3,
  FolderPlus,
  Pencil,
  Plus,
  ArrowUp,
  ArrowDown,
  Trash2,
  WifiOff,
  X,
} from "lucide-react";
import { api } from "../api";
import type { MarketTransportState } from "../advanced/providerSubscriptions";
import {
  profileActive,
  readSnapshot,
  writeSnapshot,
  type Profile,
} from "./cache";
import { type MobileMarket, seriesIdentity } from "./market";
import { sparklineExpires, sparklineLoader, sparklinePaths, sparklineScale, sparklineWithQuote, type Sparkline } from "./sparklines";
import FitText from "./FitText";
import { watchDescription } from "./watchIdentity";
import { PULL_THRESHOLD, usePullRefresh } from "./usePullRefresh";
import { formatWatchPrice, watchPriceParts } from "./quoteFormat";
import {
  allSymbols,
  removeGroup,
  removeSymbol,
  saveWatchlists,
  watchContent,
  watchPreference,
  type WatchList,
  type WatchPreference,
} from "./watchlists";
import MobileSheet from "./MobileSheet";
import { WatchOverlaysProvider, WatchConfirm } from "./WatchOverlays";
import { Button } from "./components/ui/button";
import { RadioGroup, RadioGroupItem } from "./components/ui/radio-group";
import { Input } from "./components/ui/input";
import { Field, FieldGroup, FieldLabel, FieldError } from "./components/ui/field";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";
import WatchReorderList from "./WatchReorderList";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import { InputGroup, InputGroupInput, InputGroupAddon, InputGroupButton } from "./components/ui/input-group";
import WatchIcon from "./WatchIcons";
import DataPage from "./DataPage";
import { MobileEmpty, MobileLoading } from "./MobileState";

type Quote = {
  n: string;
  s: string;
  v: Record<string, any>;
  snapshot?: { revision_id?: string };
  [key: string]: any;
};
const stamp = (value?: number | null) =>
  value ? new Date(value).toLocaleTimeString("zh-CN", { hour12: false }) : "等待首次通信";
const code = (ticker: string, quote?: Quote) => {
  if (quote?.v?.short_name) return quote.v.short_name;
  const fallback = ticker.replace(/^MW[PHC]:/, "");
  // Opaque dataset IDs are not readable symbols; keep the row stable until metadata arrives.
  return /(?:^|:)[a-f0-9]{32,64}$/i.test(fallback)
    ? quote && quote.s !== "ok" ? "暂不可用" : "读取中…"
    : fallback;
};
function compactIdentity(ticker: string, quote?: Quote) {
  const value = quote?.v;
  const parts = String(value?.description_base || value?.description || "")
    .split(" · ")
    .map((part) => part.trim());
  const kindAt = parts.findIndex((part) =>
    ["原生", "自建"].includes(part),
  );
  const identity = seriesIdentity(ticker);
  const kind = (
    {
      provider: "原生",
      history: "自建",
      managed: "自建",
      composite: "自建",
    } as Record<string, string>
  )[identity.series_kind];
  const source = (kindAt >= 0 ? parts[kindAt + 1] : value?.exchange) || "来源待确认";
  const provider = identity.series_kind === "provider"
    ? ({ "BINANCE": "Binance", "BINANCE SPOT": "Binance", "YAHOO FINANCE": "Yahoo", "YAHOO": "Yahoo" } as Record<string, string>)[source.toUpperCase()] || source
    : undefined;
  return {
    provider,
    name:
      kindAt > 0
        ? parts
            .slice(parts[0] === code(ticker, quote) ? 1 : 0, kindAt)
            .join(" · ")
        : "",
    series:
      kindAt >= 0
        ? parts
            .slice(kindAt, kindAt + 2)
            .map((part) =>
              part === "Binance Spot"
                ? "Binance"
                : part === "Yahoo Finance"
                  ? "Yahoo"
                  : part,
            )
            .join(" · ")
        : [kind, value?.exchange || "来源待确认"].filter(Boolean).join(" · "),
  };
}
function Spark({
  item,
  instrument,
  online,
  state,
  previousClose,
  quote,
}: {
  item?: Sparkline;
  instrument: string;
  online: boolean;
  state?: "loading" | "error";
  previousClose?: number;
  quote?: Quote;
}) {
  const gradient = useId();
  const container = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(200);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(1, Math.round(element.getBoundingClientRect().width)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const current = useMemo(() => item && sparklineExpires(item) > Date.now()
    ? sparklineWithQuote(item, quote) : undefined, [item, quote]);
  const previousSession = current?.session?.previous;
  const sessionOpen = current?.session_open_price == null ? undefined : Number(current.session_open_price);
  const reference = previousSession ? sessionOpen : previousClose;
  const paths = useMemo(() => current ? sparklinePaths(current, width, 50, reference, instrument) : [], [current, width, reference, instrument]);
  const scale = current ? sparklineScale(current, 50, reference, instrument) : undefined;
  const referenceY = scale?.referenceY;
  if (!current || !paths.length) {
    const label = !online
      ? "离线无缓存"
      : state === "loading"
        ? "加载中"
        : state === "error"
          ? "加载失败"
          : current?.status === "unavailable"
            ? "走势不可用"
            : current
              ? "暂无日内数据"
              : "等待走势";
    return (
      <span
        ref={container}
        className="mobile-spark mobile-spark-empty"
        data-state={!online ? "offline" : state || current?.status || "waiting"}
        title={current?.reason || label}
        aria-label={label}
      >
        {label}
      </span>
    );
  }
  const cached = !online || state === "error";
  return (
    <span ref={container} className="mobile-spark" data-cached={cached || undefined}
      data-previous-session={current.session?.previous || undefined}
      title={previousSession ? `${current.session!.date} · 历史走势，收到本日行情后自动切换` : undefined}>
      <svg
        viewBox={`0 0 ${width} 50`}
        preserveAspectRatio="none"
        aria-label={
          current.session?.previous
            ? `${current.session.date} 历史走势${cached ? " · 缓存" : ""}${scale?.referenceOutside ? " · 开盘参考价在曲线显示范围外" : ""}`
            : cached
              ? `离线或刷新失败，显示缓存走势${scale?.referenceOutside ? " · 昨收参考价在曲线显示范围外" : ""}`
              : `${current.reason || "当前窗口日内走势"}${scale?.referenceOutside ? " · 昨收参考价在曲线显示范围外" : ""}`
        }
      >
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="50" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="currentColor" className="mobile-spark-fill-top" />
            <stop offset="55%" stopColor="currentColor" className="mobile-spark-fill-middle" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        {referenceY !== undefined && (
          <line className={`${previousSession ? "mobile-spark-session-open" : "mobile-spark-previous-close"}${scale?.referenceOutside ? " mobile-spark-reference-outside" : ""}`} x1="0" x2={width}
            y1={referenceY} y2={referenceY} vectorEffect="non-scaling-stroke">
            <title>{previousSession ? `${current.session!.date} 开盘价 ${sessionOpen}` : `昨收 ${previousClose} · 与报价涨跌幅同基准`}{scale?.referenceOutside ? " · 参考价在曲线显示范围外" : ""}</title>
          </line>
        )}
        {current.reference_times?.map((at) => (
          <line
            key={at}
            x1={
              ((at - current.window_start) /
                (current.window_end - current.window_start)) *
              width
            }
            x2={
              ((at - current.window_start) /
                (current.window_end - current.window_start)) *
              width
            }
            y1="0"
            y2="50"
            stroke="currentColor"
            opacity=".12"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {paths.map((path, i) => (
          <g key={i}>
            <path d={path.area} fill={`url(#${gradient})`} />
            <path
              d={path.line}
              stroke="currentColor"
              strokeWidth="1.2"
              strokeOpacity=".72"
              strokeLinejoin="round"
              strokeLinecap="round"
              fill="none"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        ))}
      </svg>
      {cached && <small className="mobile-spark-caption">缓存</small>}
    </span>
  );
}

export default function WatchPage({
  profile,
  online,
  connection,
  visible,
  open,
  report,
  notice,
  closeNotice,
  showNotices,
  firstSymbol,
}: {
  profile: Profile;
  online: boolean;
  connection?: MobileMarket;
  visible: boolean;
  open(ticker: string): void;
  report(message: string): void;
  notice?: string;
  closeNotice?(): void;
  showNotices?(): void;
  firstSymbol?(ticker: string): void;
}) {
  const [preference, setPreference] = useState<WatchPreference>(),
    [loaded, setLoaded] = useState(false);
  const [readAt, setReadAt] = useState<number>(),
    [group, setGroup] = useState("");
  const [sheet, setSheet] = useState<"groups" | "manage" | null>(null),
    [name, setName] = useState("");
  const [draft, setDraft] = useState<WatchList[]>(),
    [busy, setBusy] = useState(false),
    [unsaved, setUnsaved] = useState(false);
  const [undo, setUndo] = useState<WatchList[]>(),
    [hydrated, setHydrated] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [searching, setSearching] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [manageTab, setManageTab] = useState("symbols");
  const afterSheetClose = useRef<(() => void) | undefined>(undefined);
  const finishSheetClose = () => {
    const next = afterSheetClose.current;
    afterSheetClose.current = undefined;
    next?.();
  };
  const leaveActions = (next: () => void) => {
    afterSheetClose.current = next;
    setActionsOpen(false);
  };
  const groupNameId = useId();
  const [confirmation, setConfirmation] = useState<
    { kind: "remove-group"; id: string; title: string } | { kind: "reload" }
  >();
  const [refreshSerial, setRefreshSerial] = useState(0), [refreshing, setRefreshing] = useState(false);
  const pullVersion = useRef(0);
  const finishPull = (version: number) => {
    if (version === pullVersion.current) setRefreshing(false);
  };
  const [groupForm, setGroupForm] = useState<"new" | "rename">();
  const [nameError, setNameError] = useState("");
  const [quotes, setQuotes] = useState<Record<string, Quote>>({}),
    [sparks, setSparks] = useState<Record<string, Sparkline>>({});
  const [sparkStates, setSparkStates] = useState<
    Record<string, "loading" | "error">
  >({});
  const [aligned, setAligned] = useState<Set<string>>(new Set());
  const [transport, setTransport] = useState<MarketTransportState>();
  const [foreground, setForeground] = useState(!document.hidden),
    [visibleRows, setVisibleRows] = useState<string[]>([]);
  const scrollPositions = useRef<Record<string, number>>({});
  const scrollTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const list = useRef<HTMLDivElement>(null),
    epoch = useRef(0),
    quotesEpoch = useRef(0);
  const content = watchContent(preference);
  const symbols = useMemo(
    () =>
      group
        ? content.lists.find((row) => row.id === group)?.symbols || []
        : allSymbols(content),
    [preference, group],
  );
  const rowKey = JSON.stringify(visibleRows),
    symbolsKey = JSON.stringify(symbols);
  useEffect(() => {
    if (hydrated) firstSymbol?.(symbols[0] || "");
  }, [hydrated, symbols[0], firstSymbol]);
  const currentQuotes = useRef(quotes);
  currentQuotes.current = quotes;
  const preparedHistory = useMemo(() => new Map<string, number>(), [profile.origin, profile.subject]);
  const currentSparks = useRef(sparks);
  currentSparks.current = sparks;
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const generation = ++epoch.current;
      setLoadError("");
      const row = watchPreference(
        await api<WatchPreference[]>(
          "/advanced-charts/preferences",
          undefined,
          signal,
        ),
      );
      if (generation !== epoch.current || signal?.aborted) return;
      if (!profileActive(profile)) return false;
      setPreference(row);
      setLoaded(true);
      setReadAt(undefined);
      await writeSnapshot(profile, "watchlists", row || null).catch(() =>
        report("自选快照未能写入本机"),
      );
    },
    [profile.origin, profile.subject, report],
  );
  const requestRefresh = () => {
    if (!online || refreshing) return;
    const version = ++pullVersion.current;
    setRefreshing(true);
    preparedHistory.clear();
    void refresh().then(() => {
      if (version !== pullVersion.current) return;
      setRefreshSerial(version);
      if (!visibleRows.length) setRefreshing(false);
    }).catch(error => {
      if (version !== pullVersion.current) return;
      setRefreshing(false); report(String(error));
    });
  };
  const pullDistance = usePullRefresh(list, visible && online && foreground && !sheet && !searching && !actionsOpen, refreshing, requestRefresh);
  useEffect(() => {
    if (!visible || !online || !foreground) {
      ++pullVersion.current; setRefreshing(false);
    }
  }, [visible, online, foreground]);
  useEffect(() => {
    if (!visible) return;
    const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!viewport) return;
    const original = viewport.content;
    viewport.content = original + ", maximum-scale=1, user-scalable=no";
    return () => { viewport.content = original; };
  }, [visible]);
  useEffect(() => {
    let active = true;
    void Promise.all([
      readSnapshot<WatchPreference | null>(profile, "watchlists"),
      readSnapshot<string>(profile, "watch-group"),
      readSnapshot<Record<string, Quote>>(profile, "watch-quotes"),
      readSnapshot<Record<string, Sparkline>>(profile, "watch-sparklines"),
      readSnapshot<Record<string, number>>(profile, "watch-scroll"),
    ])
      .then(([saved, selection, quote, spark, scroll]) => {
        if (!active) return;
        if (saved) {
          setPreference(saved.value || undefined);
          setLoaded(true);
          setReadAt(saved.readAt);
        }
        scrollPositions.current = scroll?.value || {};
        setGroup(selection?.value || "");
        setQuotes(quote?.value || {});
        setSparks(
          Object.fromEntries(
            Object.entries(spark?.value || {}).filter(
              ([, value]) => sparklineExpires(value) > Date.now(),
            ),
          ),
        );
      })
      .catch(() => report("自选本机缓存暂不可用"))
      .finally(() => {
        if (active) setHydrated(true);
      });
    return () => {
      active = false;
      ++epoch.current;
    };
  }, [profile.origin, profile.subject, report]);
  useLayoutEffect(() => {
    if (hydrated && loaded && visible && list.current)
      list.current.scrollTop = scrollPositions.current[group] || 0;
  }, [hydrated, loaded, visible, group, symbolsKey]);
  useEffect(
    () => () => {
      clearTimeout(scrollTimer.current);
      if (profileActive(profile))
        void writeSnapshot(
          profile,
          "watch-scroll",
          scrollPositions.current,
        ).catch(() => {});
    },
    [profile],
  );
  useEffect(() => {
    if (!hydrated || !online || !visible || !foreground || sheet) return;
    const controller = new AbortController();
    void refresh(controller.signal).catch((error) => {
      if (!controller.signal.aborted) {
        setLoadError(String(error));
        report(String(error));
      }
    });
    return () => {
      controller.abort();
      ++epoch.current;
    };
  }, [hydrated, online, visible, foreground, refresh]);
  useEffect(() => {
    const change = () => setForeground(!document.hidden);
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  useEffect(() => connection?.observe(setTransport), [connection]);
  useEffect(() => {
    const boundary = Math.min(
      ...Object.values(sparks).map(sparklineExpires),
    );
    if (!Number.isFinite(boundary)) return;
    const timer = setTimeout(
      () =>
        setSparks((previous) =>
          Object.fromEntries(
            Object.entries(previous).filter(
              ([, item]) => sparklineExpires(item) > Date.now(),
            ),
          ),
        ),
      Math.max(1, boundary - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [sparks]);
  useEffect(() => {
    const changed = () => {
      if (online && !sheet)
        void refresh().catch((error) => report(String(error)));
    };
    addEventListener("mw-mobile-watchlists-changed", changed);
    return () => removeEventListener("mw-mobile-watchlists-changed", changed);
  }, [online, sheet, refresh, report]);
  useEffect(() => {
    if (!loaded || (group && !content.lists.some((row) => row.id === group)))
      setGroup("");
  }, [loaded, preference]);
  useEffect(() => {
    if (!visible || !list.current) {
      // Keep the last viewport's quote subscriptions across app navigation.
      // Watchlist edits may still remove symbols while this page is hidden.
      setVisibleRows((previous) => previous.filter((ticker) => symbols.includes(ticker)));
      return;
    }
    let active = true;
    const shown = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        if (!active) return;
        for (const entry of entries) {
          const ticker = (entry.target as HTMLElement).dataset.ticker!;
          if (entry.isIntersecting) shown.add(ticker);
          else shown.delete(ticker);
        }
        setVisibleRows(symbols.filter((ticker) => shown.has(ticker)));
      },
      { root: list.current, rootMargin: "120px" },
    );
    list.current
      .querySelectorAll("[data-ticker]")
      .forEach((row) => observer.observe(row));
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [visible, symbolsKey]);
  useEffect(() => {
    setAligned(new Set());
    if (
      !online ||
      !foreground ||
      !connection ||
      !visibleRows.length
    )
      return;
    const generation = ++quotesEpoch.current,
      controller = new AbortController();
    const subscriptions = visibleRows
      .filter((ticker) => !/^(MWP:)?(?:AKSHARE|TENCENT):/.test(ticker))
      .map((ticker) => ({
        client: connection.client,
        listener: crypto.randomUUID(),
        generation: 1,
        sequence: 0,
        kind: "quotes",
        query: { ...seriesIdentity(ticker), timeframe: "M1", limit: 2 },
      }));
    const received = new Set<string>();
    let ready = false,
      openedAt: number | null = null,
      snapshotEpoch = 0;
    let snapshot: AbortController | undefined;
    const update = (rows: Quote[], streamed = false) => {
      if (generation !== quotesEpoch.current || controller.signal.aborted)
        return;
      const next = { ...currentQuotes.current };
      for (const row of rows) {
        if (!visibleRows.includes(row.n) || (!streamed && received.has(row.n)))
          continue;
        if (streamed) received.add(row.n);
        next[row.n] = row;
      }
      currentQuotes.current = next;
      setQuotes(next);
      if (ready)
        setAligned(
          (previous) => new Set([...previous, ...rows.map((row) => row.n)]),
        );
      void writeSnapshot(profile, "watch-quotes", next).catch(() => {});
    };
    const loadSnapshot = () => {
      snapshot?.abort();
      const request = (snapshot = new AbortController()),
        token = ++snapshotEpoch;
      void api<Quote[]>(
        "/market-data/quotes",
        { symbols: visibleRows, client: connection.client },
        request.signal,
      )
        .then((rows) => {
          if (!request.signal.aborted && token === snapshotEpoch) update(rows);
        })
        .catch((error) => {
          if (!request.signal.aborted && !controller.signal.aborted)
            report(String(error));
        });
    };
    loadSnapshot();
    const stopObserving = connection.observe((state) => {
      if (state.state !== "open") {
        ready = false;
        openedAt = null;
        snapshot?.abort();
        ++snapshotEpoch;
        setAligned(new Set());
      } else if (!ready || openedAt !== state.openedAt) {
        ready = true;
        openedAt = state.openedAt;
        received.clear();
        setAligned(new Set());
        loadSnapshot();
      }
    });
    for (const args of subscriptions)
      void connection
        .subscribe(args, (event) => {
          if (event.type !== "quotes" || !ready) return;
          const ticker = visibleRows.find(
            (value) =>
              seriesIdentity(value).instrument === args.query.instrument &&
              seriesIdentity(value).series_kind === args.query.series_kind,
          )!;
          update(
            (event.quotes || []).map((row) => ({ ...row, n: ticker })),
            true,
          );
        })
        .catch((error) => report(String(error)));
    return () => {
      ++quotesEpoch.current;
      controller.abort();
      snapshot?.abort();
      stopObserving();
      for (const args of subscriptions)
        void connection.unsubscribe(args).catch(() => {});
    };
  }, [
    online,
    foreground,
    connection,
    rowKey,
    refreshSerial,
    profile.origin,
    profile.subject,
    report,
  ]);
  useEffect(() => {
    if (!online || !visible || !foreground || !visibleRows.length) return;
    let timer: ReturnType<typeof setTimeout>,
      active = true;
    const loader = sparklineLoader(
      async (items, signal) => {
        setSparkStates((previous) => ({
          ...previous,
          ...Object.fromEntries(
            items.map((item) => [item.ticker, "loading" as const]),
          ),
        }));
        try {
          const response = await api(
            "/market-data/sparklines",
            { items },
            signal,
          );
          if (active && !signal.aborted)
            setSparkStates((previous) => {
              const next = { ...previous };
              for (const item of items) delete next[item.ticker];
              return next;
            });
          return response;
        } catch (error) {
          if (active && !signal.aborted)
            setSparkStates((previous) => ({
              ...previous,
              ...Object.fromEntries(
                items.map((item) => [item.ticker, "error" as const]),
              ),
            }));
          throw error;
        }
      },
      (items) => {
        if (!active) return;
        const next = { ...currentSparks.current };
        for (const item of items) {
          const quoteRevision =
            currentQuotes.current[item.ticker]?.snapshot?.revision_id;
          if (
            quoteRevision &&
            item.revision?.composite_revision_id !== quoteRevision
          )
            continue;
          next[item.ticker] = item;
        }
        for (const [ticker, item] of Object.entries(next))
          if (sparklineExpires(item) <= Date.now()) delete next[ticker];
        currentSparks.current = next;
        setSparks(next);
        void writeSnapshot(profile, "watch-sparklines", next).catch(() => {});
      },
      () => {
        /* Keep existing curves on history failures; periodic refresh retries. */
      },
      {
        prepared: preparedHistory,
        request: (ticker, signal) => api("/market-data/sparklines/prepare", { ticker }, signal),
      },
    );
    const load = () => {
      // Expire old curves before a new request, even when that request fails.
      setSparks((previous) =>
        Object.fromEntries(
          Object.entries(previous).filter(
            ([, item]) => sparklineExpires(item) > Date.now(),
          ),
        ),
      );
      void loader.load(
        visibleRows.map((ticker) => ({
          ticker,
          ...(currentQuotes.current[ticker]?.snapshot?.revision_id
            ? {
                composite_revision_id:
                  currentQuotes.current[ticker].snapshot!.revision_id,
              }
            : {}),
        })),
        () => {
          if (!active) return;
          finishPull(refreshSerial);
          // Start the next observation interval now; history preparation has
          // its own bounded queue and must not delay visible freshness.
          const boundary = Math.min(...visibleRows.map(ticker =>
            currentSparks.current[ticker] ? sparklineExpires(currentSparks.current[ticker]) : Infinity));
          timer = setTimeout(load, Math.max(1, Math.min(60000, boundary - Date.now())));
        },
      );
    };
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
      loader.cancel();
    };
  }, [
    online,
    visible,
    foreground,
    rowKey,
    profile.origin,
    profile.subject,
    preparedHistory,
    refreshSerial,
    report,
  ]);
  async function save(lists: WatchList[]) {
    if (busy || !online) return;
    const titles = lists.map(row => row.title.trim());
    if (titles.some(title => !title || title.length > 20 || title === "全部") || new Set(titles).size !== titles.length) {
      report("分组名称需为 1–20 字，不能重复或使用“全部”。");
      return false;
    }
    setBusy(true);
    setUnsaved(true);
    try {
      const row = await saveWatchlists(api, preference, lists.map((list, index) => ({ ...list, title: titles[index] })));
      if (!profileActive(profile)) return false;
      setPreference(row);
      setDraft(undefined);
      setUnsaved(false);
      await writeSnapshot(profile, "watchlists", row).catch(() =>
        report("服务器已保存，本机快照未更新"),
      );
      return true;
    } catch (error) {
      report(String(error));
      return false;
    } finally {
      setBusy(false);
    }
  }
  const status = !foreground
    ? "后台暂停"
    : !online
      ? "等待连接"
      : !transport || transport.state === "idle"
        ? "等待行情"
        : transport.state === "open"
          ? "已连接"
          : transport.state === "error"
            ? "正在重连"
            : "连接中";
  const last = Math.max(transport?.messageAt || 0, transport?.heartbeatAt || 0);
  const editing = draft || content.lists;
  const cacheStatus =
    loaded &&
    (!online
      ? "手机离线 · 当前显示上次数据"
      : loadError
        ? "刷新失败 · 已保留上次自选"
        : readAt
          ? "正在确认 · 当前显示上次自选"
          : "");
  return (
    <section hidden={!visible} className="mobile-watch mobile-controls">
      <WatchOverlaysProvider>
      <header className="mobile-watch-title">
        <Button variant="plain"
          className="mobile-group-button"
          aria-label="选择自选分组"
          aria-haspopup="dialog"
          aria-expanded={sheet === "groups"}
          onClick={() => setSheet("groups")}
        >
          <span>
            自选
            {group && (
              <small>
                {content.lists.find((row) => row.id === group)?.title}
              </small>
            )}
          </span>
          <ChevronDown aria-hidden="true" />
        </Button>
        <div
          className="mobile-sse"
          data-connected={online && transport?.state === "open"}
          role="status"
        >
          <span>{status}</span>
          <small>{last ? "最近通信 " + stamp(last) : "等待首次通信"}</small>
        </div>
        <div className="mobile-header-actions">
          <Button variant="plain"
            aria-label="自选操作"
            aria-haspopup="dialog"
            aria-expanded={actionsOpen}
            onClick={() => setActionsOpen(true)}
          >
            <WatchIcon name="/more" />
          </Button>
        </div>
      </header>
      {cacheStatus && (
        <div className="mobile-watch-status" role="status">
          <WifiOff aria-hidden="true" />
          <span>{cacheStatus}</span>
        </div>
      )}
      {notice && (
        <aside className="mobile-watch-notice" role="status">
          <div>
            <strong>有事件需要查看</strong>
            <p>{notice}</p>
          </div>
          <Button variant="plain" className="mobile-link-button" onClick={showNotices}>
            查看
          </Button>
          <Button variant="plain"
            className="mobile-watch-dismiss"
            aria-label="关闭事件提醒"
            onClick={closeNotice}
          >
            <X aria-hidden="true" />
          </Button>
        </aside>
      )}
      <div className="mobile-pull-refresh" style={{height: refreshing ? PULL_THRESHOLD : pullDistance}} aria-live="polite" data-refreshing={refreshing || undefined}>
        {(refreshing || pullDistance > 8) && <><RefreshCw aria-hidden="true" style={refreshing ? undefined : {transform:`rotate(${pullDistance * 3}deg)`}} /><span>{refreshing ? "正在刷新…" : pullDistance >= PULL_THRESHOLD ? "松开刷新" : "下拉刷新"}</span></>}
      </div>
      <div
        ref={list}
        className="mobile-watch-list"
        onScroll={(event) => {
          if (!hydrated || !visible) return;
          scrollPositions.current[group] = event.currentTarget.scrollTop;
          clearTimeout(scrollTimer.current);
          scrollTimer.current = setTimeout(() => {
            void writeSnapshot(
              profile,
              "watch-scroll",
              scrollPositions.current,
            ).catch(() => {});
          }, 150);
        }}
      >
        {!loaded ? (
          online && !loadError ? (
            <MobileLoading label="正在读取自选…" />
          ) : (
            <MobileEmpty
              offline
              title="暂无本地数据"
              action={
                loadError && (
                  <Button variant="plain"
                    onClick={() =>
                      void refresh().catch((error) => {
                        setLoadError(String(error));
                        report(String(error));
                      })
                    }
                  >
                    重试
                  </Button>
                )
              }
            >
              连接恢复后自动读取。
            </MobileEmpty>
          )
        ) : !symbols.length ? (
          <MobileEmpty
            title="还没有关注品种"
            action={
              <Button variant="plain" className="primary" onClick={() => setSearching(true)}>
                搜索品种
              </Button>
            }
          >
            按需选择品种，建立自己的行情清单。
          </MobileEmpty>
        ) : null}
        {symbols.map((ticker) => {
          const quote = quotes[ticker],
            value = quote?.v,
            price = value?.lp,
            change = value?.chp;
          const stale =
            !online ||
            transport?.state !== "open" ||
            !aligned.has(ticker) ||
            quote?.s !== "ok" ||
            (value?.fetch_status && value.fetch_status !== "ok");
          const item = sparks[ticker],
            revision = quote?.snapshot?.revision_id;
          const identity = compactIdentity(ticker, quote);
          const displayCode = code(ticker, quote);
          const displayPrice = formatWatchPrice(price, value?.display_precision, displayCode);
          const priceParts = watchPriceParts(displayPrice);
          const displayChange = typeof change === "number" ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}%` : "—";
          return (
            <Button variant="plain"
              key={ticker}
              data-ticker={ticker}
              data-delayed={typeof value?.delay_seconds === "number" && value.delay_seconds > 0 || undefined}
              title={value?.description}
              className={`mobile-watch-row ${stale ? "stale" : ""} ${typeof change === "number" ? (change >= 0 ? "positive" : "negative") : ""}`}
              onClick={() => open(ticker)}
            >
              <span className="mobile-watch-symbol">
                <strong title={displayCode}><FitText text={displayCode} /></strong>
                {watchDescription(displayCode, identity.name) && <span className="mobile-watch-description" title={identity.name}>{watchDescription(displayCode, identity.name)}</span>}
                {identity.provider && (
                  <span className="mobile-watch-origin" title={identity.series}>
                    {identity.provider}
                  </span>
                )}
              </span>
              <Spark
                instrument={displayCode}
                online={online}
                quote={!stale && foreground ? quote : undefined}
                previousClose={quote?.s === "ok" && item && !item.session?.previous && value?.read_at >= item.window_start &&
                  value.read_at < sparklineExpires(item) ? value.prev_close_price : undefined}
                state={sparkStates[ticker]}
                item={
                  revision && item?.revision?.composite_revision_id !== revision
                    ? undefined
                    : item
                }
              />
              <span className="mobile-watch-price">
                <strong
                  aria-label={typeof change === "number" ? `涨跌幅 ${change.toFixed(2)}%` : "涨跌幅暂无"}
                  className={
                    typeof change !== "number"
                      ? ""
                      : change >= 0
                        ? "up"
                        : "down"
                  }
                >
                  <FitText text={displayChange} />
                </strong>
                <small className="mobile-watch-last-price" title={typeof price === "number" ? String(price) : undefined}>
                  <FitText text={displayPrice}>
                    {priceParts.prefix}<b className="mobile-price-pips">{priceParts.focus}</b>{priceParts.tail && <sup>{priceParts.tail}</sup>}
                  </FitText>
                </small>
                {typeof value?.delay_seconds === "number" &&
                  value.delay_seconds > 0 && (
                    <small className="mobile-watch-delay">
                      延迟{Math.ceil(value.delay_seconds / 60)}分
                    </small>
                  )}
              </span>
            </Button>
          );
        })}
      </div>
      <MobileSheet open={actionsOpen} title="自选操作" description="添加品种，整理你的关注列表"
        close={() => setActionsOpen(false)} onClosed={finishSheetClose}>
        <div className="mobile-watch-action-list">
          <Button variant="ghost" aria-label="搜索并添加品种" onClick={() => leaveActions(() => setSearching(true))}>
            <span className="watch-action-icon"><Plus aria-hidden="true" /></span><span><strong>添加自选</strong><small>搜索代码或名称</small></span><ChevronRight aria-hidden="true" />
          </Button>
          <Button variant="ghost" aria-label="管理自选" onClick={() => leaveActions(() => { setDraft(undefined); setManageTab("symbols"); setSheet("manage"); })}>
            <span className="watch-action-icon"><WatchIcon name="manage" /></span><span><strong>管理自选</strong><small>分组、排序与移除</small></span><ChevronRight aria-hidden="true" />
          </Button>
          <Button variant="ghost" onClick={() => leaveActions(requestRefresh)} disabled={!online || refreshing}>
            <span className="watch-action-icon"><RefreshCw aria-hidden="true" /></span><span><strong>刷新行情</strong><small>重新读取当前自选与走势</small></span><ChevronRight aria-hidden="true" />
          </Button>
        </div>
      </MobileSheet>
      <MobileSheet open={searching} fullHeight title="搜索品种" close={() => setSearching(false)} onClosed={finishSheetClose}>
          <DataPage
            profile={profile}
            online={online}
            visible
            searchMode
            initialGroup={group}
            report={report}
            open={(ticker) => {
              afterSheetClose.current = () => open(ticker);
              setSearching(false);
            }}
          />
        </MobileSheet>
      <MobileSheet
          open={Boolean(sheet)}
          dismissible={!busy}
          fullHeight={sheet === "manage"}
          title={sheet === "groups" ? "自选分组" : "管理自选"}
          description={sheet === "groups" ? `${content.lists.length} 个分组 · ${allSymbols(content).length} 个品种` : undefined}
          dirty={Boolean(name || draft || unsaved)}
          close={() => {
            setSheet(null);
            setName("");
            setDraft(undefined);
            setUnsaved(false);
          }}
        >
          {sheet === "groups" ? (
            <>
              <RadioGroup value={group} aria-label="自选分组" className="watch-group-list"
                onValueChange={(value) => {
                  const id = String(value);
                  setGroup(id); setSheet(null);
                  void writeSnapshot(profile, "watch-group", id).catch(() => report("分组选择未记住"));
                }}>
                {[{ id: "", title: "全部自选" }, ...content.lists].map(row => (
                  <RadioGroupItem key={row.id} value={row.id} variant="row" aria-label={row.title}
                    onClick={() => { if (group === row.id) setSheet(null); }}>
                    <span className="watch-group-icon" aria-hidden="true">{row.id ? <Folder /> : <Layers3 />}</span>
                    <span className="mobile-group-label">{row.title}</span>
                    <span className="mobile-group-count" aria-hidden="true">{row.id ? content.lists.find(item => item.id === row.id)?.symbols.length : allSymbols(content).length}</span>
                  </RadioGroupItem>
                ))}
              </RadioGroup>
              <div className="mobile-sheet-actions watch-group-footer">
                <div className="watch-group-shortcuts">
                  <Button variant="outline" onClick={() => { setName(""); setNameError(""); setGroupForm("new"); }}>
                    <FolderPlus data-icon="inline-start" aria-hidden="true" />新建分组
                  </Button>
                  {group && <Button variant="outline" onClick={() => {
                    setName(content.lists.find(row => row.id === group)?.title || "");
                    setNameError(""); setGroupForm("rename");
                  }}><Pencil data-icon="inline-start" aria-hidden="true" />重命名当前分组</Button>}
                </div>
                <Button variant="ghost" onClick={() => { setName(""); setManageTab("groups"); setSheet("manage"); }}>
                  管理分组与排序<ChevronRight data-icon="inline-end" aria-hidden="true" />
                </Button>
              </div>
            </>
          ) : (
            <>
              {!online && <p>上次内容，连接核验后才能修改。</p>}
              {unsaved && (
                <p className="mobile-submit-status" role="status">
                  尚未保存。冲突时保留当前输入，放弃修改后可查看最新。
                </p>
              )}
              <Tabs value={manageTab} onValueChange={value => setManageTab(String(value))} className="watch-manage-tabs">
                <TabsList aria-label="管理内容">
                  <TabsTrigger value="symbols" aria-label="品种">品种<span>{symbols.length}</span></TabsTrigger>
                  <TabsTrigger value="groups" aria-label="分组">分组<span>{editing.length}</span></TabsTrigger>
                </TabsList>
                <TabsContent value="groups" className="mobile-form-detail">
                <FieldGroup>
                <Field data-invalid={Boolean(nameError) || undefined}>
                  <FieldLabel htmlFor={groupNameId + "-create"}>新分组名称</FieldLabel>
                  <InputGroup className="watch-create-input">
                  <InputGroupInput id={groupNameId + "-create"}
                    value={name}
                    placeholder="例如：重点关注"
                    maxLength={20}
                    aria-invalid={Boolean(nameError)}
                    aria-describedby={nameError ? groupNameId + "-create-error" : undefined}
                    onChange={(event) => { setName(event.target.value); setNameError(""); }}
                  />
                  <InputGroupAddon align="inline-end">
                <InputGroupButton variant="secondary" size="icon-sm" aria-label="添加分组"
                  disabled={!online || busy || !name.trim()}
                  onClick={() => {
                    if (name.trim() === "全部" || editing.some(row => row.title.trim() === name.trim())) {
                      setNameError("请输入不重复的分组名称。");
                      return;
                    }
                    const lists = [
                      ...editing,
                      {
                        id: crypto.randomUUID(),
                        title: name.trim(),
                        symbols: [],
                      },
                    ];
                    setDraft(lists);
                    setName("");
                  }}
                >
                  <Plus aria-hidden="true" />
                </InputGroupButton>
                  </InputGroupAddon>
                  </InputGroup>
                  {nameError && <FieldError id={groupNameId + "-create-error"}>{nameError}</FieldError>}
                </Field>
                </FieldGroup>
                <WatchReorderList order={editing.map(row => row.id)}>
                {editing.map((row, index) => (
                  <div key={row.id} data-order-id={row.id} className="mobile-manage-group">
                    <FieldGroup>
                    <Field>
                      <FieldLabel className="sr-only" htmlFor={groupNameId + row.id}>分组名称</FieldLabel>
                      <Input id={groupNameId + row.id}
                        value={row.title}
                        maxLength={20}
                        onChange={(event) =>
                          setDraft(
                            editing.map((item) =>
                              item.id === row.id
                                ? { ...item, title: event.target.value }
                                : item,
                            ),
                          )
                        }
                      />
                    </Field>
                    </FieldGroup>
                    <div className="mobile-inline-actions">
                      <Button variant="outline" size="icon"
                        aria-label={`上移分组 ${row.title}`}
                        disabled={!index}
                        onClick={() => {
                          const next = [...editing];
                          [next[index - 1], next[index]] = [
                            next[index],
                            next[index - 1],
                          ];
                          setDraft(next);
                        }}
                      >
                        <ArrowUp aria-hidden="true" />
                      </Button>
                      <Button variant="outline" size="icon"
                        aria-label={`下移分组 ${row.title}`}
                        disabled={index === editing.length - 1}
                        onClick={() => {
                          const next = [...editing];
                          [next[index + 1], next[index]] = [
                            next[index],
                            next[index + 1],
                          ];
                          setDraft(next);
                        }}
                      >
                        <ArrowDown aria-hidden="true" />
                      </Button>
                      <Button variant="destructive" size="icon"
                        aria-label={`删除分组 ${row.title}`}
                        onClick={() => {
                          setConfirmation({ kind: "remove-group", id: row.id, title: row.title });
                        }}
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </div>
                    <Collapsible className="mobile-group-order">
                      <CollapsibleTrigger className="watch-disclosure" render={<Button variant="ghost" />}>
                        <span>品种排序<small>{row.symbols.length} 个品种</small></span><ChevronDown aria-hidden="true" />
                      </CollapsibleTrigger>
                      <CollapsibleContent className="watch-collapse-panel">
                      {!row.symbols.length && <p className="watch-group-empty">分组内暂无品种，可通过“添加自选”加入。</p>}
                      <WatchReorderList order={row.symbols}>
                    {row.symbols.map((ticker, position) => (
                      <div className="mobile-sheet-row" key={ticker} data-order-id={ticker}>
                        <span>{code(ticker, quotes[ticker])}</span>
                        <div className="mobile-inline-actions">
                          {[
                            [-1, "上移"],
                            [1, "下移"],
                          ].map(([direction, title]) => (
                            <Button variant="outline" size="icon"
                              key={String(direction)}
                              aria-label={`${title}品种 ${code(ticker, quotes[ticker])}（${row.title}）`}
                              disabled={
                                Number(direction) < 0
                                  ? position === 0
                                  : position === row.symbols.length - 1
                              }
                              onClick={() => {
                                const symbols = [...row.symbols],
                                  destination = position + Number(direction);
                                [symbols[position], symbols[destination]] = [
                                  symbols[destination],
                                  symbols[position],
                                ];
                                setDraft(
                                  editing.map((item) =>
                                    item.id === row.id
                                      ? { ...item, symbols }
                                      : item,
                                  ),
                                );
                              }}
                            >
                              {Number(direction) < 0 ? (
                                <ArrowUp aria-hidden="true" />
                              ) : (
                                <ArrowDown aria-hidden="true" />
                              )}
                            </Button>
                          ))}
                        </div>
                      </div>
                    ))}
                      </WatchReorderList>
                      </CollapsibleContent>
                    </Collapsible>
                  </div>
                ))}
                </WatchReorderList>
                <div className="mobile-group-save-actions">
                <Button variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (draft || unsaved) setConfirmation({ kind: "reload" });
                    else { setName(""); void refresh().catch(error => report(String(error))); }
                  }}
                >
                  查看最新
                </Button>
                </div>
                </TabsContent>
                <TabsContent value="symbols">
              <div className="mobile-manage-context">
                <span>当前分组</span>
                <strong>{group ? content.lists.find(row => row.id === group)?.title : "全部自选"}</strong>
                <small>{symbols.length} 个品种</small>
              </div>
              <p className="mobile-manage-help">{group ? "用箭头调整顺序，移除后可撤销。" : "选择具体分组可调整顺序，移除后可撤销。"}</p>
              <WatchReorderList order={symbols}>
              {symbols.map((ticker, position) => (
                <div key={ticker} data-order-id={ticker} className="mobile-watch-manage-row">
                  <span>
                    <strong>{code(ticker, quotes[ticker])}</strong>
                    <small>
                      {compactIdentity(ticker, quotes[ticker]).name}
                    </small>
                  </span>
                  <div className="mobile-watch-list-actions">
                    {group &&
                      [-1, 1].map((direction) => (
                        <Button variant="outline" size="icon"
                          key={direction}
                          aria-label={`${direction < 0 ? "上移" : "下移"}${code(ticker, quotes[ticker])}`}
                          disabled={
                            !online ||
                            busy ||
                            Boolean(draft) ||
                            (direction < 0
                              ? position === 0
                              : position === symbols.length - 1)
                          }
                          onClick={() => {
                            const next = [...symbols],
                              target = position + direction;
                            [next[position], next[target]] = [
                              next[target],
                              next[position],
                            ];
                            void save(
                              content.lists.map((row) =>
                                row.id === group
                                  ? { ...row, symbols: next }
                                  : row,
                              ),
                            );
                          }}
                        >
                          {direction < 0 ? (
                            <ArrowUp aria-hidden="true" />
                          ) : (
                            <ArrowDown aria-hidden="true" />
                          )}
                        </Button>
                      ))}
                    <Button variant="ghost"
                      className="mobile-watch-remove"
                      disabled={!online || busy || Boolean(draft)}
                      onClick={async () => {
                        const previous = content.lists;
                        if (await save(removeSymbol(content, ticker, group))) {
                          report("已移除；可在自选管理中撤销本次移除");
                          setUndo(previous);
                        }
                      }}
                    >
                      移除
                    </Button>
                  </div>
                </div>
              ))}
              </WatchReorderList>
              {undo && (
                <Button variant="outline"
                  disabled={!online || busy}
                  onClick={async () => {
                    if (await save(undo)) setUndo(undefined);
                  }}
                >
                  撤销上次移除
                </Button>
              )}
                </TabsContent>
              </Tabs>
              <div className="mobile-sheet-actions watch-manage-footer">
                {draft ? <Button
                  className="primary"
                  disabled={!online || busy || draft.some(row => !row.title.trim())}
                  onClick={() => void save(editing)}
                >
                  {busy ? "正在保存…" : "保存分组"}
                </Button> : <Button
                  className="primary"
                  disabled={busy || unsaved}
                  onClick={() => {
                    setSheet(null);
                    setName("");
                  }}
                >
                  完成
                </Button>}
              </div>
            </>
          )}
        </MobileSheet>
      <MobileSheet
          open={Boolean(groupForm)}
          dismissible={!busy}
          title={groupForm === "new" ? "新建分组" : "重命名分组"}
          dirty={
            groupForm === "new"
              ? Boolean(name)
              : name !==
                (content.lists.find((row) => row.id === group)?.title || "")
          }
          close={() => {
            setGroupForm(undefined);
            setName("");
          }}
        >
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              const title = name.trim();
              if (
                !title ||
                title === "全部" ||
                content.lists.some(
                  (row) =>
                    row.title === title &&
                    (groupForm === "new" || row.id !== group),
                )
              ) {
                setNameError("请输入不重复的分组名称（1–20 字）。");
                return;
              }
              const lists =
                groupForm === "new"
                  ? [
                      ...content.lists,
                      { id: crypto.randomUUID(), title, symbols: [] },
                    ]
                  : content.lists.map((row) =>
                      row.id === group ? { ...row, title } : row,
                    );
              if (await save(lists)) {
                setGroupForm(undefined);
                setName("");
                report("分组已保存");
              }
            }}
          >
            {unsaved && (
              <p role="status" className="mobile-submit-status">
                尚未保存 · 本次输入已保留
              </p>
            )}
            <FieldGroup>
              <Field data-invalid={Boolean(nameError) || undefined}>
                <FieldLabel htmlFor={groupNameId}>分组名称</FieldLabel>
                <Input id={groupNameId} required maxLength={20} autoComplete="off"
                  placeholder="例如：重点关注" value={name}
                  aria-invalid={Boolean(nameError)} aria-describedby={nameError ? groupNameId + "-error" : undefined}
                  onChange={event => { setName(event.target.value); setNameError(""); }} />
                {nameError && <FieldError id={groupNameId + "-error"}>{nameError}</FieldError>}
              </Field>
            </FieldGroup>
            <div className="mobile-sheet-actions">
              <Button type="submit" disabled={!online || busy}>
                {busy ? "正在保存…" : "保存分组"}
              </Button>
            </div>
          </form>
        </MobileSheet>
      {confirmation && <WatchConfirm
        title={confirmation.kind === "remove-group" ? `删除“${confirmation.title}”？` : "放弃修改并查看最新？"}
        description={confirmation.kind === "remove-group" ? "品种会保留在其他分组或未分组中，不会丢失自选。" : "当前未保存的输入将被替换为最新自选。"}
        actionLabel={confirmation.kind === "remove-group" ? "删除分组" : "放弃并刷新"}
        destructive
        onClose={() => setConfirmation(undefined)}
        onAccept={() => {
          if (confirmation.kind === "remove-group") setDraft(removeGroup({ ...content, lists: editing }, confirmation.id));
          else { setDraft(undefined); setUnsaved(false); setName(""); void refresh().catch(error => report(String(error))); }
          setConfirmation(undefined);
        }}
      />}
      </WatchOverlaysProvider>
    </section>
  );
}
