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
  if (pages.length && page.epoch !== pages[0].epoch)
    throw Error("NOTICE_RESET：消息记录已更新");
  if (
    page.before &&
    (page.before === before || pages.some((old) => old.before === page.before))
  )
    throw Error("消息加载游标未前进，请重试");
}

/** Cursor history shared by preview and live panel. Refreshes all loaded chunks;
 * stale filter/epoch responses cannot append to the current list. */
export function useSystemHistory({
  request,
  filters,
  epoch,
  revision,
  enabled,
}: {
  request: NoticeTransport;
  filters: Record<string, string>;
  epoch: string;
  revision: number;
  enabled: boolean;
}) {
  const key = JSON.stringify([epoch, filters]);
  const cache = useRef({
    key: "",
    generation: 0,
    pages: [] as HistoryPage[],
    busy: false,
  });
  const [view, setView] = useState({
    page: null as HistoryPage | null,
    loading: false,
    loadingMore: false,
    error: "",
    moreError: "",
  });
  useEffect(() => {
    const current = cache.current,
      generation = ++current.generation;
    current.busy = false;
    if (!enabled) return;
    const retain = current.key === key;
    const count = retain ? Math.max(1, current.pages.length) : 1;
    if (!retain) {
      current.key = key;
      current.pages = [];
    }
    current.busy = true;
    setView((old) => ({
      ...old,
      page: retain ? old.page : null,
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
              current.key = "";
              current.pages = [];
            }
            setView((old) => ({
              ...old,
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
    const current = cache.current,
      before = current.pages.at(-1)?.before;
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
  return { ...view, loadMore };
}
