import { useCallback, useEffect, useRef, useState } from "react";
import type { HistoryPage, NoticeTransport } from "./types";

function combine(pages: HistoryPage[]): HistoryPage | null {
  if (!pages.length) return null;
  const seen = new Set<string>();
  return {
    ...pages[0],
    before: pages.at(-1)!.before,
    events: pages
      .flatMap((page) => page.events)
      .filter((row) => {
        if (seen.has(row.id)) return false;
        seen.add(row.id);
        return true;
      }),
  };
}
function checkCursor(
  page: HistoryPage,
  before: string | null,
  pages: HistoryPage[],
) {
  if (
    pages.length &&
    (page.epoch !== pages[0].epoch || page.highwater !== pages[0].highwater)
  )
    throw Error("NOTICE_RESET：消息记录已更新");
  if (
    page.before &&
    (page.before === before || pages.some((old) => old.before === page.before))
  )
    throw Error("消息加载游标未前进，请重试");
}

type QueryCache = {
  key: string;
  generation: number;
  pages: HistoryPage[];
  busy: boolean;
  scrollTop: number;
};
/** Owned by one native controller (therefore one authenticated scope), outside
 * its open/close portal. Never share across accounts, sessions or controllers. */
export class SystemHistoryCache {
  private epoch = "";
  private queries = new Map<string, QueryCache>();
  filters: Record<string, string> = {};
  query(epoch: string, filters: Record<string, string>) {
    if (this.epoch !== epoch) {
      for (const entry of this.queries.values()) entry.generation++;
      this.queries.clear();
      this.epoch = epoch;
    }
    const key = JSON.stringify([
      epoch,
      Object.entries(filters).sort(([a], [b]) => a.localeCompare(b)),
    ]);
    let entry = this.queries.get(key);
    if (!entry) {
      entry = { key, generation: 0, pages: [], busy: false, scrollTop: 0 };
      this.queries.set(key, entry);
      if (this.queries.size > 8) {
        const oldest = this.queries.keys().next().value!;
        this.queries.get(oldest)!.generation++;
        this.queries.delete(oldest);
      }
    }
    return entry;
  }
}

/** Cursor history shared by preview and live panel. Refreshes all loaded chunks;
 * stale filter/epoch responses cannot append to the current list. */
export function useSystemHistory({
  request,
  filters,
  epoch,
  revision,
  enabled,
  historyCache,
}: {
  request: NoticeTransport;
  filters: Record<string, string>;
  epoch: string;
  revision: number;
  enabled: boolean;
  historyCache?: SystemHistoryCache;
}) {
  const ownCache = useRef(new SystemHistoryCache());
  const cache = historyCache || ownCache.current;
  const current = cache.query(epoch, filters),
    key = current.key;
  const [view, setView] = useState(() => ({
    key,
    page: combine(current.pages),
    loading: enabled,
    loadingMore: false,
    error: "",
    moreError: "",
  }));
  useEffect(() => {
    const generation = ++current.generation;
    current.busy = false;
    if (!enabled) return;
    const count = Math.max(1, current.pages.length);
    current.busy = true;
    setView((old) => ({
      ...old,
      key,
      page: combine(current.pages),
      loading: true,
      loadingMore: false,
      error: "",
      moreError: "",
    }));
    const timer = setTimeout(
      () => {
        void (async () => {
          const pages: HistoryPage[] = [];
          let before: string | null = null;
          for (let i = 0; i < count; i++) {
            const next: HistoryPage = await request({
              action: "history",
              filters,
              before,
            });
            if (current.generation !== generation) return;
            checkCursor(next, before, pages);
            pages.push(next);
            before = next.before;
            if (!before) break;
          }
          current.pages = pages;
          setView({
            key,
            page: combine(pages),
            loading: false,
            loadingMore: false,
            error: "",
            moreError: "",
          });
        })()
          .catch((error) => {
            if (current.generation !== generation) return;
            if (String(error).includes("NOTICE_RESET")) {
              current.pages = [];
            }
            setView((old) => ({
              ...old,
              page: current.pages.length ? old.page : null,
              loading: false,
              error: String(error),
            }));
          })
          .finally(() => {
            if (current.generation === generation) current.busy = false;
          });
      },
      filters.q ? 250 : 0,
    );
    return () => {
      clearTimeout(timer);
      current.generation++;
      current.busy = false;
    };
  }, [request, key, revision, enabled]);
  const loadMore = useCallback(() => {
    const before = current.pages.at(-1)?.before;
    if (!enabled || current.key !== key || current.busy || !before) return;
    const generation = current.generation;
    current.busy = true;
    setView((old) => ({ ...old, loadingMore: true, moreError: "" }));
    void request({ action: "history", filters, before })
      .then((next: HistoryPage) => {
        if (current.generation !== generation) return;
        checkCursor(next, before, current.pages);
        current.pages = [...current.pages, next];
        setView((old) => ({
          ...old,
          page: combine(current.pages),
          loadingMore: false,
          moreError: "",
        }));
      })
      .catch((error) => {
        if (current.generation === generation)
          setView((old) => ({
            ...old,
            loadingMore: false,
            moreError: String(error),
          }));
      })
      .finally(() => {
        if (current.generation === generation) current.busy = false;
      });
  }, [request, key, enabled]);
  // A render with a new epoch/filter must never briefly expose the old page.
  const visible =
    view.key === key
      ? view
      : {
          key,
          page: combine(current.pages),
          loading: enabled,
          loadingMore: false,
          error: "",
          moreError: "",
        };
  return {
    ...visible,
    loadMore,
    scrollTop: current.scrollTop,
    saveScroll: (value: number) => {
      current.scrollTop = value;
    },
  };
}
