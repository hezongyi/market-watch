import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChevronDown,
  Plus,
  SlidersHorizontal,
  ArrowUp,
  ArrowDown,
  Trash2,
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
import { sparklineLoader, sparklinePaths, type Sparkline } from "./sparklines";
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

type Quote = {
  n: string;
  s: string;
  v: Record<string, any>;
  snapshot?: { revision_id?: string };
  [key: string]: any;
};
const stamp = (value?: number | null) =>
  value ? new Date(value).toLocaleTimeString() : "等待首次通信";
const code = (ticker: string, quote?: Quote) =>
  quote?.v.short_name || ticker.replace(/^MW[PHC]:/, "");
function Spark({ item }: { item?: Sparkline }) {
  if (!item || item.window_end <= Date.now())
    return <span className="mobile-spark" aria-label="暂无当前窗口日内缓存" />;
  const paths = sparklinePaths(item);
  return (
    <svg
      className="mobile-spark"
      viewBox="0 0 200 48"
      preserveAspectRatio="none"
      aria-label={item.reason || "当前窗口日内走势"}
    >
      {item.reference_times?.map((at) => (
        <line
          key={at}
          x1={
            ((at - item.window_start) / (item.window_end - item.window_start)) *
            200
          }
          x2={
            ((at - item.window_start) / (item.window_end - item.window_start)) *
            200
          }
          y1="0"
          y2="48"
          stroke="currentColor"
          opacity=".2"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {paths.map((path, i) => (
        <g key={i}>
          <path d={path.area} fill="currentColor" opacity=".08" />
          <path
            d={path.line}
            stroke="currentColor"
            strokeWidth="1.4"
            fill="none"
            vectorEffect="non-scaling-stroke"
          />
        </g>
      ))}
      {paths.length > 0 && (
        <circle
          cx={paths.at(-1)!.end[0]}
          cy={paths.at(-1)!.end[1]}
          r="2"
          fill="currentColor"
        />
      )}
    </svg>
  );
}

export default function WatchPage({
  profile,
  online,
  connection,
  visible,
  open,
  search,
  report,
}: {
  profile: Profile;
  online: boolean;
  connection?: MobileMarket;
  visible: boolean;
  open(ticker: string): void;
  search(): void;
  report(message: string): void;
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
  const [quotes, setQuotes] = useState<Record<string, Quote>>({}),
    [sparks, setSparks] = useState<Record<string, Sparkline>>({});
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
  const currentQuotes = useRef(quotes);
  currentQuotes.current = quotes;
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
              ([, value]) => value.window_end > Date.now(),
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
      ...Object.values(sparks).map((item) => item.window_end),
    );
    if (!Number.isFinite(boundary)) return;
    const timer = setTimeout(
      () =>
        setSparks((previous) =>
          Object.fromEntries(
            Object.entries(previous).filter(
              ([, item]) => item.window_end > Date.now(),
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
      setVisibleRows([]);
      return;
    }
    const shown = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
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
    return () => observer.disconnect();
  }, [visible, symbolsKey]);
  useEffect(() => {
    setAligned(new Set());
    if (
      !online ||
      !visible ||
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
    visible,
    foreground,
    connection,
    rowKey,
    profile.origin,
    profile.subject,
    report,
  ]);
  useEffect(() => {
    if (!online || !visible || !foreground || !visibleRows.length) return;
    let timer: ReturnType<typeof setTimeout>,
      active = true;
    const loader = sparklineLoader(
      (items, signal) => api("/market-data/sparklines", { items }, signal),
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
          if (item.window_end <= Date.now()) delete next[ticker];
        currentSparks.current = next;
        setSparks(next);
        void writeSnapshot(profile, "watch-sparklines", next).catch(() => {});
      },
      (error) => report(String(error)),
    );
    const load = async () => {
      // Expire old curves before a new request, even when that request fails.
      setSparks((previous) =>
        Object.fromEntries(
          Object.entries(previous).filter(
            ([, item]) => item.window_end > Date.now(),
          ),
        ),
      );
      await loader.load(
        visibleRows.map((ticker) => ({
          ticker,
          ...(currentQuotes.current[ticker]?.snapshot?.revision_id
            ? {
                composite_revision_id:
                  currentQuotes.current[ticker].snapshot!.revision_id,
              }
            : {}),
        })),
      );
      if (active) {
        const boundary = Math.min(
          ...visibleRows.map(
            (ticker) => currentSparks.current[ticker]?.window_end || Infinity,
          ),
        );
        timer = setTimeout(
          load,
          Math.max(1, Math.min(60000, boundary - Date.now())),
        );
      }
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
    report,
  ]);
  async function save(lists: WatchList[]) {
    if (busy || !online) return;
    setBusy(true);
    setUnsaved(true);
    try {
      const row = await saveWatchlists(api, preference, lists);
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
      ? "SSE 等待连接"
      : !transport || transport.state === "idle"
        ? "SSE 无活跃订阅"
        : transport.state === "open"
          ? "SSE 已连接"
          : transport.state === "error"
            ? "SSE 正在重连"
            : "SSE 连接中";
  const last = Math.max(transport?.messageAt || 0, transport?.heartbeatAt || 0);
  const editing = draft || content.lists;
  return (
    <section hidden={!visible} className="mobile-watch">
      <header className="mobile-watch-title">
        <button
          className="mobile-group-button"
          aria-label="选择自选分组"
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
        </button>
        <div className="mobile-sse" role="status">
          <span>{status}</span>
          <small>{last ? "最近通信 " + stamp(last) : "等待首次通信"}</small>
        </div>
        <div className="mobile-header-actions">
          <button aria-label="搜索并添加品种" onClick={search}>
            <Plus aria-hidden="true" />
          </button>
          <button
            aria-label="管理自选"
            onClick={() => {
              setDraft(undefined);
              setSheet("manage");
            }}
          >
            <SlidersHorizontal aria-hidden="true" />
          </button>
        </div>
      </header>
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
          <p role="status">
            {loadError
              ? "读取失败，暂无可读取的自选缓存"
              : online
                ? "正在读取自选…"
                : "暂无可读取的自选缓存"}
            {loadError && (
              <button
                onClick={() =>
                  void refresh().catch((error) => {
                    setLoadError(String(error));
                    report(String(error));
                  })
                }
              >
                重试
              </button>
            )}
          </p>
        ) : !symbols.length ? (
          <p>此分组还没有自选，点击右上角添加。</p>
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
          return (
            <button
              key={ticker}
              data-ticker={ticker}
              className={`mobile-watch-row ${stale ? "stale" : ""}`}
              onClick={() => open(ticker)}
            >
              <span className="mobile-watch-symbol">
                <strong>{code(ticker, quote)}</strong>
                <small>{value?.description || ticker}</small>
              </span>
              <Spark
                item={
                  revision && item?.revision?.composite_revision_id !== revision
                    ? undefined
                    : item
                }
              />
              <span className="mobile-watch-price">
                <strong>
                  {typeof price === "number"
                    ? price.toLocaleString(undefined, {
                        maximumFractionDigits: 8,
                      })
                    : "—"}
                </strong>
                <small
                  className={
                    typeof change !== "number"
                      ? ""
                      : change >= 0
                        ? "up"
                        : "down"
                  }
                >
                  {typeof change === "number"
                    ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`
                    : "—"}
                </small>
              </span>
            </button>
          );
        })}
      </div>
      {sheet && (
        <MobileSheet
          title={sheet === "groups" ? "自选分组" : "管理自选"}
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
              {[{ id: "", title: "全部自选" }, ...content.lists].map((row) => (
                <button
                  key={row.id}
                  className="mobile-sheet-row"
                  aria-pressed={group === row.id}
                  onClick={() => {
                    setGroup(row.id);
                    setSheet(null);
                    void writeSnapshot(profile, "watch-group", row.id).catch(
                      () => report("分组选择未记住"),
                    );
                  }}
                >
                  {row.title}
                </button>
              ))}
              <button
                onClick={() => {
                  setName("");
                  setSheet("manage");
                }}
              >
                管理分组
              </button>
            </>
          ) : (
            <>
              {!online && <p>上次内容，连接核验后才能修改。</p>}
              {unsaved && (
                <p role="status">
                  尚未保存。冲突时保留当前输入，放弃修改后可查看最新。
                </p>
              )}
              <label>
                新分组名称
                <input
                  value={name}
                  maxLength={100}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <button
                disabled={!online || busy || !name.trim()}
                onClick={() => {
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
                添加分组
              </button>
              {editing.map((row, index) => (
                <div key={row.id} className="mobile-manage-group">
                  <label>
                    分组名称
                    <input
                      value={row.title}
                      maxLength={100}
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
                  </label>
                  <div className="mobile-inline-actions">
                    <button
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
                    </button>
                    <button
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
                    </button>
                    <button
                      aria-label={`删除分组 ${row.title}`}
                      onClick={() => {
                        if (
                          confirm(
                            "删除此分组？自选品种将保留在其他分组或未分组中。",
                          )
                        )
                          setDraft(
                            removeGroup({ ...content, lists: editing }, row.id),
                          );
                      }}
                    >
                      <Trash2 aria-hidden="true" />
                    </button>
                  </div>
                  {row.symbols.map((ticker, position) => (
                    <div className="mobile-sheet-row" key={ticker}>
                      <span>{code(ticker, quotes[ticker])}</span>
                      <div className="mobile-inline-actions">
                        {[
                          [-1, "上移"],
                          [1, "下移"],
                        ].map(([direction, title]) => (
                          <button
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
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
              <button
                className="primary"
                disabled={
                  !online ||
                  busy ||
                  !draft ||
                  draft.some((row) => !row.title.trim())
                }
                onClick={() => void save(editing)}
              >
                {busy ? "正在保存…" : "保存分组"}
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  if (
                    (!draft && !unsaved) ||
                    confirm("放弃当前修改并查看最新自选？")
                  ) {
                    setDraft(undefined);
                    setUnsaved(false);
                    setName("");
                    void refresh().catch((error) => report(String(error)));
                  }
                }}
              >
                查看最新
              </button>
              <h3>{group ? "从当前分组移除" : "从全部自选移除"}</h3>
              {symbols.map((ticker) => (
                <div key={ticker} className="mobile-sheet-row">
                  <span>{code(ticker, quotes[ticker])}</span>
                  <button
                    disabled={!online || busy}
                    onClick={async () => {
                      const previous = content.lists;
                      if (await save(removeSymbol(content, ticker, group))) {
                        report("已移除；可在自选管理中撤销本次移除");
                        setUndo(previous);
                      }
                    }}
                  >
                    移除
                  </button>
                </div>
              ))}
              {undo && (
                <button
                  disabled={!online || busy}
                  onClick={async () => {
                    if (await save(undo)) setUndo(undefined);
                  }}
                >
                  撤销上次移除
                </button>
              )}
            </>
          )}
        </MobileSheet>
      )}
    </section>
  );
}
