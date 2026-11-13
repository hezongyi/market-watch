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

type RowSnapshot<T> = { signature: string; items: T[]; total: number; complete: boolean; at: number; loaded: number };
const rowCache = new Map<string, RowSnapshot<any>>();
const rowKey = (row: any): string => row.dataset?.id || row.id;

/** Append new pages; refresh loaded IDs without replaying the whole prefix. */
export function useMarketRows<
  T extends { id: string } | { dataset: { id: string } },
>(endpoint: string, filters: URLSearchParams, refresh: number) {
  const [params, setParams] = useSearchParams(), { location, workspace } = useCenter();
  const latest = useRef({ params, setParams });
  latest.current = { params, setParams };
  const signature = (workspace || "") + ":" + endpoint + "?" + filters.toString();
  const [paging, setPaging] = useState({ signature, count: Math.max(1, Math.min(100, Number(params.get("page")) || 1)) });
  const pages = paging.signature === signature ? paging.count : Math.max(1, Math.min(100, Number(params.get("page")) || 1));
  const [snapshot, setSnapshot] = useState<RowSnapshot<T> | null>(() => rowCache.get(signature) || null);
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const list = useRef<HTMLDivElement>(null), sentinel = useRef<HTMLDivElement>(null);
  const snapshotRef = useRef(snapshot); snapshotRef.current = snapshot;
  const current = snapshot?.signature === signature ? snapshot : rowCache.get(signature);
  const items: T[] = current?.items || [], total = current?.total ?? null;
  const batch = endpoint.endsWith("/dataset-summaries");
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>, running = false;
    function accept(value: RowSnapshot<T>) {
      if (abort.signal.aborted) return;
      snapshotRef.current = value; setSnapshot(value);
      rowCache.delete(signature); rowCache.set(signature, value);
      while (rowCache.size > 10) rowCache.delete(rowCache.keys().next().value!);
      const next = new URLSearchParams(latest.current.params);
      next.set("page", String(value.loaded));
      if (next.toString() !== latest.current.params.toString()) latest.current.setParams(next, { replace: true });
    }
    async function requestPage(page: number) {
      const query = new URLSearchParams(filters);
      query.set("page", String(page)); query.set("page_size", "25");
      return api<Page<T>>(`${endpoint}?${query}`, undefined, abort.signal);
    }
    async function prefix(previous: RowSnapshot<T> | null, target: number) {
      const unique = new Map<string, T>((previous?.items || []).map(row => [rowKey(row), row]));
      let total = previous?.total || 0, loaded = previous?.loaded || 0, complete = previous?.complete || false;
      for (let page = loaded + 1; page <= target && !complete; page++) {
        const response = await requestPage(page); total = response.total; loaded = page;
        for (const row of response.items) unique.set(rowKey(row), row);
        complete = !response.items.length || page * 25 >= total;
        // Restore progressively on a cold return; continuation keeps existing rows.
        accept({ signature, items: [...unique.values()], total, loaded, complete, at: Date.now() });
      }
      return { signature, items: [...unique.values()], total, loaded, complete, at: Date.now() };
    }
    async function poll(previous: RowSnapshot<T>) {
      if (!batch || !previous.items.length) return prefix(null, Math.max(1, previous.loaded));
      const updated: T[] = [];
      let total = previous.total;
      for (let offset = 0; offset < previous.items.length; offset += 100) {
        const query = new URLSearchParams(filters);
        query.set("ids", previous.items.slice(offset, offset + 100).map(rowKey).join(","));
        const response = await api<Page<T>>(`${endpoint}?${query}`, undefined, abort.signal);
        total = response.total; updated.push(...response.items);
      }
      const byId = new Map(updated.map(row => [rowKey(row), row]));
      const rows = previous.items.map(row => byId.get(rowKey(row)));
      // Membership/order changes require a fresh prefix, including a formerly
      // complete last page that gained a row. An unchanged list stays batched.
      if (rows.some((row, index) => !row || (row as any).position !== index + 1) ||
          rows.length !== Math.min(total, previous.loaded * 25)) return prefix(null, Math.max(1, previous.loaded));
      return { ...previous, items: rows as T[], total, complete: previous.loaded * 25 >= total, at: Date.now() };
    }
    async function read() {
      if (abort.signal.aborted || running || document.hidden) return;
      running = true; setLoading(true); setError("");
      try {
        const previous = snapshotRef.current?.signature === signature ? snapshotRef.current : rowCache.get(signature) || null;
        const value = !previous || previous.loaded < pages ? await prefix(previous, pages) : await poll(previous);
        accept(value);
      } catch (error) { if (!abort.signal.aborted) setError(String(error)); }
      finally {
        running = false;
        if (!abort.signal.aborted) { setLoading(false); if (!document.hidden) timer = setTimeout(read, 10000); }
      }
    }
    const visibility = () => { clearTimeout(timer); if (!document.hidden) void read(); };
    document.addEventListener("visibilitychange", visibility);
    // Search text updates immediately; only the network query is debounced.
    timer = setTimeout(read, filters.get("query") ? 200 : 0);
    return () => { abort.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [signature, pages, refresh, retry]);
  useEffect(() => {
    if (!sentinel.current || loading || error || total === null || current?.complete) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setPaging({ signature, count: Math.min(100, pages + 1) });
    }, { root: list.current, rootMargin: "0px 0px 40px" });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [signature, pages, loading, error, total, items.length, current?.complete]);
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
