import { useCallback, useEffect, useRef, useState } from "react";
import type { Dataset } from "../market-data/types";
import { errorMessage } from "../api";
import {
  profileActive,
  readSnapshot,
  writeSnapshot,
  type Profile,
} from "./cache";
import { dataRequest } from "./dataOperations";
import { logFailure } from "./logs";

export type ManagedList = {
  items: Dataset[];
  total: number;
  categories?: { value: string; label: string }[];
};
type State = {
  data?: ManagedList;
  pages: number;
  loading: boolean;
  loadingMore: boolean;
  error: string;
  readAt?: number;
  freshRevision?: number;
  settledRevision?: number;
};

/** Each category/filter keeps its loaded span. Refresh replaces that span atomically. */
export function useManagedList(
  profile: Profile,
  params: string,
  active: boolean,
  online: boolean,
  interval: number,
) {
  const scopeFor = (params: string) => JSON.stringify([
    profile.origin,
    profile.subject,
    profile.generation,
    params,
  ]);
  const scope = scopeFor(params);
  const cache = useRef(new Map<string, State>());
  const [state, setState] = useState<{ scope: string; value: State }>();
  const [revision, setRevision] = useState(0);
  const version = useRef(0);
  const more = useRef<(() => void) | undefined>(undefined);
  const refresh = useCallback(() => {
    const next = ++version.current;
    setRevision(next);
    return next;
  }, []);
  const loadMore = useCallback(() => more.current?.(), []);
  const current =
    state?.scope === scope ? state.value : cache.current.get(scope);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    let value: State = cache.current.get(scope) || {
      pages: 1,
      loading: true,
      loadingMore: false,
      error: "",
    };
    const valid = () => !controller.signal.aborted && profileActive(profile);
    const commit = (next: State) => {
      if (!valid()) return;
      value = next;
      cache.current.set(scope, next);
      setState({ scope, value: next });
    };
    const page = (number: number) =>
      dataRequest<ManagedList>(
        profile,
        `/market-data/center/dataset-summaries?${params}&page=${number}&page_size=25`,
        undefined,
        controller.signal,
      );
    async function load(append = false) {
      if (!valid() || busy || !online) return;
      busy = true;
      clearTimeout(timer);
      commit({ ...value, loading: !append, loadingMore: append, error: "" });
      try {
        const start = append ? value.pages + 1 : 1;
        let response = await page(start),
          pages = start;
        const items = append
          ? [...(value.data?.items || []), ...response.items]
          : [...response.items];
        if (!append) {
          const wanted = Math.min(
            value.pages,
            Math.max(1, Math.ceil(response.total / 25)),
          );
          while (pages < wanted && valid()) {
            const next = await page(++pages);
            items.push(...next.items);
            response = next;
          }
        }
        if (!valid()) return;
        const data = {
          ...response,
          items: [...new Map(items.map((row) => [row.id, row])).values()],
        };
        commit({
          data,
          pages,
          loading: false,
          loadingMore: false,
          error: "",
          freshRevision: revision,
          settledRevision: revision,
        });
        void writeSnapshot(profile, "managed-list:" + params, {
          data,
          pages,
        }).catch(() => {});
      } catch (error) {
        if (valid()) {
          commit({
            ...value,
            loading: false,
            loadingMore: false,
            error: errorMessage(error),
            settledRevision: revision,
          });
          logFailure("数据", append ? "加载更多自建" : "刷新自建列表", error);
        }
      } finally {
        busy = false;
        if (valid()) timer = setTimeout(() => void load(), interval);
      }
    }
    more.current = () => {
      if (value.data && value.pages * 25 < value.data.total && !value.error)
        void load(true);
    };
    async function start() {
      if (!value.data) {
        const saved = await readSnapshot<{ data: ManagedList; pages: number }>(
          profile,
          "managed-list:" + params,
        ).catch(() => undefined);
        if (!valid()) return;
        if (saved) value = { ...value, ...saved.value, readAt: saved.readAt };
      }
      if (!valid()) return;
      if (!online && value.data && !value.readAt)
        value = { ...value, readAt: Date.now() };
      commit({ ...value, loading: online, loadingMore: false });
      if (online) void load();
      else commit({ ...value, loading: false });
    }
    void start();
    return () => {
      controller.abort();
      clearTimeout(timer);
      more.current = undefined;
    };
  }, [scope, active, online, interval, revision]);
  return {
    ...(current || {
      pages: 1,
      loading: active,
      loadingMore: false,
      error: "",
    }),
    hasMore: !!current?.data && current.pages * 25 < current.data.total,
    refresh,
    loadMore,
    // Read-only previews share this hook's cache; inactive panels never fetch.
    peek: (params: string) => cache.current.get(scopeFor(params)),
  };
}
