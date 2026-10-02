import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import "./advanced.css";
import { HistoryPlansDialog, type DatasetViews } from "./HistoryPlansDialog";
import { MaintenanceDialog } from "./MaintenanceDialog";
import { ExportDialog, type ExportSelection } from "./ExportDialog";
import { providerSubscriptions } from "./providerSubscriptions";

type Workspace = {
  id: string;
  name: string;
  revision: number;
  document: Record<string, unknown>;
  initial_symbol?: {ticker: string; metadata: Record<string, unknown>};
};
const channel = "mw-chart-v1";
const frames = new Set([
  "M1",
  "M5",
  "M15",
  "M30",
  "H1",
  "H4",
  "D1",
  "W1",
  "MN",
]);

export default function AdvancedWorkspace() {
  const [, setRows] = useState<Workspace[]>([]),
    [active, setActive] = useState<Workspace | null>(null);
  const [historyPlansOpen,setHistoryPlansOpen] = useState(false);
  const [maintenanceInstrument,setMaintenanceInstrument] = useState<string | null>(null);
  const [datasetViews,setDatasetViews] = useState<DatasetViews>({});
  const [frameKey, setFrameKey] = useState(0);
  const [exportSelection, setExportSelection] =
    useState<ExportSelection | null>(null);
  const [historyProgress,setHistoryProgress] = useState<Record<string,string>>({});
  const [feedError, setFeedError] = useState("");
  const [syncNotices, setSyncNotices] = useState<Record<string, string>>({});
  const [pollErrors, setPollErrors] = useState<Record<string, string>>({});
  const [chartTheme, setChartTheme] = useState("dark");
  const [nativeReady, setNativeReady] = useState(false);
  const [status, setStatus] = useState("正在加载工作区"),
    [error, setError] = useState("");
  const frame = useRef<HTMLIFrameElement>(null),
    current = useRef<Workspace | null>(null);
  const unsaved = useRef(false);
  const flushWaiters = useRef<
    { resolve: () => void; reject: (e: Error) => void }[]
  >([]);
  const mobile = matchMedia("(max-width:700px), (pointer:coarse)").matches;
  const queue = useRef<Promise<void>>(Promise.resolve()),
    blocked = useRef(false),
    inflight = useRef(0);
  const host =
    (import.meta as any).env.VITE_ADVANCED_CHART_ORIGIN ||
    `${location.protocol}//${location.hostname}:5187`;
  const origin = new URL(host).origin;
  if (origin === location.origin) throw new Error("图表库必须使用独立来源");
  const post = (value: object) =>
    frame.current?.contentWindow?.postMessage({ channel, ...value }, origin);
  const flush = () =>
    new Promise<void>((resolve, reject) => {
      if (!current.current || mobile) {
        resolve();
        return;
      }
      const waiter = { resolve, reject };
      flushWaiters.current.push(waiter);
      post({ type: "save" });
      setTimeout(() => {
        if (flushWaiters.current.includes(waiter)) {
          flushWaiters.current = flushWaiters.current.filter(
            (w) => w !== waiter,
          );
          reject(Error("保存未完成，请等待图表加载后再试"));
        }
      }, 15000);
    });
  const select = (row: Workspace) => {
    setNativeReady(false);
    setPollErrors({});
    setHistoryProgress({});
    setDatasetViews({});
    setSyncNotices({});
    unsaved.current = false;
    current.current = row;
    blocked.current =
      !mobile && !!localStorage.getItem("mw-tv-draft:" + row.id);
    setActive(row);
    setFrameKey((key) => key + 1);
    setError(
      blocked.current
        ? "存在未保存草稿，请点击复制恢复为独立工作区；原工作区自动保存已暂停"
        : "",
    );
    setStatus("正在加载图表");
  };
  const noticeMessages = [
    ...(blocked.current ? [{id: "draft", text: "草稿尚未保存，自动保存已暂停。是否复制恢复为独立工作区？", recover: true}] : []),
    ...(!blocked.current && error ? [{id: "workspace", text: error}] : []),
    ...(feedError && !(blocked.current && /未保存草稿|保存已暂停/.test(feedError))
      ? [{id: "feed", text: feedError}] : []),
    ...Object.entries(pollErrors).map(([id, text]) => ({id: "poll:" + id, text})),
    ...Object.entries(syncNotices).map(([id, text]) => ({id: "viewport:" + id, text})),
  ];
  const notificationState = JSON.stringify(noticeMessages);
  useEffect(() => {
    if (nativeReady) post({type: "notifications", notices: JSON.parse(notificationState),
      draftBlocked: blocked.current});
  }, [nativeReady, notificationState]);
  async function refresh(limit?: number) {
    const list = await api<Workspace[]>("/advanced-charts/workspaces"+(limit ? '?limit='+limit : ''));
    setRows(list);
    return list;
  }
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (mobile || !unsaved.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    addEventListener("beforeunload", protect);
    return () => removeEventListener("beforeunload", protect);
  }, [mobile]);
  useEffect(() => {
    const save = (event: KeyboardEvent) => {
      if (mobile || !(event.ctrlKey || event.metaKey) || event.altKey ||
          event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      post({type: "save"});
    };
    addEventListener("keydown", save);
    return () => removeEventListener("keydown", save);
  }, [mobile]);
  useEffect(() => {
    let cancelled = false;
    refresh(1)
      .then((list) => {
        if (!cancelled) {
          if (list[0]) select(list[0]);
          else setStatus("新建工作区开始使用");
        }
      })
      .catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    const marketRequests = new Map<Window, Map<number, AbortController>>();
    const provider = providerSubscriptions(api,
      client => new EventSource('/api/charts/provider/events?client='+encodeURIComponent(client)),
      event => frame.current?.contentWindow?.postMessage({channel,type:'provider-event',event},origin),
      error => setError(String(error)));
    const listener = async (e: MessageEvent) => {
      if (
        e.source !== frame.current?.contentWindow ||
        e.origin !== origin ||
        e.data?.channel !== channel
      )
        return;
      const m = e.data,
        source = e.source as Window;
      const reply = (value: object) =>
        source.postMessage({ channel, ...value }, origin);
      if(m.type==='provider-subscribe' || m.type==='provider-unsubscribe') {
        const args=m.args;
        if(!args || !/^[A-Za-z0-9_-]{1,64}$/.test(args.client) ||
          typeof args.listener!=='string' || args.listener.length>100) return;
        try {
          if(m.type==='provider-subscribe') {
            await provider.subscribe(args);
          } else {
            await provider.unsubscribe(args);
          }
        }catch(error){setError(String(error));}
        return;
      }
      if (m.type === "history-progress") {
        const key=String(m.key).slice(0,100),text=String(m.text).slice(0,200);
        setHistoryProgress(previous=> {
          const next={...previous};
          if(text)next[key]=text;else delete next[key];
          return next;
        });
        return;
      }
      if (m.type === "history-views" && Array.isArray(m.keys)) {
        const keys=new Set(m.keys.slice(0,8));
        setHistoryProgress(previous=>Object.fromEntries(Object.entries(previous).filter(([key])=>keys.has(key))));
        return;
      }
      if (m.type === "history-plans-open") {
        setHistoryPlansOpen(true); return;
      }
      if (m.type === "managed-dataset" && typeof m.dataset?.instrument === "string" && frames.has(m.dataset?.timeframe)) {
        const dataset=m.dataset;
        setDatasetViews(previous=>({...previous,[dataset.instrument+'|'+dataset.timeframe]:dataset}));
        return;
      }
      if (m.type === "maintenance-required" && !mobile && typeof m.instrument === "string" && m.instrument.length <= 40) {
        setMaintenanceInstrument(m.instrument); return;
      }
      if (m.type === "cancel-request") {
        marketRequests.get(source)?.get(m.id)?.abort();
        return;
      }
      if (m.type === "loaded") {
        await provider.clear();
        try {
          if (!mobile) await api("/advanced-charts/preferences/migrate", {});
          const [catalog, preferences] = await Promise.all([
            api("/advanced-charts/catalog"), api("/advanced-charts/preferences"),
          ]);
          reply({
            type: "init",
            document: current.current?.document || {},
            workspace: current.current,
            readonly: mobile,
            catalog,
            preferences,
            initial_symbol: current.current?.initial_symbol,
          });
        } catch (e) {
          setError(String(e));
        }
      } else if (m.type === "export-selection") {
        const value = m.selection;
        if (
          value &&
          typeof value.instrument === "string" &&
          value.instrument.length <= 80 &&
          frames.has(value.timeframe) &&
          Array.isArray(value.indicators) &&
          value.indicators.length <= 12 &&
          JSON.stringify(value).length < 20000
        )
          setExportSelection(value);
      } else if (m.type === "workspace-action") {
        if (m.action === "home") location.assign("/");
        else if (m.action === "logout") {
          try {
            if (!mobile && unsaved.current) await flush();
            await api("/logout", {});
            location.assign("/");
          } catch (e) {setError(String(e));}
        }
        else if (!mobile && m.action === "create") await create();
        else if (!mobile && m.action === "recover") await copy();
      } else if (m.type === "theme-changed") {
        if (typeof m.theme === "string" && /^(dark|light)$/i.test(m.theme))
          setChartTheme(m.theme.toLowerCase());
      } else if (m.type === "ready") {
        setNativeReady(true);
        setStatus("已加载 · 行情每15秒检查");
      }
      else if (m.type === "viewport-notice") {
        if (typeof m.key !== "string" || m.key.length > 200) return;
        setSyncNotices(previous => {
          if (m.key === "*") return {};
          const next = {...previous};
          if (m.text) next[m.key] = String(m.text).slice(0, 500);
          else delete next[m.key];
          return next;
        });
      }
      else if (m.type === "feed-poll-state") {
        if (typeof m.key !== "string" || m.key.length > 2000) return;
        setPollErrors(previous => {
          const next = { ...previous };
          if (m.error) next[m.key] = String(m.error).slice(0, 500);
          else delete next[m.key];
          return next;
        });
      }
      else if (m.type === "error") setFeedError(String(m.error).slice(0, 500));
      else if (m.type === "workspace-dirty") {
        if (!mobile) unsaved.current = true;
        setStatus("布局有未保存更改");
      }
      else if (m.type === "native-saving") {
        if (!mobile) unsaved.current = true;
        setStatus("正在保存");
      } else if (m.type === "native-saved") {
        unsaved.current = false;
        setStatus("已保存");
        flushWaiters.current.splice(0).forEach((w) => w.resolve());
      } else if (m.type === "workspace") {
        const q = m.query;
        if (
          !q ||
          !["list", "load", "save", "delete"].includes(q.op) ||
          JSON.stringify(q).length > 4_100_000 ||
          (mobile && ["save", "delete"].includes(q.op))
        ) {
          reply({ type: "result", id: m.id, error: "工作区操作不允许" });
          return;
        }
        if (
          ["load", "delete"].includes(q.op) &&
          !/^[a-zA-Z0-9-]{1,40}$/.test(q.args?.id || "")
        ) {
          reply({ type: "result", id: m.id, error: "无效工作区标识" });
          return;
        }
        try {
          await queue.current;
          if (
            blocked.current &&
            (q.op === "load" || (q.op === "save" && q.args?.id))
          )
            throw Error("存在未保存草稿，请先复制恢复为独立工作区");
          const draftId = q.op === "save" ? q.args?.id : null;
          const draft = draftId
            ? JSON.stringify({
                ...(current.current?.id === draftId
                  ? current.current?.document
                  : {}),
                engine: "tv31",
                schemaVersion: 1,
                state: JSON.parse(q.args.content),
                symbol: q.args.symbol,
                interval: q.args.resolution,
              })
            : null;
          if (draftId && draft) {
            try {
              localStorage.setItem("mw-tv-draft:" + draftId, draft);
            } catch {
              setError("本地草稿空间不足，请勿关闭页面，等待服务器保存完成");
            }
          }
          let result;
          if (q.op === "list")
            result = await api("/advanced-charts/native-charts");
          else if (q.op === "load")
            result = await api("/advanced-charts/native-charts/" + q.args.id);
          else if (q.op === "save")
            result = await api("/advanced-charts/native-charts/save", q.args);
          else
            result = await api(
              "/advanced-charts/workspaces/" + q.args.id + "/delete",
              { revision: q.args.revision },
            );
          if (
            q.op === "load" &&
            (!result.document?.state ||
              Object.keys(result.document.state).length === 0)
          ) {
            // A never-saved workspace has no vendor layout envelope. Initialize
            // a fresh widget instead of loading {} or copying the current chart.
            select({
              id: result.id,
              name: result.name,
              revision: result.revision,
              document: result.document,
            });
            setFeedError("");
            return;
          }
          if (q.op === "save" || q.op === "load") {
            // A successful native Save As binds a new independent workspace.
            // Keep any older failed draft available under its original ID.
            if (q.op === "save" && !q.args?.id) {
              blocked.current = false;
              setError("");
              setFeedError("");
              setStatus("已另存为独立工作区");
            }
            if (
              draftId &&
              localStorage.getItem("mw-tv-draft:" + draftId) === draft
            )
              localStorage.removeItem("mw-tv-draft:" + draftId);
            current.current = {
              id: result.id,
              name: result.name,
              revision: result.revision,
              document: result.document,
            };
            // Native loads happen inside the existing widget. Reflect their
            // identity without recreating the iframe or discarding chart state.
            setActive(current.current);
            setRows((p) =>
              p.some((x) => x.id === result.id)
                ? p.map((x) => (x.id === result.id ? current.current! : x))
                : [current.current!, ...p],
            );
          }
          if (q.op === "delete")
            setRows((previous) =>
              previous.filter((row) => row.id !== q.args.id),
            );
          reply({ type: "result", id: m.id, result });
          if (q.op === "delete" && current.current?.id === q.args.id) {
            // Do not leave a widget bound to a record which no longer exists.
            // Deletion is already committed; a refresh failure must not revive it.
            current.current = null;
            unsaved.current = false;
            blocked.current = false;
            setActive(null);
            setError("");
            setStatus("工作区已删除");
            try {
              const remaining = await refresh();
              if (remaining[0]) select(remaining[0]);
            } catch (e) {
              setError("工作区已删除，列表加载失败：" + String(e));
            }
          }
        } catch (e) {
          if (
            q.op === "save" &&
            q.args?.id &&
            localStorage.getItem("mw-tv-draft:" + q.args.id)
          ) {
            blocked.current = true;
            setStatus("保存已暂停 · 草稿已保留，请复制恢复");
          }
          setError(String(e));
          reply({ type: "result", id: m.id, error: String(e) });
        }
      } else if (m.type === "account-password") {
        const body = m.query;
        if (!body || typeof body.current_password !== "string" || typeof body.new_password !== "string" ||
            body.current_password.length > 512 || body.new_password.length > 512) {
          reply({type: "result", id: m.id, error: "无效密码请求"});
          return;
        }
        try {
          reply({type: "result", id: m.id, result: await api("/account/password", body)});
        } catch (error) {reply({type: "result", id: m.id, error: String(error)});}
      } else if (m.type === "style-template-name") {
        const name = mobile
          ? null
          : prompt("图表样式模板名称（同名将覆盖）", "我的样式");
        const value = name?.trim() || "";
        reply(
          value.length > 128
            ? { type: "result", id: m.id, error: "模板名称不能超过128字" }
            : { type: "result", id: m.id, result: value },
        );
      } else if (m.type === "preferences") {
        const q = m.query;
        if (
          mobile ||
          !q ||
          !["save", "delete"].includes(q.op) ||
          JSON.stringify(q).length > 1_100_000
        ) {
          reply({ type: "result", id: m.id, error: "设置请求不允许" });
          return;
        }
        if (q.op === "delete" && !/^[a-f0-9]{64}$/.test(q.args?.id || "")) {
          reply({ type: "result", id: m.id, error: "无效设置标识" });
          return;
        }
        try {
          reply({
            type: "result",
            id: m.id,
            result: await api(
              q.op === "save"
                ? "/advanced-charts/preferences/save"
                : "/advanced-charts/preferences/" + q.args.id + "/delete",
              q.args,
            ),
          });
        } catch (e) {
          reply({ type: "result", id: m.id, error: String(e) });
        }
      } else if (m.type === "market") {
        const q = m.query;
        const endpoints: Record<string, string> = {
          search: "/market-data/catalog",
          resolve: "/market-data/resolve",
          viewport: "/market-data/viewport-session",
          history: "/market-data/history",
          historyCache: "/market-data/history/cache",
          historyDemand: "/market-data/history/demand",
          dataset: "/market-data/dataset",
          activity: "/market-data/activity",
          retry: "/market-data/retry",
          quotes: "/market-data/quotes",
          serverTime: "/readyz",
        };
        if (
          !q ||
          !Object.hasOwn(endpoints, q.op) ||
          JSON.stringify(q).length > 4000 ||
          (q.op === "retry" &&
            !/^[a-zA-Z0-9-]{1,40}$/.test(String(q.args?.id || ""))) ||
          inflight.current >= 8
          || (q.native_history !== undefined &&
            (q.series_kind !== 'provider' || !q.native_history ||
              typeof q.native_history !== 'object' || Array.isArray(q.native_history) ||
              !Number.isInteger(q.native_history.chart_count) ||
              q.native_history.chart_count < 1 || q.native_history.chart_count > 8 ||
              (q.native_history.focused !== null && typeof q.native_history.focused !== 'boolean') ||
              typeof q.native_history.historical_navigation !== 'boolean'))
          || (q.history_observation !== undefined &&
            (!q.native_history || !q.history_observation ||
              typeof q.history_observation !== 'object' || Array.isArray(q.history_observation) ||
              !['revision','observed_at','first','last'].every(field =>
                Number.isSafeInteger(q.history_observation[field]) && q.history_observation[field] >= 0) ||
              q.history_observation.first > q.history_observation.last))
        ) {
          reply({ type: "result", id: m.id, error: "无效行情请求" });
          return;
        }
        const controller = new AbortController();
        if (!marketRequests.has(source)) marketRequests.set(source, new Map());
        const sourceRequests = marketRequests.get(source)!;
        sourceRequests.set(m.id, controller);
        inflight.current++;
        try {
          let result;
          if (q.op === "serverTime") {
            const response = await fetch("/readyz", {signal: controller.signal,
              credentials: "omit", cache: "no-store"});
            const health = await response.json();
            if (!response.ok || !Number.isSafeInteger(health.time) || health.time <= 0)
              throw Error("服务器时间暂不可用");
            result = Math.floor(health.time / 1000);
          } else result = await api(
            endpoints[q.op] +
              (q.op === "search" ? "?query=" + encodeURIComponent(String(q.args?.query || ""))
                : q.op === "retry" ? "/" + encodeURIComponent(q.args.id) : ""),
            q.op === "search" ? undefined : q.args, controller.signal);
          reply({
            type: "result",
            id: m.id,
            result,
          });
        } catch (e) {
          reply({ type: "result", id: m.id, error: String(e) });
        } finally {
          sourceRequests.delete(m.id);
          if (!sourceRequests.size) marketRequests.delete(source);
          inflight.current--;
        }
      } else if (m.type === "status") {
        setStatus(String(m.text).slice(0, 200));
        if (m.text === "行情已加载") setFeedError("");
      } else if (m.type === "data") {
        const q = m.query;
        if (
          !q ||
          (q.indicators !== undefined &&
            (!Array.isArray(q.indicators) ||
              q.indicators.length > 1 ||
              JSON.stringify(q.indicators).length > 2000)) ||
          typeof q.instrument !== "string" ||
          q.instrument.length > 80 ||
          (q.series_kind !== undefined && !["provider", "managed"].includes(q.series_kind)) ||
          !frames.has(q.timeframe) ||
          !Number.isInteger(q.limit) ||
          q.limit < 1 ||
          q.limit > (q.series_kind === "provider" ? 20000 : 2000) ||
          (q.before !== undefined &&
            (!Number.isSafeInteger(q.before) || q.before <= 0)) ||
          (q.revision_before !== undefined &&
            (!Number.isSafeInteger(q.revision_before) ||
              q.revision_before <= 0)) ||
          (q.revision_after !== undefined &&
            (!Number.isSafeInteger(q.revision_after) ||
              q.revision_after < 0)) ||
          inflight.current >= 8
        ) {
          reply({ type: "result", id: m.id, error: "请求不在允许范围内" });
          return;
        }
        const controller = new AbortController();
        if (!marketRequests.has(source)) marketRequests.set(source, new Map());
        const sourceRequests = marketRequests.get(source)!;
        sourceRequests.set(m.id, controller);
        inflight.current++;
        try {
          reply({
            type: "result",
            id: m.id,
            result: await api("/charts/data", {
              instrument: q.instrument,
              series_kind: q.series_kind || "managed",
              published: q.series_kind !== "provider",
              ...(typeof q.dataset_start === 'number' ? {dataset_start:q.dataset_start} : {}),
              timeframe: q.timeframe,
              limit: q.limit,
              ...(q.series_kind === 'provider' ? {countBack:q.countBack,
                from:q.from,firstDataRequest:q.firstDataRequest === true,client:q.client,
                ...(q.native_history !== undefined ? {native_history:q.native_history} : {}),
                ...(q.history_observation !== undefined ? {history_observation:q.history_observation} : {})} : {}),
              indicators: q.indicators || [],
              ...(q.before ? { before: q.before } : {}),
              track_history: q.track_history === true,
              ...(q.revision_after !== undefined
                ? { revision_after: q.revision_after }
                : {}),
              ...(q.revision_before
                ? { revision_before: q.revision_before }
                : {}),
            }, controller.signal),
          });
        } catch (e) {
          reply({ type: "result", id: m.id, error: String(e) });
        } finally {
          sourceRequests.delete(m.id);
          if (!sourceRequests.size) marketRequests.delete(source);
          inflight.current--;
        }
      } else if (m.type === "snapshot") {
        const id = current.current?.id,
          document = m.document;
        if (
          mobile ||
          !id ||
          document?.engine !== "tv31" ||
          document?.schemaVersion !== 1 ||
          JSON.stringify(document).length > 4_000_000
        )
          return;
        const waiters = flushWaiters.current.splice(0);
        if (blocked.current) {
          waiters.forEach((w) => w.reject(Error("存在未保存草稿，请复制恢复")));
          return;
        }
        if (
          JSON.stringify(document) === JSON.stringify(current.current?.document)
        ) {
          waiters.forEach((w) => w.resolve());
          setStatus("已保存");
          return;
        }
        try {
          localStorage.setItem("mw-tv-draft:" + id, JSON.stringify(document));
        } catch (e) {
          setError("本地草稿空间不足，将继续尝试服务器保存");
        }
        setStatus("正在保存");
        queue.current = queue.current.then(async () => {
          if (blocked.current || current.current?.id !== id) {
            waiters.forEach((w) =>
              w.reject(Error("保存已暂停，请保留此页面并处理冲突")),
            );
            return;
          }
          try {
            const row = await api<Workspace>(
              `/advanced-charts/workspaces/${id}/save`,
              {
                name: current.current.name,
                revision: current.current.revision,
                document,
              },
            );
            if (current.current?.id === id) {
              current.current = row;
              setRows((prev) => prev.map((x) => (x.id === id ? row : x)));
              setStatus("已自动保存");
              setError("");
              if (
                localStorage.getItem("mw-tv-draft:" + id) ===
                JSON.stringify(document)
              )
                localStorage.removeItem("mw-tv-draft:" + id);
            }
            waiters.forEach((w) => w.resolve());
          } catch (e) {
            waiters.forEach((w) => w.reject(new Error(String(e))));
            blocked.current = true;
            setStatus("保存已暂停");
            setError(String(e));
          }
        });
      }
    };
    addEventListener("message", listener);
    return () => {
      removeEventListener("message", listener);
      void provider.dispose();
      for (const requests of marketRequests.values())
        for (const controller of requests.values()) controller.abort();
    };
  }, [origin]);
  async function create() {
    const name = prompt("工作区名称", "我的图表");
    if (!name?.trim()) return;
    try {
      await flush();
      const row = await api<Workspace>("/advanced-charts/workspaces", {
        name: name.trim(),
      });
      setRows((p) => [row, ...p]);
      select(row);
    } catch (e) {
      setError(String(e));
    }
  }
  async function copy() {
    try {
      if (!blocked.current) await flush();
      const old = current.current;
      if (!old) return;
      const draft = localStorage.getItem("mw-tv-draft:" + old.id);
      const document = draft ? JSON.parse(draft) : old.document;
      const row = await api<Workspace>("/advanced-charts/workspaces", {
        name: old.name + " 副本",
      });
      const saved = await api<Workspace>(
        `/advanced-charts/workspaces/${row.id}/save`,
        { name: row.name, revision: row.revision, document },
      );
      localStorage.removeItem("mw-tv-draft:" + old.id);
      setRows((p) => [saved, ...p]);
      select(saved);
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <main className="advanced-workspace" data-theme={chartTheme}>
      {historyPlansOpen && <HistoryPlansDialog onClose={()=>setHistoryPlansOpen(false)} readonly={mobile}
        onRefresh={()=>post({type:'refresh-managed'})} views={datasetViews}/> }
      {maintenanceInstrument && <MaintenanceDialog instrument={maintenanceInstrument}
        onClose={()=>setMaintenanceInstrument(null)} onSubmitted={()=>{
          setMaintenanceInstrument(null);setHistoryPlansOpen(true);
        }}/>}
      {exportSelection && (
        <ExportDialog
          selection={exportSelection}
          onClose={() => setExportSelection(null)}
        />
      )}
      <div
        className="advanced-status"
        role="status"
        aria-live="polite"
        data-idle={/^(行情已加载|已加载|已保存|已另存)/.test(status)}
      >
        {status}
      </div>
      {!nativeReady && noticeMessages.length > 0 && (
        <div className="advanced-loading-notice" role="alert">
          {noticeMessages.map(notice => notice.text.replace(/^(?:Error:\s*)+/, "")).join("；")}
          {blocked.current && !mobile && <button onClick={copy}>复制恢复草稿</button>}
        </div>
      )}
      {active ? (
        <iframe
          key={frameKey}
          ref={frame}
          title="专业图表工作区"
          data-workspace-id={active.id}
          src={`${origin}/?parent=${encodeURIComponent(location.origin)}`}
          sandbox="allow-scripts allow-same-origin allow-downloads"
          allowFullScreen
          referrerPolicy="no-referrer"
        />
      ) : (
        <section>
          <a href="/">返回守望</a>
          <h1>专业图表夹</h1>
          <p>独立工作区，沿用守望行情。</p>
          <button disabled={mobile} onClick={create}>
            新建工作区
          </button>
        </section>
      )}
    </main>
  );
}
