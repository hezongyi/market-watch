import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Task } from "./types";
import { useCenter } from "./router";
import { useCenterRowRestore } from "./navigation";

const memory = new Map<string, { feed: Feed; at: number; scroll: number }>();

type Feed = {
  items: Task[];
  total: number;
  snapshot: number;
  next_cursor: string | null;
  new_count: number;
};

/** Keyset continuation and ID polling keep a changing task list in place. */
export function useTaskRows(filters: URLSearchParams) {
  const signature = filters.toString();
  const workspaceScope = useCenter().workspace || "current";
  const memoryKey = workspaceScope + ":" + signature;
  const [generation, restart] = useState(0),
    [revision, pollNow] = useState(0);
  const [data, setData] = useState<{
    key: string;
    feed: Feed;
    at: number;
  } | null>(() => {
    const saved = memory.get(memoryKey);
    return saved
      ? { key: memoryKey + ":0", feed: saved.feed, at: saved.at }
      : null;
  });
  const [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const [stateError, setStateError] = useState("");
  const list = useRef<HTMLDivElement>(null),
    sentinel = useRef<HTMLDivElement>(null);
  const current = useRef(data);
  current.current = data;
  const scope = memoryKey + ":" + generation;
  const reading = useRef(false),
    sequence = useRef(0),
    abort = useRef<AbortController | null>(null);
  const readRef = useRef<() => Promise<void>>(async () => {});
  async function read() {
    if (reading.current) return;
    const latest = current.current?.key === scope ? current.current.feed : null;
    if (latest && !latest.next_cursor) return;
    const activeSequence = sequence.current;
    const request = new AbortController();
    abort.current = request;
    reading.current = true;
    setLoading(true);
    setError("");
    const query = new URLSearchParams(signature);
    if (latest) {
      query.set("snapshot", String(latest.snapshot));
      query.set("before", latest.next_cursor!);
    }
    try {
      const page = await api<Feed>(
        `/market-data/center/task-feed?${query}`,
        undefined,
        request.signal,
      );
      if (activeSequence !== sequence.current || request.signal.aborted) return;
      setData((previous) => {
        const rows = previous?.key === scope ? previous.feed.items : [];
        const unique = new Map(rows.map((row) => [row.id, row]));
        for (const row of page.items) unique.set(row.id, row);
        return {
          key: scope,
          feed: { ...page, items: [...unique.values()] },
          at: Date.now(),
        };
      });
    } catch (error) {
      if (activeSequence === sequence.current && !request.signal.aborted)
        setError(String(error));
    } finally {
      if (activeSequence === sequence.current) {
        reading.current = false;
        setLoading(false);
      }
    }
  }
  readRef.current = read;
  useEffect(() => {
    ++sequence.current;
    abort.current?.abort();
    reading.current = false;
    setError("");
    setStateError("");
    if (list.current)
      list.current.scrollTop =
        generation === 0 ? memory.get(memoryKey)?.scroll || 0 : 0;
    if (!current.current || current.current.key !== scope)
      void readRef.current();
    return () => {
      ++sequence.current;
      abort.current?.abort();
      reading.current = false;
    };
  }, [scope]);
  useEffect(() => {
    const request = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const latest = current.current;
      if (latest?.key === scope) {
        try {
          const items: Task[] = [];
          const ids = latest.feed.items.map((row) => row.id);
          for (let start = 0; start < ids.length; start += 100) {
            const query = new URLSearchParams({
              ids: ids.slice(start, start + 100).join(","),
            });
            const result = await api<{ items: Task[] }>(
              `/market-data/center/task-feed?${query}`,
              undefined,
              request.signal,
            );
            items.push(...result.items);
          }
          const query = new URLSearchParams(signature);
          query.set("snapshot", String(latest.feed.snapshot));
          query.set("page_size", "1");
          const counts = await api<Feed>(
            `/market-data/center/task-feed?${query}`,
            undefined,
            request.signal,
          );
          if (!request.signal.aborted) {
            const updates = new Map(items.map((row) => [row.id, row]));
            setData((previous) =>
              previous?.key === scope
                ? {
                    ...previous,
                    at: Date.now(),
                    feed: {
                      ...previous.feed,
                      new_count: counts.new_count,
                      items: previous.feed.items.map(
                        (row) => updates.get(row.id) || row,
                      ),
                    },
                  }
                : previous,
            );
            setStateError("");
          }
        } catch (error) {
          if (!request.signal.aborted) setStateError(String(error));
        }
      }
      if (!request.signal.aborted) timer = setTimeout(poll, 10000);
    }
    void poll();
    return () => {
      request.abort();
      clearTimeout(timer);
    };
  }, [scope, revision]);
  const feed = data?.key === scope ? data.feed : null;
  useCenterRowRestore(feed);
  useEffect(() => {
    if (data?.key === scope) {
      const scroll = memory.get(memoryKey)?.scroll || 0;
      memory.set(memoryKey, { feed: data.feed, at: data.at, scroll });
      if (memory.size > 8) memory.delete(memory.keys().next().value!);
    }
  }, [data, scope, memoryKey]);
  useEffect(() => {
    const node = list.current;
    if (!node) return;
    const save = () => {
      const saved = memory.get(memoryKey);
      if (saved) saved.scroll = node.scrollTop;
    };
    node.addEventListener("scroll", save);
    return () => {
      save();
      node.removeEventListener("scroll", save);
    };
  }, [memoryKey]);
  useEffect(() => {
    if (!sentinel.current || !feed?.next_cursor || loading || error) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          void readRef.current();
      },
      { root: list.current, rootMargin: "0px 0px 40px" },
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [feed?.next_cursor, loading, error]);
  return {
    items: feed?.items || [],
    total: feed?.total ?? null,
    complete: !!feed && !feed.next_cursor,
    newCount: feed?.new_count || 0,
    loading,
    error,
    stateError,
    at: data?.key === scope ? data.at : null,
    list,
    sentinel,
    retry: () => void read(),
    refreshStates: () => pollNow((value) => value + 1),
    restart: () => {
      memory.delete(memoryKey);
      restart((value) => value + 1);
    },
  };
}
