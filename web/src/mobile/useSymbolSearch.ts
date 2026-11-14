import { useOverlayActive } from "./WatchOverlays";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../api";
import {
  profileActive,
  readSnapshot,
  writeSnapshot,
  type Profile,
} from "./cache";

export type SymbolPage<T> = { items: T[]; next?: string; note?: string };
type SearchState<T> = SymbolPage<T> & {
  scope: string;
  loaded: boolean;
  loading: boolean;
  error: string;
  readAt?: number;
};

/** Keeps each query's page chain intact; adapters retain their real backend cursors. */
export function useSymbolSearch<T>({
  profile,
  queryKey,
  active,
  online,
  fetchPage,
  identity,
}: {
  profile: Profile;
  queryKey: string;
  active: boolean;
  online: boolean;
  fetchPage(
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<SymbolPage<T>>;
  identity(item: T): string;
}) {
  const overlayActive = useOverlayActive();
  active = active && overlayActive;
  const scope = JSON.stringify([
    profile.origin,
    profile.subject,
    profile.generation,
    queryKey,
  ]);
  const empty = (): SearchState<T> => ({
    scope,
    items: [],
    loaded: false,
    loading: false,
    error: "",
  });
  const [state, setState] = useState<SearchState<T>>(empty);
  const current = useRef(state),
    request = useRef<AbortController | undefined>(undefined);
  const reconnect = useRef(false);
  const latest = useRef({ fetchPage, identity });
  latest.current = { fetchPage, identity };
  current.current = state;
  const load = useCallback(
    async (cursor?: string) => {
      if (!active || !online || request.current || !profileActive(profile))
        return;
      const controller = new AbortController();
      request.current = controller;
      setState((old) => ({
        ...(old.scope === scope ? old : empty()),
        loading: true,
        error: "",
      }));
      try {
        const result = await latest.current.fetchPage(
          cursor,
          controller.signal,
        );
        if (controller.signal.aborted || !profileActive(profile)) return;
        setState((old) => {
          const rows =
            cursor && old.scope === scope
              ? [...old.items, ...result.items]
              : result.items;
          const items = [
            ...new Map(
              rows.map((item) => [latest.current.identity(item), item]),
            ).values(),
          ];
          const value = {
            ...result,
            items,
            scope,
            loaded: true,
            loading: false,
            error: "",
          };
          void writeSnapshot(profile, "symbol-search:" + queryKey, value).catch(
            () => {},
          );
          return value;
        });
      } catch (error) {
        if (!controller.signal.aborted)
          setState((old) => ({
            ...(old.scope === scope ? old : empty()),
            loading: false,
            error: errorMessage(error),
          }));
      } finally {
        if (request.current === controller) request.current = undefined;
      }
    },
    [scope, active, online],
  );
  useEffect(() => {
    if (!online) reconnect.current = true;
    if (!active) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      if (
        current.current.scope === scope &&
        current.current.loaded &&
        !current.current.readAt &&
        !reconnect.current
      )
        return;
      const cached = await readSnapshot<SearchState<T>>(
        profile,
        "symbol-search:" + queryKey,
      ).catch(() => undefined);
      if (controller.signal.aborted) return;
      if (cached)
        setState({
          ...cached.value,
          scope,
          loading: online,
          error: "",
          readAt: cached.readAt,
        });
      if (online) {
        reconnect.current = false;
        void load();
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
      request.current?.abort();
      request.current = undefined;
      setState((old) => ({ ...old, loading: false }));
    };
  }, [scope, active, online, load]);
  const data = state.scope === scope ? state : empty();
  return {
    ...data,
    loading: data.loading || (!data.loaded && !data.error && active && online),
    loadNext: () => {
      if (data.next && !data.error) void load(data.next);
    },
    retry: () => void load(data.loaded ? data.next : undefined),
    refresh: () => void load(),
    update: (fn: (item: T) => T) =>
      setState((old) => ({ ...old, items: old.items.map(fn) })),
  };
}
