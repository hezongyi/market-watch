import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../api";
import {
  profileActive,
  readSnapshot,
  writeSnapshot,
  type Profile,
} from "./cache";

export const dataSources = [
  { value: "all", label: "全部来源" },
  { value: "dukascopy", label: "Dukascopy" },
  { value: "oanda", label: "OANDA Practice" },
  { value: "binance", label: "Binance" },
  { value: "yahoo", label: "Yahoo Finance" },
  { value: "akshare", label: "AKShare" },
  { value: "fxcm", label: "FXCM Demo" },
];
export const dataTime = (value?: number | null) =>
  value == null
    ? "—"
    : new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(value));
export const sourceName = (source: string) =>
  dataSources.find((row) => row.value === source)?.label || source;
export const recentDate = () =>
  new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
export const taskName = (status?: string) =>
  ({
    pending: "排队中",
    running: "下载中",
    deriving: "生成周期中",
    retrying: "等待重试",
    configuration_error: "配置需处理",
    failed: "更新失败",
    partial: "部分成功",
    published: "已完成",
    paused: "任务已暂停",
    cancelled: "任务已取消",
  })[status || ""] ||
  status ||
  "等待更新";

export async function dataRequest<T = any>(
  profile: Profile,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  if (!profileActive(profile))
    throw new DOMException("会话已切换", "AbortError");
  const budget = /history-catalog\/(refresh|probe)/.test(path) ? 120000 : 20000;
  const timeout = AbortSignal.timeout(budget);
  try {
    const value = await api<T>(
      path,
      body,
      signal ? AbortSignal.any([timeout, signal]) : timeout,
    );
    if (!profileActive(profile))
      throw new DOMException("会话已切换", "AbortError");
    return value;
  } catch (error) {
    if (timeout.aborted && !signal?.aborted)
      throw Error(
        body === undefined
          ? "读取超时，请重试"
          : "提交结果待核实，请核查后重试",
      );
    throw error;
  }
}

/** One current-page read, bounded polling, and profile-partitioned offline snapshots. */
export function useDataRead<T>(
  profile: Profile,
  path: string,
  active: boolean,
  online: boolean,
  interval = 0,
) {
  const scope = JSON.stringify([
    profile.origin,
    profile.subject,
    profile.generation,
    path,
  ]);
  const [state, setState] = useState<{
    data?: T;
    scope?: string;
    loading: boolean;
    error: string;
    readAt?: number;
    freshRevision?: number;
  }>({ loading: false, error: "" });
  const [revision, setRevision] = useState(0);
  const refreshRevision = useRef(0);
  const refresh = useCallback(() => {
    const next = ++refreshRevision.current;
    setRevision(next);
    return next;
  }, []);
  useEffect(() => {
    if (!active || !path) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const valid = () => !controller.signal.aborted && profileActive(profile);
    const key = "data-workflow:" + path;
    async function load(first = false) {
      if (!valid()) return;
      setState((old) => ({
        ...old,
        ...(old.scope !== scope ? { data: undefined, readAt: undefined } : {}),
        scope,
        loading: true,
        error: "",
      }));
      try {
        if (first) {
          const snapshot = await readSnapshot<T>(profile, key);
          if (!valid()) return;
          if (snapshot)
            setState({
              data: snapshot.value,
              scope,
              loading: true,
              error: "",
              readAt: snapshot.readAt,
            });
        }
        if (!online) return;
        const data = await dataRequest<T>(
          profile,
          path,
          undefined,
          controller.signal,
        );
        if (!valid()) return;
        setState({ data, scope, loading: false, error: "", freshRevision: revision });
        await writeSnapshot(profile, key, data).catch(() => {});
      } catch (error) {
        if (valid())
          setState((old) => ({ ...old, error: errorMessage(error) }));
      } finally {
        if (valid()) {
          setState((old) => ({ ...old, loading: false }));
          if (online && interval)
            timer = setTimeout(() => void load(), interval);
        }
      }
    }
    void load(true);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [
    profile.origin,
    profile.subject,
    profile.generation,
    path,
    active,
    online,
    interval,
    revision,
  ]);
  return {
    ...state,
    data: state.scope === scope ? state.data : undefined,
    refresh,
  };
}

/** A write is never retried automatically: callers reconcile their own command. */
export function useDataCommand(profile: Profile, online: boolean) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const locked = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = async (
    action: (request: typeof dataRequest) => Promise<void>,
  ) => {
    if (locked.current || !online || !profileActive(profile)) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action(dataRequest);
    } catch (error) {
      if (alive.current && profileActive(profile))
        setError(errorMessage(error));
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return { busy, error, notice, setError, setNotice, run };
}
