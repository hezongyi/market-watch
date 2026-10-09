import { useEffect, useRef, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { NativeInput } from "./NativeControls";
import { api } from "./api";
import { useCenter, useSearchParams } from "./router";
import { useCenterRowRestore } from "./navigation";
import type { Page } from "./types";

export function MarketListHeader({
  title,
  query,
  onQuery,
  refresh,
  children,
}: {
  title: string;
  query: string;
  onQuery: (value: string) => void;
  refresh: () => void;
  children?: ReactNode;
}) {
  return (
    <>
      <div className="dc-market-title">
        <h1>{title}</h1>
        <div className="dc-actions">
          {children}
          <button
            className="dc-market-refresh"
            title="刷新列表"
            aria-label="刷新列表"
            onClick={refresh}
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>
      <div className="dc-market-search">
        <NativeInput
          type="search"
          aria-label="搜索品种"
          maxLength={100}
          placeholder="品种代码或名称"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
      </div>
    </>
  );
}

export function MarketTabs({
  label,
  value,
  items,
  change,
}: {
  label: string;
  value: string;
  items: readonly (readonly [string, string])[];
  change: (value: string) => void;
}) {
  return (
    <nav className="dc-market-tabs" aria-label={label}>
      {items.map(([key, name]) => (
        <button
          key={key}
          aria-pressed={value === key}
          onClick={() => change(key)}
        >
          {name}
        </button>
      ))}
    </nav>
  );
}

/** Keep a refreshed prefix of server pages; continuation failures retain earlier rows. */
export function useMarketRows<
  T extends { id: string } | { dataset: { id: string } },
>(endpoint: string, filters: URLSearchParams, refresh: number) {
  const [params, setParams] = useSearchParams(),
    { location } = useCenter();
  const latest = useRef({ params, setParams });
  latest.current = { params, setParams };
  const signature = endpoint + "?" + filters.toString();
  const [pages, setPages] = useState(
    Math.max(1, Math.min(100, Number(params.get("page")) || 1)),
  );
  const [snapshot, setSnapshot] = useState<{
    signature: string;
    items: T[];
    total: number;
    complete: boolean;
    at: number;
  } | null>(null);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const active = useRef(signature),
    list = useRef<HTMLDivElement>(null),
    sentinel = useRef<HTMLDivElement>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const items = snapshot?.signature === signature ? snapshot.items : [];
  const total = snapshot?.signature === signature ? snapshot.total : null;
  useEffect(() => {
    if (active.current !== signature) {
      active.current = signature;
      setPages(1);
    }
  }, [signature]);
  useEffect(() => {
    if (signature !== active.current) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const requestedPages = pages;
    async function read() {
      setLoading(true);
      setError("");
      try {
        const unique = new Map<string, T>();
        let total = 0;
        let complete = false;
        for (let page = 1; page <= requestedPages; page++) {
          const query = new URLSearchParams(filters);
          query.set("page", String(page));
          query.set("page_size", "25");
          const result = await api<Page<T>>(
            `${endpoint}?${query}`,
            undefined,
            abort.signal,
          );
          total = result.total;
          for (const row of result.items)
            unique.set("dataset" in row ? row.dataset.id : row.id, row);
          const rows = [...unique.values()];
          complete = !result.items.length || page * 25 >= total;
          // Initial restoration may show its first batch. A continuation or
          // periodic refresh keeps the entire previous prefix until success.
          if (
            !abort.signal.aborted &&
            snapshotRef.current?.signature !== signature
          )
            setSnapshot({
              signature,
              items: rows,
              total,
              complete,
              at: Date.now(),
            });
          if (complete) break;
        }
        if (!abort.signal.aborted) {
          setSnapshot({
            signature,
            items: [...unique.values()],
            total,
            complete,
            at: Date.now(),
          });
          const next = new URLSearchParams(latest.current.params);
          next.set("page", String(requestedPages));
          if (next.toString() !== latest.current.params.toString())
            latest.current.setParams(next, { replace: true });
        }
      } catch (error) {
        if (!abort.signal.aborted) setError(String(error));
      } finally {
        if (!abort.signal.aborted) {
          setLoading(false);
          timer = setTimeout(read, 10000);
        }
      }
    }
    void read();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [signature, pages, refresh, retry]);
  useEffect(() => {
    if (
      !sentinel.current ||
      loading ||
      error ||
      total === null ||
      snapshot?.complete
    )
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          setPages((value) => value + 1);
      },
      { root: list.current, rootMargin: "0px 0px 40px" },
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [loading, error, total, items.length, snapshot?.complete]);
  useCenterRowRestore(snapshot?.signature === signature ? snapshot : null);
  // A section round trip can have a saved scroll position without a row hash.
  useEffect(() => {
    const node = list.current;
    if (!node) return;
    const save = () =>
      sessionStorage.setItem(
        "mw-market-scroll:" + signature,
        String(node.scrollTop),
      );
    node.addEventListener("scroll", save);
    return () => {
      node.removeEventListener("scroll", save);
    };
  }, [signature]);
  const restored = useRef("");
  useEffect(() => {
    if (
      !items.length ||
      loading ||
      !list.current ||
      location.includes("#") ||
      restored.current === signature
    )
      return;
    restored.current = signature;
    const key = "mw-market-scroll:" + signature;
    const saved = Number(sessionStorage.getItem(key)) || 0;
    if (list.current.scrollTop === 0 && saved) list.current.scrollTop = saved;
  }, [signature, loading]);
  return {
    items,
    total,
    loading,
    error,
    list,
    sentinel,
    retry: () => setRetry((value) => value + 1),
    at: snapshot?.signature === signature ? snapshot.at : null,
  };
}

export function MarketListStatus({
  loading,
  error,
  count,
  total,
  retry,
}: {
  loading: boolean;
  error: string;
  count: number;
  total: number | null;
  retry: () => void;
}) {
  return (
    <div className="dc-market-status" role={error ? "alert" : "status"}>
      {error ? (
        <>
          {error}
          <button onClick={retry}>重试</button>
        </>
      ) : loading ? (
        "正在加载…"
      ) : !count ? (
        "没有符合筛选的条目"
      ) : count >= (total || 0) ? (
        `已全部加载 · ${count} 条`
      ) : (
        `已加载 ${count} / ${total}`
      )}
    </div>
  );
}
